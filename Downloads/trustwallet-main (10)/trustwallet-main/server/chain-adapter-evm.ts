// EVM implementation of ChainAdapter.
// Extracts logic previously inline in scheduler.ts and routes.ts.

import { Wallet, Contract, Interface, keccak256, toUtf8Bytes, parseUnits } from "ethers";
import type { ChainAdapter, ExecutionResult, TransactionStatus, SubscriptionOnChain, ActivationVerification } from "./chain-adapter";
import type { ChainType } from "../shared/chain";
import { getRpcUrls, makeJsonRpcProvider, isRpcConnectivityError } from "./rpc";
import { SUBSCRIPTION_CONTRACT_ABI } from "../shared/contracts";
import { AddressUtils } from "../shared/address-utils";

const MIN_EXECUTOR_BALANCE_WEI = BigInt("50000000000000"); // 0.00005 ETH
const TX_CONFIRMATIONS = Math.max(1, Number.parseInt(process.env.TX_CONFIRMATIONS || "3", 10) || 3);
const MAX_GAS_PRICE_GWEI = BigInt(process.env.MAX_GAS_PRICE_GWEI || "300"); // Default 300 Gwei safety cap

const TRANSFER_TOPIC = keccak256(toUtf8Bytes("Transfer(address,address,uint256)"));
const subscriptionIface = new Interface(SUBSCRIPTION_CONTRACT_ABI as unknown as any[]);

/**
 * Tries each RPC URL in sequence until the callback succeeds.
 * Throws the last error if all URLs fail.
 */
async function tryWithFallback<T>(
  rpcUrls: string[],
  networkId: string,
  fn: (provider: ReturnType<typeof makeJsonRpcProvider>) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (const url of rpcUrls) {
    try {
      const provider = makeJsonRpcProvider(url, networkId);
      return await fn(provider);
    } catch (err) {
      lastError = err;
      if (!isRpcConnectivityError(err)) throw err; // non-connectivity errors should not be retried
    }
  }
  throw lastError;
}

export class EvmChainAdapter implements ChainAdapter {
  readonly chainType: ChainType = "evm";
  readonly networkId: string;

  constructor(networkId: string) {
    this.networkId = networkId;
  }

  isValidAddress(address: string): boolean {
    return AddressUtils.isValid(address, "evm");
  }

  normalizeAddress(address: string): string {
    return AddressUtils.normalize(address, "evm");
  }

  async hasMinimumExecutorBalance(privateKey: string): Promise<boolean> {
    const rpcUrls = getRpcUrls(this.networkId);
    if (rpcUrls.length === 0) return false;
    return tryWithFallback(rpcUrls, this.networkId, async (provider) => {
      const wallet = new Wallet(privateKey, provider);
      const balance = await provider.getBalance(wallet.address);
      return balance >= MIN_EXECUTOR_BALANCE_WEI;
    });
  }

  async isDue(contractAddress: string, onChainSubId: string, executorKey: string): Promise<boolean> {
    const rpcUrls = getRpcUrls(this.networkId);
    if (rpcUrls.length === 0) return false;
    return tryWithFallback(rpcUrls, this.networkId, async (provider) => {
      const wallet = new Wallet(executorKey, provider);
      const contract = new Contract(contractAddress, SUBSCRIPTION_CONTRACT_ABI as unknown as any[], wallet);
      return contract.isDue(BigInt(onChainSubId));
    });
  }

  async hasEnoughAllowance(contractAddress: string, onChainSubId: string, executorKey: string): Promise<boolean> {
    const rpcUrls = getRpcUrls(this.networkId);
    if (rpcUrls.length === 0) return false;
    return tryWithFallback(rpcUrls, this.networkId, async (provider) => {
      const wallet = new Wallet(executorKey, provider);
      const contract = new Contract(contractAddress, SUBSCRIPTION_CONTRACT_ABI as unknown as any[], wallet);
      return contract.hasEnoughAllowance(BigInt(onChainSubId));
    });
  }

