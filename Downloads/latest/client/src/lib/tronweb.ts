import { isMobile } from "./metamask";
/**
 * TronWeb integration for TRC-20 token operations.
 *
 * TRON uses TronLink wallet (browser extension) instead of MetaMask.
 * The window.tronWeb / window.tronLink objects are injected by TronLink.
 */

declare global {
  interface Window {
    tronWeb?: any;
    tronLink?: any;
  }
}

export interface TronWalletInfo {
  address: string; // Base58 TRON address (starts with T)
  networkName: string;
  chainId: string; // "tron_mainnet" | "tron_shasta" | "tron_nile"
}

const TRON_FULL_NODE_MAINNET = "https://api.trongrid.io";
const TRON_FULL_NODE_SHASTA = "https://api.shasta.trongrid.io";

/**
 * Check if TronLink wallet is installed
 */
export function isTronLinkInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window.tronWeb || window.tronLink);
}

/**
 * Wait for TronLink to be ready (it sometimes initializes async)
 */
async function waitForTronLink(timeoutMs = 3000): Promise<boolean> {
  if (isTronLinkInstalled() && (window.tronWeb?.ready || window.tronWeb?.defaultAddress?.base58)) return true;

  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (window.tronWeb?.ready || window.tronWeb?.defaultAddress?.base58) {
        clearInterval(interval);
        resolve(true);
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 200);
  });
}

/**
 * Get the current TRON network from TronLink
 */
function detectTronNetwork(): { chainId: string; name: string } {
  if (!window.tronWeb) return { chainId: "tron_mainnet", name: "TRON Mainnet" };

  const fullNode = window.tronWeb.fullNode?.host || "";
  if (fullNode.includes("shasta")) {
    return { chainId: "tron_shasta", name: "TRON Shasta Testnet" };
  }
  if (fullNode.includes("nile")) {
    return { chainId: "tron_nile", name: "TRON Nile Testnet" };
  }
  return { chainId: "tron_mainnet", name: "TRON Mainnet" };
}

/**
 * Connect to TronLink wallet
 */
export async function connectTronLink(): Promise<TronWalletInfo> {
  if (!isTronLinkInstalled()) {
    if (isMobile()) {
      throw new Error("TRON wallet not detected. Please open this link in Trust Wallet or the TronLink app.");
    }
    throw new Error("TronLink extension not detected. Please install the TronLink browser extension.");
  }

  // Request access if tronLink has the request method
  if (window.tronLink?.request) {
    try {
      await window.tronLink.request({ method: "tron_requestAccounts" });
    } catch (e: any) {
      if (e?.code === 4001) {
        throw new Error("User rejected TronLink connection request.");
      }
    }
  }

  const ready = await waitForTronLink();
  if (!ready && !window.tronWeb?.defaultAddress?.base58) {
    throw new Error("Tron wallet is not ready. Please unlock your wallet and refresh.");
  }

  const address = window.tronWeb?.defaultAddress?.base58;
  if (!address) {
    throw new Error("No TRON account found. Please create or import an account in your wallet.");
  }

  const network = detectTronNetwork();

  return {
    address,
    networkName: network.name,
    chainId: network.chainId,
  };
}

/**
 * Get TRC-20 token balance
 */
export async function getTrc20Balance(tokenAddress: string, walletAddress: string): Promise<string> {
  if (!window.tronWeb) {
    throw new Error("TronWeb not ready");
  }

  try {
    const contract = await window.tronWeb.contract().at(tokenAddress);
    const balance = await contract.balanceOf(walletAddress).call();
    return balance.toString();
  } catch (e: any) {
    console.error("Failed to get TRC-20 balance:", e);
    return "0";
  }
}

/**
 * Get TRC-20 token decimals
 */
export async function getTrc20Decimals(tokenAddress: string): Promise<number> {
  if (!window.tronWeb) {
    throw new Error("TronWeb not ready");
  }

  try {
    const contract = await window.tronWeb.contract().at(tokenAddress);
    const decimals = await contract.decimals().call();
    return Number(decimals);
  } catch {
    return 6; // Default for most TRC-20 stablecoins
  }
}

