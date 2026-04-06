import { useCallback, useEffect, useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Plan, Subscription } from "@shared/schema";
import { ERC20_ABI, SUBSCRIPTION_CONTRACT_ABI, getContractForNetwork } from "@shared/contracts";
import { getApprovalAmount, UNLIMITED_APPROVAL_AMOUNT } from "@shared/subscription-flow";
import { useWallet } from "@/lib/wallet";
import { isMobile, openInMetaMaskMobile, type WalletBrand } from "@/lib/metamask";
import { Contract, parseUnits, formatUnits, Signature } from "ethers";
import PayTronPage from "./pay-tron";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaymentLoader } from "@/components/payment-loader";
import { useToast } from "@/hooks/use-toast";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Copy,
  Delete as DeleteIcon,
  Info,
  QrCode,
  Settings,
  Wallet,
  X,
} from "lucide-react";
import { SiEthereum } from "react-icons/si";

const TESTNET_CHAIN_IDS = ["0xaa36a7", "0x5", "0xcd8690dc"];

function isTestnet(chainId: string): boolean {
  return TESTNET_CHAIN_IDS.includes(chainId.toLowerCase());
}

function extractServerJsonMessage(text: string): string | null {
  const m = String(text || "").match(/^\s*\d{3}\s*:\s*(\{[\s\S]*\})\s*$/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // ignore
  }
  return null;
}

function getFriendlyError(error: any, tokenSymbol: string, networkName: string, chainId: string): string {
  let msg = error?.message || error?.toString() || "Unknown error";
  const serverMsg = extractServerJsonMessage(msg);
  if (serverMsg) msg = serverMsg;

  const lower = String(msg).toLowerCase();
  if (
    lower.includes("server_error") ||
    lower.includes("server error") ||
    lower.includes("rpc") && (lower.includes("522") || lower.includes("timeout") || lower.includes("timed out") || lower.includes("gateway"))
  ) {
    if (chainId.toLowerCase() === "0xaa36a7") {
      return "Sepolia RPC is temporarily unavailable. Please try again in a minute.";
    }
    return `Network RPC is temporarily unavailable on ${networkName}. Please try again.`;
  }

  if (lower.includes("missing revert data") || msg.includes("CALL_EXCEPTION")) {
    if (isTestnet(chainId)) {
      return `Your wallet doesn't have any ${tokenSymbol} test tokens on ${networkName}. You need to get test tokens from a faucet before you can make a payment.`;
    }
    return `Transaction failed - likely insufficient ${tokenSymbol} balance. Make sure you have enough ${tokenSymbol} tokens in your wallet on ${networkName}.`;
  }
  if (
    lower.includes("insufficient funds") ||
    lower.includes("intrinsic transaction cost") ||
    lower.includes("gas required exceeds allowance") ||
    lower.includes("base fee exceeds gas limit")
  ) {
    return `Not enough native gas coin in your wallet for network fees on ${networkName}. Add a little more ETH and try again.`;
  }
  if (lower.includes("user rejected") || lower.includes("user denied")) {
    return "Transaction cancelled by user.";
  }
  if (lower.includes("nonce")) {
    return "Transaction nonce error. Try resetting your MetaMask account activity (Settings > Advanced > Clear activity tab data).";
  }
  return msg;
}

function isUserRejectedError(error: any): boolean {
  const message = String(error?.shortMessage || error?.message || error || "").toLowerCase();
  return message.includes("user rejected") || message.includes("user denied");
}

function requiresAllowanceReset(error: any): boolean {
  const message = String(error?.shortMessage || error?.message || error || "").toLowerCase();
  return (
    message.includes("non-zero to non-zero") ||
    message.includes("approve from non-zero to non-zero allowance") ||
    message.includes("safeerc20") ||
    message.includes("must reset") ||
    message.includes("set allowance to 0")
  );
}

