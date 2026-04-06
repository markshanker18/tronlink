// TRON implementation of ChainAdapter.
// Uses TronWeb for all chain interactions.
// Key differences from EVM:
//   - Addresses are Base58Check T-prefix (case-sensitive)
//   - No gas — uses energy + bandwidth (feeLimit in sun)
//   - Transaction confirmation via TronGrid polling (~57s solidification)
//   - No ERC-2612 permit support

import type { ChainAdapter, ExecutionResult, TransactionStatus, SubscriptionOnChain, ActivationVerification } from "./chain-adapter";
import type { ChainType } from "../shared/chain";
import { makeTronWebInstance, getTronTransaction, getTronTransactionInfo, getTronGridUrl, isTronChain } from "./tron-rpc";
import { TronEnergyManager } from "./services/tron-energy";
import { TRON_SUBSCRIPTION_CONTRACT_ABI, getTronNetworkInfo, TRON_NULL_TOKEN_ADDRESSES } from "../shared/tron-contracts";
import { AddressUtils } from "../shared/address-utils";
import { parseUnits } from "ethers";

const MIN_EXECUTOR_BALANCE_TRX_SUN = BigInt("20000000"); // 20 TRX minimum
const TRON_FEE_LIMIT_SUN = Number(process.env.TRON_FEE_LIMIT_SUN || "100000000"); // 100 TRX (boosted for reliability)
const TRON_CONFIRMATION_POLLS = Number(process.env.TRON_CONFIRMATION_POLLS || "20");
const TRON_POLL_INTERVAL_MS = 3000; // 3 seconds between polls (~3s block time on TRON)
const TRON_VERIFY_ACTIVATION_ATTEMPTS = Number(process.env.TRON_VERIFY_ACTIVATION_ATTEMPTS || "8");
const TRON_VERIFY_ACTIVATION_RETRY_MS = Number(process.env.TRON_VERIFY_ACTIVATION_RETRY_MS || "3000");

export class TronChainAdapter implements ChainAdapter {
  readonly chainType: ChainType = "tron";
  readonly networkId: string;

  constructor(networkId: string) {
    this.networkId = networkId;
  }

  isValidAddress(address: string): boolean {
    return AddressUtils.isValid(address, "tron");
  }

  normalizeAddress(address: string): string {
    return AddressUtils.normalize(address, "tron");
  }

  async hasMinimumExecutorBalance(privateKey: string): Promise<boolean> {
    const tronWeb = await makeTronWebInstance(this.networkId, privateKey);
    const address = tronWeb.defaultAddress.base58;
    const balance = await tronWeb.trx.getBalance(address);
    return BigInt(balance) >= MIN_EXECUTOR_BALANCE_TRX_SUN;
  }

  private async getContract(contractAddress: string, privateKey?: string): Promise<any> {
    // Pass contractAddress as the dummy caller for view-only instances (no private key).
    // TronGrid requires owner_address for triggerConstantContract — any valid address works.
    const tronWeb = await makeTronWebInstance(this.networkId, privateKey, contractAddress);
    return tronWeb.contract(TRON_SUBSCRIPTION_CONTRACT_ABI, contractAddress);
  }

  async isDue(contractAddress: string, onChainSubId: string, _executorKey: string): Promise<boolean> {
    const contract = await this.getContract(contractAddress);
    return contract.isDue(BigInt(onChainSubId)).call();
  }

  async hasEnoughBalance(contractAddress: string, onChainSubId: string, _executorKey: string): Promise<boolean> {
    const sub = await this.getSubscription(contractAddress, onChainSubId);
    if (!sub || !sub.token || !sub.sender || !sub.amount) return false;
    const tronWeb = await makeTronWebInstance(this.networkId, _executorKey);

    if (TRON_NULL_TOKEN_ADDRESSES.has(sub.token)) return false;

    try {
      const { constant_result } = await tronWeb.transactionBuilder.triggerConstantContract(
        sub.token,
        "balanceOf(address)",
        {},
        [{ type: 'address', value: sub.sender }],
        tronWeb.defaultAddress.base58
      );
      if (!constant_result || constant_result.length === 0) return false;
      const bal = BigInt("0x" + constant_result[0]);
      return bal >= sub.amount;
    } catch { return false; }
  }

