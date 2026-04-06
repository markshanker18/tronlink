import type { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import { storage } from "./storage";
import { loginSchema, type Subscription, type Plan } from "../shared/schema";
import { isAllowedVideoUrl } from "../shared/video";
import bcrypt from "bcrypt";
import connectPgSimple from "connect-pg-simple";
import { z } from "zod";
import { encrypt, decrypt } from "./crypto";
import { createHash, randomBytes } from "node:crypto";
import { Wallet, Contract, Interface, formatUnits, id as keccak256Id, parseUnits } from "ethers";
import { SUBSCRIPTION_CONTRACT_ABI, getContractForNetwork } from "../shared/contracts";
import { getTronContractForNetwork } from "../shared/tron-contracts";
import { runSchedulerTick } from "./scheduler";
import { getRpcUrls, isRpcConnectivityError, makeJsonRpcProvider, RpcUnavailableError } from "./rpc";

import { detectChainType, normalizeAddress, isValidAddress, isTronChainId } from "../shared/chain";
import type { ChainType } from "../shared/chain";
import { getIntervalMs, getIntervalSeconds, hasMinimumSubscriptionInterval, MIN_SUBSCRIPTION_INTERVAL_SECONDS } from "../shared/interval";
import { signQrPayload, verifyQrPayload } from "./qr-signing";
import { bumpPlanVersion } from "./plan-version";

/** Builds the embeddable SDK script string. Injected at request time with the server host. */
function buildSdkScript(host: string): string {
  return `(function(){
  "use strict";
  var script = document.currentScript || (function(){ var s = document.getElementsByTagName("script"); return s[s.length-1]; })();
  var key = script && (script.getAttribute("data-key") || script.dataset.key);
  if (!key) { console.warn("[CryptoPay SDK] No data-key attribute found."); return; }

  var HOST = ${JSON.stringify(host)};
  var PING_INTERVAL = 60000; // 60s
  var origin = location.origin;

  function ping() {
    fetch(HOST + "/api/sdk/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key, origin: origin })
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data.status === "suspended") {
        showOverlay("Service suspended. " + (data.suspendReason || "Please contact support."));
      } else if (data.status === "payment_required") {
        showPaymentPrompt();
      } else if (data.status === "invalid_key") {
        console.warn("[CryptoPay SDK] Invalid API key.");
      }
    })
    .catch(function(){});
  }

  function showOverlay(message) {
    if (document.getElementById(“cpay-sdk-overlay”)) return;
    var el = document.createElement(“div”);
    el.id = “cpay-sdk-overlay”;
    el.style.cssText = “position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;font-family:sans-serif;”;
    var card = document.createElement(“div”);
    card.style.cssText = “background:#1a1a2e;color:#fff;padding:32px 40px;border-radius:12px;max-width:420px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.5);”;
    var icon = document.createElement(“div”);
    icon.style.cssText = “font-size:32px;margin-bottom:12px;”;
    icon.textContent = “\uD83D\uDD12”;
    var heading = document.createElement(“h2”);
    heading.style.cssText = “margin:0 0 12px;font-size:20px;”;
    heading.textContent = “Service Unavailable”;
    var para = document.createElement(“p”);
    para.style.cssText = “margin:0 0 20px;color:#aaa;font-size:14px;”;
    para.textContent = message;
    var link = document.createElement(“a”);
    link.href = HOST;
    link.target = “_blank”;
    link.style.cssText = “display:inline-block;background:#6366f1;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:14px;”;
    link.textContent = “Contact Support”;
    card.appendChild(icon);
    card.appendChild(heading);
    card.appendChild(para);
    card.appendChild(link);
    el.appendChild(card);
    document.body.appendChild(el);
  }

  function showPaymentPrompt() {
    if (document.getElementById("cpay-sdk-overlay")) return;
    var el = document.createElement("div");
    el.id = "cpay-sdk-overlay";
    el.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;font-family:sans-serif;";
    el.innerHTML = '<div style="background:#1a1a2e;color:#fff;padding:32px 40px;border-radius:12px;max-width:420px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.5);">'
      + '<div style="font-size:32px;margin-bottom:12px;">ðŸ’³</div>'
      + '<h2 style="margin:0 0 12px;font-size:20px;">Payment Required</h2>'
      + '<p style="margin:0 0 20px;color:#aaa;font-size:14px;">Your subscription has expired. Please renew to continue using this service.</p>'
      + '<a href="' + HOST + '" target="_blank" style="display:inline-block;background:#6366f1;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:14px;">Renew Now</a>'
      + '</div>';
    document.body.appendChild(el);
  }

  // Ping immediately on load, then every 60s
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ping);
  } else {
    ping();
  }
  setInterval(ping, PING_INTERVAL);
})();
`;
}

/** Returns the subscription contract address for a plan, using the correct registry for its chain type. */
function getContractAddrForPlan(plan: { networkId: string; contractAddress: string | null; chainType: string | null }): string | undefined {
  if (plan.chainType === "tron") {
    return plan.contractAddress ?? getTronContractForNetwork(plan.networkId) ?? undefined;
  }
  return plan.contractAddress ?? getContractForNetwork(plan.networkId) ?? undefined;
}


type RateLimitEntry = {
  count: number;
  resetAt: number;
};

function createRateLimiter(windowMs: number, max: number, keyFn?: (req: Request) => string) {
  const entries = new Map<string, RateLimitEntry>();

  // Periodically prune expired entries to prevent unbounded memory growth.
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(key);
    }
  }, Math.max(windowMs, 5 * 60 * 1000));

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const keyBase = keyFn ? keyFn(req) : req.ip || "unknown";
    const key = `${req.path}:${keyBase}`;
    const current = entries.get(key);

    if (!current || current.resetAt <= now) {
      entries.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (current.count >= max) {
      const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({ message: "Too many requests. Please try again later." });
    }

    current.count += 1;
    entries.set(key, current);
    return next();
  };
}

const TRANSFER_TOPIC = keccak256Id("Transfer(address,address,uint256)");
const transferIface = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
] as const);
const subscriptionIface = new Interface(SUBSCRIPTION_CONTRACT_ABI as any);
const PAYER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FEE_ESTIMATE_GAS_UNITS = BigInt(65000);
const TX_CONFIRMATIONS = Math.max(1, Number.parseInt(process.env.TX_CONFIRMATIONS || "3", 10) || 3);

const COINGECKO_ID_BY_SYMBOL: Record<string, string> = {
  ETH: "ethereum",
  WETH: "ethereum",
  BNB: "binancecoin",
  WBNB: "binancecoin",
  MATIC: "matic-network",
  POL: "matic-network",
  AVAX: "avalanche-2",
  FTM: "fantom",
  USDC: "usd-coin",
  USDT: "tether",
};

function hashPayerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function issuePayerToken() {
  const token = randomBytes(32).toString("base64url");
  const hash = hashPayerToken(token);
  const expiresAt = new Date(Date.now() + PAYER_TOKEN_TTL_MS);
  return { token, hash, expiresAt };
}

const _priceCache = new Map<string, { price: number; expiresAt: number }>();
const PRICE_CACHE_TTL_MS = 60_000; // 60 seconds

