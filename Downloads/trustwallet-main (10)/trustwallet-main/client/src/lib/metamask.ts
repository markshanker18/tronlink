import { BrowserProvider, formatEther, parseEther } from "ethers";

export type ChainType = "evm" | "tron";

// Re-export from ./tronlink for convenience in wallet hook
export { detectTronChainId, isTronLinkInstalled, isTronLinkReady } from "./tronlink";

declare global {
  interface Window {
    ethereum?: any;
  }
}

export function isMobile(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const ua = navigator.userAgent;
  const isMobileUA = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isIPadOS = /Macintosh/i.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1;
  return isMobileUA || isIPadOS;
}

export function isAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent || "");
}

export function getMetaMaskDappUrl(targetUrl: string): string {
  const stripped = targetUrl.replace(/^https?:\/\//, "");
  return `https://metamask.app.link/dapp/${stripped}`;
}

export function openInMetaMaskMobile(targetUrl: string): void {
  const dappUrl = getMetaMaskDappUrl(targetUrl);
  if (typeof window !== "undefined") {
    window.location.href = dappUrl;
  }
}


export interface NetworkInfo {
  chainId: string;
  name: string;
}

export type WalletBrand = "metamask" | "tronlink" | "trustwallet" | "other";

function isMetaMaskProvider(p: any): boolean {
  return !!p?.isMetaMask;
}

export function detectWalletBrand(providerLike?: any): WalletBrand {
  const p = providerLike ?? (typeof window !== "undefined" ? (window as any).ethereum : undefined);
  if (p?.isMetaMask) return "metamask";
  if (p?.isTrust || p?.isTrustWallet) return "trustwallet";
  return (p && typeof p.request === "function") ? "other" : "metamask";
}

import { ALL_SUPPORTED_NETWORKS as SHARED_NETWORKS } from "../../../shared/chain";

export interface SupportedNetwork {
  chainId: string;
  name: string;
  symbol: string;
  type: "mainnet" | "testnet";
}

export const SUPPORTED_NETWORKS: SupportedNetwork[] = SHARED_NETWORKS.map(n => ({
  chainId: n.chainId,
  name: n.name,
  symbol: n.symbol,
  type: n.type
}));

const TRON_CHAIN_ID_SET = new Set(["0x2b6653dc", "0xcd8690dc"]);

/** Returns true if the given hex chain ID belongs to the TRON network. */
export function isTronChain(chainId: string): boolean {
  return TRON_CHAIN_ID_SET.has(chainId?.toLowerCase());
}

const CHAIN_NAMES: Record<string, string> = {};
SUPPORTED_NETWORKS.forEach((n) => { CHAIN_NAMES[n.chainId] = n.name; });

export function getChainName(chainId: string): string {
  return CHAIN_NAMES[chainId.toLowerCase()] || `Chain ${parseInt(chainId, 16)}`;
}

export function isInjectedWalletInstalled(): boolean {
  return typeof window !== "undefined" && typeof window.ethereum !== "undefined";
}

// Backward-compatible alias used across older files.
export function isMetaMaskInstalled(): boolean {
  return isInjectedWalletInstalled();
}

export interface ConnectedWallet {
  address: string;
  network: NetworkInfo;
  walletBrand: WalletBrand;
}

let pendingConnection: Promise<ConnectedWallet> | null = null;

export async function connectInjectedWallet(): Promise<ConnectedWallet> {
  if (!isInjectedWalletInstalled()) {
    throw new Error("Wallet not detected. Open this page in a Web3-compatible browser like MetaMask or TronLink.");
  }

  if (pendingConnection) {
    return pendingConnection;
  }

  pendingConnection = (async () => {
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const chainId = await window.ethereum.request({ method: "eth_chainId" });
      const walletBrand = detectWalletBrand(window.ethereum);
      return {
        address: accounts[0],
        network: {
          chainId,
          name: getChainName(chainId),
        },
        walletBrand,
      };
    } finally {
      pendingConnection = null;
    }
  })();

  return pendingConnection;
}

// Backward-compatible alias used across older files.
export async function connectMetaMask(): Promise<ConnectedWallet> {
  return connectInjectedWallet();
}

export async function getConnectedAccounts(): Promise<string[]> {
  if (!isInjectedWalletInstalled()) return [];
  try {
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    return accounts;
  } catch {
    return [];
  }
}

export async function getCurrentNetwork(): Promise<NetworkInfo | null> {
  if (!isInjectedWalletInstalled()) return null;
  try {
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    return { chainId, name: getChainName(chainId) };
  } catch {
    return null;
  }
}

export async function getBalance(address: string): Promise<string> {
  if (!isInjectedWalletInstalled()) return "0";
  try {
    const provider = new BrowserProvider(window.ethereum);
    const balance = await provider.getBalance(address);
    return formatEther(balance);
  } catch {
    return "0";
  }
}

export async function sendTransaction(to: string, valueInEther: string): Promise<string> {
  if (!isInjectedWalletInstalled()) throw new Error("Wallet not installed");

  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const value = parseEther(valueInEther);
  const tx = await signer.sendTransaction({
    to,
    value,
  });

  return tx.hash;
}

export function onAccountsChanged(callback: (accounts: string[]) => void): () => void {
  if (!isInjectedWalletInstalled()) return () => {};
  window.ethereum.on("accountsChanged", callback);
  return () => window.ethereum.removeListener("accountsChanged", callback);
}

export function onChainChanged(callback: (chainId: string) => void): () => void {
  if (!isInjectedWalletInstalled()) return () => {};
  window.ethereum.on("chainChanged", callback);
  return () => window.ethereum.removeListener("chainChanged", callback);
}
