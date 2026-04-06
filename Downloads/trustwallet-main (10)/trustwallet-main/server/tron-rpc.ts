// TRON RPC utilities — equivalent of server/rpc.ts but for TRON chains.
// Uses TronWeb for contract interaction instead of ethers.js.

import type { ChainType } from "../shared/chain";

const TRON_CHAIN_IDS = new Set([
  "0x2b6653dc", // TRON Mainnet (728126428)
  "0xcd8690dc", // TRON Nile testnet (3448148188)
]);

export function isTronChain(chainId: string): boolean {
  if (!chainId) return false;
  return TRON_CHAIN_IDS.has(chainId.toLowerCase());
}

interface TronGridConfig {
  fullNodeUrl: string;
  apiKey?: string;
}

function getTronGridConfig(chainId: string): TronGridConfig {
  const cid = chainId.toLowerCase();
  if (cid === "0xcd8690dc") {
    return {
      fullNodeUrl: process.env.TRON_NILE_FULL_NODE || "https://nile.trongrid.io",
      apiKey: process.env.TRON_NILE_API_KEY,
    };
  }
  // Default to mainnet
  return {
    fullNodeUrl: process.env.TRON_MAINNET_FULL_NODE || "https://api.trongrid.io",
    apiKey: process.env.TRON_MAINNET_API_KEY,
  };
}

export function getTronGridUrl(chainId: string): string {
  return getTronGridConfig(chainId).fullNodeUrl;
}

/**
 * Create a TronWeb instance for the given network.
 * If privateKey is provided, transactions can be signed with it.
 * Lazy import of tronweb to avoid bundling it in the client.
 */
export async function makeTronWebInstance(chainId: string, privateKey?: string, defaultAddress?: string): Promise<any> {
  // Dynamic import to keep tronweb out of the browser bundle
  let TronWebCtor: any;
  try {
    const mod = await import("tronweb");
    TronWebCtor = mod.TronWeb ?? mod.default?.TronWeb ?? mod.default;
  } catch (e) {
    throw new Error("tronweb package not installed. Run: npm install tronweb");
  }

  const config = getTronGridConfig(chainId);
  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers["TRON-PRO-API-KEY"] = config.apiKey;
  }

  // TronWeb requires the private key WITHOUT 0x prefix; strip it if present
  const cleanKey = privateKey?.startsWith("0x") ? privateKey.slice(2) : privateKey;
  const instance = new TronWebCtor({
    fullHost: config.fullNodeUrl,
    headers,
    ...(cleanKey ? { privateKey: cleanKey } : {}),
  });

  // TronGrid requires a non-empty owner_address for triggerConstantContract (view calls).
  // When no private key is given, set a dummy caller so view-only .call() doesn't throw.
  if (!privateKey && defaultAddress) {
    instance.defaultAddress.base58 = defaultAddress;
    try {
      instance.defaultAddress.hex = instance.address.toHex(defaultAddress);
    } catch { /* leave hex as-is if conversion fails */ }
  }

  return instance;
}

/**
 * Fetch a transaction from TronGrid REST API.
 * Uses POST /wallet/gettransactionbyid (wallet API) which works on all networks
 * including Nile testnet (the V1 GET endpoint returns 404 on Nile).
 * Returns null if the transaction is not found yet.
 */
export async function getTronTransaction(
  chainId: string,
  txId: string
): Promise<any | null> {
  const config = getTronGridConfig(chainId);
  const url = `${config.fullNodeUrl}/wallet/gettransactionbyid`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["TRON-PRO-API-KEY"] = config.apiKey;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ value: txId }),
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  // Wallet API returns the tx object directly (not wrapped in data[])
  // An empty object {} means not found yet
  if (!json?.txID) return null;
  return json;
}

/**
 * Fetch transaction info (includes energy/bandwidth consumed) from TronGrid.
 */
export async function getTronTransactionInfo(
  chainId: string,
  txId: string
): Promise<any | null> {
  const config = getTronGridConfig(chainId);
  const url = `${config.fullNodeUrl}/wallet/gettransactioninfobyid`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["TRON-PRO-API-KEY"] = config.apiKey;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ value: txId }),
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  return json?.id ? json : null;
}