  async hasEnoughBalance(contractAddress: string, onChainSubId: string, executorKey: string): Promise<boolean> {
    const sub = await this.getSubscription(contractAddress, onChainSubId);
    if (!sub || !sub.token || !sub.sender || !sub.amount) return false;

    const rpcUrls = getRpcUrls(this.networkId);
    if (rpcUrls.length === 0) return false;
    return tryWithFallback(rpcUrls, this.networkId, async (provider) => {
      // Check if it's a native token (should be blocked by now, but safety first)
      if (sub.token!.toLowerCase() === "0x0000000000000000000000000000000000000000" ||
          sub.token!.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
        const bal = await provider.getBalance(sub.sender!);
        return bal >= sub.amount!;
      }
      const tokenContract = new Contract(sub.token!, [
        "function balanceOf(address account) view returns (uint256)"
      ], provider);
      const bal = await tokenContract.balanceOf(sub.sender!);
      return bal >= sub.amount!;
    });
  }

  async getSubscription(contractAddress: string, onChainSubId: string): Promise<SubscriptionOnChain> {
    const rpcUrls = getRpcUrls(this.networkId);
    if (rpcUrls.length === 0) throw new Error(`No RPC URL for chain ${this.networkId}`);
    return tryWithFallback(rpcUrls, this.networkId, async (provider) => {
      const contract = new Contract(contractAddress, SUBSCRIPTION_CONTRACT_ABI as unknown as any[], provider);
      const sub = await contract.getSubscription(BigInt(onChainSubId));
      return {
        sender: sub.sender ?? sub[0],
        receiver: sub.receiver ?? sub[1],
        token: sub.token ?? sub[2],
        amount: sub.amount ?? sub[3],
        interval: sub.interval ?? sub[4],
        nextPaymentTime: sub.nextPaymentTime ?? sub[5],
        active: sub.active ?? sub[6],
      };
    });
  }

  async executeSubscription(
    contractAddress: string,
    onChainSubId: string,
    executorKey: string,
    attempt = 1
  ): Promise<ExecutionResult> {
    const rpcUrls = getRpcUrls(this.networkId);
    if (rpcUrls.length === 0) throw new Error(`No RPC URL for chain ${this.networkId}`);

    const rpcUrl = rpcUrls[(attempt - 1) % rpcUrls.length];
    const provider = makeJsonRpcProvider(rpcUrl, this.networkId);
    const wallet = new Wallet(executorKey, provider);
    const contract = new Contract(contractAddress, SUBSCRIPTION_CONTRACT_ABI as unknown as any[], wallet);

    // Gas Price Protection
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
    if (gasPrice && gasPrice > parseUnits(MAX_GAS_PRICE_GWEI.toString(), "gwei")) {
       throw new Error(`Current gas price (${gasPrice.toString()}) exceeds the safety cap of ${MAX_GAS_PRICE_GWEI} Gwei. Execution deferred.`);
    }

    const gasEstimate = await contract.executeSubscription.estimateGas(BigInt(onChainSubId)).catch(() => BigInt(200000));
    const gasLimit = gasEstimate * BigInt(130) / BigInt(100); // 30% buffer for state changes

    const txOptions: any = { gasLimit };
    if (feeData.maxFeePerGas) {
      txOptions.maxFeePerGas = feeData.maxFeePerGas;
      txOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
    } else if (feeData.gasPrice) {
      txOptions.gasPrice = feeData.gasPrice;
    }

    try {
      const tx = await contract.executeSubscription(BigInt(onChainSubId), txOptions);
      return { txHash: tx.hash, feeConsumed: "pending_indexer", nextPaymentTimeMs: null, confirmed: false };
    } catch (err: any) {
       const msg = err.message.toLowerCase();
       if (msg.includes("nonce too low") || msg.includes("replacement transaction underpriced")) {
          // Add random jitter to nonce or wait for indexer to catch up
          console.warn(`[EVM] Nonce/Price conflict on ${this.networkId}: ${err.message}`);
       }
       throw err;
    }
  }

  async updateReceiver(
    contractAddress: string,
    onChainSubId: string,
    newReceiver: string,
    executorKey: string
  ): Promise<string> {
    const rpcUrls = getRpcUrls(this.networkId);
    if (rpcUrls.length === 0) throw new Error(`No RPC URL for chain ${this.networkId}`);
    return tryWithFallback(rpcUrls, this.networkId, async (provider) => {
      const wallet = new Wallet(executorKey, provider);
      const contract = new Contract(contractAddress, SUBSCRIPTION_CONTRACT_ABI as unknown as any[], wallet);
      const tx = await contract.updateReceiver(BigInt(onChainSubId), newReceiver);
      const receipt = await tx.wait(1);
      return receipt.hash;
    });
  }

