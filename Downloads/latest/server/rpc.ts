import { FetchRequest, JsonRpcProvider } from "ethers";

function normalizeChainId(chainId: string): string {
  const raw = String(chainId || "").trim();
  if (!raw) return "";
  if (raw.startsWith("0x") || raw.startsWith("0X")) {
    return `0x${raw.slice(2).toLowerCase()}`;
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    return `0x${Math.trunc(n).toString(16)}`;
  }
  return raw.toLowerCase();
}

function uniqNonEmpty(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

const DEFAULT_RPC_URLS: Record<string, string> = {
  "0x1": "https://eth.llamarpc.com",
  "0x89": "https://polygon-rpc.com",
  "0x38": "https://bsc-dataseed.binance.org",
  "0xa86a": "https://api.avax.network/ext/bc/C/rpc",
  "0xa4b1": "https://arb1.arbitrum.io/rpc",
  "0xa": "https://mainnet.optimism.io",
  "0x2105": "https://mainnet.base.org",
  "0xfa": "https://rpc.ftm.tools",
  "0x5": "https://rpc.goerli.mudit.blog",
  "0x61": "https://data-seed-prebsc-1-s1.binance.org:8545",
};

// TRON uses separate RPC infra (TronGrid HTTP API, not JSON-RPC)
const TRON_RPC_URLS: Record<string, string> = {
  tron_mainnet: "https://api.trongrid.io",
  tron_shasta: "https://api.shasta.trongrid.io",
};

export function getRpcUrls(chainId: string): string[] {
  // TRON chains use string-based IDs without 0x prefix
  if (chainId.startsWith("tron_")) {
    const tronUrl = TRON_RPC_URLS[chainId];
    return tronUrl ? [tronUrl] : [];
  }

  const cid = normalizeChainId(chainId);
  if (!cid) return [];

  // Sepolia: use a fallback list (rpc.sepolia.org frequently times out / 522).
  if (cid === "0xaa36a7") {
    return uniqNonEmpty([
      process.env.SEPOLIA_RPC_URL,
      "https://ethereum-sepolia.publicnode.com",
      "https://sepolia.drpc.org",
      "https://1rpc.io/sepolia",
    ]);
  }

  const single = DEFAULT_RPC_URLS[cid];
  return single ? [single] : [];
}

function parseTimeoutMs(): number {
  const raw = process.env.RPC_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 8000;
  // Avoid pathological values.
  return Math.min(Math.max(n, 1000), 120000);
}

function parseChainIdNumber(chainId: string): number {
  const raw = String(chainId || "").trim();
  if (!raw) throw new Error("chainId is required");
  if (raw.startsWith("0x") || raw.startsWith("0X")) {
    return Number.parseInt(raw, 16);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid chainId: ${chainId}`);
  }
  return Math.trunc(n);
}

export function makeJsonRpcProvider(url: string, chainId: string): JsonRpcProvider {
  const timeoutMs = parseTimeoutMs();
  const fetchReq = new FetchRequest(url);
  fetchReq.timeout = timeoutMs;

  const chainIdNumber = parseChainIdNumber(chainId);
  return new JsonRpcProvider(fetchReq, chainIdNumber, { staticNetwork: true });
}

export class RpcUnavailableError extends Error {
  code: string;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RpcUnavailableError";
    this.code = "RPC_UNAVAILABLE";
    // Preserve the underlying error for logging when available.
    (this as any).cause = cause;
  }
}

export function isRpcConnectivityError(err: unknown): boolean {
  if (!err) return false;

  const code = typeof (err as any)?.code === "string" ? String((err as any).code) : "";
  if (code === "RPC_UNAVAILABLE") return true;
  if (code === "SERVER_ERROR" || code === "TIMEOUT" || code === "NETWORK_ERROR") return true;

  const name = typeof (err as any)?.name === "string" ? String((err as any).name) : "";
  if (name === "RpcUnavailableError") return true;

  const msg = typeof (err as any)?.message === "string" ? String((err as any).message) : String(err);
  const lower = msg.toLowerCase();

  return (
    lower.includes("server_error") ||
    lower.includes("server error") ||
    lower.includes("gateway") ||
    lower.includes("522") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("eai_again") ||
    lower.includes("failed to fetch") ||
    lower.includes("socket hang up") ||
    lower.includes("connection closed")
  );
}

