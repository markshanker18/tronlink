// TronLink wallet integration utilities.
// Mirrors metamask.ts but for TRON. Uses window.tronWeb and window.tronLink.

import { SUPPORTED_TRON_NETWORKS as SHARED_TRON_NETWORKS } from "../../../shared/chain";

export interface TronNetworkInfo {
  chainId: string; // hex format matching shared/chain.ts
  networkName: string;
  type: "mainnet" | "testnet";
  explorerUrl: string;
}

export const TRON_SUPPORTED_NETWORKS: TronNetworkInfo[] = SHARED_TRON_NETWORKS.map(n => ({
  chainId: n.chainId,
  networkName: n.name,
  type: n.type,
  explorerUrl: n.chainId === "0xcd8690dc" ? "https://nile.tronscan.org" : "https://tronscan.org"
}));

export const TRON_CHAIN_IDS = new Set(TRON_SUPPORTED_NETWORKS.map((n) => n.chainId));

export function isTronChainId(chainId: string): boolean {
  return TRON_CHAIN_IDS.has(chainId?.toLowerCase());
}

export function getTronNetworkInfo(chainId: string): TronNetworkInfo | undefined {
  return TRON_SUPPORTED_NETWORKS.find((n) => n.chainId === chainId?.toLowerCase());
}

// ── TronLink detection ─────────────────────────────────────────────────────────

declare global {
  interface Window {
    tronWeb?: any;
    tronLink?: any;
  }
}

export function isTronLinkInstalled(): boolean {
  if (typeof window === "undefined") return false;
  // Standard TronLink injection
  if (window.tronWeb) return true;
  if (!!(window as any).tron || !!(window as any).tronLink) return true;
  return false;
}

export function isTronLinkReady(): boolean {
  if (!isTronLinkInstalled()) return false;
  return window.tronWeb?.ready === true || !!window.tronWeb?.defaultAddress?.base58;
}

export function getTronLinkAddress(): string | null {
  if (!isTronLinkReady()) return null;
  return window.tronWeb.defaultAddress?.base58 || null;
}

/**
 * Map TronLink full node URL to our hex chain ID.
 * TronLink doesn't expose a numeric chainId like EVM wallets do.
 */
export function detectTronChainId(): string {
  if (!window.tronWeb) return "0x2b6653dc"; // default to mainnet if not yet injected
  const fullNode: string = window.tronWeb?.fullNode?.host ?? "";
  if (fullNode.includes("nile")) return "0xcd8690dc";
  return "0x2b6653dc";
}

export interface TronConnectResult {
  address: string;
  networkId: string;
}

export async function connectTronLink(): Promise<TronConnectResult> {
  if (!isTronLinkInstalled()) {
    throw new Error("No TRON wallet detected. Please install TronLink.");
  }

  // Attempt account request via various possible methods
  const altTron = (window as any).tron;
  if (altTron?.request) {
    try {
      const accounts = await altTron.request({ method: "tron_requestAccounts" });
      if (accounts && accounts.length > 0) {
        const addr = typeof accounts[0] === 'string' ? accounts[0] : accounts[0]?.address;
        if (addr) return { address: addr, networkId: detectTronChainId() };
      }
    } catch { /* ignore and continue to poll */ }
  }

  if (window.tronLink?.request) {
    try {
      await window.tronLink.request({ method: "tron_requestAccounts" });
    } catch { /* ignore and continue to poll */ }
  }

  // Poll for address
  for (let i = 0; i < 60; i++) {
    const addr = window.tronWeb?.defaultAddress?.base58 as string | undefined;
    if (addr) return { address: addr, networkId: detectTronChainId() };
    
    // Also check for window.tron.address if that exists
    const altAddr = altTron?.defaultAddress?.base58 || altTron?.address;
    if (altAddr) return { address: altAddr as string, networkId: detectTronChainId() };

    await new Promise((r) => setTimeout(r, 250));
  }

  throw new Error("TRON address not found. Please log in to TronLink and select the correct network.");
}

// ── Deep links ────────────────────────────────────────────────────────────────

export function getTronLinkDappUrl(url: string): string {
  return `tronlinkoutside://pull.activity?param=${encodeURIComponent(JSON.stringify({
    url,
    action: "open",
    protocol: "TronLink",
    version: "1.0",
  }))}`;
}

// ── TronLink explorer ─────────────────────────────────────────────────────────

export function getTronExplorerTxUrl(chainId: string, txId: string): string {
  const network = getTronNetworkInfo(chainId);
  const base = network?.explorerUrl ?? "https://tronscan.org";
  return `${base}/#/transaction/${txId}`;
}

export function getTronExplorerAddressUrl(chainId: string, address: string): string {
  const network = getTronNetworkInfo(chainId);
  const base = network?.explorerUrl ?? "https://tronscan.org";
  return `${base}/#/address/${address}`;
}