/**
 * Send TRC-20 token transfer (direct transfer, no subscription contract)
 */
export async function sendTrc20Transfer(
  tokenAddress: string,
  toAddress: string,
  amount: string,
  decimals: number
): Promise<string> {
  if (!window.tronWeb) {
    throw new Error("TronWeb not ready. Please connect your TRON wallet.");
  }

  try {
    // Convert amount to Sun (smallest unit)
    const amountInSun = BigInt(Math.round(parseFloat(amount) * Math.pow(10, decimals)));

    const contract = await window.tronWeb.contract().at(tokenAddress);
    const result = await contract.transfer(toAddress, amountInSun.toString()).send({
      feeLimit: 100_000_000, // 100 TRX max fee
      callValue: 0,
    });

    // TronWeb returns the transaction hash directly
    return typeof result === "string" ? result : result?.txid || result?.transaction?.txID || "";
  } catch (e: any) {
    const msg = e?.message || e?.toString() || "Unknown error";
    if (msg.includes("Confirmation declined") || msg.includes("User rejected")) {
      throw new Error("Transaction cancelled by user.");
    }
    throw new Error(`TRC-20 transfer failed: ${msg}`);
  }
}

/**
 * Approve TRC-20 token spending (for subscription contracts on TRON)
 */
export async function approveTrc20(
  tokenAddress: string,
  spenderAddress: string,
  amount: string,
  decimals: number
): Promise<string> {
  if (!window.tronWeb) {
    throw new Error("TronWeb not ready.");
  }

  try {
    const amountInSun = BigInt(Math.round(parseFloat(amount) * Math.pow(10, decimals)));
    const contract = await window.tronWeb.contract().at(tokenAddress);
    const result = await contract.approve(spenderAddress, amountInSun.toString()).send({
      feeLimit: 100_000_000,
      callValue: 0,
    });

    return typeof result === "string" ? result : result?.txid || result?.transaction?.txID || "";
  } catch (e: any) {
    const msg = e?.message || e?.toString() || "Unknown error";
    if (msg.includes("Confirmation declined") || msg.includes("User rejected")) {
      throw new Error("Approval cancelled by user.");
    }
    throw new Error(`TRC-20 approval failed: ${msg}`);
  }
}

/**
 * Get TRX balance (native token) for gas fees
 */
export async function getTrxBalance(walletAddress: string): Promise<string> {
  if (!window.tronWeb) return "0";

  try {
    const balance = await window.tronWeb.trx.getBalance(walletAddress);
    // Balance is in SUN (1 TRX = 1,000,000 SUN)
    return (Number(balance) / 1_000_000).toString();
  } catch {
    return "0";
  }
}

/**
 * Format SUN to TRX
 */
export function sunToTrx(sun: string | number): string {
  return (Number(sun) / 1_000_000).toFixed(6);
}

/**
 * Format token amount from smallest unit
 */
export function formatTrc20Amount(amount: string | bigint, decimals: number): string {
  const value = typeof amount === "bigint" ? amount : BigInt(amount || "0");
  const divisor = BigInt(10 ** decimals);
  const whole = value / divisor;
  const fraction = value % divisor;
  const fractionStr = fraction.toString().padStart(decimals, "0");
  return `${whole}.${fractionStr}`.replace(/\.?0+$/, "") || "0";
}

/**
 * Listen for TronLink account changes
 */
export function onTronAccountChanged(callback: (address: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const handler = (e: MessageEvent) => {
    if (e.data?.message?.action === "setAccount") {
      const addr = e.data.message?.data?.address || null;
      callback(addr);
    }
    if (e.data?.message?.action === "setNode") {
      // Network changed, could refetch
    }
  };

  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

/**
 * Get TRON RPC URL for server-side verification
 */
export function getTronRpcUrl(chainId: string): string {
  if (chainId === "tron_shasta") return TRON_FULL_NODE_SHASTA;
  return TRON_FULL_NODE_MAINNET;
}
