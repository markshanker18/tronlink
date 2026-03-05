import { BrowserProvider, formatEther, parseEther } from "ethers";

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

export function getTrustWalletDappUrl(targetUrl: string, isTron = false): string {
  const encoded = encodeURIComponent(targetUrl);
  const coinId = isTron ? 195 : 60;
  return `https://link.trustwallet.com/open_url?coin_id=${coinId}&url=${encoded}`;
}

export function getTrustWalletNativeUrl(targetUrl: string, isTron = false): string {
  const encoded = encodeURIComponent(targetUrl);
  const coinId = isTron ? 195 : 60;
  return `trust://open_url?coin_id=${coinId}&url=${encoded}`;
}

export function getTrustWalletAndroidIntentUrl(targetUrl: string, isTron = false): string {
  const encoded = encodeURIComponent(targetUrl);
  const coinId = isTron ? 195 : 60;
  return `intent://open_url?coin_id=${coinId}&url=${encoded}#Intent;scheme=trust;package=com.wallet.crypto.trustapp;end`;
}

export function openInTronLinkMobile(url?: string): void {
  if (typeof window === "undefined") return;
  const targetUrl = url || window.location.href;
  // TronLink deep link scheme
  window.location.href = `tronlinksite://explore/dapp?url=${encodeURIComponent(targetUrl)}`;
}

export function openInMetaMaskMobile(url?: string): void {
  if (typeof window === "undefined") return;
  const targetUrl = url || window.location.href;
  window.location.href = getMetaMaskDappUrl(targetUrl);
}

export function openInTrustWalletMobile(url?: string, isTron = false): void {
  if (typeof window === "undefined") return;
  const targetUrl = url || window.location.href;
  const universalUrl = getTrustWalletDappUrl(targetUrl, isTron);

  if (!isMobile()) {
    window.location.href = universalUrl;
    return;
  }

  if (!isAndroid()) {
    window.location.href = universalUrl;
    return;
  }

  // Android-specific fallback chain:
  // 1) trust:// deep link
  // 2) intent:// package hint
  // 3) universal https fallback
  const toIntent = window.setTimeout(() => {
    if (document.visibilityState === "visible") {
      window.location.href = getTrustWalletAndroidIntentUrl(targetUrl, isTron);
    }
  }, 650);

  const toUniversal = window.setTimeout(() => {
    if (document.visibilityState === "visible") {
      window.location.href = universalUrl;
    }
  }, 1400);

  const clearFallbacks = () => {
    window.clearTimeout(toIntent);
    window.clearTimeout(toUniversal);
  };

  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") {
        clearFallbacks();
      }
    },
    { once: true }
  );

  window.location.href = getTrustWalletNativeUrl(targetUrl, isTron);
}

export interface NetworkInfo {
  chainId: string;
  name: string;
}

export type WalletBrand = "metamask" | "trust" | "generic";

function getAllInjectedProviders(providerLike: any): any[] {
  if (!providerLike) return [];
  if (Array.isArray(providerLike.providers) && providerLike.providers.length > 0) {
    return providerLike.providers;
  }
  return [providerLike];
}

function isTrustProvider(p: any): boolean {
  return !!(
    p?.isTrust ||
    p?.isTrustWallet ||
    p?.isTrustBrowser ||
    p?.isTrustWeb3Wallet
  );
}

function isMetaMaskProvider(p: any): boolean {
  // Some wallets set isMetaMask for compatibility. Exclude known Trust markers first.
  if (isTrustProvider(p)) return false;
  return !!p?.isMetaMask;
}

export function detectWalletBrand(providerLike?: any): WalletBrand {
  const providers = getAllInjectedProviders(
    providerLike ?? (typeof window !== "undefined" ? (window as any).ethereum : undefined),
  );

  if (providers.some(isTrustProvider)) return "trust";
  if (providers.some(isMetaMaskProvider)) return "metamask";
  return providers.length > 0 ? "generic" : "generic";
}

export interface SupportedNetwork {
  chainId: string;
  name: string;
  symbol: string;
  type: "mainnet" | "testnet";
}

export const SUPPORTED_NETWORKS: SupportedNetwork[] = [
  { chainId: "0x1", name: "Ethereum Mainnet", symbol: "ETH", type: "mainnet" },
  { chainId: "0x89", name: "Polygon Mainnet", symbol: "MATIC", type: "mainnet" },
  { chainId: "0x38", name: "BSC Mainnet", symbol: "BNB", type: "mainnet" },
  { chainId: "0xa86a", name: "Avalanche C-Chain", symbol: "AVAX", type: "mainnet" },
  { chainId: "0xa4b1", name: "Arbitrum One", symbol: "ETH", type: "mainnet" },
  { chainId: "0xa", name: "Optimism", symbol: "ETH", type: "mainnet" },
  { chainId: "0x2105", name: "Base", symbol: "ETH", type: "mainnet" },
  { chainId: "0xfa", name: "Fantom Opera", symbol: "FTM", type: "mainnet" },
  { chainId: "tron_mainnet", name: "TRON Mainnet", symbol: "TRX", type: "mainnet" },
  { chainId: "0xaa36a7", name: "Sepolia Testnet", symbol: "ETH", type: "testnet" },
  { chainId: "0x5", name: "Goerli Testnet", symbol: "ETH", type: "testnet" },
  { chainId: "tron_shasta", name: "TRON Shasta Testnet", symbol: "TRX", type: "testnet" },
];

const CHAIN_NAMES: Record<string, string> = {};
SUPPORTED_NETWORKS.forEach((n) => { CHAIN_NAMES[n.chainId] = n.name; });

export function getChainName(chainId: string): string {
  return CHAIN_NAMES[chainId.toLowerCase()] || CHAIN_NAMES[chainId] || `Chain ${parseInt(chainId, 16) || chainId}`;
}

export function isTronChainId(chainId: string | null | undefined): boolean {
  return !!chainId && chainId.startsWith("tron_");
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
    throw new Error("Wallet not detected. Open this page in Trust Wallet or MetaMask, or install an injected wallet extension.");
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
