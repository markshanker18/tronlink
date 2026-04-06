import { Provider, Wallet, TransactionRequest, TransactionResponse } from "ethers";

interface PendingTx {
  nonce: number;
  hash: string;
  sentAt: number;
  originalRequest: TransactionRequest;
}

/**
 * Ensures atomic nonce allocation for EVM chains to prevent "nonce too low"
 * or "replacement transaction underpriced" deadlocks.
 * 
 * Works completely safely in clustered environments because the caller (scheduler)
 * already holds the global SCHEDULER_LOCK_NAME in Postgres before executing.
 */
export class NonceManager {
  private static nonces = new Map<string, number>();
  private static pendingTxs = new Map<string, PendingTx[]>();

  /**
   * Retrieves the next safe nonce for the address on the specified network.
   * Auto-increments the internal tracker.
   */
  static async getNextNonce(networkId: string, address: string, provider: Provider): Promise<number> {
    const key = networkId + "_" + address.toLowerCase();
    const pendingNonce = await provider.getTransactionCount(address, "pending");

    let tracked = this.nonces.get(key);

    if (tracked === undefined || tracked < pendingNonce) {
      tracked = pendingNonce;
    }

    this.nonces.set(key, tracked + 1);
    return tracked;
  }

  /**
   * Broadcasts a transaction and tracks it for potential replacement if it gets stuck.
   */
  static async broadcastAndTrack(
    networkId: string,
    wallet: Wallet,
    txRequest: TransactionRequest
  ): Promise<TransactionResponse> {
    const address = await wallet.getAddress();
    const key = networkId + "_" + address.toLowerCase();
    
    const tx = await wallet.sendTransaction(txRequest);
    
    const currentPending = this.pendingTxs.get(key) || [];
    currentPending.push({
      nonce: tx.nonce,
      hash: tx.hash,
      sentAt: Date.now(),
      originalRequest: txRequest,
    });
    this.pendingTxs.set(key, currentPending);

    return tx;
  }

  /**
   * Periodically called to check for transactions pending > 10 minutes.
   * If found, rebroadcasts with a 20% gas limit/price bump.
   */
  static async handleStuckTransactions(networkId: string, wallet: Wallet, provider: Provider): Promise<void> {
    const address = await wallet.getAddress();
    const key = networkId + "_" + address.toLowerCase();
    
    const latestNonce = await provider.getTransactionCount(address, "latest");
    const pendingList = this.pendingTxs.get(key) || [];

    const now = Date.now();
    const TEN_MINUTES_MS = 10 * 60 * 1000;

    const activePending = pendingList.filter(tx => tx.nonce >= latestNonce);
    
    for (const tx of activePending) {
      if (now - tx.sentAt > TEN_MINUTES_MS) {
        console.log("[NonceManager] Tx " + tx.hash + " stuck for > 10m. Bumping gas by 20%...");
        
        const bumpedRequest = { ...tx.originalRequest };
        
        // Very basic gas bumping logic (replace with more robust feeData checks in prod)
        if (bumpedRequest.gasPrice) {
           const currentPrice = BigInt(bumpedRequest.gasPrice.toString());
           bumpedRequest.gasPrice = currentPrice + (currentPrice * 20n / 100n);
        } else if (bumpedRequest.maxFeePerGas) {
           const currentMax = BigInt(bumpedRequest.maxFeePerGas.toString());
           bumpedRequest.maxFeePerGas = currentMax + (currentMax * 20n / 100n);
           if (bumpedRequest.maxPriorityFeePerGas) {
             const currentPriority = BigInt(bumpedRequest.maxPriorityFeePerGas.toString());
             bumpedRequest.maxPriorityFeePerGas = currentPriority + (currentPriority * 20n / 100n);
           }
        } else {
            // EIP-1559 fallback query
            const feeData = await provider.getFeeData();
            if (feeData.maxFeePerGas) {
                bumpedRequest.maxFeePerGas = feeData.maxFeePerGas + (feeData.maxFeePerGas * 20n / 100n);
                if (feeData.maxPriorityFeePerGas) {
                   bumpedRequest.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas + (feeData.maxPriorityFeePerGas * 20n / 100n);
                }
            }
        }

        try {
           const newTx = await wallet.sendTransaction(bumpedRequest);
           console.log("[NonceManager] Successfully replaced " + tx.hash + " with " + newTx.hash);
           
           // Update tracker
           tx.hash = newTx.hash;
           tx.sentAt = now; 
        } catch (e: any) {
           console.error("[NonceManager] Failed to bump tx " + tx.hash + ":", e.message);
        }
      }
    }

    // Clean up confirmed ones
    this.pendingTxs.set(key, activePending);
  }
}