  async hasEnoughAllowance(contractAddress: string, onChainSubId: string, _executorKey: string): Promise<boolean> {
    const contract = await this.getContract(contractAddress);
    return contract.hasEnoughAllowance(BigInt(onChainSubId)).call();
  }

  async getSubscription(contractAddress: string, onChainSubId: string): Promise<SubscriptionOnChain> {
    const tronWeb = await makeTronWebInstance(this.networkId, undefined, contractAddress);
    const contract = await this.getContract(contractAddress);
    const sub = await contract.getSubscription(BigInt(onChainSubId)).call();
    
    // Normalize hex addresses to Base58 check (T-prefix) for consistent comparison
    const normalize = (val: any) => {
       const addr = val?.toString() || "";
       if (addr.startsWith("41") || addr.startsWith("0x")) {
         return tronWeb.address.fromHex(addr);
       }
       return addr;
    };

    return {
      sender: normalize(sub.sender ?? sub[0]),
      receiver: normalize(sub.receiver ?? sub[1]),
      token: normalize(sub.token ?? sub[2]),
      amount: BigInt(sub.amount ?? sub[3]),
      interval: BigInt(sub.interval ?? sub[4]),
      nextPaymentTime: BigInt(sub.nextPaymentTime ?? sub[5]),
      active: sub.active ?? sub[6],
    };
  }

  async executeSubscription(
    contractAddress: string,
    onChainSubId: string,
    executorKey: string
  ): Promise<ExecutionResult> {
    const tronWeb = await makeTronWebInstance(this.networkId, executorKey);

    // ENERGY CHECK INTERCEPT 
    const isSafe = await TronEnergyManager.checkAndRentEnergy(tronWeb, tronWeb.defaultAddress.base58);
    if (!isSafe) {
      // Deferred due to energy renting buffer. Idempotency worker will pick this up next cycle.
      return { txHash: "renting_energy", feeConsumed: "0", energyUsed: "0", nextPaymentTimeMs: null, confirmed: false };
    }

    const contract = tronWeb.contract(TRON_SUBSCRIPTION_CONTRACT_ABI, contractAddress);

    const txId: string = await contract.executeSubscription(BigInt(onChainSubId)).send({
      feeLimit: TRON_FEE_LIMIT_SUN,
      callValue: 0,
    });

    // DECOUPLED: We no longer await this.pollForConfirmation(txId)
    // The Event-Based Indexer will map TRON triggers and securely finalize via webhook.
    return { txHash: txId, feeConsumed: "pending_indexer", energyUsed: "0", nextPaymentTimeMs: null, confirmed: false };
  }

  async updateReceiver(
    contractAddress: string,
    onChainSubId: string,
    newReceiver: string,
    executorKey: string
  ): Promise<string> {
    const tronWeb = await makeTronWebInstance(this.networkId, executorKey);

    // Set the default address to the signer address so transactions have a clear 'from' account.
    if (executorKey) {
      const address = tronWeb.address.fromPrivateKey(executorKey.startsWith("0x") ? executorKey.slice(2) : executorKey);
      tronWeb.setAddress(address);
    }

    const contract = tronWeb.contract(TRON_SUBSCRIPTION_CONTRACT_ABI, contractAddress);
    
    try {
      console.info(`[tron-adapter] updateReceiver id=${onChainSubId} newReceiver=${newReceiver}`);
      const txId: string = await contract.updateReceiver(BigInt(onChainSubId), newReceiver).send({
        feeLimit: TRON_FEE_LIMIT_SUN,
      });
      await this.pollForConfirmation(txId);
      return txId;
    } catch (err: any) {
      console.error(`[tron-adapter] updateReceiver failed: ${err.message || err}`);
      throw err;
    }
  }

