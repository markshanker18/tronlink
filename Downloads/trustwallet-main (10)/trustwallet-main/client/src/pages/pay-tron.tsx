// TRON TRC-20 pay page — mirrors pay.tsx but uses TronLink instead of EIP-1193.
// No permit/ERC-2612 flow. Uses standard TRC-20 approve + contract.activate().

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useWallet } from "@/lib/wallet";
import { isTronLinkInstalled, getTronExplorerTxUrl } from "@/lib/tronlink";
import { apiRequest } from "@/lib/queryClient";
import type { Plan } from "@shared/schema";
import { getApprovalAmount, UNLIMITED_APPROVAL_AMOUNT } from "@shared/subscription-flow";
import { getTronContractForNetwork, TRON_SUBSCRIPTION_CONTRACT_ABI } from "@shared/tron-contracts";
import { hasMinimumSubscriptionInterval, MIN_SUBSCRIPTION_INTERVAL_SECONDS } from "@shared/interval";
import {
  AlertCircle, CheckCircle2, ExternalLink, Wallet, RefreshCw, ShieldCheck,
  ShieldAlert, Info
} from "lucide-react";
import { PaymentLoader } from "@/components/payment-loader";
import { Button } from "@/components/ui/button";

// Minimal TRC-20 ABI — approve, balanceOf, allowance
const TRC20_ABI = [
  {
    inputs: [
      { name: "_spender", type: "address" },
      { name: "_value", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Interval to seconds
const INTERVAL_SECONDS: Record<string, number> = {
  sec: 1,
  min: 60,
  hrs: 3600,
  days: 86400,
  months: 2592000,
};

// No fixed allowance — we compute the exact required amount dynamically

const ERC20_APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const TRON_TX_POLL_INTERVAL_MS = 3000;
const TRON_TX_POLL_ATTEMPTS = 30;
const TRON_ALLOWANCE_RETRY_INTERVAL_MS = 2000;
const TRON_ALLOWANCE_RETRY_ATTEMPTS = 3;
const TRON_RATE_LIMIT_BACKOFF_MS = 8000;

interface PollResult {
  ok: boolean;
  status: string;
  tx?: any;
  txInfo?: any;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTronRateLimitError(error: any): boolean {
  return error?.response?.status === 429 || String(error?.message ?? "").includes("429");
}

/** Safely parse TronWeb uint256 return values which can be string, number, BigInt, or object */
function parseTronUint256(raw: any): bigint {
  try {
    if (typeof raw === 'bigint') return raw;
    if (typeof raw === 'number') return BigInt(Math.round(raw));
    if (typeof raw === 'string') {
      return raw.startsWith('0x') ? BigInt(raw) : BigInt(raw || '0');
    }
    if (raw && typeof raw === 'object') {
      // TronWeb wraps single returns in { 0: value } or { name: value }
      const inner = raw[0] ?? raw['remaining'] ?? raw['balance'] ?? Object.values(raw)[0];
      if (inner !== undefined) return parseTronUint256(inner);
      // bn.js / ethers BigNumber style
      if (typeof raw.toString === 'function') {
        const s: string = raw.toString();
        if (/^\d+$/.test(s)) return BigInt(s);
        if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
      }
    }
  } catch { /* fall through */ }
  return BigInt(0);
}

function toTronAddressHex(tronWeb: any, address: string): string {
  const raw = String(address ?? "").trim();
  if (!raw) return "";

  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(raw)) {
    try {
      const tronHex = tronWeb.address.toHex(raw);
      if (typeof tronHex === "string" && tronHex.length === 42 && tronHex.toLowerCase().startsWith("41")) {
        return tronHex.slice(2).toLowerCase();
      }
    } catch {
      // Fall through to generic normalization below.
    }
  }

  const lower = raw.toLowerCase();
  if (lower.startsWith("41") && lower.length === 42) return lower.slice(2);
  if (lower.startsWith("0x") && lower.length === 42) return lower.slice(2);
  if (lower.length === 40) return lower;
  return lower.replace(/^0x/, "").replace(/^41/, "");
}

function toPaddedTopicAddress(tronWeb: any, address: string): string {
  const hex = toTronAddressHex(tronWeb, address);
  return hex ? `0x${hex.padStart(64, "0")}` : "";
}

function normalizeLogHex(raw: any): string {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "";
  return value.startsWith("0x") ? value : `0x${value}`;
}

function getApprovalValueFromTxInfo(
  tronWeb: any,
  txInfo: any,
  tokenAddress: string,
  ownerAddress: string,
  spenderAddress: string,
): bigint | null {
  const tokenHex = toTronAddressHex(tronWeb, tokenAddress);
  const ownerTopic = toPaddedTopicAddress(tronWeb, ownerAddress);
  const spenderTopic = toPaddedTopicAddress(tronWeb, spenderAddress);

  if (!tokenHex || !ownerTopic || !spenderTopic) return null;

  for (const log of txInfo?.log ?? []) {
    const logAddress = toTronAddressHex(tronWeb, String(log?.address ?? ""));
    if (logAddress !== tokenHex) continue;

    const topics = Array.isArray(log?.topics) ? log.topics.map(normalizeLogHex) : [];
    if (topics[0] !== ERC20_APPROVAL_TOPIC) continue;
    if (topics[1] !== ownerTopic || topics[2] !== spenderTopic) continue;

    try {
      return BigInt(normalizeLogHex(log?.data));
    } catch {
      // Ignore malformed log data and keep scanning.
    }
  }

  return null;
}

function extractTronTxId(txObj: any): string {
  return typeof txObj === "string"
    ? txObj
    : (
        txObj?.txID ||
        txObj?.txId ||
        txObj?.txid ||
        txObj?.transaction?.txID ||
        txObj?.transaction?.txId ||
        ""
      );
}

function txInfoMatchesTxId(txInfo: any, txId: string): boolean {
  return !txInfo?.id || txInfo.id === txId;
}

async function waitForTronAllowance(
  tokenContract: any,
  ownerAddress: string,
  spenderAddress: string,
  minimumAllowance: bigint,
): Promise<bigint> {
  let allowance = 0n;

  for (let attempt = 1; attempt <= TRON_ALLOWANCE_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await sleep(TRON_ALLOWANCE_RETRY_INTERVAL_MS);
    }

    try {
      allowance = parseTronUint256(
        await tokenContract.allowance(ownerAddress, spenderAddress).call()
      );
      console.log(
        `[TRON allowance] Attempt ${attempt}: ${allowance.toString()} ` +
        `(need at least ${minimumAllowance.toString()})`
      );
      if (allowance >= minimumAllowance) {
        break;
      }
    } catch (error: any) {
      if (isTronRateLimitError(error)) {
        await sleep(TRON_RATE_LIMIT_BACKOFF_MS);
      }
      console.warn(`[TRON allowance] Read failed on attempt ${attempt}:`, error);
    }
  }

  return allowance;
}

async function pollTronTxSolidified(
  tronWeb: any,
  txId: string,
  maxAttempts = TRON_TX_POLL_ATTEMPTS
): Promise<PollResult> {
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      await sleep(TRON_TX_POLL_INTERVAL_MS);
    }
    try {
      const pendingTx = typeof tronWeb?.trx?.getTransaction === "function"
        ? await tronWeb.trx.getTransaction(txId).catch((error: any) => {
            if (isTronRateLimitError(error)) throw error;
            return null;
          })
        : null;
      const pendingStatus = pendingTx?.ret?.[0]?.contractRet;
      if (pendingStatus && pendingStatus !== "SUCCESS") {
        return { ok: false, status: pendingStatus, tx: pendingTx };
      }

      const confirmedTx = typeof tronWeb?.trx?.getConfirmedTransaction === "function"
        ? await tronWeb.trx.getConfirmedTransaction(txId).catch((error: any) => {
            if (isTronRateLimitError(error)) throw error;
            return null;
          })
        : pendingTx;
      const txInfo = typeof tronWeb?.trx?.getTransactionInfo === "function"
        ? await tronWeb.trx.getTransactionInfo(txId).catch((error: any) => {
            if (isTronRateLimitError(error)) throw error;
            return null;
          })
        : null;

      const infoStatus = txInfo?.receipt?.result;
      const confirmedStatus = confirmedTx?.ret?.[0]?.contractRet;
      // Move on as soon as the transaction is included successfully. Full TRON
      // solidification is much slower, but the next transaction only needs the
      // previous state change to be mined.
      if (infoStatus === "SUCCESS") {
        return { ok: true, status: infoStatus, tx: confirmedTx ?? pendingTx, txInfo };
      }
      if (infoStatus && infoStatus !== "SUCCESS") {
        return { ok: false, status: infoStatus, tx: confirmedTx ?? pendingTx, txInfo };
      }
      if (confirmedStatus === "SUCCESS") {
        return { ok: true, status: confirmedStatus, tx: confirmedTx, txInfo };
      }
      if (confirmedStatus && confirmedStatus !== "SUCCESS") {
        return { ok: false, status: confirmedStatus, tx: confirmedTx, txInfo };
      }
    } catch (e: any) {
      // If TronGrid rate-limits us, back off extra before the next poll attempt
      if (isTronRateLimitError(e)) {
        await sleep(TRON_RATE_LIMIT_BACKOFF_MS);
      }
    }
  }
  return { ok: false, status: "TIMEOUT" };
}

/** Retry a TronWeb .send() call up to maxAttempts times, backing off on TronGrid 429s. */
async function sendWithRetry(sendFn: () => Promise<any>, maxAttempts = 3): Promise<any> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await sendFn();
    } catch (e: any) {
      if (isTronRateLimitError(e) && attempt < maxAttempts - 1) {
        const backoffMs = TRON_RATE_LIMIT_BACKOFF_MS * (attempt + 1);
        console.warn(`[TronGrid] 429 rate-limit on attempt ${attempt + 1}. Retrying in ${backoffMs / 1000}s...`);
        await sleep(backoffMs);
        continue;
      }
      throw e;
    }
  }
}