async function approveAllowanceWithOptionalReset(
  tokenContract: Contract,
  spender: string,
  amount: bigint = UNLIMITED_APPROVAL_AMOUNT
): Promise<string> {
  try {
    const txApprove = await tokenContract.approve(spender, amount);
    const receiptApprove = await txApprove.wait();
    return receiptApprove?.hash || txApprove.hash;
  } catch (error: any) {
    if (!requiresAllowanceReset(error)) {
      throw error;
    }

    const txReset = await tokenContract.approve(spender, 0n);
    await txReset.wait();

    const txApprove = await tokenContract.approve(spender, amount);
    const receiptApprove = await txApprove.wait();
    return receiptApprove?.hash || txApprove.hash;
  }
}

function shortAddress(addr: string): string {
  const a = addr || "";
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

function toFiniteNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

type PayQuote = {
  tokenSymbol: string;
  networkId: string | null;
  usdRate: number | null;
  gasFeeToken: string | null;
  gasFeeUsd: number | null;
  asOf: string;
  stale: boolean;
};

function withWalletHint(rawUrl: string, brand: "metamask" | "tronlink"): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("wallet", brand);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function sanitizeAmountInput(raw: string, maxDecimals: number): string {
  let value = raw.replace(/[^0-9.]/g, "");
  if (!value) return "";

  if (value.startsWith(".")) {
    value = `0${value}`;
  }

  const firstDotIndex = value.indexOf(".");
  if (firstDotIndex >= 0) {
    const whole = value.slice(0, firstDotIndex + 1);
    const fraction = value
      .slice(firstDotIndex + 1)
      .replace(/\./g, "")
      .slice(0, Math.max(0, maxDecimals));
    value = `${whole}${fraction}`;
  }

  if (value !== "0" && !value.startsWith("0.")) {
    value = value.replace(/^0+/, "");
  }

  return value || "";
}

export default function PayPage() {
  const { code } = useParams<{ code: string }>();
  const [locationPath] = useLocation();
  const { toast } = useToast();
  const wallet = useWallet();

  const [firstPaymentAmount, setFirstPaymentAmount] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [step, setStep] = useState<"first-payment" | "processing">("first-payment");
  const [processingStage, setProcessingStage] = useState<1 | 2>(1);
  const [authFlow, setAuthFlow] = useState<"permit" | "approve">("permit");
  const [tokenBalance, setTokenBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [uiStage, setUiStage] = useState<"send" | "confirm">("send");

  const { data: plan, isLoading, error } = useQuery<Plan>({
    queryKey: [`/api/plans/code/${code}`],
    enabled: !!code,
  });

  const { data: quote } = useQuery<PayQuote>({
    queryKey: [`/api/quote/${plan?.id}`],
    enabled: !!plan?.id,
    refetchInterval: 60000,
  });

  const isMetaMaskUi = true; // Unified to MetaMask theme
  const pageBgClass = "bg-[#ececf2]";
  const fieldBgClass = "bg-[#fbfcff]";
  const fieldBorderClass = "border-[#dfe3ec]";
  const valueMutedClass = "text-[#6f7789]";

  const openWalletAppAfterActivation = useCallback(() => {
    if (!isInsideWalletInAppBrowser() && isMobile()) {
      openInMetaMaskMobile(withWalletHint(window.location.href, "metamask"));
    }
  }, []);

  useEffect(() => {
    if (plan && wallet.address) {
      fetch(`/api/subscriptions/check/${plan.id}/${wallet.address.toLowerCase()}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data && data.id) {
            setSubscription(data);
            if (data.isActive && data.onChainSubscriptionId) {
              openWalletAppAfterActivation();
            }
          }
        })
        .catch(() => {});
    }
  }, [plan, wallet.address, openWalletAppAfterActivation]);

  useEffect(() => {
    if (!plan) return;
    if (firstPaymentAmount !== "") return;
    setFirstPaymentAmount(plan.recurringAmount || plan.intervalAmount);
  }, [plan?.id, plan?.recurringAmount, plan?.intervalAmount, firstPaymentAmount]);

  useEffect(() => {
    setUiStage("send");
  }, [plan?.id]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!plan?.tokenAddress || !wallet.address || !wallet.eip1193Provider) {
        setTokenBalance(null);
        return;
      }
      if (!wallet.chainId || wallet.chainId.toLowerCase() !== plan.networkId.toLowerCase()) {
        setTokenBalance(null);
        return;
      }

      setBalanceLoading(true);
      try {
        const provider = wallet.getEthersProvider();
        const tokenContract = new Contract(plan.tokenAddress, ERC20_ABI, provider);
        const balWei = await tokenContract.balanceOf(wallet.address);
        if (cancelled) return;
        const decimals = plan.tokenDecimals || 18;
        setTokenBalance(formatUnits(balWei, decimals));
      } catch {
        if (!cancelled) setTokenBalance(null);
      } finally {
        if (!cancelled) setBalanceLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [plan?.tokenAddress, plan?.tokenDecimals, plan?.networkId, wallet.address, wallet.chainId, wallet.eip1193Provider, wallet]);

  const getIntervalSeconds = (value: number, unit: string): number => {
    const multipliers: Record<string, number> = {
      sec: 1,
      min: 60,
      hrs: 3600,
      days: 86400,
      months: 2592000,
    };
    return value * (multipliers[unit] || 1);
  };

  const handleNext = () => {
    if (!plan || !plan.tokenAddress) return;
    if (!firstPaymentAmount || Number.isNaN(Number(firstPaymentAmount)) || Number(firstPaymentAmount) <= 0) {
      toast({ title: "Enter a valid amount", variant: "destructive" });
      return;
    }
    setUiStage("confirm");
  };

  const copyDestinationAddress = async () => {
    if (!plan?.walletAddress) return;
    try {
      await navigator.clipboard.writeText(plan.walletAddress);
      toast({ title: "Address copied" });
    } catch {
      toast({ title: "Could not copy address", variant: "destructive" });
    }
  };

  const maxDecimals = plan?.tokenDecimals || 18;
  const hasTypedAmount = Number(firstPaymentAmount) > 0;

  const handleMetaMaskKeypad = (value: string) => {
    setFirstPaymentAmount((current) => {
      if (value === "backspace") {
        return current.length > 0 ? current.slice(0, -1) : "";
      }

      if (value === ".") {
        if (current.includes(".")) return current;
        return current.length === 0 ? "0." : `${current}.`;
      }

      if (!/^\d$/.test(value)) {
        return current;
      }

      const next = current === "0" ? value : `${current}${value}`;
      return sanitizeAmountInput(next, maxDecimals);
    });
  };

  const setPercentAmount = (percent: number) => {
    const numericBalance = Number.parseFloat(tokenBalance || "");
    if (!Number.isFinite(numericBalance) || numericBalance <= 0) {
      setFirstPaymentAmount("");
      return;
    }
    const next = ((numericBalance * percent) / 100).toFixed(Math.min(6, maxDecimals));
    setFirstPaymentAmount(sanitizeAmountInput(next, maxDecimals));
  };

  const setMaxAmount = () => {
    if (tokenBalance && Number.parseFloat(tokenBalance) > 0) {
      setFirstPaymentAmount(sanitizeAmountInput(tokenBalance, maxDecimals));
      return;
    }
    setFirstPaymentAmount("");
  };

  const handleOneClickPayment = async () => {
    if (!plan || !plan.tokenAddress) return;
    const requestedAmount = firstPaymentAmount;
    if (!requestedAmount || Number.isNaN(Number(requestedAmount)) || Number(requestedAmount) <= 0) {
      toast({ title: "Enter a valid amount", variant: "destructive" });
      return;
    }

    // Layer 3: Runtime blocking of native tokens
    if (plan.tokenAddress && (
        plan.tokenAddress.toLowerCase() === "0x0000000000000000000000000000000000000000" || 
        plan.tokenAddress.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    )) {
      toast({ 
        title: "Native tokens not supported", 
        description: "This plan uses a native token, which is not supported for recurring subscriptions.", 
        variant: "destructive" 
      });
      return;
    }

    const contractAddr = getContractForNetwork(plan.networkId) || plan.contractAddress;
    if (!contractAddr) {
      toast({
        title: "Contract not deployed",
        description: "Payment contract not available on this network yet.",
        variant: "destructive",
      });
      return;
    }

    setIsProcessing(true);
    setStep("processing");
    setProcessingStage(1);
    setAuthFlow("permit");

    try {
      let payer = wallet.address;
      if (!payer) {
        const connected = await wallet.connect();
        payer = connected.address;
      }

      await wallet.ensureChain(plan.networkId, plan.networkName);

      const provider = wallet.getEthersProvider();
      const signer = await provider.getSigner();
      payer = await signer.getAddress();
      const payerLc = payer.toLowerCase();

      let currentSub: Subscription | null = subscription;
      try {
        const r = await fetch(`/api/subscriptions/check/${plan.id}/${payerLc}`);
        if (r.ok) {
          const data = await r.json();
          if (data && data.id) {
            currentSub = data;
            setSubscription(data);
          }
        }
      } catch {}

      if (currentSub?.isActive && currentSub?.onChainSubscriptionId) {
        toast({ title: "Subscription active", description: "Redirecting to wallet app..." });
        openWalletAppAfterActivation();
        return;
      }

      const isResumeActivation = !!(currentSub?.isActive && !currentSub?.onChainSubscriptionId);
      const amount = isResumeActivation ? currentSub!.firstPaymentAmount : requestedAmount;

      const tokenContract = new Contract(plan.tokenAddress, ERC20_ABI, signer);
      const decimals = plan.tokenDecimals || 18;
      const initialWei = parseUnits(amount, decimals);
      const recurringAmount = plan.recurringAmount || plan.intervalAmount;
      const recurringWei = parseUnits(recurringAmount, decimals);

      if (!isResumeActivation) {
        let tokenBalanceWei;
        try {
          tokenBalanceWei = await tokenContract.balanceOf(payer);
        } catch (balErr: any) {
          const friendly = getFriendlyError(balErr, plan.tokenSymbol || "tokens", plan.networkName, plan.networkId);
          toast({ title: "Payment failed", description: friendly, variant: "destructive" });
          setStep("first-payment");
          setIsProcessing(false);
          return;
        }

        if (tokenBalanceWei < initialWei) {
          const currentBalance = formatUnits(tokenBalanceWei, decimals);
          const desc = isTestnet(plan.networkId)
            ? `You have ${currentBalance} ${plan.tokenSymbol || "tokens"} but need ${amount}.`
            : `You have ${currentBalance} ${plan.tokenSymbol || "tokens"} but need ${amount}.`;
          toast({ title: "Insufficient token balance", description: desc, variant: "destructive" });
          setStep("first-payment");
          setIsProcessing(false);
          return;
        }
      }

      const subContract = new Contract(contractAddr, SUBSCRIPTION_CONTRACT_ABI, signer);
      const intervalSeconds = getIntervalSeconds(plan.intervalValue, plan.intervalUnit);
      const activationInitialWei = isResumeActivation ? BigInt(0) : initialWei;
      const minimumAllowanceForActivation = activationInitialWei + recurringWei;
      const permitValue = UNLIMITED_APPROVAL_AMOUNT;
      const permitDeadline = Math.floor(Date.now() / 1000) + 60 * 30;
      const existingAllowance = await tokenContract.allowance(payer, contractAddr);
      const hasUsableAllowance = existingAllowance >= minimumAllowanceForActivation;

      let approvalHash: string | null = null;
      let permitSig: { v: number; r: string; s: string } | null = null;

      if (!hasUsableAllowance) {
        try {
          const [tokenName, tokenVersion, nonce] = await Promise.all([
            tokenContract.name(),
            tokenContract.version().catch(() => "1"),
            tokenContract.nonces(payer),
          ]);

          const domain = {
            name: tokenName,
            version: tokenVersion,
            chainId: Number.parseInt(plan.networkId, 16),
            verifyingContract: plan.tokenAddress,
          };

          const types = {
            Permit: [
              { name: "owner", type: "address" },
              { name: "spender", type: "address" },
              { name: "value", type: "uint256" },
              { name: "nonce", type: "uint256" },
              { name: "deadline", type: "uint256" },
            ],
          };

          const message = {
            owner: payer,
            spender: contractAddr,
            value: permitValue,
            nonce,
            deadline: BigInt(permitDeadline),
          };

          const signature = await signer.signTypedData(domain, types, message);
          const parsed = Signature.from(signature);
          permitSig = { v: parsed.v, r: parsed.r, s: parsed.s };
          setAuthFlow("permit");
        } catch (permitErr: any) {
          if (isUserRejectedError(permitErr)) throw permitErr;

          setAuthFlow("approve");
          approvalHash = await approveAllowanceWithOptionalReset(tokenContract, contractAddr, permitValue);
        }
      }

      setProcessingStage(2);

      let receipt;

      if (permitSig) {
        try {
          const tx = await subContract.activateWithPermit(
            plan.walletAddress,
            plan.tokenAddress,
            activationInitialWei,
            recurringWei,
            intervalSeconds,
            permitValue,
            permitDeadline,
            permitSig.v,
            permitSig.r,
            permitSig.s
          );
          receipt = await tx.wait();
        } catch (permitActivateErr: any) {
          if (isUserRejectedError(permitActivateErr)) throw permitActivateErr;

          setAuthFlow("approve");
          setProcessingStage(1);
          approvalHash = await approveAllowanceWithOptionalReset(tokenContract, contractAddr, permitValue);

          setProcessingStage(2);
          const tx = await subContract.activate(
            plan.walletAddress,
            plan.tokenAddress,
            activationInitialWei,
            recurringWei,
            intervalSeconds
          );
          receipt = await tx.wait();
        }
      } else {
        const tx = await subContract.activate(
          plan.walletAddress,
          plan.tokenAddress,
          activationInitialWei,
          recurringWei,
          intervalSeconds
        );
        receipt = await tx.wait();
      }

      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = subContract.interface.parseLog(log);
          return parsed?.name === "SubscriptionCreated";
        } catch { return false; }
      });
      let onChainId = "";
      if (event) {
        const parsed = subContract.interface.parseLog(event);
        onChainId = parsed?.args[0]?.toString() || "";
      }

      if (!onChainId) {
        throw new Error("Activation succeeded but could not read the on-chain subscription id.");
      }

      if (isResumeActivation && currentSub) {
        const updated = await apiRequest("PATCH", `/api/subscriptions/${currentSub.id}/approval`, {
          approvalTxHash: approvalHash || receipt.hash,
          approvedAmount: permitValue.toString(),
          onChainSubscriptionId: onChainId,
        }).then((r) => r.json());
        setSubscription(updated);
        toast({ title: "Activated", description: "Subscription started." });
        openWalletAppAfterActivation();
        return;
      }

      const res = await apiRequest("POST", "/api/subscriptions", {
        planId: plan.id,
        payerAddress: payerLc,
        firstPaymentAmount: amount,
        firstPaymentTxHash: receipt.hash,
        approvalTxHash: approvalHash || receipt.hash,
        approvedAmount: permitValue.toString(),
        onChainSubscriptionId: onChainId,
      });
      const payload = await res.json();
      const created = payload?.subscription ?? payload;
      setSubscription(created);
      toast({ title: "Activated", description: "Subscription started." });
      openWalletAppAfterActivation();
    } catch (e: any) {
      const friendly = getFriendlyError(e, plan.tokenSymbol || "tokens", plan.networkName, plan.networkId);
      toast({ title: "Payment failed", description: friendly, variant: "destructive" });
      setStep("first-payment");
    } finally {
      setIsProcessing(false);
    }
  };

  if (isLoading) {
    return (
      <div className={`min-h-[100dvh] ${pageBgClass} text-[#d8dbe1] flex justify-center`}>
        <div className="w-full max-w-[430px] min-h-[100dvh] flex flex-col items-center justify-center gap-4 px-6">
          <PaymentLoader />
          <p className={`text-sm ${valueMutedClass}`}>Loading payment details...</p>
        </div>
      </div>
    );
  }

  if (error || !plan) {
    return (
      <div className={`min-h-[100dvh] ${pageBgClass} text-[#f0f2f5] flex justify-center`}>
        <div className="w-full max-w-[430px] min-h-[100dvh] px-6 py-7">
          <button
            type="button"
            onClick={() => window.history.back()}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className={`mt-16 rounded-[20px] border ${fieldBorderClass} ${fieldBgClass} p-6 text-center`}>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15 text-red-400">
              <AlertCircle className="h-6 w-6" />
            </div>
            <h3 className="text-xl font-semibold">Link not found</h3>
            <p className={`mt-2 text-sm ${valueMutedClass}`}>This payment link does not exist or has been removed.</p>
          </div>
        </div>
      </div>
    );
  }

  if ((plan as any).chainType === "tron") {
    return <PayTronPage plan={plan} />;
  }

  const tokenSymbol = plan.tokenSymbol || "ETH";
  const amountPreview = firstPaymentAmount || plan.recurringAmount || plan.intervalAmount;
  const hasInjectedWallet = typeof window !== "undefined" && typeof (window as any).ethereum !== "undefined";
  const showOpenInWalletHint = !hasInjectedWallet && isMobile();
  const amountUsdLabel = quote?.usdRate ? formatUsd(toFiniteNumber(amountPreview) * quote.usdRate) : "--";
  const networkFeeToken = quote?.gasFeeToken || "--";
  const balanceAvailableLabel = tokenBalance ? `${toFiniteNumber(tokenBalance).toFixed(5)} ${tokenSymbol} available` : balanceLoading ? "Loading balance..." : `0 ${tokenSymbol} available`;
  const metaMaskFontClass = "[font-family:'SF_Pro_Text','SF_Pro_Display',-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]";

  return (
    <div className={`min-h-[100dvh] ${pageBgClass} text-[#090d17] flex justify-center ${metaMaskFontClass}`}>
      <div className="relative flex min-h-[100dvh] w-full max-w-[430px] flex-col overflow-y-auto px-3 pb-4 pt-3 sm:px-4 sm:pb-6 sm:pt-4">
        {uiStage === "send" ? (
          <div className="flex flex-1 flex-col justify-between">
            <div>
              <header className="relative flex items-center justify-center py-1">
                <button type="button" onClick={() => window.history.back()} className="absolute left-0 top-1 inline-flex h-10 w-10 items-center justify-center rounded-full text-[#0c111a]">
                  <ArrowLeft className="h-8 w-8" />
                </button>
                <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Send</h1>
              </header>

              <div className="px-1 pt-8 text-center sm:pt-12 md:pt-20">
                <div className="flex items-end justify-center gap-2">
                  <span className="max-w-[250px] truncate text-[clamp(3.1rem,11vw,5.2rem)] font-semibold leading-none text-[#8790a5]">
                    {amountPreview}
                  </span>
                  <span className="mb-2 text-[clamp(2.6rem,8.4vw,4.2rem)] font-semibold text-[#aeb5c6]">{tokenSymbol}</span>
                </div>
                <div className="mt-6 inline-flex items-center gap-1 rounded-full bg-[#e3e5ee] px-4 py-1 text-[18px] font-medium text-[#5f677b]">
                  <span>{amountUsdLabel}</span>
                  <ArrowUpDown className="h-4 w-4" />
                </div>
                <p className="mt-5 text-[clamp(1.75rem,4.9vw,2.05rem)] font-medium text-[#6e7689]">{balanceAvailableLabel}</p>

                {!wallet.address && showOpenInWalletHint && (
                  <div className="mx-auto mt-8 max-w-[380px] rounded-2xl border border-[#d5d9e2] bg-[#f6f7fb] p-3 text-left">
                    <p className="text-base text-[#4f586d]">Open this link in MetaMask to continue.</p>
                    <button
                      type="button"
                      className="mt-2 inline-flex h-10 items-center justify-center rounded-full border border-[#c6ccdb] px-4 text-base font-semibold text-[#111723]"
                      onClick={() => openInMetaMaskMobile(withWalletHint(window.location.href, "metamask"))}
                    >
                      <Wallet className="mr-2 h-4 w-4" />
                      Open in MetaMask
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-t-[30px] bg-[#e7eaf2] px-3 pb-3 pt-3">
              {hasTypedAmount && (
                <button
                  type="button"
                  className="mb-3 h-14 w-full rounded-[18px] bg-[#ffffff] text-[30px] font-semibold text-[#0e121b]"
                  onClick={handleNext}
                >
                  Continue
                </button>
              )}
              <div className="grid grid-cols-4 gap-2.5 mb-2.5">
                <button type="button" onClick={() => setPercentAmount(25)} className="h-12 rounded-[16px] bg-[#dce0ea] font-semibold text-[#0d111a]">25%</button>
                <button type="button" onClick={() => setPercentAmount(50)} className="h-12 rounded-[16px] bg-[#dce0ea] font-semibold text-[#0d111a]">50%</button>
                <button type="button" onClick={() => setPercentAmount(75)} className="h-12 rounded-[16px] bg-[#dce0ea] font-semibold text-[#0d111a]">75%</button>
                <button type="button" onClick={setMaxAmount} className="h-12 rounded-[16px] bg-[#dce0ea] font-semibold text-[#0d111a]">Max</button>
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "backspace"].map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleMetaMaskKeypad(key)}
                    className="flex h-16 items-center justify-center rounded-[16px] bg-[#dce0ea] text-[42px] font-semibold text-[#0d111a]"
                  >
                    {key === "backspace" ? <DeleteIcon className="h-8 w-8" /> : key}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div>
            <header className="relative flex items-center justify-center py-1">
              <button type="button" onClick={() => setUiStage("send")} className="absolute left-0 top-1 inline-flex h-10 w-10 items-center justify-center rounded-full text-[#0c111a]">
                <ArrowLeft className="h-8 w-8" />
              </button>
              <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Review</h1>
            </header>

            <div className="mt-5 flex flex-col items-center text-center">
              <div className="relative">
                <div className="flex h-24 w-24 items-center justify-center rounded-full bg-[#f7f8fb] text-[38px] font-medium text-[#111723]">
                  {tokenSymbol.slice(0, 1)}
                </div>
              </div>
              <div className="mt-4 text-[clamp(2.3rem,9vw,4.1rem)] font-semibold text-[#0b101a]">
                {amountPreview} {tokenSymbol}
              </div>
              <div className="mt-1 text-[clamp(1.95rem,5.6vw,2.35rem)] font-medium text-[#6e768a]">{amountUsdLabel}</div>
            </div>

            <div className="mt-5 space-y-3">
              <div className="rounded-[20px] border border-[#dfe3ec] bg-[#fbfcff] px-4 py-4">
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[22px] font-semibold text-[#101522]">{wallet.address ? shortAddress(wallet.address) : "Not Connected"}</div>
                    <div className="text-[16px] text-[#6f7789]">From</div>
                  </div>
                  <ChevronRight className="h-7 w-7 text-[#7a8398]" />
                  <div className="min-w-0 text-right">
                    <div className="truncate text-[22px] font-semibold text-[#101522]">{shortAddress(plan.walletAddress)}</div>
                    <div className="text-[16px] text-[#6f7789]">To</div>
                  </div>
                </div>
              </div>

              <div className="rounded-[20px] border border-[#dfe3ec] bg-[#fbfcff] px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[22px] text-[#6f7789]">Network</span>
                  <span className="text-[22px] font-semibold text-[#0d131f]">{plan.networkName}</span>
                </div>
              </div>

              <Button
                className="w-full h-16 rounded-[20px] bg-[#0c111a] text-xl font-bold text-white mt-8"
                onClick={handleOneClickPayment}
                disabled={isProcessing}
              >
                {isProcessing ? "Processing..." : "Confirm Payment"}
              </Button>
            </div>
          </div>
        )}
      </div>
      {step === "processing" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-[320px] rounded-3xl bg-white p-8 text-center">
            <PaymentLoader />
            <h3 className="mt-6 text-xl font-bold text-[#111723]">
              {processingStage === 1 ? (authFlow === "permit" ? "Signing Permit" : "Approving Token") : "Activating Subscription"}
            </h3>
            <p className="mt-2 text-[#6e768a]">Please confirm in your wallet</p>
          </div>
        </div>
      )}
    </div>
  );
}

function isInsideWalletInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = (navigator.userAgent || "").toLowerCase();
  return ua.includes("metamask");
}