async function fetchUsdPrice(symbol: string): Promise<number | null> {
  const id = COINGECKO_ID_BY_SYMBOL[symbol.toUpperCase()];
  if (!id) return null;

  const cached = _priceCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.price;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const value = Number(data?.[id]?.usd);
    if (Number.isFinite(value) && value > 0) {
      _priceCache.set(id, { price: value, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
      return value;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function toPublicSubscription(sub: Subscription) {
  const {
    payerTokenHash: _ignored,
    payerTokenExpiresAt: _ignoredExp,
    pendingTxHash: _ignoredPendingHash,
    pendingTxCreatedAt: _ignoredPendingAt,
    ...publicSub
  } = sub as any;
  return publicSub;
}

function toPublicPlan(plan: Plan) {
  const { userId: _ignoredUserId, ...publicPlan } = plan as any;
  return publicPlan;
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k || rest.length === 0) continue;
    const v = rest.join("=");
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function normalizeHexAddress(value: string): string {
  return value.toLowerCase();
}

function getBigintString(value: unknown): string {
  try {
    return BigInt(value as any).toString();
  } catch {
    return String(value ?? "");
  }
}

async function verifyActivationTx(plan: Plan, payerAddress: string, firstPaymentAmount: string, txHash: string, subRecurringAmount?: string | null): Promise<{
  onChainId: string;
  blockTimestampMs: number;
}> {
  if (!plan.tokenAddress) {
    throw new Error("Plan tokenAddress is not configured");
  }

  const contractAddr = getContractForNetwork(plan.networkId) || plan.contractAddress;
  if (!contractAddr) {
    throw new Error("Subscription contract address not configured for this network");
  }
  const rpcUrls = getRpcUrls(plan.networkId);
  if (rpcUrls.length === 0) {
    throw new Error(`No RPC endpoint configured for network ${plan.networkName} (${plan.networkId}).`);
  }

  let sawNullReceipt = false;
  let lastRpcError: unknown = null;

  for (const rpcUrl of rpcUrls) {
    try {
      const provider = makeJsonRpcProvider(rpcUrl, plan.networkId);
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        sawNullReceipt = true;
        continue;
      }

      if (!receipt.to || normalizeHexAddress(receipt.to) !== normalizeHexAddress(contractAddr)) {
        throw new Error("Activation transaction was not sent to the subscription contract");
      }

      if (normalizeHexAddress(receipt.from) !== normalizeHexAddress(payerAddress)) {
        throw new Error("Activation transaction sender does not match payerAddress");
      }

      const created = receipt.logs.find((log) => {
        try {
          const parsed = subscriptionIface.parseLog(log);
          return parsed?.name === "SubscriptionCreated";
        } catch {
          return false;
        }
      });

      if (!created) {
        throw new Error("Activation transaction did not emit SubscriptionCreated");
      }

      const parsedCreated = subscriptionIface.parseLog(created);
      if (!parsedCreated) {
        throw new Error("Activation transaction did not emit SubscriptionCreated");
      }
      const onChainId = getBigintString(parsedCreated.args?.[0]);
      const sender = String(parsedCreated.args?.[1] ?? "");
      const receiver = String(parsedCreated.args?.[2] ?? "");
      const token = String(parsedCreated.args?.[3] ?? "");
      const recurringAmountWei = getBigintString(parsedCreated.args?.[4]);
      const intervalSeconds = getBigintString(parsedCreated.args?.[5]);

      if (normalizeHexAddress(sender) !== normalizeHexAddress(payerAddress)) {
        throw new Error("Activation sender mismatch");
      }

      if (normalizeHexAddress(receiver) !== normalizeHexAddress(plan.walletAddress)) {
        throw new Error("Activation receiver does not match plan wallet address");
      }

      if (normalizeHexAddress(token) !== normalizeHexAddress(plan.tokenAddress)) {
        throw new Error("Activation token does not match plan token");
      }

      const decimals = plan.tokenDecimals || 18;
      // Use the subscription's own locked-in recurring amount if available (handles plan changes after activation)
      const effectiveRecurring = subRecurringAmount || plan.recurringAmount || plan.intervalAmount;
      const expectedRecurring = parseUnits(effectiveRecurring, decimals).toString();
      if (recurringAmountWei !== expectedRecurring) {
        throw new Error("Activation recurring amount does not match plan");
      }

      const expectedInterval = String(getIntervalSeconds(plan.intervalValue, plan.intervalUnit));
      if (intervalSeconds !== expectedInterval) {
        throw new Error("Activation interval does not match plan");
      }

      const expectedInitialWei = parseUnits(firstPaymentAmount, decimals).toString();
      const initialTransfer = receipt.logs.find((log) => {
        if (normalizeHexAddress(log.address) !== normalizeHexAddress(plan.tokenAddress!)) return false;
        if (!log.topics?.length) return false;
        if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) return false;
        try {
          const t = transferIface.parseLog(log);
          if (!t) return false;
          const from = String(t.args?.from ?? "");
          const to = String(t.args?.to ?? "");
          const value = getBigintString(t.args?.value);
          return (
            normalizeHexAddress(from) === normalizeHexAddress(payerAddress) &&
            normalizeHexAddress(to) === normalizeHexAddress(plan.walletAddress) &&
            value === expectedInitialWei
          );
        } catch {
          return false;
        }
      });

      if (!initialTransfer) {
        throw new Error("Could not verify initial token transfer in activation transaction");
      }

      const block = receipt.blockNumber ? await provider.getBlock(receipt.blockNumber) : null;
      if (!block?.timestamp) {
        throw new RpcUnavailableError("Could not fetch activation block timestamp");
      }

      const blockTimestampMs = Number(block.timestamp) * 1000;
      return { onChainId, blockTimestampMs };
    } catch (err: unknown) {
      if (isRpcConnectivityError(err)) {
        lastRpcError = err;
        continue;
      }
      throw err;
    }
  }

  if (sawNullReceipt) {
    throw new Error("Activation transaction not found or not yet mined");
  }
  if (lastRpcError) {
    throw new RpcUnavailableError(
      `RPC temporarily unavailable for ${plan.networkName} (${plan.networkId}). Please try again.`,
      lastRpcError
    );
  }
  throw new Error(`No RPC endpoint configured for network ${plan.networkName} (${plan.networkId}).`);
}

async function verifyOnChainSubscription(plan: Plan, payerAddress: string, onChainSubscriptionId: string, subRecurringAmount?: string | null, subIntervalValue?: number | null, subIntervalUnit?: string | null): Promise<void> {
  if (!plan.tokenAddress) {
    throw new Error("Plan tokenAddress is not configured");
  }

  const contractAddr = getContractForNetwork(plan.networkId) || plan.contractAddress;
  if (!contractAddr) {
    throw new Error("Subscription contract address not configured for this network");
  }
  const rpcUrls = getRpcUrls(plan.networkId);
  if (rpcUrls.length === 0) {
    throw new Error(`No RPC endpoint configured for network ${plan.networkName} (${plan.networkId}).`);
  }

  let lastRpcError: unknown = null;

  for (const rpcUrl of rpcUrls) {
    try {
      const provider = makeJsonRpcProvider(rpcUrl, plan.networkId);
      const contract = new Contract(contractAddr, SUBSCRIPTION_CONTRACT_ABI, provider);
      const sub = await contract.getSubscription(BigInt(onChainSubscriptionId));

      const sender = String(sub?.sender ?? "");
      const receiver = String(sub?.receiver ?? "");
      const token = String(sub?.token ?? "");
      const amount = getBigintString(sub?.amount);
      const interval = getBigintString(sub?.interval);

      if (normalizeHexAddress(sender) !== normalizeHexAddress(payerAddress)) {
        throw new Error("On-chain sender mismatch");
      }
      if (normalizeHexAddress(receiver) !== normalizeHexAddress(plan.walletAddress)) {
        throw new Error("On-chain receiver does not match plan wallet address");
      }
      if (normalizeHexAddress(token) !== normalizeHexAddress(plan.tokenAddress)) {
        throw new Error("On-chain token does not match plan token");
      }

      const decimals = plan.tokenDecimals || 18;
      // Use the subscription's own locked-in recurring amount if available
      const effectiveRecurring = subRecurringAmount || plan.recurringAmount || plan.intervalAmount;
      const expectedRecurring = parseUnits(effectiveRecurring, decimals).toString();
      if (amount !== expectedRecurring) {
        throw new Error("On-chain recurring amount does not match plan");
      }

      // Use the subscription's own locked-in interval if available
      const effectiveIntervalValue = subIntervalValue ?? plan.intervalValue;
      const effectiveIntervalUnit = subIntervalUnit ?? plan.intervalUnit;
      const expectedInterval = String(getIntervalSeconds(effectiveIntervalValue, effectiveIntervalUnit));
      if (interval !== expectedInterval) {
        throw new Error("On-chain interval does not match plan");
      }

      return;
    } catch (err: unknown) {
      if (isRpcConnectivityError(err)) {
        lastRpcError = err;
        continue;
      }
      throw err;
    }
  }

  throw new RpcUnavailableError(
    `RPC temporarily unavailable for ${plan.networkName} (${plan.networkId}). Please try again.`,
    lastRpcError
  );
}

async function verifyExecutionTx(
  plan: Plan,
  payerAddress: string,
  onChainSubscriptionId: string,
  txHash: string,
  subRecurringAmount?: string | null
): Promise<{ blockTimestampMs: number }> {
  if (!plan.tokenAddress) {
    throw new Error("Plan tokenAddress is not configured");
  }

  const contractAddr = getContractForNetwork(plan.networkId) || plan.contractAddress;
  if (!contractAddr) {
    throw new Error("Subscription contract address not configured for this network");
  }
  const rpcUrls = getRpcUrls(plan.networkId);
  if (rpcUrls.length === 0) {
    throw new Error(`No RPC endpoint configured for network ${plan.networkName} (${plan.networkId}).`);
  }

  let sawNullReceipt = false;
  let lastRpcError: unknown = null;

  for (const rpcUrl of rpcUrls) {
    try {
      const provider = makeJsonRpcProvider(rpcUrl, plan.networkId);
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        sawNullReceipt = true;
        continue;
      }

      if (receipt.status !== 1) {
        throw new Error("Execution transaction failed on-chain");
      }

      if (!receipt.to || normalizeHexAddress(receipt.to) !== normalizeHexAddress(contractAddr)) {
        throw new Error("Execution transaction was not sent to the subscription contract");
      }

      const paymentLog = receipt.logs.find((log) => {
        try {
          const parsed = subscriptionIface.parseLog(log);
          return parsed?.name === "PaymentExecuted";
        } catch {
          return false;
        }
      });
      if (!paymentLog) {
        throw new Error("Execution transaction did not emit PaymentExecuted");
      }

      const parsedPayment = subscriptionIface.parseLog(paymentLog);
      if (!parsedPayment) {
        throw new Error("Execution transaction did not emit PaymentExecuted");
      }

      const subId = getBigintString(parsedPayment.args?.[0]);
      const sender = String(parsedPayment.args?.[1] ?? "");
      const receiver = String(parsedPayment.args?.[2] ?? "");
      const amountWei = getBigintString(parsedPayment.args?.[3]);

      if (subId !== String(onChainSubscriptionId)) {
        throw new Error("Execution transaction subscription id mismatch");
      }
      if (normalizeHexAddress(sender) !== normalizeHexAddress(payerAddress)) {
        throw new Error("Execution transaction payer mismatch");
      }
      if (normalizeHexAddress(receiver) !== normalizeHexAddress(plan.walletAddress)) {
        throw new Error("Execution transaction receiver mismatch");
      }

      const decimals = plan.tokenDecimals || 18;
      // Use the subscription's own locked-in recurring amount if available
      const effectiveRecurring = subRecurringAmount || plan.recurringAmount || plan.intervalAmount;
      const expectedRecurring = parseUnits(effectiveRecurring, decimals).toString();
      if (amountWei !== expectedRecurring) {
        throw new Error("Execution amount does not match plan recurring amount");
      }

      const block = receipt.blockNumber ? await provider.getBlock(receipt.blockNumber) : null;
      if (!block?.timestamp) {
        throw new RpcUnavailableError("Could not fetch execution block timestamp");
      }
      return { blockTimestampMs: Number(block.timestamp) * 1000 };
    } catch (err: unknown) {
      if (isRpcConnectivityError(err)) {
        lastRpcError = err;
        continue;
      }
      throw err;
    }
  }

  if (sawNullReceipt) {
    throw new Error("Execution transaction not found or not yet mined");
  }
  throw new RpcUnavailableError(
    `RPC temporarily unavailable for ${plan.networkName} (${plan.networkId}). Please try again.`,
    lastRpcError
  );
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

// Accepts both EVM (0x-prefixed hex) and TRON (T-prefix Base58) addresses
const WALLET_ADDRESS_REGEX = /^(0x[a-fA-F0-9]{40}|T[1-9A-HJ-NP-Za-km-z]{33})$/;
const PLAN_INTERVAL_UNITS = ["sec", "min", "hrs", "days", "months"] as const;
const createPlanRequestSchema = z.object({
  planName: z.string().trim().min(1, "Plan name is required").max(120, "Plan name is too long"),
  walletAddress: z.string().trim().regex(WALLET_ADDRESS_REGEX, "Invalid wallet address"),
  networkId: z.string().trim().min(1, "Network id is required"),
  networkName: z.string().trim().min(1, "Network name is required").max(120, "Network name is too long"),
  tokenAddress: z.string().trim().regex(WALLET_ADDRESS_REGEX, "Invalid token address"),
  tokenSymbol: z.string().trim().min(1, "Token symbol is required").max(24, "Token symbol is too long"),
  tokenDecimals: z.number().int().min(0, "Token decimals must be >= 0").max(36, "Token decimals too large"),
  intervalAmount: z.string().trim().refine((v) => !Number.isNaN(Number(v)) && Number(v) > 0, "Invalid interval amount"),
  intervalValue: z.number().int().positive("Interval must be positive"),
  intervalUnit: z.enum(PLAN_INTERVAL_UNITS),
  contractAddress: z.string().trim().regex(WALLET_ADDRESS_REGEX, "Invalid contract address").optional(),
  videoUrl: z.string().trim().optional(),
  chainType: z.enum(["evm", "tron"]).optional(),
});

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

function toPublicUser(user: {
  id: string;
  username: string;
}) {
  return {
    id: user.id,
    username: user.username,
  };
}
export async function registerRoutes(app: Express): Promise<void> {
  const isProduction = process.env.NODE_ENV === "production";
  const PostgresStore = connectPgSimple(session);

  const sessionStore = isProduction
    ? new PostgresStore({
        conString: process.env.DATABASE_URL,
        createTableIfMissing: true,
      })
    : undefined;

  app.use(
    session({
      store: sessionStore,
      secret: (() => {
        const s = process.env.SESSION_SECRET;
        if (!s) throw new Error("SESSION_SECRET environment variable is required but not set.");
        return s;
      })(),
      resave: false,
      saveUninitialized: false,
      proxy: isProduction,
      cookie: {
        secure: isProduction,
        sameSite: "lax",
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      },
    })
  );

  const apiRateLimiter = createRateLimiter(15 * 60 * 1000, 100); // 100 requests per 15 minutes
  app.use("/api", apiRateLimiter);

  /**
   * Health Check Endpoint
   * Used for remote site monitoring and 502 diagnostics.
   */
  app.get("/api/health", async (_req, res) => {
    try {
      const { db } = await import("./db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`SELECT 1`);
      res.json({ status: "ok", time: new Date().toISOString() });
    } catch (e: any) {
      res.status(503).json({ status: "error", message: e.message });
    }
  });

  function setPayerTokenCookies(res: Response, subscriptionId: string, token: string, secure: boolean) {
    const common = {
      secure,
      sameSite: (secure ? "none" : "lax") as "none" | "lax",
      httpOnly: true,
      maxAge: PAYER_TOKEN_TTL_MS,
      path: "/",
    };
    res.cookie(`payer-id-${subscriptionId}`, subscriptionId, common);
    res.cookie(`payer-token-${subscriptionId}`, token, common);
  }

  function clearPayerTokenCookies(res: Response, subscriptionId: string, secure: boolean) {
    const common = {
      secure,
      sameSite: (secure ? "none" : "lax") as "none" | "lax",
      httpOnly: true,
      path: "/",
    };
    res.clearCookie(`payer-id-${subscriptionId}`, common);
    res.clearCookie(`payer-token-${subscriptionId}`, common);
  }

  async function rotatePayerTokenForSubscription(res: Response, subscriptionId: string) {
    const issued = issuePayerToken();
    await storage.updatePayerToken(subscriptionId, issued.hash, issued.expiresAt);
    setPayerTokenCookies(res, subscriptionId, issued.token, isProduction);
  }

  async function hasSubscriptionAccess(req: Request, sub: Subscription): Promise<boolean> {
    if (req.session.userId) {
      const plan = await storage.getPlanById(sub.planId);
      if (plan && plan.userId === req.session.userId) return true;
    }

    const cookies = parseCookies(req);
    const cookieId = cookies[`payer-id-${sub.id}`];
    const cookieToken = cookies[`payer-token-${sub.id}`];
    if (!cookieId || !cookieToken || cookieId !== sub.id) return false;

    if (!sub.payerTokenHash || !sub.payerTokenExpiresAt) return false;
    if (sub.payerTokenExpiresAt.getTime() < Date.now()) return false;

    const expectedHash = hashPayerToken(cookieToken);
    return expectedHash === sub.payerTokenHash;
  }

  async function hasSubscriptionCancelAccess(req: Request, sub: Subscription): Promise<boolean> {
    if (req.session.userId) {
      const plan = await storage.getPlanById(sub.planId);
      if (plan && plan.userId === req.session.userId) return true;
    }
    return false;
  }

  const authRateLimiter = createRateLimiter(60 * 60 * 1000, 20);

  app.post("/api/auth/register", authRateLimiter, async (req: Request, res: Response) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }

      const existing = await storage.getUserByUsername(parsed.data.username);
      if (existing) {
        return res.status(400).json({ message: "Username taken" });
      }

      const hashedPassword = await bcrypt.hash(parsed.data.password, 10);
      const user = await storage.createUser({
        username: parsed.data.username,
        password: hashedPassword,
      });

      req.session.userId = user.id;
      return res.json(toPublicUser(user));
    } catch (err: any) {
      return res.status(500).json({ message: "Registration failed" });
    }
  });

  app.post("/api/auth/login", authRateLimiter, async (req: Request, res: Response) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }

      const user = await storage.getUserByUsername(parsed.data.username);
      if (!user) {
        return res.status(401).json({ message: "Invalid credentials" });
      }

      const valid = await bcrypt.compare(parsed.data.password, user.password);
      if (!valid) {
        return res.status(401).json({ message: "Invalid credentials" });
      }

      req.session.userId = user.id;
      return res.json(toPublicUser(user));
    } catch (err: any) {
      return res.status(500).json({ message: "Login failed" });
    }
  });
  app.get("/api/auth/me", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.json(null);
    }
    const user = await storage.getUser(req.session.userId);
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    return res.json(toPublicUser(user));
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ message: "Logout failed" });
      res.clearCookie("connect.sid");
      return res.json({ message: "Logged out" });
    });
  });

  app.post("/api/auth/wallet", requireAuth, async (req: Request, res: Response) => {
    const { walletAddress, walletNetwork } = req.body;
    if (!walletAddress || typeof walletAddress !== "string" || !WALLET_ADDRESS_REGEX.test(walletAddress)) {
      return res.status(400).json({ message: "Valid wallet address required" });
    }

    if (walletNetwork !== undefined && typeof walletNetwork !== "string") {
      return res.status(400).json({ message: "Wallet network must be a string" });
    }

    // Use chain-aware normalization: EVM addresses are lowercased,
    // TRON Base58Check addresses are case-sensitive and must be preserved.
    const walletChainType = walletNetwork ? detectChainType(walletNetwork) : "evm";
    const normalizedWalletAddress = normalizeAddress(walletAddress, walletChainType);
    const user = await storage.updateUserWallet(
      req.session.userId!,
      normalizedWalletAddress,
      walletNetwork ?? null,
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json(toPublicUser(user));
  });

  app.post("/api/auth/executor-key", requireAuth, async (req: Request, res: Response) => {
    try {
      const { privateKey, type = "evm" } = req.body;
      if (!privateKey || typeof privateKey !== "string") {
        return res.status(400).json({ message: "Private key is required" });
      }
      const normalizedKey = privateKey.trim();
      // Most private keys are 64-character hex strings, sometimes with 0x prefix.
      if (!/^(0x)?[a-fA-F0-9]{64}$/.test(normalizedKey)) {
        return res.status(400).json({ message: "Invalid private key format. Expected 64-character hex." });
      }
      const encryptedKey = encrypt(normalizedKey);
      const updated = await storage.updateUserExecutorKey(req.session.userId!, encryptedKey, type);
      if (!updated) {
        return res.status(404).json({ message: "User not found" });
      }
      return res.json({ message: `${type.toUpperCase()} executor key saved`, hasKey: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[auth/executor-key] Failed to save executor key:", message);
      return res.status(500).json({ message: "Failed to save executor key" });
    }
  });

  app.delete("/api/auth/executor-key", requireAuth, async (req: Request, res: Response) => {
    const type = (req.query.type as ChainType) || "evm";
    await storage.updateUserExecutorKey(req.session.userId!, null, type);
    return res.json({ message: `${type.toUpperCase()} executor key removed`, hasKey: false });
  });

  app.get("/api/auth/executor-key", requireAuth, async (req: Request, res: Response) => {
    const evmKey = await storage.getUserExecutorKey(req.session.userId!, "evm");
    const tronKey = await storage.getUserExecutorKey(req.session.userId!, "tron");
    return res.json({ 
      hasKey: !!evmKey || !!tronKey, // legacy support
      hasEvmKey: !!evmKey,
      hasTronKey: !!tronKey
    });
  });

  app.get("/api/dashboard/stats", requireAuth, async (req: Request, res: Response) => {
    try {
      const stats = await storage.getDashboardStats(req.session.userId!);
      return res.json(stats);
    } catch (err: any) {
      return res.status(500).json({ message: "Failed to fetch stats" });
    }
  });

  app.get("/api/dashboard/subscribers", requireAuth, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const subs = await storage.getAllSubscriptionsForUser(req.session.userId!, limit, offset);
      return res.json(subs.map((sub) => toPublicSubscription(sub as any)));
    } catch (err: any) {
      return res.status(500).json({ message: "Failed to fetch subscribers" });
    }
  });

  app.get("/api/dashboard/transactions", requireAuth, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const logs = await storage.getAllSchedulerLogsForUser(req.session.userId!, limit, offset);
      return res.json(logs);
    } catch (err: any) {
      return res.status(500).json({ message: "Failed to fetch transactions" });
    }
  });

  app.get("/api/transactions/check", requireAuth, async (req: Request, res: Response) => {
    const schema = z.object({
      // Accept EVM hashes (0x + 64 hex) and TRON hashes (plain 64 hex, no 0x prefix)
      txHash: z.string().regex(
        /^(0x)?[a-fA-F0-9]{64}$/,
        "Valid transaction hash is required"
      ),
      networkId: z.string().min(1, "networkId is required"),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0].message });
    }

    const { txHash, networkId } = parsed.data;

    // --- TRON path ---
    if (isTronChainId(networkId)) {
      try {
        const { getTronTransactionInfo } = await import("./tron-rpc");
        const txInfo = await getTronTransactionInfo(networkId, txHash);
        if (!txInfo || !txInfo.id) {
          return res.json({
            status: "not_found",
            confirmed: false,
            message: "Transaction not found or not solidified yet",
          });
        }
        const confirmed = txInfo.receipt?.result === "SUCCESS";
        return res.json({
          status: confirmed ? "confirmed" : "reverted",
          confirmed,
          blockNumber: txInfo.blockNumber ?? null,
          confirmations: null, // TRON doesn't expose confirmations easily
          txHash,
        });
      } catch (err: any) {
        return res.status(500).json({
          status: "rpc_error",
          message: `Failed to check TRON transaction: ${err?.message || "Unknown error"}`,
        });
      }
    }

    // --- EVM path ---
    const rpcUrls = getRpcUrls(networkId);
    if (rpcUrls.length === 0) {
      return res.status(400).json({ message: `No RPC URL configured for chain ${networkId}` });
    }

    let lastErr: any = null;
    for (const rpcUrl of rpcUrls) {
      try {
        const provider = makeJsonRpcProvider(rpcUrl, networkId);
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt) {
          return res.json({
            status: "not_found",
            confirmed: false,
            message: "Transaction not found or not mined yet",
          });
        }

        const latestBlock = await provider.getBlockNumber();
        const confirmations = Math.max(0, latestBlock - Number(receipt.blockNumber) + 1);
        const confirmed = receipt.status === 1;
        return res.json({
          status: confirmed ? "confirmed" : "reverted",
          confirmed,
          blockNumber: Number(receipt.blockNumber),
          confirmations,
          txHash: receipt.hash,
        });
      } catch (err: any) {
        lastErr = err;
      }
    }

    const isRpcErr = isRpcConnectivityError(lastErr);
    return res.status(isRpcErr ? 503 : 500).json({
      status: "rpc_error",
      message: isRpcErr
        ? "RPC is temporarily unavailable. Please try again."
        : `Failed to check transaction: ${lastErr?.message || "Unknown error"}`,
    });
  });

  app.get("/api/wallets", requireAuth, async (req: Request, res: Response) => {
    const userWallets = await storage.getUserWallets(req.session.userId!);
    return res.json(userWallets);
  });

  app.post("/api/wallets", requireAuth, async (req: Request, res: Response) => {
    try {
      const existing = await storage.getUserWallets(req.session.userId!);
      if (existing.length >= 6) {
        return res.status(400).json({ message: "Maximum 6 wallets allowed" });
      }
      const schema = z.object({
        address: z.string().regex(WALLET_ADDRESS_REGEX, "Invalid wallet address"),
        label: z.string().max(50).optional(),
        networkId: z.string().optional(),
        networkName: z.string().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }
      const wallet = await storage.addUserWallet(req.session.userId!, {
        ...parsed.data,
        // TRON addresses are Base58Check case-sensitive (must start with 'T'); EVM addresses are lowercased
        address: parsed.data.address.startsWith('T') ? parsed.data.address : parsed.data.address.toLowerCase(),
      });
      return res.json(wallet);
    } catch (err: any) {
      return res.status(400).json({ message: err.message || "Failed to add wallet" });
    }
  });

  app.delete("/api/wallets/:id", requireAuth, async (req: Request, res: Response) => {
    const deleted = await storage.removeUserWallet(req.params.id as string, req.session.userId!);
    if (!deleted) {
      return res.status(404).json({ message: "Wallet not found" });
    }
    return res.json({ message: "Wallet removed" });
  });

  app.patch("/api/wallets/:id/default", requireAuth, async (req: Request, res: Response) => {
    const wallet = await storage.setDefaultWallet(req.params.id as string, req.session.userId!);
    if (!wallet) {
      return res.status(404).json({ message: "Wallet not found" });
    }
    return res.json(wallet);
  });

  app.get("/api/plans", requireAuth, async (req: Request, res: Response) => {
    const plans = await storage.getPlans(req.session.userId!);
    return res.json(plans);
  });

  app.post("/api/plans", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = createPlanRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }
      if (parsed.data.videoUrl && !isAllowedVideoUrl(parsed.data.videoUrl)) {
        return res.status(400).json({
          message: "Invalid video URL. Use https YouTube/Vimeo URL or direct .mp4/.webm/.ogg file.",
        });
      }

      const isTronPlan = parsed.data.chainType === "tron";

      // Layer 2: Backend validation - Block native tokens for recurring subscriptions
      if (!isTronPlan && (
        parsed.data.tokenAddress.toLowerCase() === "0x0000000000000000000000000000000000000000" ||
        parsed.data.tokenAddress.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
      )) {
        return res.status(400).json({ message: "Native ETH/BNB/MATIC not supported for recurring subscriptions. Use ERC-20 tokens like USDT/USDC." });
      }
      if (isTronPlan && (parsed.data.tokenAddress.toUpperCase() === "TRX" || parsed.data.tokenAddress.toLowerCase() === "trx")) {
        return res.status(400).json({ message: "Native TRX not supported for recurring subscriptions. Use TRC-20 tokens like USDT." });
      }
      if (!hasMinimumSubscriptionInterval(parsed.data.intervalValue, parsed.data.intervalUnit)) {
        return res.status(400).json({
          message: `Minimum recurring interval is ${MIN_SUBSCRIPTION_INTERVAL_SECONDS} seconds.`,
        });
      }
      const normalizedInput = {
        ...parsed.data,
        // TRON addresses are Base58 case-sensitive; EVM addresses are lowercased
        walletAddress: isTronPlan ? parsed.data.walletAddress : parsed.data.walletAddress.toLowerCase(),
        tokenAddress: isTronPlan ? parsed.data.tokenAddress : parsed.data.tokenAddress.toLowerCase(),
        contractAddress: parsed.data.contractAddress
          ? (isTronPlan ? parsed.data.contractAddress : parsed.data.contractAddress.toLowerCase())
          : undefined,
        videoUrl: parsed.data.videoUrl || undefined,
        // Keep recurringAmount in sync with intervalAmount on creation so the pay page
        // always shows the correct amount even before any billing update occurs.
        recurringAmount: parsed.data.intervalAmount,
      };

      // Ensure the plan has a usable subscription contract address (used by the scheduler).
      const inferredContract =
        normalizedInput.contractAddress ||
        (isTronPlan
          ? getTronContractForNetwork(normalizedInput.networkId)
          : getContractForNetwork(normalizedInput.networkId)) ||
        null;
      const plan = await storage.createPlan(req.session.userId!, {
        ...normalizedInput,
        contractAddress: inferredContract || undefined,
      });
      return res.json(plan);
    } catch (err: any) {
      return res.status(500).json({ message: "Failed to create plan" });
    }
  });

  app.delete("/api/plans/:id", requireAuth, async (req: Request, res: Response) => {
    const planId = req.params.id as string;
    const plan = await storage.getPlanById(planId);
    if (!plan || plan.userId !== req.session.userId) {
      return res.status(404).json({ message: "Plan not found" });
    }

    const subs = await storage.getSubscriptionsByPlan(planId);
    const activeSubs = subs.filter((s) => s.isActive && s.onChainSubscriptionId);
    const cancelResults: { subscriptionId: string; onChainCancelled: boolean; error?: string }[] = [];

    // Auto-cancel all active subscriptions (on-chain best-effort + always cancel in DB)
    if (activeSubs.length > 0) {
      const contractAddr = getContractAddrForPlan(plan);
      const isTronPlan = plan.chainType === "tron";
      const rpcUrls = isTronPlan ? [] : getRpcUrls(plan.networkId);
      const deployerKey = process.env.DEPLOYER_PRIVATE_KEY || null;

      for (const sub of activeSubs) {
        let onChainCancelled = false;
        let onChainError: string | undefined;

        if (contractAddr && deployerKey) {
          try {
            if (isTronPlan) {
              const { getChainAdapter } = await import("./chain-adapter");
              const adapter = await getChainAdapter("tron", plan.networkId);
              await adapter.cancelSubscription(contractAddr, sub.onChainSubscriptionId!, deployerKey);
              onChainCancelled = true;
            } else if (rpcUrls.length > 0) {
              for (const rpcUrl of rpcUrls) {
                try {
                  const provider = makeJsonRpcProvider(rpcUrl, plan.networkId);
                  const wallet = new Wallet(deployerKey, provider);
                  const contract = new Contract(contractAddr, SUBSCRIPTION_CONTRACT_ABI, wallet);
                  const tx = await contract.cancelSubscription(BigInt(sub.onChainSubscriptionId!));
                  await tx.wait(TX_CONFIRMATIONS);
                  onChainCancelled = true;
                  break;
                } catch (err: any) {
                  onChainError = err?.message || String(err);
                  if (!isRpcConnectivityError(err)) break;
                }
              }
            }
          } catch (err: any) {
            const msg = err?.message || String(err);
            onChainError = msg.toLowerCase().includes("not authorized")
              ? "On-chain cancel requires the deployer wallet to match the subscription receiver. Ensure DEPLOYER_PRIVATE_KEY corresponds to the plan's receiver wallet."
              : msg;
          }
        } else {
          onChainError = contractAddr
            ? "DEPLOYER_PRIVATE_KEY not configured — subscription cancelled in DB only."
            : "No contract address for this network — subscription cancelled in DB only.";
        }

        if (onChainError) {
          await storage.createSchedulerLog(sub.id, "error", undefined, `Plan deletion: on-chain cancel failed: ${onChainError}`).catch(() => {});
        }

        // Always cancel in DB regardless of on-chain result
        await storage.cancelSubscription(sub.id).catch(() => {});
        cancelResults.push({ subscriptionId: sub.id, onChainCancelled, error: onChainError });
      }
    }

    const deleted = await storage.deletePlan(planId, req.session.userId!);
    if (!deleted) {
      return res.status(404).json({ message: "Plan not found" });
    }
    return res.json({
      message: "Plan deleted",
      ...(cancelResults.length > 0 && { cancelledSubscriptions: cancelResults }),
    });
  });

  app.patch("/api/plans/:id/wallet", requireAuth, async (req: Request, res: Response) => {
    const walletAddress = typeof req.body.walletAddress === "string" ? req.body.walletAddress.trim() : req.body.walletAddress;
    if (!walletAddress || typeof walletAddress !== "string" || !WALLET_ADDRESS_REGEX.test(walletAddress)) {
      return res.status(400).json({ message: "Valid wallet address required" });
    }

    const planId = req.params.id as string;
    const oldPlan = await storage.getPlanById(planId);
    if (!oldPlan || oldPlan.userId !== req.session.userId) {
      return res.status(404).json({ message: "Plan not found" });
    }

    const chainType: ChainType = (oldPlan.chainType as ChainType) ?? detectChainType(oldPlan.networkId);
    const oldWallet = normalizeAddress(oldPlan.walletAddress, chainType);
    const newWallet = normalizeAddress(walletAddress, chainType);
    if (oldWallet === newWallet) {
      return res.json({ plan: oldPlan, markedCount: 0 });
    }

    await bumpPlanVersion(planId);
    const plan = await storage.updatePlanWalletAddress(planId, req.session.userId!, newWallet);
    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }

    const markedCount = await storage.markSubscriptionsPendingSync(planId, plan.planVersion);
    return res.json({ plan, markedCount });
  });

  app.patch("/api/plans/:id/billing", requireAuth, async (req: Request, res: Response) => {
    const { recurringAmount, intervalValue, intervalUnit } = req.body;
    const planId = req.params.id as string;
    
    // Validation
    if (recurringAmount && (isNaN(Number(recurringAmount)) || Number(recurringAmount) <= 0)) {
       return res.status(400).json({ message: "Valid positive amount required" });
    }
    if (intervalValue && (isNaN(Number(intervalValue)) || Number(intervalValue) <= 0)) {
       return res.status(400).json({ message: "Valid interval value required" });
    }
    if (intervalUnit && !["sec", "min", "hrs", "days", "months"].includes(intervalUnit)) {
       return res.status(400).json({ message: "Invalid interval unit" });
    }
    if (
      intervalValue &&
      intervalUnit &&
      !hasMinimumSubscriptionInterval(Number(intervalValue), intervalUnit)
    ) {
      return res.status(400).json({
        message: `Minimum recurring interval is ${MIN_SUBSCRIPTION_INTERVAL_SECONDS} seconds.`,
      });
    }

    try {
      await bumpPlanVersion(planId);
      let plan;
      if (recurringAmount) {
        plan = await storage.updatePlanRecurringAmount(planId, req.session.userId!, recurringAmount);
      }
      if (intervalValue && intervalUnit) {
        plan = await storage.updatePlanInterval(planId, req.session.userId!, Number(intervalValue), intervalUnit);
      }

      if (!plan) return res.status(404).json({ message: "Plan not found" });

      const markedCount = await storage.markSubscriptionsPendingSync(planId, plan.planVersion);
      return res.json({ plan, markedCount });
    } catch (err: any) {
      return res.status(500).json({ message: err.message || "Failed to update billing" });
    }
  });

  app.patch("/api/plans/:id/recurring-amount", requireAuth, async (req: Request, res: Response) => {
    const { recurringAmount } = req.body;
    if (!recurringAmount || isNaN(Number(recurringAmount)) || Number(recurringAmount) <= 0) {
      return res.status(400).json({ message: "Valid positive amount required" });
    }
    const planId = req.params.id as string;
    // Bump plan version before changing billing terms so history is preserved
    try { await bumpPlanVersion(planId); } catch { /* non-critical if plan not found */ }
    const plan = await storage.updatePlanRecurringAmount(planId, req.session.userId!, recurringAmount);
    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }
    const markedCount = await storage.markSubscriptionsPendingSync(planId, plan.planVersion);
    return res.json({ plan, markedCount });
  });

  app.get("/api/plans/code/:code", async (req: Request, res: Response) => {
    const plan = await storage.getPlanByCode(req.params.code as string);
    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }
    return res.json(toPublicPlan(plan));
  });

  app.get("/api/plans/:id/subscriptions", requireAuth, async (req: Request, res: Response) => {
    const planId = req.params.id as string;
    const plan = await storage.getPlanById(planId);
    if (!plan || plan.userId !== req.session.userId) {
      return res.status(404).json({ message: "Plan not found" });
    }
    const subs = await storage.getSubscriptionsByPlan(planId);
    return res.json(subs.map((sub) => toPublicSubscription(sub)));
  });

  app.get("/api/plans/:id", requireAuth, async (req: Request, res: Response) => {
    const planId = req.params.id as string;
    const plan = await storage.getPlanById(planId);
    if (!plan || plan.userId !== req.session.userId) {
      return res.status(404).json({ message: "Plan not found" });
    }
    return res.json(toPublicPlan(plan));
  });

  app.get("/api/subscriptions/check/:planId/:payerAddress", async (req: Request, res: Response) => {
    const payerAddress = String(req.params.payerAddress || "");
    if (!WALLET_ADDRESS_REGEX.test(payerAddress)) {
      return res.status(400).json({ message: "Invalid wallet address" });
    }

    const plan = await storage.getPlanById(req.params.planId as string);
    const chainType: ChainType = (plan?.chainType as ChainType) || "evm";
    const sub = await storage.getSubscription(req.params.planId as string, req.params.payerAddress as string, chainType);
    if (!sub) {
      return res.json(null);
    }
    // Intentionally return only minimal subscription status by (planId, payerAddress) to avoid
    // accidental duplicate on-chain activations when payer-token cookies are unavailable.
    return res.json({
      id: sub.id,
      planId: sub.planId,
      isActive: sub.isActive,
      onChainSubscriptionId: sub.onChainSubscriptionId,
      firstPaymentAmount: sub.firstPaymentAmount,
    });
  });


  app.post("/api/subscriptions", async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        planId: z.string().min(1),
        payerAddress: z.string().regex(WALLET_ADDRESS_REGEX, "Invalid wallet address"),
        firstPaymentAmount: z.string().refine((v) => !isNaN(Number(v)) && Number(v) > 0, "Invalid amount"),
        firstPaymentTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Invalid transaction hash"),
        approvalTxHash: z.string().optional(),
        approvedAmount: z.string().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }

      const plan = await storage.getPlanById(parsed.data.planId);
      if (!plan) {
        return res.status(404).json({ message: "Plan not found" });
      }

      const payerLc = parsed.data.payerAddress.toLowerCase();

      // Do not trust client-supplied on-chain ids or amounts; verify the activation on-chain.
      const verified = await verifyActivationTx(
        plan,
        payerLc,
        parsed.data.firstPaymentAmount,
        parsed.data.firstPaymentTxHash
      );
      const normalizedOnChainId = verified.onChainId;
      const nextDue = new Date(verified.blockTimestampMs + getIntervalMs(plan.intervalValue, plan.intervalUnit));

      const issuedPayerToken = issuePayerToken();

      const existing = await storage.getSubscription(parsed.data.planId, payerLc);
      if (existing) {
        // Allow a payer to resubscribe if their previous subscription was cancelled/inactive.
        if (!existing.isActive) {
          const updated = await storage.reactivateSubscriptionWithActivation(
            existing.id,
            parsed.data.firstPaymentAmount,
            parsed.data.firstPaymentTxHash,
            parsed.data.approvalTxHash ?? null,
            parsed.data.approvedAmount ?? null,
            issuedPayerToken.hash,
            issuedPayerToken.expiresAt,
            normalizedOnChainId,
            nextDue,
            plan.recurringAmount || plan.intervalAmount,
            plan.intervalValue,
            plan.intervalUnit
          );
          if (!updated) {
            return res.status(404).json({ message: "Subscription not found" });
          }
          try {
            await storage.createSchedulerLog(
              updated.id,
              "started",
              parsed.data.firstPaymentTxHash,
              "Session started. Waiting for next scheduled transaction."
            );
          } catch (logErr: any) {
            console.warn(`[subscriptions] failed to write started log for ${updated.id}: ${logErr?.message || logErr}`);
          }
          setPayerTokenCookies(res, updated.id, issuedPayerToken.token, isProduction);
          return res.json({ subscription: toPublicSubscription(updated) });
        }
        return res.status(409).json({ message: "Subscription already exists", subscription: toPublicSubscription(existing) });
      }

      let created: Subscription;
      try {
        created = await storage.createSubscription({
          planId: parsed.data.planId,
          payerAddress: payerLc,
          payerTokenHash: issuedPayerToken.hash,
          payerTokenExpiresAt: issuedPayerToken.expiresAt,
          firstPaymentAmount: parsed.data.firstPaymentAmount,
          firstPaymentTxHash: parsed.data.firstPaymentTxHash,
          approvalTxHash: parsed.data.approvalTxHash,
          approvedAmount: parsed.data.approvedAmount,
          onChainSubscriptionId: normalizedOnChainId,
          // Lock in the plan's current billing terms at activation time for audit trail
          recurringAmount: plan.recurringAmount || plan.intervalAmount,
          intervalValue: plan.intervalValue,
          intervalUnit: plan.intervalUnit,
        });
      } catch (err: any) {
        if (String(err?.code || "") === "23505") {
          const dup = await storage.getSubscription(parsed.data.planId, payerLc);
          return res.status(409).json({
            message: "Subscription already exists",
            subscription: dup ? toPublicSubscription(dup) : null,
          });
        }
        throw err;
      }

      const updated = await storage.setNextPaymentDue(created.id, nextDue);
      const finalSub = updated || created;
      try {
        await storage.createSchedulerLog(
          finalSub.id,
          "started",
          parsed.data.firstPaymentTxHash,
          "Session started. Waiting for next scheduled transaction."
        );
      } catch (logErr: any) {
        console.warn(`[subscriptions] failed to write started log for ${finalSub.id}: ${logErr?.message || logErr}`);
      }
      setPayerTokenCookies(res, finalSub.id, issuedPayerToken.token, isProduction);
      return res.json({ subscription: toPublicSubscription(finalSub) });
    } catch (err: any) {
      const message = err?.message || "Failed to create subscription";
      console.error(`[subscriptions] Execution error for plan ${req.body.planId}: ${message}`);
      if (isRpcConnectivityError(err)) {
        return res.status(503).json({
          message: "Network RPC is temporarily unavailable. Please try again soon.",
        });
      }
      return res.status(400).json({ message });
    }
  });

  app.patch("/api/subscriptions/:id/approval", async (req: Request, res: Response) => {
    const schema = z.object({
      approvalTxHash: z.string(),
      approvedAmount: z.string().min(1),
      onChainSubscriptionId: z.string(),
      payerAddress: z.string().regex(WALLET_ADDRESS_REGEX, "Invalid wallet address").optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0].message });
    }

    const existingSub = await storage.getSubscriptionById(req.params.id as string);
    if (!existingSub) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    if (!(await hasSubscriptionAccess(req, existingSub))) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // Do not trust the client-supplied on-chain id; ensure it belongs to this payer + plan.
    if (existingSub.planId) {
      const plan = await storage.getPlanById(existingSub.planId);
      if (plan) {
        try {
          await verifyOnChainSubscription(plan, existingSub.payerAddress, parsed.data.onChainSubscriptionId, existingSub.recurringAmount, existingSub.intervalValue, existingSub.intervalUnit);
        } catch (err: any) {
          if (isRpcConnectivityError(err)) {
            return res.status(503).json({ message: "Network RPC is temporarily unavailable. Please try again." });
          }
          return res.status(400).json({ message: err?.message || "Invalid on-chain subscription id" });
        }
      }
    }

    const sub = await storage.updateSubscriptionApproval(
      req.params.id as string,
      parsed.data.approvalTxHash,
      parsed.data.approvedAmount,
      parsed.data.onChainSubscriptionId
    );
    if (!sub) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    if (parsed.data.onChainSubscriptionId && sub.planId) {
      const plan = await storage.getPlanById(sub.planId);
      if (plan) {
        const intervalMs = getIntervalMs(plan.intervalValue, plan.intervalUnit);
        // Default to server time; try to sync with authoritative on-chain nextPaymentTime
        let nextDue = new Date(Date.now() + intervalMs);
        try {
          const chainType: ChainType = (plan.chainType as ChainType) ?? detectChainType(plan.networkId);
          const contractAddr = getContractAddrForPlan(plan);
          if (contractAddr) {
            const { getChainAdapter } = await import("./chain-adapter");
            const adapter = await getChainAdapter(chainType, plan.networkId);
            const onChainSub = await adapter.getSubscription(contractAddr, parsed.data.onChainSubscriptionId);
            const nextPaymentTime = Number(onChainSub?.nextPaymentTime ?? 0);
            if (Number.isFinite(nextPaymentTime) && nextPaymentTime > 0) {
              nextDue = new Date(nextPaymentTime * 1000);
            }
          }
        } catch {
          // keep server-time fallback
        }
        await storage.setNextPaymentDue(sub.id, nextDue);
      }
    }

    await rotatePayerTokenForSubscription(res, sub.id);
    return res.json(toPublicSubscription(sub));
  });

  app.post("/api/subscriptions/:id/tx", async (req: Request, res: Response) => {
    const { txHash, payerAddress } = req.body;
    if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      return res.status(400).json({ message: "Valid transaction hash required" });
    }

    if (payerAddress !== undefined && (typeof payerAddress !== "string" || !WALLET_ADDRESS_REGEX.test(payerAddress))) {
      return res.status(400).json({ message: "Valid wallet address required" });
    }

    const existingSub = await storage.getSubscriptionById(req.params.id as string);
    if (!existingSub) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    if (!(await hasSubscriptionAccess(req, existingSub))) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (payerAddress && payerAddress.toLowerCase() !== existingSub.payerAddress.toLowerCase()) {
      return res.status(400).json({ message: "payerAddress does not match this subscription" });
    }

    if (!existingSub.planId) {
      return res.status(409).json({ message: "Subscription is not linked to a plan" });
    }
    if (!existingSub.onChainSubscriptionId) {
      return res.status(409).json({ message: "Subscription is not active on-chain" });
    }

    const plan = await storage.getPlanById(existingSub.planId);
    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }

    let verifiedExecution: { blockTimestampMs: number };
    try {
      verifiedExecution = await verifyExecutionTx(
        plan,
        existingSub.payerAddress,
        existingSub.onChainSubscriptionId,
        txHash,
        existingSub.recurringAmount
      );
    } catch (err: any) {
      if (isRpcConnectivityError(err)) {
        return res.status(503).json({ message: "Network RPC is temporarily unavailable. Please try again." });
      }
      return res.status(400).json({ message: err?.message || "Invalid execution transaction" });
    }

    const nextDue = new Date(verifiedExecution.blockTimestampMs + getIntervalMs(plan.intervalValue, plan.intervalUnit));
    const sub = await storage.updateSubscriptionExecution(req.params.id as string, txHash, nextDue);
    if (!sub) {
      return res.status(404).json({ message: "Subscription not found" });
    }
    await rotatePayerTokenForSubscription(res, sub.id);
    return res.json(toPublicSubscription(sub));
  });

  app.patch("/api/subscriptions/:id/cancel", async (req: Request, res: Response) => {
    const sub = await storage.getSubscriptionById(req.params.id as string);
    if (!sub) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    if (!(await hasSubscriptionCancelAccess(req, sub))) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const updated = await storage.cancelSubscription(req.params.id as string);
    if (updated) {
      clearPayerTokenCookies(res, updated.id, isProduction);
    }
    return res.json(updated ? toPublicSubscription(updated) : null);
  });

  // Cancel in DB and attempt to cancel on-chain using the deployer/owner key (no user wallet popup).
  app.patch("/api/subscriptions/:id/cancel-onchain", async (req: Request, res: Response) => {
    const sub = await storage.getSubscriptionById(req.params.id as string);
    if (!sub) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    if (!(await hasSubscriptionCancelAccess(req, sub))) {
      return res.status(403).json({ message: "Forbidden" });
    }

    let onChainCancelled = false;
    let onChainError: string | null = null;

    if (sub.onChainSubscriptionId && sub.planId) {
      const plan = await storage.getPlanById(sub.planId);
      const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;

      if (!plan) {
        onChainError = "Plan not found for on-chain cancellation.";
      } else if (!deployerKey) {
        onChainError = "DEPLOYER_PRIVATE_KEY not configured.";
      } else {
        const contractAddr = getContractAddrForPlan(plan);
        const isTronPlan = plan.chainType === "tron";
        const rpcUrls = isTronPlan ? [] : getRpcUrls(plan.networkId);

        if (!contractAddr) {
          onChainError = "Subscription contract address not configured for this network.";
        } else if (!isTronPlan && rpcUrls.length === 0) {
          onChainError = `No RPC endpoint configured for network ${plan.networkName} (${plan.networkId}).`;
        } else if (isTronPlan) {
          try {
            const { getChainAdapter } = await import("./chain-adapter");
            const adapter = await getChainAdapter("tron", plan.networkId);
            await adapter.cancelSubscription(contractAddr, sub.onChainSubscriptionId!, deployerKey!);
            onChainCancelled = true;
          } catch (err: any) {
            onChainError = err?.message || String(err || "Unknown error");
            try {
              await storage.createSchedulerLog(sub.id, "error", undefined, `On-chain cancel failed: ${onChainError}`);
            } catch { /* ignore */ }
          }
        } else {
          let lastErr: any = null;

          for (const rpcUrl of rpcUrls) {
            try {
              const provider = makeJsonRpcProvider(rpcUrl, plan.networkId);
              const wallet = new Wallet(deployerKey!, provider);
              const contract = new Contract(contractAddr, SUBSCRIPTION_CONTRACT_ABI, wallet);
              const tx = await contract.cancelSubscription(BigInt(sub.onChainSubscriptionId));
              await tx.wait(TX_CONFIRMATIONS);
              onChainCancelled = true;
              break;
            } catch (err: any) {
              lastErr = err;
              if (!isRpcConnectivityError(err)) {
                break;
              }
            }
          }

          if (!onChainCancelled) {
            onChainError = lastErr?.message || String(lastErr || "Unknown error");
            try {
              await storage.createSchedulerLog(sub.id, "error", undefined, `On-chain cancel failed: ${onChainError}`);
            } catch { /* ignore */ }
          }
        }
      }
    }

    if (sub.onChainSubscriptionId && !onChainCancelled) {
      return res.status(409).json({
        message: "On-chain cancellation failed. Subscription is still active on-chain.",
        onChainCancelled,
        onChainError,
      });
    }

    const updated = await storage.cancelSubscription(req.params.id as string);
    if (updated) {
      clearPayerTokenCookies(res, updated.id, isProduction);
    }
    return res.json({
      subscription: updated ? toPublicSubscription(updated) : null,
      onChainCancelled,
      onChainError,
    });
  });

  app.get("/api/subscriptions/:id", async (req: Request, res: Response) => {
    const sub = await storage.getSubscriptionById(req.params.id as string);
    if (!sub) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    if (!(await hasSubscriptionAccess(req, sub))) {
      return res.status(403).json({ message: "Forbidden" });
    }

    return res.json(toPublicSubscription(sub));
  });

  app.get("/api/subscriptions/:id/logs", async (req: Request, res: Response) => {
    const sub = await storage.getSubscriptionById(req.params.id as string);
    if (!sub) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    if (!(await hasSubscriptionAccess(req, sub))) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const logs = await storage.getSchedulerLogs(req.params.id as string);
    return res.json(logs);
  });
  // â”€â”€ QR Signing endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Generate a signed QR payload for a plan (authenticated)
  app.get("/api/plans/:id/signed-qr", requireAuth, async (req: Request, res: Response) => {
    const plan = await storage.getPlanById(req.params.id as string);
    if (!plan) return res.status(404).json({ message: "Plan not found" });
    if (plan.userId !== req.session.userId) return res.status(403).json({ message: "Forbidden" });

    const payload = signQrPayload(plan);
    return res.json(payload);
  });

  // Verify a signed QR payload and return plan data (public)
  app.post("/api/qr/verify", async (req: Request, res: Response) => {
    const payload = req.body;
    if (!payload?.v || !payload?.planId || !payload?.sig) {
      return res.status(400).json({ message: "Invalid QR payload format" });
    }

    try {
      await verifyQrPayload(
        payload,
        (nonce, planId, expiresAt) => storage.recordQrNonce(nonce, planId, expiresAt),
        (nonce) => storage.isQrNonceUsed(nonce)
      );
    } catch (err: any) {
      return res.status(400).json({ message: err.message || "QR verification failed" });
    }

    const plan = await storage.getPlanByCode(payload.planCode);
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    // Warn if plan version has changed since QR was generated
    const versionChanged = plan.planVersion !== payload.planVersion;

    return res.json({
      valid: true,
      versionChanged,
      currentPlanVersion: plan.planVersion,
      planCode: plan.planCode,
    });
  });

  // Get plan version history (authenticated)
  app.get("/api/plans/:id/versions", requireAuth, async (req: Request, res: Response) => {
    const plan = await storage.getPlanById(req.params.id as string);
    if (!plan) return res.status(404).json({ message: "Plan not found" });
    if (plan.userId !== req.session.userId) return res.status(403).json({ message: "Forbidden" });

    const versions = await storage.getPlanVersions(plan.id);
    return res.json(versions);
  });

  /**
   * POST /api/subscriptions/verify-tron
   * Called by pay-tron.tsx after the subscriber's activate() tx is solidified on TRON.
   * Verifies the tx on-chain via TronChainAdapter, then creates/reactivates a subscription record.
   * Public endpoint (no session required) â€” trust is established by on-chain verification.
   */
  app.post("/api/subscriptions/verify-tron", async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        planId: z.string().min(1),
        txHash: z.string().min(1, "Transaction hash is required"),
        payerAddress: z.string().regex(
          /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
          "Invalid TRON wallet address"
        ),
        networkId: z.string().min(1),
        firstPaymentAmount: z
          .string()
          .optional()
          .refine((value) => value === undefined || (!Number.isNaN(Number(value)) && Number(value) >= 0), "Invalid first payment amount"),
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }

      const { planId, txHash, payerAddress, networkId } = parsed.data;

      const plan = await storage.getPlanById(planId);
      if (!plan) return res.status(404).json({ message: "Plan not found" });

      if ((plan.chainType as string) !== "tron") {
        return res.status(400).json({ message: "Plan is not a TRON plan" });
      }

      if (plan.networkId !== networkId) {
        return res.status(400).json({ message: "Network ID does not match plan" });
      }

      const { getChainAdapter } = await import("./chain-adapter");
      const adapter = await getChainAdapter("tron", plan.networkId);

      const contractAddress = (await import("../shared/tron-contracts")).getTronContractForNetwork(plan.networkId)
        ?? plan.contractAddress;
      if (!contractAddress) {
        return res.status(400).json({ message: "No TRON subscription contract configured for this network" });
      }

      const expectedRecurringAmount = parseUnits(
        plan.recurringAmount || plan.intervalAmount,
        plan.tokenDecimals || 6
      ).toString();
      const expectedInterval = String(getIntervalSeconds(plan.intervalValue, plan.intervalUnit));

      // Verify the activation transaction on-chain (parses SubscriptionCreated event and all params)
      const verified = await adapter.verifyActivationTx(
        txHash,
        contractAddress,
        payerAddress,
        plan.walletAddress,
        plan.tokenAddress || undefined,
        expectedRecurringAmount,
        expectedInterval
      );
      if (!verified) {
        return res.status(400).json({ message: "Could not verify TRON activation transaction. Ensure it matches the requested plan and has finished solidifying." });
      }

      const { subscriptionId: onChainSubscriptionId, blockTimestampMs } = verified;
      const onChainSubscription = await adapter.getSubscription(contractAddress, onChainSubscriptionId);
      const normalizedPayer = normalizeAddress(payerAddress, "tron");
      const normalizedReceiver = normalizeAddress(plan.walletAddress, "tron");
      const normalizedToken = normalizeAddress(plan.tokenAddress || "", "tron");

      // Double-check everything from getSubscription (redundancy for security)
      if (normalizeAddress(onChainSubscription.sender, "tron") !== normalizedPayer) {
        return res.status(400).json({ message: "TRON activation sender does not match payer address" });
      }
      if (normalizeAddress(onChainSubscription.receiver, "tron") !== normalizedReceiver) {
        return res.status(400).json({ message: "TRON activation receiver does not match the plan wallet" });
      }
      if (normalizeAddress(onChainSubscription.token, "tron") !== normalizedToken) {
        return res.status(400).json({ message: "TRON activation token does not match the plan token" });
      }
      if (String(onChainSubscription.amount) !== expectedRecurringAmount) {
        return res.status(400).json({ message: "TRON activation recurring amount does not match the plan" });
      }
      if (String(onChainSubscription.interval) !== expectedInterval) {
        return res.status(400).json({ message: "TRON activation interval does not match the plan" });
      }

      const nextDue =
        Number(onChainSubscription.nextPaymentTime) > 0
          ? new Date(Number(onChainSubscription.nextPaymentTime) * 1000)
          : new Date(blockTimestampMs + getIntervalMs(plan.intervalValue, plan.intervalUnit));
      const firstPaymentAmount = parsed.data.firstPaymentAmount || plan.recurringAmount || plan.intervalAmount || "0";

      const issuedPayerToken = issuePayerToken();

      // Check for existing subscription (allow reactivation if previously cancelled)
      const existing = await storage.getSubscription(planId, payerAddress, "tron");
      if (existing) {
        if (!existing.isActive) {
          const updated = await storage.reactivateSubscriptionWithActivation(
            existing.id,
            firstPaymentAmount,
            txHash,
            null,
            null,
            issuedPayerToken.hash,
            issuedPayerToken.expiresAt,
            onChainSubscriptionId,
            nextDue,
            plan.recurringAmount || plan.intervalAmount,
            plan.intervalValue,
            plan.intervalUnit
          );
          if (!updated) return res.status(404).json({ message: "Subscription not found" });
          try {
            await storage.createSchedulerLog(updated.id, "started", txHash, "TRON subscription activated.");
          } catch { /* non-critical */ }
          setPayerTokenCookies(res, updated.id, issuedPayerToken.token, isProduction);
          return res.json(toPublicSubscription(updated));
        }
        return res.status(409).json({ message: "Subscription already active", subscription: toPublicSubscription(existing) });
      }

      // Create new subscription record
      let created: Subscription;
      try {
        created = await storage.createSubscription({
          planId,
          payerAddress,
          payerTokenHash: issuedPayerToken.hash,
          payerTokenExpiresAt: issuedPayerToken.expiresAt,
          firstPaymentAmount,
          firstPaymentTxHash: txHash,
          approvalTxHash: txHash,
          approvedAmount: null,
          onChainSubscriptionId,
          // Lock in the plan's current billing terms at activation time
          recurringAmount: plan.recurringAmount || plan.intervalAmount,
          intervalValue: plan.intervalValue,
          intervalUnit: plan.intervalUnit,
        }, "tron");
      } catch (err: any) {
        if (String(err?.code || "") === "23505") {
          const dup = await storage.getSubscription(planId, payerAddress, "tron");
          return res.status(409).json({ message: "Subscription already exists", subscription: dup ? toPublicSubscription(dup) : null });
        }
        throw err;
      }

      const finalSub = (await storage.setNextPaymentDue(created.id, nextDue)) || created;
      try {
        await storage.createSchedulerLog(finalSub.id, "started", txHash, "TRON subscription activated. Waiting for next scheduled charge.");
      } catch { /* non-critical */ }

      setPayerTokenCookies(res, finalSub.id, issuedPayerToken.token, isProduction);
      return res.json(toPublicSubscription(finalSub));
    } catch (err: any) {
      const userMessage = err?.message || "Failed to verify TRON subscription";
      const isUserError = /invalid|not found|does not match|too early|not a tron|network id/i.test(userMessage);
      const statusCode = isUserError ? 400 : 500;
      if (statusCode === 500 && !isUserError) {
        console.error("[verify-tron] Unexpected error:", err);
      }
      return res.status(statusCode).json({ message: userMessage });
    }
  });

  app.get("/sdk/v1.js", (_req: Request, res: Response) => {
    const host = process.env.SDK_HOST || (_req.headers.host ? `${_req.protocol || "https"}://${_req.headers.host}` : "");
    const script = buildSdkScript(host);
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(script);
  });

  /**
   * POST /api/sdk/heartbeat
   * Called by the embedded script every 60 seconds.
   * Records origin + logs last seen. Returns key status.
   * Public endpoint â€” no auth required (uses api key in body).
   */
  app.post("/api/sdk/heartbeat", async (req: Request, res: Response) => {
    const schema = z.object({ key: z.string().min(1), origin: z.string().max(500) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid request" });

    const { key, origin } = parsed.data;
    const sdkKey = await storage.getSdkKeyByApiKey(key);
    if (!sdkKey) return res.status(404).json({ status: "invalid_key" });

    const fwd = req.headers["x-forwarded-for"];
    const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null;
    const userAgent = (req.headers["user-agent"] ?? null) as string | null;

    // Record installation (upsert by origin)
    try {
      await storage.upsertSdkInstallation(sdkKey.id, origin, ip, userAgent);
    } catch { /* non-critical */ }

    return res.json({ status: sdkKey.status, suspendReason: sdkKey.suspendReason ?? null });
  });

  /**
   * GET /api/sdk/keys
   * List all SDK keys for the logged-in merchant.
   */
  app.get("/api/sdk/keys", requireAuth, async (req: Request, res: Response) => {
    const keys = await storage.getSdkKeys(req.session.userId!);
    return res.json(keys);
  });

  /**
   * POST /api/sdk/keys
   * Create a new SDK key.
   */
  app.post("/api/sdk/keys", requireAuth, async (req: Request, res: Response) => {
    const schema = z.object({ label: z.string().max(80).optional() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid request" });

    const existing = await storage.getSdkKeys(req.session.userId!);
    if (existing.length >= 10) return res.status(409).json({ message: "Maximum 10 SDK keys per account" });

    const key = await storage.createSdkKey(req.session.userId!, parsed.data.label);
    return res.json(key);
  });

  /**
   * PATCH /api/sdk/keys/:id/status
   * Change key status: active | suspended | payment_required
   */
  app.patch("/api/sdk/keys/:id/status", requireAuth, async (req: Request, res: Response) => {
    const schema = z.object({
      status: z.enum(["active", "suspended", "payment_required"]),
      reason: z.string().max(200).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid status" });

    const updated = await storage.updateSdkKeyStatus(String(req.params.id), req.session.userId!, parsed.data.status, parsed.data.reason);
    if (!updated) return res.status(404).json({ message: "Key not found" });
    return res.json(updated);
  });

  /**
   * DELETE /api/sdk/keys/:id
   * Delete an SDK key.
   */
  app.delete("/api/sdk/keys/:id", requireAuth, async (req: Request, res: Response) => {
    const ok = await storage.deleteSdkKey(String(req.params.id), req.session.userId!);
    if (!ok) return res.status(404).json({ message: "Key not found" });
    return res.json({ message: "Key deleted" });
  });

  /**
   * GET /api/sdk/installations
   * All usage records for all keys owned by this merchant.
   */
  app.get("/api/sdk/installations", requireAuth, async (req: Request, res: Response) => {
    const rows = await storage.getAllSdkInstallationsForUser(req.session.userId!);
    return res.json(rows);
  });

  /**
   * GET /api/sdk/installations/:keyId
   * Usage records for a specific key.
   */
  app.get("/api/sdk/installations/:keyId", requireAuth, async (req: Request, res: Response) => {
    // Verify key ownership
    const keys = await storage.getSdkKeys(req.session.userId!);
    const key = keys.find((k) => k.id === String(req.params.keyId));
    if (!key) return res.status(404).json({ message: "Key not found" });

    const rows = await storage.getSdkInstallations(String(req.params.keyId));
    return res.json(rows);
  });

  /**
   * GET /api/cron/tick  — invoked by Vercel cron (sends GET)
   * POST /api/cron/tick — invoked manually or by external cron services
   * External trigger for the scheduler, essential for Serverless deployments.
   * Secured by CRON_SECRET environment variable when set.
   */
  const cronTickHandler = async (req: Request, res: Response) => {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ message: "Unauthorized cron request" });
    }

    // Trigger the tick asynchronously without blocking the response
    runSchedulerTick().catch(err => {
      console.error("[Cron] Error executing tick:", err);
    });

    return res.json({ message: "Tick initiated", timestamp: Date.now() });
  };

  // Vercel cron jobs send GET; manual/external triggers may use POST
  app.get("/api/cron/tick", cronTickHandler);
  app.post("/api/cron/tick", cronTickHandler);
}