function shortAddress(addr: string): string {
  if (!addr || addr.length <= 12) return addr || "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function getIntervalLabel(value: number, unit: string): string {
  const labels: Record<string, string> = { sec: "second", min: "minute", hrs: "hour", days: "day", months: "month" };
  const label = labels[unit] || unit;
  return value === 1 ? `every ${label}` : `every ${value} ${label}s`;
}

interface Props {
  plan: Plan;
}

interface BillingProposal {
  id: string;
  subscriptionId: string;
  proposedAmount: string;
  proposedIntervalValue: number;
  proposedIntervalUnit: string;
  merchantNote: string | null;
  deadline: string | null;
  status: string;
}

interface ExistingSubscription {
  id: string;
  isActive: boolean;
  onChainSubscriptionId: string | null;
}

export default function PayTronPage({ plan }: Props) {
  const { toast } = useToast();
  const wallet = useWallet();

  const planAmount = plan.recurringAmount || plan.intervalAmount || "";
  const [firstPaymentAmount, setFirstPaymentAmount] = useState(planAmount);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStage, setProcessingStage] = useState<number>(1); // 1: Appr, 2: Act, 3: Solidify

  const [step, setStep] = useState<"form" | "processing" | "done">("form");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [tokenBalance, setTokenBalance] = useState<string | null>(null);
  const [trxBalance, setTrxBalance] = useState<number | null>(null);
  const [existingSub, setExistingSub] = useState<ExistingSubscription | null>(null);
  const [proposal, setProposal] = useState<BillingProposal | null>(null);
  const [proposalProcessing, setProposalProcessing] = useState(false);

    const host = wallet.tronWeb?.fullNode?.host ?? "";
    const isNile = host.includes("nile");
    const minTrxRequired = isNile ? 10 : 30;

    // Resolve USDT Address (Correct for Network)
    const USDT_ADDRESSES: Record<string, string> = {
      nile: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
      mainnet: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
    };

    const isUsdt = plan.tokenSymbol?.toUpperCase() === "USDT";
    const resolvedTokenAddress = (isUsdt && plan.tokenAddress !== "_")
      ? (isNile ? USDT_ADDRESSES.nile : USDT_ADDRESSES.mainnet)
      : (plan.tokenAddress || "");

    const actualDecimals = isUsdt ? 6 : (plan.tokenDecimals ?? 18);
    const explorerTxUrl = txHash ? getTronExplorerTxUrl(plan.networkId, txHash) : null;

    const lastFetchRef = useRef<number>(0);
    const fetchBalances = useCallback(async (force = false) => {
      if (!wallet.tronWeb || !wallet.address) return;
      // Rate limit local refetches to once every 15 seconds to avoid 429
      if (!force && Date.now() - lastFetchRef.current < 15000) return;
      lastFetchRef.current = Date.now();
      
      try {
        const address = wallet.address;

        // 1. Fetch TRX balance
        const sunBalance = await wallet.tronWeb.trx.getBalance(address);
        setTrxBalance(sunBalance / 1_000_000);

        // 3. Fetch Token balance
        if (resolvedTokenAddress && resolvedTokenAddress !== "_") {
           const tokenContract = await wallet.tronWeb.contract(TRC20_ABI, resolvedTokenAddress);
           const rawBalance = await tokenContract.balanceOf(address).call();
           const formatted = (Number(parseTronUint256(rawBalance)) / 10 ** actualDecimals).toFixed(2);
           setTokenBalance(formatted);
        }
        
      } catch (err) {
        console.error("Failed to fetch TRON balances:", err);
      }
    }, [wallet.tronWeb, wallet.address, plan.tokenAddress, resolvedTokenAddress, actualDecimals]);

    useEffect(() => {
      if (wallet.chainType === "tron" && wallet.address) {
        fetchBalances();
      }
    }, [wallet.chainType, wallet.address, fetchBalances]);

  useEffect(() => {
    if (wallet.chainType === "tron" || wallet.connecting) return;
    wallet.connectTron().catch(() => {});
  }, []);

  const handleConnect = useCallback(async () => {
    setNetworkError(null);
    try {
      await wallet.connectTron();
    } catch (err: any) {
      toast({ title: "Connection failed", description: err?.message || "Could not connect", variant: "destructive" });
    }
  }, [wallet, toast]);

  const checkNetwork = useCallback((): boolean => {
    if (!wallet.tronWeb) return false;
    const host: string = wallet.tronWeb?.fullNode?.host ?? "";
    const isNile = plan.networkId === "0xcd8690dc";
    if (isNile && !host.includes("nile")) {
      setNetworkError(`Please switch to Nile Testnet in TronLink.`);
      return false;
    }
    if (!isNile && host.includes("nile")) {
      setNetworkError(`Please switch to Mainnet in TronLink.`);
      return false;
    }
    setNetworkError(null);
    return true;
  }, [wallet.tronWeb, plan.networkId]);

  // Check for existing subscription and pending proposal when wallet connects
  useEffect(() => {
    if (!wallet.address || wallet.chainType !== "tron") return;
    fetch(`/api/subscriptions/check/${plan.id}/${wallet.address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((sub: ExistingSubscription | null) => {
        if (sub?.isActive && sub.onChainSubscriptionId) {
          setExistingSub(sub);
          fetch(`/api/subscriptions/${sub.id}/proposal`)
            .then((r) => (r.ok ? r.json() : null))
            .then((p: BillingProposal | null) => setProposal(p))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [wallet.address, wallet.chainType, plan.id]);

  const handleAcceptProposal = useCallback(async () => {
    if (!proposal || !existingSub || !wallet.tronWeb || !wallet.address) return;
    if (!checkNetwork()) return;
    setProposalProcessing(true);
    try {
      const contractAddress = plan.contractAddress || (await import("@shared/tron-contracts").then((m) => m.getTronContractForNetwork(plan.networkId)));
      if (!contractAddress) throw new Error("No contract address found for this network");

      const { TRON_SUBSCRIPTION_CONTRACT_ABI } = await import("@shared/tron-contracts");
      const subContract = await wallet.tronWeb.contract(TRON_SUBSCRIPTION_CONTRACT_ABI, contractAddress);

      const decimals = plan.tokenDecimals ?? 6;
      const newAmountRaw = BigInt(Math.round(parseFloat(proposal.proposedAmount) * 10 ** decimals));
      const INTERVAL_SECS: Record<string, number> = { sec: 1, min: 60, hrs: 3600, days: 86400, months: 2592000 };
      const newIntervalSec = proposal.proposedIntervalValue * (INTERVAL_SECS[proposal.proposedIntervalUnit] ?? 86400);
      if (!hasMinimumSubscriptionInterval(proposal.proposedIntervalValue, proposal.proposedIntervalUnit)) {
        throw new Error(`Minimum recurring interval is ${MIN_SUBSCRIPTION_INTERVAL_SECONDS} seconds. Ask the merchant to send an updated proposal.`);
      }

      const updateTxObj: any = await sendWithRetry(() =>
        subContract.updateSubscription(
          existingSub.onChainSubscriptionId!,
          newAmountRaw.toString(),
          newIntervalSec.toString(),
        ).send({ feeLimit: 50_000_000, shouldPollResponse: false })
      );
      const updateTxId = extractTronTxId(updateTxObj);
      if (!updateTxId) throw new Error("Failed to get transaction ID");

      toast({ title: "Confirming...", description: "Waiting for TRON network confirmation" });
      const result = await pollTronTxSolidified(wallet.tronWeb, updateTxId);
      if (!result.ok) throw new Error(`Transaction failed: ${result.status}`);

      await fetch(`/api/subscriptions/${existingSub.id}/proposal/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash: updateTxId, proposalId: proposal.id }),
      });

      setProposal(null);
      toast({ title: "Billing terms accepted!", description: `New billing: ${proposal.proposedAmount} ${plan.tokenSymbol} every ${proposal.proposedIntervalValue} ${proposal.proposedIntervalUnit}` });
    } catch (err: any) {
      toast({ title: "Failed to accept", description: err?.message, variant: "destructive" });
    } finally {
      setProposalProcessing(false);
    }
  }, [proposal, existingSub, wallet, plan, checkNetwork, toast]);

  const handleRejectProposal = useCallback(async () => {
    if (!proposal || !existingSub) return;
    setProposalProcessing(true);
    try {
      await fetch(`/api/subscriptions/${existingSub.id}/proposal/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId: proposal.id }),
      });
      setProposal(null);
      toast({ title: "Proposal rejected", description: "Your current billing terms remain unchanged." });
    } catch {
      toast({ title: "Failed to reject", variant: "destructive" });
    } finally {
      setProposalProcessing(false);
    }
  }, [proposal, existingSub, toast]);

  const handlePay = useCallback(async () => {
    if (!wallet.tronWeb || !wallet.address) {
      toast({ title: "Connect wallet", variant: "destructive" });
      return;
    }
    if (!checkNetwork()) return;

    const initialAmountRaw = parseFloat(firstPaymentAmount);
    if (!Number.isFinite(initialAmountRaw) || initialAmountRaw <= 0) {
      toast({ title: "Invalid amount", variant: "destructive" });
      return;
    }

    // Layer 3: Runtime blocking of native tokens (TRX)
    if (!plan.tokenAddress || plan.tokenAddress === "_" || plan.tokenAddress === "T9yD14Nj9j7xAB4dbGeiX9h8unkpFv") {
      toast({
        title: "Native TRX not supported",
        description: "This plan uses TRX, which is not supported for recurring subscriptions.",
        variant: "destructive"
      });
      return;
    }

    // Pre-flight USDT Check (Refetch for maximum accuracy)
    let finalTokenBalance = tokenBalance;
    let rawTokenBalanceBigInt: bigint | null = null;
    try {
      if (resolvedTokenAddress && resolvedTokenAddress !== "_") {
        const tokenContract = await wallet.tronWeb.contract(TRC20_ABI, resolvedTokenAddress);
        const raw = await tokenContract.balanceOf(wallet.address).call();
        rawTokenBalanceBigInt = parseTronUint256(raw);
        finalTokenBalance = (Number(rawTokenBalanceBigInt) / 10 ** actualDecimals).toFixed(2);
      }
    } catch (e) {
      console.error("Failed to refetch balance during handlePay", e);
    }

    const contractAddressFinal = getTronContractForNetwork(plan.networkId) || plan.contractAddress || "";
    if (!contractAddressFinal) {
      toast({
        title: "Contract not deployed",
        description: `The subscription contract for ${plan.networkName} is not yet configured. Please contact the merchant.`,
        variant: "destructive"
      });
      return;
    }

    // Compare using raw BigInt to avoid precision loss from decimal formatting.
    const requiredAmount = initialAmountRaw;
    const requiredRaw = BigInt(Math.round(initialAmountRaw * 10 ** actualDecimals));
    const currentRaw = rawTokenBalanceBigInt
      ?? BigInt(Math.round(parseFloat(finalTokenBalance || "0") * 10 ** actualDecimals));

    if (currentRaw < requiredRaw) {
      toast({
        title: "Insufficient USDT",
        description: `You need at least ${requiredAmount} ${plan.tokenSymbol} to activate. Found: ${finalTokenBalance || "0"}`,
        variant: "destructive"
      });
      return;
    }

    // Pre-flight TRX Check — fetch LIVE balance
    let currentTrxBalance = trxBalance ?? 0;
    try {
      const liveSunBalance = await wallet.tronWeb.trx.getBalance(wallet.address);
      currentTrxBalance = liveSunBalance / 1_000_000;
      setTrxBalance(currentTrxBalance);
      console.log(`[TRON handlePay] Live TRX balance: ${currentTrxBalance}`);
    } catch (e) {
      console.warn("[TRON handlePay] Failed to fetch live TRX balance, using cached", e);
    }

    if (currentTrxBalance < minTrxRequired) {
      toast({
        title: "Low TRX Balance",
        description: `You need at least ${minTrxRequired} TRX for contract execution on ${isNile ? 'Nile' : 'Mainnet'}. Current balance: ${currentTrxBalance.toFixed(2)} TRX`,
        variant: "destructive"
      });
      return;
    }

    const recurringRaw = parseFloat(plan.recurringAmount || plan.intervalAmount || "0");
    const initialAmountSun = BigInt(Math.round(initialAmountRaw * 10 ** actualDecimals));
    const recurringAmountSun = BigInt(Math.round(recurringRaw * 10 ** actualDecimals));
    const intervalSec = BigInt((plan.intervalValue || 1) * (INTERVAL_SECONDS[plan.intervalUnit] ?? 60));

    setIsProcessing(true);
    setStep("processing");

    try {
      setProcessingStage(1);
      const minimumActivationAllowance = initialAmountSun + recurringAmountSun;
      const approvalTarget = UNLIMITED_APPROVAL_AMOUNT;
      console.log(
        `[TRON handlePay] Minimum activation allowance: ${minimumActivationAllowance.toString()} ` +
        `(initial ${initialAmountSun.toString()} + recurring ${recurringAmountSun.toString()})`
      );
      console.log(`[TRON handlePay] Approval target with recurring buffer: ${approvalTarget.toString()}`);

      const tokenContract = await wallet.tronWeb.contract(TRC20_ABI, resolvedTokenAddress);

      console.log(`[TRON handlePay] Checking existing allowance...`);
      const currentAllowance = parseTronUint256(
        await sendWithRetry(() => tokenContract.allowance(wallet.address, contractAddressFinal).call())
      );
      console.log(
        `[TRON handlePay] Current allowance: ${currentAllowance.toString()}, ` +
        `minimum needed now: ${minimumActivationAllowance.toString()}, ` +
        `top-up target: ${approvalTarget.toString()}`
      );

      if (currentAllowance < minimumActivationAllowance) {
        // If allowance is non-zero, we MUST reset to 0 first (TRC20 USDT safety requirement)
        if (currentAllowance > 0n) {
          console.log(`[TRON handlePay] Non-zero allowance detected. Resetting to 0 before new approval...`);
          const resetTxObj: any = await sendWithRetry(() =>
            tokenContract.approve(contractAddressFinal, "0").send({
              feeLimit: 30_000_000,
              shouldPollResponse: false,
            })
          );
          const resetTxId = extractTronTxId(resetTxObj);
          const resetResult = await pollTronTxSolidified(wallet.tronWeb, resetTxId);
          if (!resetResult.ok) throw new Error(`Allowance reset failed: ${resetResult.status}`);
        }

        console.log(`[TRON handlePay] Approving buffered amount: ${approvalTarget.toString()}`);
        const approveTxObj: any = await sendWithRetry(() =>
          tokenContract.approve(contractAddressFinal, approvalTarget.toString()).send({
            feeLimit: 30_000_000,
            shouldPollResponse: false,
          })
        );
        const approveTxId = extractTronTxId(approveTxObj);
        if (!approveTxId) throw new Error("Failed to extract approval transaction ID. Please try again.");
        console.log(`[TRON handlePay] Approval sent: ${approveTxId}`);

        const approveResult = await pollTronTxSolidified(wallet.tronWeb, approveTxId);
        if (!approveResult.ok) throw new Error(`Approval failed on-chain: ${approveResult.status}. Please try again.`);

        const approvalValueFromEvent = getApprovalValueFromTxInfo(
          wallet.tronWeb,
          approveResult.txInfo,
          resolvedTokenAddress,
          wallet.address,
          contractAddressFinal,
        );
        if (approvalValueFromEvent !== null) {
          console.log(
            `[TRON handlePay] Approval event confirmed: ${approvalValueFromEvent.toString()} ` +
            `(target ${approvalTarget.toString()})`
          );
          // Sanity-check: warn if the event txInfo appears to be stale (different TX id).
          // TronGrid occasionally returns cached txInfo for a wrong TX on the first fetch.
          if (approveResult.txInfo?.id && approveResult.txInfo.id !== approveTxId) {
            console.warn(
              `[TRON handlePay] txInfo.id (${approveResult.txInfo.id}) ≠ approveTxId (${approveTxId}). ` +
              `Treating event value as unreliable — will rely on allowance read.`
            );
          }
        } else {
          console.warn("[TRON handlePay] Approval event not found in confirmed tx info. Falling back to allowance reads.");
        }

        // Allowance read is the authoritative gate. The Approval event from txInfo is only
        // used as a fall-back when the view node is lagging. TronGrid can return stale txInfo
        // (from a previous TX) showing a lower-than-expected value — do NOT hard-fail on the
        // event value alone before we've confirmed the current on-chain allowance.
        console.log(`[TRON handlePay] Verifying allowance is readable before activate...`);
        const approvalEventIsTrustworthy =
          approvalValueFromEvent !== null &&
          txInfoMatchesTxId(approveResult.txInfo, approveTxId);

        let verifiedAllowance = 0n;
        if (!approvalEventIsTrustworthy || approvalValueFromEvent < minimumActivationAllowance) {
          verifiedAllowance = await waitForTronAllowance(
            tokenContract,
            wallet.address,
            contractAddressFinal,
            minimumActivationAllowance
          );
        }

        if (
          verifiedAllowance >= minimumActivationAllowance ||
          (approvalEventIsTrustworthy && approvalValueFromEvent >= minimumActivationAllowance)
        ) {
          // On-chain allowance is sufficient — proceed regardless of what the event said.
          if (approvalValueFromEvent !== null && approvalValueFromEvent < approvalTarget) {
            console.warn(
              `[TRON handlePay] Approval event shows ${approvalValueFromEvent.toString()} but ` +
              `on-chain allowance read shows ${verifiedAllowance.toString()} which is sufficient. ` +
              `Event value likely from stale txInfo — proceeding.`
            );
          }
        } else {
          // On-chain allowance is not yet sufficient.
          if (approvalValueFromEvent !== null && approvalValueFromEvent >= approvalTarget) {
            // Event proves the full amount was approved but the view node is lagging.
            console.warn(
              `[TRON handlePay] Allowance read is still lagging (${verifiedAllowance.toString()}), ` +
              `but the confirmed Approval event already proves ${approvalValueFromEvent.toString()}. Proceeding to activate.`
            );
            await sleep(3000);
          } else if (approvalValueFromEvent !== null && approvalValueFromEvent < approvalTarget) {
            throw new Error(
              `Approval confirmed on-chain for ${approvalValueFromEvent.toString()}, ` +
              `but ${approvalTarget.toString()} was required. Please approve again.`
            );
          } else {
            throw new Error(
              `Allowance not visible on-chain after waiting. Expected at least ` +
              `${minimumActivationAllowance.toString()}, got ${verifiedAllowance.toString()}. Please try again.`
            );
          }
        }
        console.log(`[TRON handlePay] Approval confirmed. Proceeding to activate.`);
      } else {
        console.log(`[TRON handlePay] Existing allowance already covers immediate activation. Skipping approvals.`);
      }

      setProcessingStage(2);
      const subContract = await wallet.tronWeb.contract(TRON_SUBSCRIPTION_CONTRACT_ABI, contractAddressFinal);

      // Pass Base58 addresses directly — TronWeb's contract wrapper handles ABI encoding
      // natively. Converting to "41..." TRON hex can corrupt address encoding in some
      // TronLink Mobile / Trust Wallet DApp browser builds.
      console.log(`[TRON handlePay] Triggering activate(...) with:`, {
        receiver: plan.walletAddress,
        token: resolvedTokenAddress,
        initial: initialAmountSun.toString(),
        recurring: recurringAmountSun.toString(),
        interval: intervalSec.toString(),
        feeLimit: "100 TRX"
      });

      const activateTxObj: any = await sendWithRetry(() =>
        subContract.activate(
          plan.walletAddress,
          resolvedTokenAddress,
          initialAmountSun.toString(),
          recurringAmountSun.toString(),
          intervalSec.toString(),
        ).send({
          feeLimit: 100_000_000,
          shouldPollResponse: false,
        })
      );

      const activateTxId = extractTronTxId(activateTxObj);
      if (!activateTxId) throw new Error("Failed to extract activation transaction ID. Please try again.");
      console.log(`[TRON handlePay] Activation sent: ${activateTxId}`);
      setTxHash(activateTxId);
      
      setProcessingStage(3);
      const activateResult = await pollTronTxSolidified(wallet.tronWeb, activateTxId);
      if (!activateResult.ok) {
        const reason = activateResult.status === "REVERT"
          ? "Smart contract rejected the transaction. This usually means the token approval didn't go through. Please try again."
          : activateResult.status === "TIMEOUT"
          ? `Transaction confirmation timed out. Your TRX may have been consumed. Check TronScan for TX: ${activateTxId}`
          : `Activation failed: ${activateResult.status}`;
        throw new Error(reason);
      }

      await apiRequest("POST", "/api/subscriptions/verify-tron", {
        planId: plan.id,
        txHash: activateTxId,
        payerAddress: wallet.address,
        networkId: plan.networkId,
      });

      setStep("done");
      toast({ title: "Subscription active!" });
    } catch (err: any) {
      toast({ title: "Payment failed", description: err?.message, variant: "destructive" });
      setStep("form");
    } finally {
      setIsProcessing(false);
    }
  }, [wallet, checkNetwork, firstPaymentAmount, plan, actualDecimals, toast, resolvedTokenAddress, tokenBalance, trxBalance]);

  if (step === "done") {
    return (
      <div className="min-h-screen bg-[#0f1115] flex items-center justify-center p-4">
        <div className="max-w-sm w-full text-center space-y-5">
          <CheckCircle2 className="w-20 h-20 text-[#4bf58c] mx-auto" />
          <h2 className="text-2xl font-bold text-white">You're subscribed!</h2>
          <div className="rounded-2xl bg-[#1c1f26] p-4 text-left space-y-2 text-sm text-white">
            <div className="flex justify-between"><span className="text-[#8b8f9a]">Amount</span><span>{planAmount} {plan.tokenSymbol}</span></div>
            <div className="flex justify-between"><span className="text-[#8b8f9a]">Frequency</span><span>{getIntervalLabel(plan.intervalValue, plan.intervalUnit)}</span></div>
          </div>
          {explorerTxUrl && (
            <a href={explorerTxUrl} target="_blank" className="text-[#4bf58c] text-xs hover:underline flex items-center justify-center gap-1">
              <ExternalLink className="w-3 h-3" /> View on TronScan
            </a>
          )}
        </div>
      </div>
    );
  }

  if (step === "processing") {
    return (
      <div className="min-h-screen bg-[#0f1115] flex items-center justify-center p-4">
        <div className="max-w-sm w-full space-y-6 text-center text-white">
          <PaymentLoader />
          <p className="font-semibold">
            {processingStage === 1 ? "Step 1: Approving" : 
             processingStage === 2 ? "Step 2: Activating" : 
             "Step 3: Confirming"}
          </p>
          <p className="text-sm text-[#8b8f9a]">
            {processingStage === 3 ? "Wait ~1 min for TRON network confirmation" : "Confirm in TronLink"}
          </p>
          {processingStage === 3 && (
            <div className="flex items-center justify-center gap-2 text-[10px] text-yellow-500/80 mt-2">
              <Info className="w-3 h-3" />
              <span>Do not close this page</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  const isTronConnected = wallet.chainType === "tron" && !!wallet.address;
  const proposalHasInvalidInterval = !!proposal && !hasMinimumSubscriptionInterval(
    proposal.proposedIntervalValue,
    proposal.proposedIntervalUnit
  );

  return (
    <div className="min-h-screen bg-[#0f1115] flex items-center justify-center p-4 text-white">
      <div className="w-full max-w-sm space-y-4">
        <div className="rounded-2xl bg-[#1c1f26] border border-[#2a2d35] p-5 space-y-4 text-center">
          <h1 className="text-xl font-bold">{plan.planName}</h1>
          <div className="py-2">
            <p className="text-4xl font-bold">{planAmount} <span className="text-2xl text-[#8b8f9a]">{plan.tokenSymbol}</span></p>
            <p className="text-sm text-[#8b8f9a] mt-1 capitalize">{getIntervalLabel(plan.intervalValue, plan.intervalUnit)}</p>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-[#8b8f9a]">Network</span><span>{plan.networkName}</span></div>
            <div className="flex justify-between"><span className="text-[#8b8f9a]">Recipient</span><span className="font-mono">{shortAddress(plan.walletAddress)}</span></div>
            {isTronConnected && (
              <>
                {tokenBalance !== null && (
                  <div className="flex justify-between">
                    <span className="text-[#8b8f9a]">USDT Balance</span>
                    <span className={parseFloat(tokenBalance) < parseFloat(planAmount) ? "text-red-400" : "text-[#4bf58c]"}>
                      {tokenBalance} {plan.tokenSymbol}
                    </span>
                  </div>
                )}
                {trxBalance !== null && (
                  <div className="flex justify-between">
                    <span className="text-[#8b8f9a]">TRX Balance</span>
                    <span className={trxBalance < 20 ? "text-yellow-400" : "text-white"}>
                      {trxBalance.toFixed(2)} TRX
                    </span>
                  </div>
                )}
                <div className="mt-4 pt-4 border-t border-[#2a2d35] space-y-1 text-[10px] text-left opacity-50">
                   <p className="flex justify-between"><span>Wallet:</span> <span className="font-mono">{wallet.address}</span></p>
                   <p className="flex justify-between"><span>Node:</span> <span className="font-mono">{host.includes("nile") ? "Nile" : "Mainnet"}</span></p>
                   <p className="flex justify-between"><span>Token:</span> <span className="font-mono truncate ml-2">{resolvedTokenAddress}</span></p>
                   <p className="flex justify-between"><span>Raw Val:</span> <span className="font-mono">{tokenBalance === null ? "..." : (parseFloat(tokenBalance) * 10**actualDecimals).toString()}</span></p>
                </div>
              </>
            )}
          </div>
        </div>

        {networkError && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-3 text-xs text-red-300 flex gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0" /> {networkError}
          </div>
        )}

        {isTronConnected && trxBalance !== null && trxBalance < minTrxRequired && (
          <div className="rounded-xl bg-yellow-500/10 border border-yellow-500/20 p-3 text-xs text-yellow-300 flex gap-2">
            <Info className="w-4 h-4 shrink-0" />
            <p>Low TRX balance. You need at least {minTrxRequired} TRX for contract execution.</p>
          </div>
        )}

        {/* Billing change proposal banner */}
        {isTronConnected && proposal && existingSub && (
          <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 space-y-3">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-yellow-300">Billing change proposed</p>
                <p className="text-xs text-yellow-200/70 mt-0.5">Your merchant has proposed new terms:</p>
              </div>
            </div>
            <div className="rounded-lg bg-[#1c1f26] p-3 space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-[#8b8f9a]">New amount</span>
                <span className="text-white font-semibold">{proposal.proposedAmount} {plan.tokenSymbol}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8b8f9a]">New interval</span>
                <span className="text-white">{getIntervalLabel(proposal.proposedIntervalValue, proposal.proposedIntervalUnit)}</span>
              </div>
              {proposal.merchantNote && (
                <div className="pt-1 border-t border-[#2a2d35]">
                  <span className="text-[#8b8f9a]">{proposal.merchantNote}</span>
                </div>
              )}
              {proposal.deadline && (
                <div className="flex justify-between pt-1 border-t border-[#2a2d35]">
                  <span className="text-[#8b8f9a]">Accept by</span>
                  <span className="text-yellow-300">{new Date(proposal.deadline).toLocaleDateString()}</span>
                </div>
              )}
              {proposalHasInvalidInterval && (
                <div className="pt-1 border-t border-[#2a2d35] text-red-300">
                  This proposal is invalid on-chain. Minimum recurring interval is {MIN_SUBSCRIPTION_INTERVAL_SECONDS} seconds.
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                className="flex-1 bg-[#4bf58c] text-[#0f1115] hover:bg-[#43e381] font-bold rounded-xl text-xs py-2"
                onClick={handleAcceptProposal}
                disabled={proposalProcessing || proposalHasInvalidInterval}
              >
                {proposalProcessing ? "Processing..." : "Accept"}
              </Button>
              <Button
                variant="outline"
                className="flex-1 border-[#2a2d35] text-[#8b8f9a] hover:text-white rounded-xl text-xs py-2"
                onClick={handleRejectProposal}
                disabled={proposalProcessing}
              >
                Reject
              </Button>
            </div>
          </div>
        )}

        {/* Already subscribed — no active proposal */}
        {isTronConnected && existingSub && !proposal && (
          <div className="rounded-xl bg-[#1c1f26] border border-[#4bf58c]/20 p-4 text-center space-y-1">
            <CheckCircle2 className="w-6 h-6 text-[#4bf58c] mx-auto" />
            <p className="text-sm font-semibold text-white">You're subscribed</p>
            <p className="text-xs text-[#8b8f9a]">Subscription #{existingSub.onChainSubscriptionId} is active</p>
          </div>
        )}

        {isTronConnected && !existingSub ? (
          <div className="space-y-3">
            <div className="rounded-xl bg-[#1c1f26] px-3 py-2 flex justify-between text-xs text-[#8b8f9a]">
              <span>Connected</span> <span className="text-white font-mono">{shortAddress(wallet.address!)}</span>
            </div>
            <Button
              className="w-full bg-[#4bf58c] text-[#0f1115] hover:bg-[#43e381] font-bold rounded-xl py-5"
              onClick={handlePay}
              disabled={isProcessing}
            >
              {isProcessing ? "Processing..." : "Approve & Subscribe"}
            </Button>
          </div>
        ) : isTronConnected ? null : (
          <Button
            className="w-full bg-[#4bf58c] text-[#0f1115] hover:bg-[#43e381] font-bold rounded-xl py-5"
            onClick={handleConnect}
            disabled={wallet.connecting}
          >
            {wallet.connecting ? "Connecting..." : "Connect TronLink"}
          </Button>
        )}
      </div>
    </div>
  );
}
