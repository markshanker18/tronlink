// Wallet abstraction layer — normalises EVM (EIP-1193) and TronLink into a common interface.
// Used by pay-tron.tsx and other chain-agnostic components.

import type { ChainType } from "../../../shared/chain";
import { isTronLinkInstalled, isTronLinkReady, connectTronLink, detectTronChainId } from "./tronlink";
import { isInjectedWalletInstalled } from "./metamask";

// ── Signing contexts returned to callers ──────────────────────────────────────

export interface EvmSigningContext {
  type: "evm";
  /** Raw EIP-1193 provider (window.ethereum) */
  provider: any;
}

export interface TronSigningContext {
  type: "tron";
  /** window.tronWeb instance — use to build Contract objects and sign */
  tronWeb: any;
}

export type SigningContext = EvmSigningContext | TronSigningContext;

// ── WalletAdapter interface ────────────────────────────────────────────────────

export interface WalletAdapterConnectResult {
  address: string;
  networkId: string;
  chainType: ChainType;
}

export interface WalletAdapter {
  readonly chainType: ChainType;
  isAvailable(): boolean;
  connect(): Promise<WalletAdapterConnectResult>;
  getCurrentNetworkId(): string;
  /** For TRON: shows an instruction error (cannot switch programmatically). */
  ensureNetwork(networkId: string, networkName?: string): Promise<void>;
  getSigningContext(): SigningContext;
}

// ── EVM adapter ───────────────────────────────────────────────────────────────

export class EvmWalletAdapter implements WalletAdapter {
  readonly chainType: ChainType = "evm";

  isAvailable(): boolean {
    return isInjectedWalletInstalled();
  }

  async connect(): Promise<WalletAdapterConnectResult> {
    if (!this.isAvailable()) {
      throw new Error(
        "No EVM wallet detected. Open this page in MetaMask or install an injected wallet extension.",
      );
    }
    const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
    const address = accounts?.[0];
    if (!address) throw new Error("No EVM account returned from wallet");
    const networkId = (await window.ethereum.request({ method: "eth_chainId" })) as string;
    return { address, networkId, chainType: "evm" };
  }

  getCurrentNetworkId(): string {
    // Synchronous best-effort; context must have called connect() first
    return (window.ethereum as any)?._state?.chainId ?? "";
  }

  async ensureNetwork(targetChainId: string, networkName?: string): Promise<void> {
    const current = (await window.ethereum.request({ method: "eth_chainId" })) as string;
    if (current?.toLowerCase() === targetChainId.toLowerCase()) return;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetChainId }],
      });
    } catch {
      const name = networkName || `chain ${Number.parseInt(targetChainId, 16)}`;
      throw new Error(`Please switch your wallet to ${name} (${targetChainId}) and try again.`);
    }
  }

  getSigningContext(): EvmSigningContext {
    if (!this.isAvailable()) throw new Error("EVM wallet not connected");
    return { type: "evm", provider: window.ethereum };
  }
}

// ── TRON adapter ──────────────────────────────────────────────────────────────

export class TronWalletAdapter implements WalletAdapter {
  readonly chainType: ChainType = "tron";

  isAvailable(): boolean {
    return isTronLinkInstalled();
  }

  async connect(): Promise<WalletAdapterConnectResult> {
    const result = await connectTronLink();
    return { address: result.address, networkId: result.networkId, chainType: "tron" };
  }

  getCurrentNetworkId(): string {
    return detectTronChainId();
  }

  async ensureNetwork(targetNetworkId: string, networkName?: string): Promise<void> {
    const current = this.getCurrentNetworkId();
    if (current === targetNetworkId) return;
    const name = networkName || targetNetworkId;
    throw new Error(
      `Please switch to ${name} in TronLink and reconnect. TronLink does not support programmatic network switching.`,
    );
  }

  getSigningContext(): TronSigningContext {
    if (!isTronLinkReady()) throw new Error("TronLink is not ready. Please unlock your wallet.");
    return { type: "tron", tronWeb: window.tronWeb };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns the best available adapter for the given chain type.
 * If chainType is omitted, tries TRON first (if TronLink is present), then EVM.
 */
export function getWalletAdapter(chainType?: ChainType): WalletAdapter {
  if (chainType === "tron") return new TronWalletAdapter();
  if (chainType === "evm") return new EvmWalletAdapter();

  // Auto-detect: prefer TronLink when present
  if (isTronLinkInstalled()) return new TronWalletAdapter();
  return new EvmWalletAdapter();
}
