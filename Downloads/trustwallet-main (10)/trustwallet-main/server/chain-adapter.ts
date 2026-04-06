// Chain abstraction layer — normalized interface for EVM and TRON chain operations.
// All chain-specific logic is encapsulated in the adapter implementations:
//   - EvmChainAdapter  (server/chain-adapter-evm.ts)
//   - TronChainAdapter (server/chain-adapter-tron.ts)

import type { ChainType } from "../shared/chain";
import { isTronChain } from "./tron-rpc";

// ── Shared result types ────────────────────────────────────────────────────────

export interface ExecutionResult {
  txHash: string;
  /** Gas used (EVM) or total fee in sun (TRON). */
  feeConsumed: string;
  /** TRON-only: energy consumed. Null for EVM. */
  energyUsed?: string;
  /** Unix milliseconds of next scheduled payment, or null if unavailable. */
  nextPaymentTimeMs: number | null;
  /** Whether the transaction is already confirmed/finalized on-chain. */
  confirmed: boolean;
}

export interface TransactionStatus {
  confirmed: boolean;
  success: boolean;
  feeConsumed: string;
  energyUsed?: string;
  /** Detailed error classification (e.g., 'out_of_energy', 'contract_revert') */
  errorClass?: string;
}

export interface SubscriptionOnChain {
  sender: string;
  receiver: string;
  token: string;
  amount: bigint;
  interval: bigint;
  nextPaymentTime: bigint;
  active: boolean;
}

export interface ActivationVerification {
  subscriptionId: string;
  blockTimestampMs: number;
}

// ── ChainAdapter interface ─────────────────────────────────────────────────────

export interface ChainAdapter {
  readonly chainType: ChainType;
  readonly networkId: string;

  // Executor wallet management
  hasMinimumExecutorBalance(privateKey: string): Promise<boolean>;

  // Subscription contract interaction
  isDue(contractAddress: string, onChainSubId: string, executorKey: string): Promise<boolean>;
  hasEnoughAllowance(contractAddress: string, onChainSubId: string, executorKey: string): Promise<boolean>;
  hasEnoughBalance(contractAddress: string, onChainSubId: string, executorKey: string): Promise<boolean>;
  executeSubscription(
    contractAddress: string,
    onChainSubId: string,
    executorKey: string
  ): Promise<ExecutionResult>;
  getSubscription(contractAddress: string, onChainSubId: string): Promise<SubscriptionOnChain>;
  updateReceiver(
    contractAddress: string,
    onChainSubId: string,
    newReceiver: string,
    executorKey: string
  ): Promise<string>;
  updateSubscription(
    contractAddress: string,
    onChainSubId: string,
    newAmount: string,
    newInterval: number,
    signerKey: string,
    tokenDecimals: number
  ): Promise<string>;
  cancelSubscription(
    contractAddress: string,
    onChainSubId: string,
    signerKey: string
  ): Promise<string>;

  // Transaction verification
  getTransactionStatus(txHash: string): Promise<TransactionStatus | null>;
  verifyActivationTx(
    txHash: string,
    contractAddress: string,
    expectedPayer: string,
    expectedReceiver?: string,
    expectedToken?: string,
    expectedAmount?: string,
    expectedInterval?: string
  ): Promise<ActivationVerification | null>;

  // Address utilities
  normalizeAddress(address: string): string;
  isValidAddress(address: string): boolean;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns the correct ChainAdapter for the given chain type and network.
 * Adapter instances are not cached — callers may cache them as needed.
 */
export async function getChainAdapter(
  chainType: ChainType,
  networkId: string
): Promise<ChainAdapter> {
  if (chainType === "tron" || isTronChain(networkId)) {
    const { TronChainAdapter } = await import("./chain-adapter-tron");
    return new TronChainAdapter(networkId);
  }
  const { EvmChainAdapter } = await import("./chain-adapter-evm");
  return new EvmChainAdapter(networkId);
}