  async updateSubscription(
    contractAddress: string,
    onChainSubId: string,
    newAmount: string,
    newInterval: number,
    signerKey: string,
    tokenDecimals: number
  ): Promise<string> {
    const tronWeb = await makeTronWebInstance(this.networkId, signerKey);

    const cleanKey = signerKey.startsWith("0x") ? signerKey.slice(2) : signerKey;
    const signerAddress = tronWeb.address.fromPrivateKey(cleanKey);
    tronWeb.setAddress(signerAddress);

    const contract = tronWeb.contract(TRON_SUBSCRIPTION_CONTRACT_ABI, contractAddress);
    const amountRaw = parseUnits(newAmount, tokenDecimals);

    // Read on-chain state for diagnostic logging before attempting the call
    try {
      const onChainSub = await contract.getSubscription(BigInt(onChainSubId)).call();
      const subActive = onChainSub.active ?? onChainSub[6];
      const subSender = onChainSub.sender ?? onChainSub[0];
      const subReceiver = onChainSub.receiver ?? onChainSub[1];
      const subOwner = await contract.owner().call().catch(() => "unknown");
      console.info(
        `[tron-adapter] updateSubscription pre-flight:` +
        ` id=${onChainSubId} active=${subActive}` +
        ` sender=${subSender} receiver=${subReceiver} owner=${subOwner}` +
        ` signerAddress=${signerAddress}` +
        ` amountRaw=${amountRaw.toString()} interval=${newInterval}`
      );
      if (!subActive) throw new Error(`updateSubscription reverted: Subscription not active (id=${onChainSubId})`);
    } catch (err: any) {
      if (err.message?.includes("not active")) throw err;
      console.warn(`[tron-adapter] updateSubscription pre-flight read failed (non-fatal): ${err.message}`);
    }

    try {
      const txId: string = await contract.updateSubscription(
        BigInt(onChainSubId),
        amountRaw,
        BigInt(newInterval)
      ).send({
        feeLimit: TRON_FEE_LIMIT_SUN,
      });
      await this.pollForConfirmation(txId);
      return txId;
    } catch (err: any) {
      console.error(`[tron-adapter] updateSubscription failed: ${err.message || err}`);
      throw err;
    }
  }

  async cancelSubscription(
    contractAddress: string,
    onChainSubId: string,
    signerKey: string
  ): Promise<string> {
    const tronWeb = await makeTronWebInstance(this.networkId, signerKey);
    
    if (signerKey) {
      const address = tronWeb.address.fromPrivateKey(signerKey.startsWith("0x") ? signerKey.slice(2) : signerKey);
      tronWeb.setAddress(address);
    }

    const contract = tronWeb.contract(TRON_SUBSCRIPTION_CONTRACT_ABI, contractAddress);
    
    try {
      console.info(`[tron-adapter] cancelSubscription id=${onChainSubId}`);
      const txId: string = await contract.cancelSubscription(BigInt(onChainSubId)).send({
        feeLimit: TRON_FEE_LIMIT_SUN,
      });
      await this.pollForConfirmation(txId);
      return txId;
    } catch (err: any) {
      console.error(`[tron-adapter] cancelSubscription failed: ${err.message || err}`);
      throw err;
    }
  }

  async getTransactionStatus(txHash: string): Promise<TransactionStatus | null> {
    const txInfo = await getTronTransactionInfo(this.networkId, txHash);
    if (!txInfo) return null;

    const tx = await getTronTransaction(this.networkId, txHash);
    if (!tx) return null;

    const confirmed = tx.confirmed === true || Boolean(txInfo.blockNumber);
    const contractRet = tx.ret?.[0]?.contractRet;
    const success = contractRet === "SUCCESS";
    
    // Detailed error classification
    let errorClass: string | undefined;
    if (!success) {
      if (contractRet === "OUT_OF_ENERGY") errorClass = "out_of_energy";
      else if (contractRet === "OUT_OF_BANDWIDTH") errorClass = "out_of_bandwidth";
      else if (contractRet === "REVERT") errorClass = "contract_revert";
      else errorClass = contractRet?.toLowerCase();
    }

    const energyUsed = String(txInfo.receipt?.energy_usage_total ?? 0);
    const feeConsumed = String((txInfo.fee ?? 0) + (txInfo.receipt?.energy_fee ?? 0));

    return { confirmed, success, feeConsumed, energyUsed, errorClass };
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
    console.log(`[TRON verifyActivationTx] Verifying tx ${txHash} for ${expectedPayer}`);

    const tronWeb = await makeTronWebInstance(this.networkId);

    const toEvmHex = (addr: string): string => {
      if (!addr) return "";
      const a = addr.trim();
      if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) {
        try {
          const tronHex: string = tronWeb.address.toHex(a);
          return "0x" + tronHex.slice(2).toLowerCase();
        } catch {
          return a.toLowerCase();
        }
      }
      const lower = a.toLowerCase();
      if (lower.startsWith("41") && lower.length === 42) return "0x" + lower.slice(2);
      if (lower.startsWith("0x")) return lower;
      if (lower.length === 40) return "0x" + lower;
      return lower;
    };

