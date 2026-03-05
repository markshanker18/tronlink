import type { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import { storage } from "./storage";
import { loginSchema, type Subscription, type Plan, normalizeAddress, compareAddresses, isValidAddress, EVM_ADDRESS_REGEX, TRON_ADDRESS_REGEX } from "../shared/schema";
import { isAllowedVideoUrl } from "../shared/video";
import bcrypt from "bcrypt";
import connectPgSimple from "connect-pg-simple";
import { z } from "zod";
import { encrypt, decrypt } from "./crypto";
import { createHash, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { Wallet, Contract, Interface, formatUnits, id as keccak256Id, parseUnits } from "ethers";
import { SUBSCRIPTION_CONTRACT_ABI, getContractForNetwork } from "../shared/contracts";
import { runSchedulerTick } from "./scheduler";
import { getRpcUrls, isRpcConnectivityError, makeJsonRpcProvider, RpcUnavailableError } from "./rpc";
import { applyReceiverSwitchWithRollback, type WalletSwitchTarget } from "./wallet-switch";
import { verifyTronTx } from "./tron";

function getIntervalMs(value: number, unit: string): number {
  const multipliers: Record<string, number> = {
    sec: 1000,
    min: 60 * 1000,
    hrs: 3600 * 1000,
    days: 86400 * 1000,
    months: 2592000 * 1000,
  };
  return value * (multipliers[unit] || 1000);
}

function getIntervalSeconds(value: number, unit: string): number {
  const multipliers: Record<string, number> = {
    sec: 1,
    min: 60,
    hrs: 3600,
    days: 86400,
    months: 2592000,
  };
  return value * (multipliers[unit] || 1);
}

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

function createRateLimiter(windowMs: number, max: number, keyFn?: (req: Request) => string) {
  const entries = new Map<string, RateLimitEntry>();

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
  TRX: "tron",
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

async function fetchUsdPrice(symbol: string): Promise<number | null> {
  const id = COINGECKO_ID_BY_SYMBOL[symbol.toUpperCase()];
  if (!id) return null;

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
    return Number.isFinite(value) && value > 0 ? value : null;
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


function getBigintString(value: unknown): string {
  try {
    return BigInt(value as any).toString();
  } catch {
    return String(value ?? "");
  }
}

async function verifyActivationTx(plan: Plan, payerAddress: string, firstPaymentAmount: string, txHash: string): Promise<{
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

      if (!receipt.to || !compareAddresses(receipt.to, contractAddr)) {
        throw new Error("Activation transaction was not sent to the subscription contract");
      }

      if (!compareAddresses(receipt.from, payerAddress)) {
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

      if (!compareAddresses(sender, payerAddress)) {
        throw new Error("Activation sender mismatch");
      }

      if (!compareAddresses(receiver, plan.walletAddress)) {
        throw new Error("Activation receiver does not match plan wallet address");
      }

      if (!compareAddresses(token, plan.tokenAddress)) {
        throw new Error("Activation token does not match plan token");
      }

      const decimals = plan.tokenDecimals || 18;
      const expectedRecurring = parseUnits(plan.recurringAmount || plan.intervalAmount, decimals).toString();
      if (recurringAmountWei !== expectedRecurring) {
        throw new Error("Activation recurring amount does not match plan");
      }

      const expectedInterval = String(getIntervalSeconds(plan.intervalValue, plan.intervalUnit));
      if (intervalSeconds !== expectedInterval) {
        throw new Error("Activation interval does not match plan");
      }

      const expectedInitialWei = parseUnits(firstPaymentAmount, decimals).toString();
      const initialTransfer = receipt.logs.find((log) => {
        if (!compareAddresses(log.address, plan.tokenAddress!)) return false;
        if (!log.topics?.length) return false;
        if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) return false;
        try {
          const t = transferIface.parseLog(log);
          if (!t) return false;
          const from = String(t.args?.from ?? "");
          const to = String(t.args?.to ?? "");
          const value = getBigintString(t.args?.value);
          return (
            compareAddresses(from, payerAddress) &&
            compareAddresses(to, plan.walletAddress) &&
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

async function verifyOnChainSubscription(plan: Plan, payerAddress: string, onChainSubscriptionId: string): Promise<void> {
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

      if (!compareAddresses(sender, payerAddress)) {
        throw new Error("On-chain sender mismatch");
      }
      if (!compareAddresses(receiver, plan.walletAddress)) {
        throw new Error("On-chain receiver does not match plan wallet address");
      }
      if (!compareAddresses(token, plan.tokenAddress)) {
        throw new Error("On-chain token does not match plan token");
      }

      const decimals = plan.tokenDecimals || 18;
      const expectedRecurring = parseUnits(plan.recurringAmount || plan.intervalAmount, decimals).toString();
      if (amount !== expectedRecurring) {
        throw new Error("On-chain recurring amount does not match plan");
      }

      const expectedInterval = String(getIntervalSeconds(plan.intervalValue, plan.intervalUnit));
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
  txHash: string
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

      if (!receipt.to || !compareAddresses(receipt.to, contractAddr)) {
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
      if (!compareAddresses(sender, payerAddress)) {
        throw new Error("Execution transaction payer mismatch");
      }
      if (!compareAddresses(receiver, plan.walletAddress)) {
        throw new Error("Execution transaction receiver mismatch");
      }

      const decimals = plan.tokenDecimals || 18;
      const expectedRecurring = parseUnits(plan.recurringAmount || plan.intervalAmount, decimals).toString();
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

const PLAN_INTERVAL_UNITS = ["sec", "min", "hrs", "days", "months"] as const;
const createPlanRequestSchema = z.object({
  planName: z.string().trim().min(1, "Plan name is required").max(120, "Plan name is too long"),
  walletAddress: z.string().trim().refine(isValidAddress, "Invalid wallet address (EVM or TRON)"),
  networkId: z.string().trim().min(1, "Network id is required"),
  networkName: z.string().trim().min(1, "Network name is required").max(120, "Network name is too long"),
  tokenAddress: z.string().trim().refine(isValidAddress, "Invalid token address (EVM or TRON)"),
  tokenSymbol: z.string().trim().min(1, "Token symbol is required").max(24, "Token symbol is too long"),
  tokenDecimals: z.number().int().min(0, "Token decimals must be >= 0").max(36, "Token decimals too large"),
  intervalAmount: z.string().trim().refine((v) => !Number.isNaN(Number(v)) && Number(v) > 0, "Invalid interval amount"),
  intervalValue: z.number().int().positive("Interval must be positive"),
  intervalUnit: z.enum(PLAN_INTERVAL_UNITS),
  contractAddress: z.string().trim().refine(isValidAddress, "Invalid contract address").optional(),
  videoUrl: z.string().trim().optional(),
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
  walletAddress: string | null;
  walletNetwork: string | null;
}) {
  return {
    id: user.id,
    username: user.username,
    walletAddress: user.walletAddress,
    walletNetwork: user.walletNetwork,
  };
}

function getPayerTokenHint(req: Request, subId?: string): string | undefined {
  const cookies = parseCookies(req);
  if (subId) {
    const subScoped = cookies[`payer_token_${subId}`];
    if (typeof subScoped === "string" && subScoped.length > 0) return subScoped;
  }
  if (typeof cookies.payer_token === "string" && cookies.payer_token.length > 0) {
    return cookies.payer_token;
  }

  const header = req.headers["x-payer-token"];
  if (typeof header === "string") return header;
  if (Array.isArray(header)) return header[0];
  if (typeof req.body?.payerToken === "string") return req.body.payerToken;
  return undefined;
}

function setPayerTokenCookies(res: Response, subscriptionId: string, payerToken: string, isProduction: boolean): void {
  const common = {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    maxAge: PAYER_TOKEN_TTL_MS,
  };

  res.cookie("payer_token", payerToken, { ...common, path: "/api/subscriptions" });
  res.cookie(`payer_token_${subscriptionId}`, payerToken, { ...common, path: `/api/subscriptions/${subscriptionId}` });
}

function clearPayerTokenCookies(res: Response, subscriptionId: string, isProduction: boolean): void {
  const common = {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
  };

  res.clearCookie("payer_token", { ...common, path: "/api/subscriptions" });
  res.clearCookie(`payer_token_${subscriptionId}`, { ...common, path: `/api/subscriptions/${subscriptionId}` });
}

async function hasSubscriptionAccess(req: Request, sub: Subscription): Promise<boolean> {
  if (req.session.userId) {
    const plan = await storage.getPlanById(sub.planId);
    if (plan?.userId === req.session.userId) {
      return true;
    }
  }

  const payerToken = getPayerTokenHint(req, sub.id);
  const expiresAtMs = sub.payerTokenExpiresAt ? new Date(sub.payerTokenExpiresAt).getTime() : 0;
  if (payerToken && sub.payerTokenHash && expiresAtMs > Date.now()) {
    if (hashPayerToken(payerToken) === sub.payerTokenHash) {
      return true;
    }
  }
  return false;
}

async function hasSubscriptionCancelAccess(req: Request, sub: Subscription): Promise<boolean> {
  if (req.session.userId) {
    const plan = await storage.getPlanById(sub.planId);
    if (plan?.userId === req.session.userId) {
      return true;
    }
  }

  const payerToken = getPayerTokenHint(req, sub.id);
  const expiresAtMs = sub.payerTokenExpiresAt ? new Date(sub.payerTokenExpiresAt).getTime() : 0;
  if (!payerToken || !sub.payerTokenHash || expiresAtMs <= Date.now()) {
    return false;
  }

  return hashPayerToken(payerToken) === sub.payerTokenHash;
}

export async function registerRoutes(app: Express): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET environment variable is required");
  }

  const isProduction = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
  const PgStore = connectPgSimple(session);
  const authRateLimiter = createRateLimiter(
    15 * 60 * 1000,
    12,
    (req) => `${req.ip || "unknown"}:${String(req.body?.username || "").toLowerCase()}`
  );

  const rotatePayerTokenForSubscription = async (res: Response, subscriptionId: string): Promise<void> => {
    const next = issuePayerToken();
    await storage.updatePayerToken(subscriptionId, next.hash, next.expiresAt);
    setPayerTokenCookies(res, subscriptionId, next.token, isProduction);
  };

  app.use(
    session({
      store: new PgStore({
        conString: databaseUrl,
        createTableIfMissing: true,
      }),
      secret: sessionSecret,
      proxy: isProduction,
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
      },
    })
  );

  app.get("/api/local-ip", (_req: Request, res: Response) => {
    try {
      const nets = networkInterfaces();
      let localIp: string | null = null;
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] ?? []) {
          // Skip loopback, non-IPv4
          if (net.family === "IPv4" && !net.internal) {
            localIp = net.address;
            break;
          }
        }
        if (localIp) break;
      }
      return res.json({ ip: localIp });
    } catch {
      return res.json({ ip: null });
    }
  });

  app.get("/api/cron/scheduler", async (req: Request, res: Response) => {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      return res.status(503).json({ message: "CRON_SECRET not configured" });
    }

    const authorization = req.headers.authorization;
    if (authorization !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await runSchedulerTick();
    return res.json({ ok: true });
  });

  app.get("/api/quote", async (req: Request, res: Response) => {
    const tokenSymbol = String(req.query.tokenSymbol || "").trim().toUpperCase();
    const networkId = String(req.query.networkId || "").trim().toLowerCase();

    if (!tokenSymbol) {
      return res.status(400).json({ message: "tokenSymbol is required" });
    }

    const usdRate = await fetchUsdPrice(tokenSymbol);

    let gasFeeToken: string | null = null;
    if (networkId) {
      const rpcUrls = getRpcUrls(networkId);
      if (rpcUrls.length > 0) {
        try {
          const provider = makeJsonRpcProvider(rpcUrls[0], networkId);
          const feeData = await provider.getFeeData();
          const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
          if (gasPrice && gasPrice > 0n) {
            gasFeeToken = formatUnits(gasPrice * FEE_ESTIMATE_GAS_UNITS, 18);
          }
        } catch {
          // ignore and return partial quote
        }
      }
    }

    const gasFeeUsd =
      usdRate !== null && gasFeeToken !== null && Number.isFinite(Number(gasFeeToken))
        ? Number(gasFeeToken) * usdRate
        : null;

    return res.json({
      tokenSymbol,
      networkId: networkId || null,
      usdRate,
      gasFeeToken,
      gasFeeUsd,
      asOf: new Date().toISOString(),
      stale: usdRate === null || gasFeeToken === null,
    });
  });

  app.post("/api/auth/register", authRateLimiter, async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;
      const parsed = loginSchema.safeParse({ username, password });
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }

      const existing = await storage.getUserByUsername(parsed.data.username);
      if (existing) {
        return res.status(409).json({ message: "Username already taken" });
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
      return res.status(401).json({ message: "Not logged in" });
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
    if (!walletAddress || typeof walletAddress !== "string" || !isValidAddress(walletAddress)) {
      return res.status(400).json({ message: "Valid wallet address required" });
    }

    if (walletNetwork !== undefined && typeof walletNetwork !== "string") {
      return res.status(400).json({ message: "Wallet network must be a string" });
    }

    const user = await storage.updateUserWallet(
      req.session.userId!,
      normalizeAddress(walletAddress),
      walletNetwork ?? null,
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json(toPublicUser(user));
  });

  app.post("/api/auth/executor-key", requireAuth, async (req: Request, res: Response) => {
    try {
      const { privateKey } = req.body;
      if (!privateKey || typeof privateKey !== "string") {
        return res.status(400).json({ message: "Private key is required" });
      }
      const normalizedKey = privateKey.trim();
      if (!/^(0x)?[a-fA-F0-9]{64}$/.test(normalizedKey)) {
        return res.status(400).json({ message: "Invalid private key format" });
      }
      const encryptedKey = encrypt(normalizedKey);
      const updated = await storage.updateUserExecutorKey(req.session.userId!, encryptedKey);
      if (!updated) {
        return res.status(404).json({ message: "User not found" });
      }
      return res.json({ message: "Executor key saved", hasKey: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[auth/executor-key] Failed to save executor key:", message);
      if (message.includes("ENCRYPTION_MASTER_KEY") || message.includes("SESSION_SECRET")) {
        return res.status(500).json({ message });
      }
      return res.status(500).json({ message: "Failed to save executor key" });
    }
  });

  app.delete("/api/auth/executor-key", requireAuth, async (req: Request, res: Response) => {
    await storage.updateUserExecutorKey(req.session.userId!, null);
    return res.json({ message: "Executor key removed", hasKey: false });
  });

  app.get("/api/auth/executor-key", requireAuth, async (req: Request, res: Response) => {
    const encryptedKey = await storage.getUserExecutorKey(req.session.userId!);
    return res.json({ hasKey: !!encryptedKey });
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
      const subs = await storage.getAllSubscriptionsForUser(req.session.userId!);
      return res.json(subs.map((sub) => toPublicSubscription(sub as any)));
    } catch (err: any) {
      return res.status(500).json({ message: "Failed to fetch subscribers" });
    }
  });

  app.get("/api/dashboard/transactions", requireAuth, async (req: Request, res: Response) => {
    try {
      const logs = await storage.getAllSchedulerLogsForUser(req.session.userId!);
      return res.json(logs);
    } catch (err: any) {
      return res.status(500).json({ message: "Failed to fetch transactions" });
    }
  });

  app.get("/api/transactions/check", requireAuth, async (req: Request, res: Response) => {
    const schema = z.object({
      txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Valid transaction hash is required"),
      networkId: z.string().min(1, "networkId is required"),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0].message });
    }

    const txHash = parsed.data.txHash;
    const networkId = parsed.data.networkId;
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
        address: z.string().refine(isValidAddress, "Invalid wallet address"),
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
        address: normalizeAddress(parsed.data.address),
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
        console.log("[plans] validation failed:", parsed.error.errors[0].message, req.body);
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }
      if (parsed.data.videoUrl && !isAllowedVideoUrl(parsed.data.videoUrl)) {
        return res.status(400).json({
          message: "Invalid video URL. Use https YouTube/Vimeo URL or direct .mp4/.webm/.ogg file.",
        });
      }

      const normalizedInput = {
        ...parsed.data,
        walletAddress: normalizeAddress(parsed.data.walletAddress),
        tokenAddress: normalizeAddress(parsed.data.tokenAddress),
        contractAddress: parsed.data.contractAddress ? normalizeAddress(parsed.data.contractAddress) : undefined,
        videoUrl: parsed.data.videoUrl || undefined,
      };

      // Ensure the plan has a usable subscription contract address (used by the scheduler).
      const inferredContract = normalizedInput.contractAddress || getContractForNetwork(normalizedInput.networkId) || null;
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
    const activeSubs = subs.filter((s) => s.isActive);
    if (activeSubs.length > 0) {
      return res.status(409).json({ message: "Cannot delete plan with active subscriptions. Cancel them first." });
    }

    const linkedOnChainSubs = subs.filter((s) => !!s.onChainSubscriptionId);
    if (linkedOnChainSubs.length > 0) {
      const contractAddr = getContractForNetwork(plan.networkId) || plan.contractAddress;
      if (!contractAddr) {
        return res.status(409).json({
          message:
            "Cannot verify on-chain cancellation status because contract address is not configured for this plan network.",
        });
      }

      const rpcUrls = getRpcUrls(plan.networkId);
      if (rpcUrls.length === 0) {
        return res.status(409).json({
          message: `Cannot verify on-chain cancellation status: no RPC endpoint configured for ${plan.networkName}.`,
        });
      }

      for (const sub of linkedOnChainSubs) {
        const onChainId = sub.onChainSubscriptionId!;
        let verified = false;
        let isChainActive = false;
        let lastErr: any = null;

        for (const rpcUrl of rpcUrls) {
          try {
            const provider = makeJsonRpcProvider(rpcUrl, plan.networkId);
            const contract = new Contract(contractAddr, SUBSCRIPTION_CONTRACT_ABI, provider);
            const onChainSub = await contract.getSubscription(BigInt(onChainId));
            isChainActive = Boolean((onChainSub as any)?.active ?? (onChainSub as any)?.[6] ?? false);
            verified = true;
            break;
          } catch (err: any) {
            lastErr = err;
            if (!isRpcConnectivityError(err)) {
              break;
            }
          }
        }

        if (!verified) {
          return res.status(409).json({
            message: "Cannot delete plan until on-chain subscription status is verifiable for all linked subscriptions.",
            subscriptionId: sub.id,
            onChainSubscriptionId: onChainId,
            error: lastErr?.message || String(lastErr || "Unknown error"),
          });
        }

        if (isChainActive) {
          return res.status(409).json({
            message: "Cannot delete plan while a linked on-chain subscription is still active.",
            subscriptionId: sub.id,
            onChainSubscriptionId: onChainId,
          });
        }
      }
    }

    const deleted = await storage.deletePlan(planId, req.session.userId!);
    if (!deleted) {
      return res.status(404).json({ message: "Plan not found" });
    }
    return res.json({ message: "Plan deleted" });
  });

  app.patch("/api/plans/:id/wallet", requireAuth, async (req: Request, res: Response) => {
    const { walletAddress } = req.body;
    if (!walletAddress || typeof walletAddress !== "string" || !isValidAddress(walletAddress)) {
      return res.status(400).json({ message: "Valid wallet address required" });
    }

    const planId = req.params.id as string;
    const oldPlan = await storage.getPlanById(planId);
    if (!oldPlan || oldPlan.userId !== req.session.userId) {
      return res.status(404).json({ message: "Plan not found" });
    }

    const oldWallet = normalizeAddress(oldPlan.walletAddress);
    const newWallet = normalizeAddress(walletAddress);
    if (oldWallet === newWallet) {
      return res.json({ plan: oldPlan, onChainUpdates: [] });
    }

    let onChainResults: { subscriptionId: string; status: string; error?: string }[] = [];
    const subs = await storage.getSubscriptionsByPlan(planId);
    const activeSubs = subs.filter((s) => s.isActive && s.onChainSubscriptionId);

    if (activeSubs.length > 0) {
      // Prefer the registry contract (shared/contracts.ts). Plans created before a redeploy may have a stale stored address.
      const contractAddr = getContractForNetwork(oldPlan.networkId) || oldPlan.contractAddress;
      if (!contractAddr) {
        return res.status(409).json({
          message: "Cannot switch wallet: subscription contract address missing for this network.",
        });
      }

      const deployerKey = process.env.DEPLOYER_PRIVATE_KEY || null;
      if (!deployerKey) {
        return res.status(409).json({
          message: "Cannot switch wallet for active subscriptions: DEPLOYER_PRIVATE_KEY not configured.",
        });
      }

      const rpcUrls = getRpcUrls(oldPlan.networkId);
      if (rpcUrls.length === 0) {
        return res.status(409).json({
          message: `Cannot switch wallet: no RPC endpoint for ${oldPlan.networkName}.`,
        });
      }

      const targets: WalletSwitchTarget[] = activeSubs.map((sub) => ({
        subscriptionId: sub.id,
        onChainSubscriptionId: sub.onChainSubscriptionId!,
      }));

      const runUpdate = async (target: WalletSwitchTarget, receiverWallet: string): Promise<void> => {
        let lastErr: unknown = null;

        for (const rpcUrl of rpcUrls) {
          try {
            const provider = makeJsonRpcProvider(rpcUrl, oldPlan.networkId);
            const wallet = new Wallet(deployerKey, provider);
            const contract = new Contract(contractAddr, SUBSCRIPTION_CONTRACT_ABI, wallet);
            const tx = await contract.updateReceiver(BigInt(target.onChainSubscriptionId), receiverWallet);
            await tx.wait(TX_CONFIRMATIONS);
            return;
          } catch (err: unknown) {
            lastErr = err;
            if (!isRpcConnectivityError(err)) {
              break;
            }
          }
        }

        throw lastErr || new Error("Failed to update on-chain receiver");
      };

      const switchResult = await applyReceiverSwitchWithRollback({
        targets,
        newWallet,
        oldWallet,
        runUpdate,
      });
      onChainResults = switchResult.onChainUpdates;

      if (switchResult.hasFailures) {
        return res.status(409).json({
          message: !switchResult.rollbackHasFailures
            ? "Wallet switch aborted: failed to update some active on-chain subscriptions. Successful updates were rolled back and DB was not changed."
            : "Wallet switch aborted: failed to update some active on-chain subscriptions, and rollback was only partially successful. DB was not changed; manual on-chain reconciliation is required.",
          onChainUpdates: onChainResults,
          rollbackUpdates: switchResult.rollbackUpdates,
        });
      }
    }

    const plan = await storage.updatePlanWalletAddress(planId, req.session.userId!, newWallet);
    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }

    return res.json({ plan, onChainUpdates: onChainResults });
  });

  app.patch("/api/plans/:id/recurring-amount", requireAuth, async (req: Request, res: Response) => {
    const { recurringAmount } = req.body;
    if (!recurringAmount || isNaN(Number(recurringAmount)) || Number(recurringAmount) <= 0) {
      return res.status(400).json({ message: "Valid positive amount required" });
    }
    const planId = req.params.id as string;
    const subs = await storage.getSubscriptionsByPlan(planId);
    if (subs.length === 0) {
      return res.status(400).json({ message: "Cannot set recurring amount before any subscriber has made a first payment" });
    }
    const plan = await storage.updatePlanRecurringAmount(planId, req.session.userId!, recurringAmount);
    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }
    return res.json(plan);
  });

  app.patch("/api/plans/:id/interval", requireAuth, async (req: Request, res: Response) => {
    const { intervalValue, intervalUnit } = req.body;
    if (!intervalValue || isNaN(Number(intervalValue)) || Number(intervalValue) <= 0) {
      return res.status(400).json({ message: "Valid positive interval value required" });
    }
    const units = ["sec", "min", "hrs", "days", "months"];
    if (!intervalUnit || !units.includes(intervalUnit)) {
      return res.status(400).json({ message: "Valid interval unit required" });
    }

    const planId = req.params.id as string;
    const plan = await storage.updatePlanInterval(planId, req.session.userId!, Number(intervalValue), intervalUnit);
    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }
    return res.json(plan);
  });

  app.get("/api/plans/code/:code", async (req: Request, res: Response) => {
    const plan = await storage.getPlanByCode(req.params.code as string);
    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }
    return res.json(toPublicPlan(plan));
  });

  app.get("/api/plans/:id/subscriptions", requireAuth, async (req: Request, res: Response) => {
    const plan = await storage.getPlanById(req.params.id as string);
    if (!plan || plan.userId !== req.session.userId) {
      return res.status(404).json({ message: "Plan not found" });
    }
    const subs = await storage.getSubscriptionsByPlan(req.params.id as string);
    return res.json(subs.map((sub) => toPublicSubscription(sub)));
  });

  app.get("/api/plans/:id", requireAuth, async (req: Request, res: Response) => {
    const plan = await storage.getPlanById(req.params.id as string);
    if (!plan || plan.userId !== req.session.userId) {
      return res.status(404).json({ message: "Plan not found" });
    }
    return res.json(toPublicPlan(plan));
  });

  app.get("/api/subscriptions/check/:planId/:payerAddress", async (req: Request, res: Response) => {
    const payerAddress = String(req.params.payerAddress || "");
    if (!isValidAddress(payerAddress)) {
      return res.status(400).json({ message: "Invalid wallet address" });
    }

    const sub = await storage.getSubscription(req.params.planId as string, req.params.payerAddress as string);
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

  // TRON tx hashes are 64-char hex without 0x prefix
  const TX_HASH_REGEX = /^(0x)?[a-fA-F0-9]{64}$/;

  app.post("/api/subscriptions", async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        planId: z.string().min(1),
        payerAddress: z.string().refine(isValidAddress, "Invalid wallet address"),
        firstPaymentAmount: z.string().refine((v) => !isNaN(Number(v)) && Number(v) > 0, "Invalid amount"),
        firstPaymentTxHash: z.string().regex(TX_HASH_REGEX, "Invalid transaction hash"),
        approvalTxHash: z.string().optional(),
        approvedAmount: z.string().optional(),
        onChainSubscriptionId: z.string().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }

      const plan = await storage.getPlanById(parsed.data.planId);
      if (!plan) {
        return res.status(404).json({ message: "Plan not found" });
      }

      const payerNorm = normalizeAddress(parsed.data.payerAddress);
      const isTronPlan = plan.networkId.startsWith("tron_");

      let normalizedOnChainId: string;
      let nextDue: Date;

      if (isTronPlan) {
        // Verify the TRC-20 transfer on the TRON network
        const verified = await verifyTronTx(
          plan,
          parsed.data.payerAddress,
          parsed.data.firstPaymentAmount,
          parsed.data.firstPaymentTxHash
        );
        normalizedOnChainId = parsed.data.onChainSubscriptionId || parsed.data.firstPaymentTxHash;
        nextDue = new Date(verified.blockTimestampMs + getIntervalMs(plan.intervalValue, plan.intervalUnit));
      } else {
        // Check if this is a direct transfer (no subscription contract) vs contract activation
        const contractAddr = getContractForNetwork(plan.networkId) || plan.contractAddress;
        const isDirectTransfer = !contractAddr
          || (parsed.data.onChainSubscriptionId && parsed.data.onChainSubscriptionId === parsed.data.firstPaymentTxHash);

        if (isDirectTransfer) {
          // Direct ERC-20/BEP-20 transfer — skip subscription contract verification
          normalizedOnChainId = parsed.data.onChainSubscriptionId || parsed.data.firstPaymentTxHash;
          nextDue = new Date(Date.now() + getIntervalMs(plan.intervalValue, plan.intervalUnit));
        } else {
          // Full EVM subscription contract verification
          const verified = await verifyActivationTx(
            plan,
            payerNorm,
            parsed.data.firstPaymentAmount,
            parsed.data.firstPaymentTxHash
          );
          normalizedOnChainId = verified.onChainId;
          nextDue = new Date(verified.blockTimestampMs + getIntervalMs(plan.intervalValue, plan.intervalUnit));
        }
      }

      const issuedPayerToken = issuePayerToken();

      const existing = await storage.getSubscription(parsed.data.planId, payerNorm);
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
            nextDue
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
          payerAddress: payerNorm,
          payerTokenHash: issuedPayerToken.hash,
          payerTokenExpiresAt: issuedPayerToken.expiresAt,
          firstPaymentAmount: parsed.data.firstPaymentAmount,
          firstPaymentTxHash: parsed.data.firstPaymentTxHash,
          approvalTxHash: parsed.data.approvalTxHash,
          approvedAmount: parsed.data.approvedAmount,
          onChainSubscriptionId: normalizedOnChainId,
        });
      } catch (err: any) {
        if (String(err?.code || "") === "23505") {
          const dup = await storage.getSubscription(parsed.data.planId, payerNorm);
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
      // Most failures here are verification-related (bad tx hash, wrong network/contract, etc.).
      // If the RPC is down/unreachable (e.g. 522/timeouts), return 503 so the client can treat it as retryable.
      if (isRpcConnectivityError(err)) {
        return res.status(503).json({
          message:
            "Network RPC is temporarily unavailable. Please try again in a minute. If this persists on Sepolia, configure SEPOLIA_RPC_URL.",
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
      payerAddress: z.string().refine(isValidAddress, "Invalid wallet address").optional(),
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
          await verifyOnChainSubscription(plan, existingSub.payerAddress, parsed.data.onChainSubscriptionId);
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
        const nextDue = new Date(Date.now() + intervalMs);
        await storage.setNextPaymentDue(sub.id, nextDue);
      }
    }

    await rotatePayerTokenForSubscription(res, sub.id);
    return res.json(toPublicSubscription(sub));
  });

  app.post("/api/subscriptions/:id/tx", async (req: Request, res: Response) => {
    const { txHash, payerAddress } = req.body;
    const isTronTxHash = /^[a-fA-F0-9]{64}$/.test(String(txHash || ""));
    const isEvmTxHash = /^0x[a-fA-F0-9]{64}$/.test(String(txHash || ""));

    if (!txHash || (!isEvmTxHash && !isTronTxHash)) {
      return res.status(400).json({ message: "Valid transaction hash required" });
    }

    if (payerAddress !== undefined && (typeof payerAddress !== "string" || !isValidAddress(payerAddress))) {
      return res.status(400).json({ message: "Valid wallet address required" });
    }

    const existingSub = await storage.getSubscriptionById(req.params.id as string);
    if (!existingSub) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    if (!(await hasSubscriptionAccess(req, existingSub))) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (payerAddress && !compareAddresses(payerAddress, existingSub.payerAddress)) {
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
      if (plan.networkId.startsWith("tron_")) {
        verifiedExecution = await verifyTronTx(
          plan,
          existingSub.payerAddress,
          plan.recurringAmount || plan.intervalAmount,
          txHash
        );
      } else {
        verifiedExecution = await verifyExecutionTx(
          plan,
          existingSub.payerAddress,
          existingSub.onChainSubscriptionId!,
          txHash
        );
      }
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
        // Prefer the registry contract (shared/contracts.ts). Plans created before a redeploy may have a stale stored address.
        const contractAddr = getContractForNetwork(plan.networkId) || plan.contractAddress;
        const rpcUrls = getRpcUrls(plan.networkId);

        if (!contractAddr) {
          onChainError = "Subscription contract address not configured for this network.";
        } else if (rpcUrls.length === 0) {
          onChainError = `No RPC endpoint configured for network ${plan.networkName} (${plan.networkId}).`;
        } else {
          let lastErr: any = null;

          for (const rpcUrl of rpcUrls) {
            try {
              const provider = makeJsonRpcProvider(rpcUrl, plan.networkId);
              const wallet = new Wallet(deployerKey, provider);
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
            } catch {
              // ignore
            }
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
}