  async updateSubscription(
    contractAddress: string,
    onChainSubId: string,
    newAmount: string,
    newInterval: number,
    signerKey: string,
    tokenDecimals: number
  ): Promise<string> {
    const rpcUrls = getRpcUrls(this.networkId);
    if (rpcUrls.length === 0) throw new Error(`No RPC URL for chain ${this.networkId}`);
    return tryWithFallback(rpcUrls, this.networkId, async (provider) => {
      const wallet = new Wallet(signerKey, provider);
      const contract = new Contract(contractAddress, SUBSCRIPTION_CONTRACT_ABI as unknown as any[], wallet);
      const amountRaw = parseUnits(newAmount, tokenDecimals);
      const tx = await contract.updateSubscription(BigInt(onChainSubId), amountRaw, BigInt(newInterval));
      const receipt = await tx.wait(1);
      return receipt.hash;
    });
  }

  async cancelSubscription(
    contractAddress: string,
    onChainSubId: string,
    signerKey: string
  ): Promise<string> {
    const rpcUrls = getRpcUrls(this.networkId);
    if (rpcUrls.length === 0) throw new Error(`No RPC URL for chain ${this.networkId}`);
    return tryWithFallback(rpcUrls, this.networkId, async (provider) => {
      const wallet = new Wallet(signerKey, provider);
      const contract = new Contract(contractAddress, SUBSCRIPTION_CONTRACT_ABI as unknown as any[], wallet);
      const tx = await contract.cancelSubscription(BigInt(onChainSubId));
      const receipt = await tx.wait(1);
      return receipt.hash;
    });
  }

  async getTransactionStatus(txHash: string): Promise<TransactionStatus | null> {
    const rpcUrls = getRpcUrls(this.networkId);
    if (rpcUrls.length === 0) return null;
    return tryWithFallback(rpcUrls, this.networkId, async (provider) => {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) return null;
      return {
        confirmed: true,
        success: receipt.status === 1,
        feeConsumed: receipt.gasUsed.toString(),
      };
    });
  }

  async verifyActivationTx(
    txHash: string,
    contractAddress: string,
    expectedPayer: string,
    expectedReceiver?: string,
    expectedToken?: string,
    expectedAmount?: string,
    expectedInterval?: string
  ): Promise<ActivationVerification | null> {
    const rpcUrls = getRpcUrls(this.networkId);
    if (rpcUrls.length === 0) return null;

    const provider = await tryWithFallback(rpcUrls, this.networkId, async (p) => {
      // Probe the provider by fetching the receipt; if it throws a connectivity
      // error, tryWithFallback will move to the next URL.
      await p.getTransactionReceipt(txHash);
      return p;
    }).catch(() => makeJsonRpcProvider(rpcUrls[0], this.networkId));

    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) return null;

    // Find SubscriptionCreated event
    let subscriptionId: string | null = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
      try {
        const parsed = subscriptionIface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "SubscriptionCreated") {
          const sender = String(parsed.args[1] ?? "");
          const receiver = String(parsed.args[2] ?? "");
          const token = String(parsed.args[3] ?? "");
          const amount = parsed.args[4].toString();
          const interval = parsed.args[5].toString();

          if (!AddressUtils.isEqual(sender, expectedPayer, "evm")) continue;
          if (expectedReceiver && !AddressUtils.isEqual(receiver, expectedReceiver, "evm")) continue;
          if (expectedToken && !AddressUtils.isEqual(token, expectedToken, "evm")) continue;
          if (expectedAmount && amount !== expectedAmount) continue;
          if (expectedInterval && interval !== expectedInterval) continue;

          subscriptionId = parsed.args[0].toString();
          break;
        }
      } catch {
        // skip unparseable logs
      }
    }

    if (!subscriptionId) return null;

    const block = await provider.getBlock(receipt.blockNumber);
    const blockTimestampMs = (block?.timestamp ?? 0) * 1000;

    return { subscriptionId, blockTimestampMs };
  }
}