    const targetContractHex = toEvmHex(contractAddress);
    const expectedPayerHex = toEvmHex(expectedPayer);

    for (let attempt = 1; attempt <= TRON_VERIFY_ACTIVATION_ATTEMPTS; attempt++) {
      try {
        const txInfo = await getTronTransactionInfo(this.networkId, txHash);
        const tx = await getTronTransaction(this.networkId, txHash);

        if (!txInfo || !tx || tx.ret?.[0]?.contractRet !== "SUCCESS") {
          if (attempt < TRON_VERIFY_ACTIVATION_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, TRON_VERIFY_ACTIVATION_RETRY_MS));
          }
          continue;
        }

        const logs = txInfo.log || [];
        for (const log of logs) {
          const logAddress = toEvmHex(log.address);
          if (logAddress !== targetContractHex) continue;

          try {
            const subId = this.parseSubscriptionCreatedLog(
              log,
              expectedPayerHex,
              expectedReceiver ? toEvmHex(expectedReceiver) : undefined,
              expectedToken ? toEvmHex(expectedToken) : undefined,
              expectedAmount,
              expectedInterval
            );

            if (subId !== null) {
              return {
                subscriptionId: subId,
                blockTimestampMs: txInfo.blockTimeStamp || Date.now()
              };
            }
          } catch { }
        }

        if (attempt < TRON_VERIFY_ACTIVATION_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, TRON_VERIFY_ACTIVATION_RETRY_MS));
        }
      } catch {
        if (attempt < TRON_VERIFY_ACTIVATION_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, TRON_VERIFY_ACTIVATION_RETRY_MS));
        }
      }
    }
    return null;
  }

  private async pollForConfirmation(txId: string): Promise<any | null> {
    for (let i = 0; i < TRON_CONFIRMATION_POLLS; i++) {
      await new Promise((r) => setTimeout(r, TRON_POLL_INTERVAL_MS));
      const txInfo = await getTronTransactionInfo(this.networkId, txId);
      const tx = await getTronTransaction(this.networkId, txId);
      if (tx?.ret?.[0]?.contractRet === "SUCCESS" && txInfo?.id) {
        return txInfo;
      }
      if (tx?.ret?.[0]?.contractRet && tx.ret[0].contractRet !== "SUCCESS") {
        throw new Error(`TRON transaction failed: ${tx.ret[0].contractRet}`);
      }
    }
    return null;
  }

  private parseSubscriptionCreatedLog(
    log: any, 
    expectedPayerHex: string,
    expectedReceiverHex?: string,
    expectedTokenHex?: string,
    expectedAmount?: string,
    expectedInterval?: string
  ): string | null {
    const topics: string[] = log.topics ?? [];
    const SUB_CREATED_HASH = "818ee5f93d6e5cd1e7c2a990db4ebb6cec0d4fb9f9a3b44720eb1ee90a10ad54";
    
    if (topics.length < 4) return null;
    const eventHash = topics[0].replace(/^0x/, "");
    if (eventHash.toLowerCase() !== SUB_CREATED_HASH.toLowerCase()) return null;

    const senderHex = "0x" + topics[2].slice(-40).toLowerCase();
    if (senderHex !== expectedPayerHex) return null;

    const receiverHex = "0x" + topics[3].slice(-40).toLowerCase();
    if (expectedReceiverHex && receiverHex !== expectedReceiverHex) return null;

    let data = log.data || "";
    if (data.startsWith("0x")) data = data.slice(2);
    if (data.length < 192) return null;

    const tokenHex = "0x" + data.slice(24, 64).toLowerCase();
    const amount = BigInt("0x" + data.slice(64, 128)).toString();
    const interval = BigInt("0x" + data.slice(128, 192)).toString();

    if (expectedTokenHex && tokenHex !== expectedTokenHex) return null;
    if (expectedAmount && amount !== expectedAmount) return null;
    if (expectedInterval && interval !== expectedInterval) return null;

    return BigInt("0x" + topics[1].replace(/^0x/, "")).toString();
  }
}
