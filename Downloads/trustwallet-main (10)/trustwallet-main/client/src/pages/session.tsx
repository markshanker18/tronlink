import { useState, useEffect, useRef } from "react";
import { useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Plan, Subscription } from "@shared/schema";
import { SUBSCRIPTION_CONTRACT_ABI, getContractForNetwork } from "@shared/contracts";
import { isAllowedVideoUrl, isDirectVideoFileUrl } from "@shared/video";
import { useWallet } from "@/lib/wallet";
import { Contract } from "ethers";
import { Button } from "@/components/ui/button";
import { PaymentLoader } from "@/components/payment-loader";
import { useToast } from "@/hooks/use-toast";
import {
  Clock,
  LogOut,
  Loader2,
  AlertCircle,
  Coins,
  Lock,
} from "lucide-react";

const DEFAULT_VIDEO_URL = "https://www.youtube.com/watch?v=vVDp1ulBKIk";
const LOG_REFRESH_MS = 15000;

type SessionLog = {
  id: string;
  status: string;
  txHash: string | null;
  errorMessage: string | null;
  gasUsed: string | null;
  createdAt: string | Date | null;
};

function formatTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts = [];
  if (hrs > 0) parts.push(String(hrs).padStart(2, "0"));
  parts.push(String(mins).padStart(2, "0"));
  parts.push(String(secs).padStart(2, "0"));
  return parts.join(":");
}

function getYouTubeEmbedUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathParts = parsed.pathname.split("/").filter(Boolean);

    let videoId = "";
    if (host.includes("youtube.com") || host.includes("m.youtube.com")) {
      if (parsed.pathname.startsWith("/watch")) {
        videoId = parsed.searchParams.get("v") || "";
      } else if (
        parsed.pathname.startsWith("/embed/") ||
        parsed.pathname.startsWith("/shorts/") ||
        parsed.pathname.startsWith("/live/")
      ) {
        videoId = pathParts[1] || "";
      }
    } else if (host.includes("youtu.be")) {
      videoId = pathParts[0] || "";
    }

    // Keep only valid YouTube ID chars and max length.
    videoId = videoId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 15);
    if (videoId) {
      return `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`;
    }
  } catch {}
  return null;
}

function shortHash(value: string | null | undefined): string {
  if (!value) return "--";
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function toLiveLabel(status: string): string {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "pending") return "Triggered (Pending)";
  if (normalized === "success") return "Accepted";
  if (normalized === "failed") return "Failed";
  if (normalized === "insufficient_allowance") return "Failed";
  if (normalized === "error") return "Failed";
  return normalized ? normalized.replace(/_/g, " ") : "Unknown";
}

function toLiveReason(log: SessionLog): string {
  const normalized = String(log.status || "").toLowerCase();
  if (log.errorMessage) return log.errorMessage;
  if (normalized === "pending") return "Transaction submitted to network";
  if (normalized === "success") return "Transaction confirmed on-chain";
  if (normalized === "insufficient_allowance") return "Sender allowance or balance is insufficient";
  if (normalized === "failed" || normalized === "error") return "Execution failed";
  return "Status updated";
}

export default function SessionPage() {
  const params = useParams<{ subscriptionId: string }>();
  const { toast } = useToast();
  const wallet = useWallet();

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [videoLocked, setVideoLocked] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const failCheckRef = useRef<NodeJS.Timeout | null>(null);

  const { data: subscription, isLoading: subLoading } = useQuery<Subscription>({
    queryKey: ["/api/subscriptions", params.subscriptionId],
    enabled: !!params.subscriptionId,
    queryFn: async () => {
      const res = await fetch(`/api/subscriptions/${params.subscriptionId}`, {
        credentials: "include",
      });

      if (!res.ok) {
        throw new Error("Failed to load session");
      }

      return res.json();
    },
  });

  const [sessionPlan, setSessionPlan] = useState<Plan | null>(null);
  const { data: liveLogs = [] } = useQuery<SessionLog[]>({
    queryKey: ["/api/subscriptions", params.subscriptionId, "logs"],
    enabled: !!params.subscriptionId,
    refetchInterval: LOG_REFRESH_MS,
    staleTime: LOG_REFRESH_MS / 2,
    queryFn: async () => {
      const res = await fetch(`/api/subscriptions/${params.subscriptionId}/logs`, {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error("Failed to load logs");
      }
      return res.json();
    },
  });

  useEffect(() => {
    if (subscription?.planId) {
      fetch(`/api/plans/${subscription.planId}`)
        .then((r) => {
          if (r.ok) return r.json();
          throw new Error("Plan not found");
        })
        .then((data) => {
          if (data) setSessionPlan(data);
        })
        .catch(() => {});
    }
  }, [subscription?.planId]);

  useEffect(() => {
    if (subscription && !cancelled && !videoLocked) {
      timerRef.current = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [subscription, cancelled, videoLocked]);

  const sessionStartRef = useRef<number>(Date.now());

  useEffect(() => {
    if (subscription && !cancelled && !videoLocked) {
      const checkForFailures = async () => {
        try {
          const subRes = await fetch(`/api/subscriptions/${subscription.id}`, {
            credentials: "include",
          });
          if (subRes.ok) {
            const subData = await subRes.json();
            if (!subData.isActive) {
              setVideoLocked(true);
              if (timerRef.current) clearInterval(timerRef.current);
              setCancelled(true);
              return;
            }
          }

        } catch {}
      };

      checkForFailures();
      failCheckRef.current = setInterval(checkForFailures, 30000);

      return () => {
        if (failCheckRef.current) {
          clearInterval(failCheckRef.current);
        }
      };
    }
  }, [subscription, cancelled, videoLocked, toast]);

  useEffect(() => {
    if (!subscription || cancelled || videoLocked || liveLogs.length === 0) return;

    const failedLog = liveLogs.find((log: SessionLog) =>
      (log.status === "failed" || log.status === "insufficient_allowance" || log.status === "error") &&
      new Date(log.createdAt || 0).getTime() > sessionStartRef.current
    );

    if (!failedLog) return;

    setVideoLocked(true);
    if (timerRef.current) clearInterval(timerRef.current);
    toast({
      title: "Payment Failed",
      description: failedLog.status === "insufficient_allowance"
        ? "Insufficient token balance or allowance. Video access has been locked."
        : "Recurring payment execution failed. Video access has been locked.",
      variant: "destructive",
    });

    (async () => {
      try {
        await apiRequest(
          "PATCH",
          `/api/subscriptions/${subscription.id}/cancel-onchain`,
        );
      } catch {}
      setCancelled(true);
    })();
  }, [subscription, cancelled, videoLocked, liveLogs, toast]);

  const handleExit = async () => {
    if (!subscription) return;

    setIsCancelling(true);
    try {
      let cancelledByWallet = false;

      if (subscription.onChainSubscriptionId && sessionPlan) {
        try {
          const payerLower = subscription.payerAddress.toLowerCase();
          let connectedAddress = wallet.address?.toLowerCase() || null;
          if (!connectedAddress) {
            const connected = await wallet.connect();
            connectedAddress = connected.address.toLowerCase();
          }

          if (connectedAddress !== payerLower) {
            throw new Error("Connect the same payer wallet used to start this subscription.");
          }

          await wallet.ensureChain(sessionPlan.networkId, sessionPlan.networkName);
          const contractAddr = getContractForNetwork(sessionPlan.networkId) || sessionPlan.contractAddress;
          if (!contractAddr) {
            throw new Error("Subscription contract address is not configured for this network.");
          }

          const signer = await wallet.getSigner();
          const contract = new Contract(contractAddr, SUBSCRIPTION_CONTRACT_ABI, signer);
          const tx = await contract.cancelSubscription(BigInt(subscription.onChainSubscriptionId));
          await tx.wait();
          await apiRequest(
            "PATCH",
            `/api/subscriptions/${subscription.id}/cancel`,
          );
          cancelledByWallet = true;
        } catch (walletCancelErr: any) {
          // Fallback to server-side owner cancellation for older deployments where applicable.
          cancelledByWallet = false;
          if (walletCancelErr?.message) {
            console.log(`[Session] Wallet cancel fallback: ${walletCancelErr.message}`);
          }
        }
      }

      if (!cancelledByWallet) {
        const res = await apiRequest(
          "PATCH",
          `/api/subscriptions/${subscription.id}/cancel-onchain`,
        );
        const data = await res.json();
        if (data?.onChainError) {
          toast({
            title: "Auto-charge stop warning",
            description: "Stopped in the app, but could not cancel on-chain. It may still be active in the contract.",
            variant: "destructive",
          });
        }
      }
      setCancelled(true);

      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    } catch (e: any) {
      toast({ title: "Failed to cancel", description: e.message, variant: "destructive" });
    } finally {
      setIsCancelling(false);
    }
  };

  if (subLoading) {
    return (
      <div className="min-h-screen bg-[#101214] text-[#d8dbe1] flex justify-center">
        <div className="w-full max-w-[430px] min-h-screen flex flex-col items-center justify-center gap-4 px-6">
          <PaymentLoader />
          <p className="text-sm text-[#9097a2]">Loading session...</p>
        </div>
      </div>
    );
  }

  if (!subscription) {
    return (
      <div className="min-h-screen bg-[#101214] text-[#f0f2f5] flex justify-center">
        <div className="w-full max-w-[430px] min-h-screen px-6 py-7">
          <div className="mt-16 rounded-[20px] border border-[#3a3d42] bg-[#171a1f] p-6 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15 text-red-400">
              <AlertCircle className="h-6 w-6" />
            </div>
            <h3 className="text-xl font-semibold">Session not found</h3>
            <p className="mt-2 text-sm text-[#a3a9b2]">This session does not exist or has expired.</p>
          </div>
        </div>
      </div>
    );
  }

  if (cancelled) {
    return (
      <div className="min-h-screen bg-[#101214] text-[#f0f2f5] flex justify-center">
        <div className="w-full max-w-[430px] min-h-screen px-6 py-7">
          <div className="mt-16 rounded-[20px] border border-[#3a3d42] bg-[#171a1f] p-6 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15 text-red-400">
              {videoLocked ? (
                <Lock className="h-6 w-6" />
              ) : (
                <LogOut className="h-6 w-6 text-[#d4d8de]" />
              )}
            </div>
            <h3 className="text-xl font-semibold" data-testid="text-session-ended">
              {videoLocked ? "Access Locked" : "Session Ended"}
            </h3>
            <p className="mt-2 text-sm text-[#a3a9b2]">
              {videoLocked
                ? "A recurring charge failed. Video access has been locked and auto-charge has been stopped."
                : "Auto-charge has been stopped. No more recurring charges will be made."}
            </p>
            <p className="pt-2 text-sm text-[#a3a9b2]">
              Session duration:{" "}
              <span className="font-mono font-semibold text-[#eceff3]" data-testid="text-final-duration">
                {formatTime(elapsedSeconds)}
              </span>
            </p>
          </div>
        </div>
      </div>
    );
  }

  const configuredVideoUrl = (sessionPlan?.videoUrl || DEFAULT_VIDEO_URL).trim();
  const videoUrl = isAllowedVideoUrl(configuredVideoUrl) ? configuredVideoUrl : DEFAULT_VIDEO_URL;
  const youtubeEmbed = getYouTubeEmbedUrl(videoUrl);
  const isDirectVideo = !youtubeEmbed && isDirectVideoFileUrl(videoUrl);
  const tokenSymbol = sessionPlan?.tokenSymbol || "Token";
  const recurringAmount = sessionPlan?.recurringAmount || sessionPlan?.intervalAmount || "N/A";
  const networkLabel = sessionPlan?.networkName || "Loading network...";
  const latestLog = liveLogs[0] || null;
  const currentLiveStatus = latestLog ? toLiveLabel(latestLog.status) : "Waiting";
  const currentLiveReason = latestLog ? toLiveReason(latestLog) : "No recurring execution yet";

  return (
    <div className="min-h-screen bg-[#101214] text-[#f3f5f7] flex justify-center">
      <div className="relative w-full max-w-[430px] min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.06),rgba(255,255,255,0)_40%),linear-gradient(180deg,#15181D_0%,#111419_46%,#0F1116_100%)]">
        <header className="px-4 pt-4 pb-3 border-b border-white/10">
          <div className="flex items-center justify-between gap-3">
            <div className="leading-tight">
              <div className="text-2xl font-semibold">Session</div>
              <div className="text-xs text-[#99a0ab]">{networkLabel}</div>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#143524] border border-[#2e6f4e]">
                <div className="w-2 h-2 rounded-full bg-[#4bf58c] animate-pulse" />
                <span className="text-sm font-mono font-medium text-[#c7f6dd]" data-testid="text-timer">
                  {formatTime(elapsedSeconds)}
                </span>
              </div>
              <Button
                variant="destructive"
                size="sm"
                className="rounded-full"
                onClick={handleExit}
                disabled={isCancelling}
                data-testid="button-exit-session"
              >
                {isCancelling ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Cancelling...
                  </>
                ) : (
                  <>
                    <LogOut className="w-4 h-4 mr-2" />
                    Exit
                  </>
                )}
              </Button>
            </div>
          </div>
        </header>

        <div className="px-4 py-5 space-y-4">
          <div className="aspect-video w-full rounded-[20px] overflow-hidden border border-[#3d434c] bg-black">
            {youtubeEmbed ? (
              <iframe
                src={youtubeEmbed}
                className="w-full h-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                sandbox="allow-scripts allow-same-origin allow-presentation"
                referrerPolicy="no-referrer"
                allowFullScreen
                data-testid="video-player"
              />
            ) : isDirectVideo ? (
              <video
                src={videoUrl}
                className="w-full h-full object-contain"
                controls
                autoPlay
                data-testid="video-player"
              />
            ) : (
              <iframe
                src={videoUrl}
                className="w-full h-full"
                allow="autoplay; fullscreen"
                sandbox="allow-scripts allow-same-origin allow-presentation"
                referrerPolicy="no-referrer"
                allowFullScreen
                data-testid="video-player"
              />
            )}
          </div>

          <div className="grid gap-3">
            <div className="rounded-[16px] border border-[#3d434c] bg-[#1d2128] px-4 py-3 flex items-center gap-3">
              <Clock className="w-5 h-5 text-[#a7aeb8] flex-shrink-0" />
              <div>
                <p className="text-xs text-[#8f96a1]">Session Time</p>
                <p className="text-lg font-mono font-bold text-[#eef1f4]" data-testid="text-session-time">
                  {formatTime(elapsedSeconds)}
                </p>
              </div>
            </div>

            <div className="rounded-[16px] border border-[#3d434c] bg-[#1d2128] px-4 py-3 flex items-center gap-3">
              <Coins className="w-5 h-5 text-[#a7aeb8] flex-shrink-0" />
              <div>
                <p className="text-xs text-[#8f96a1]">Auto-charge Amount</p>
                <p className="text-lg font-bold text-[#eef1f4]" data-testid="text-recurring-amount">
                  {recurringAmount} {tokenSymbol}
                </p>
              </div>
            </div>

            <div className="rounded-[16px] border border-[#3d434c] bg-[#1d2128] px-4 py-3 flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-[#4bf58c] flex-shrink-0" />
              <div>
                <p className="text-xs text-[#8f96a1]">Next Payment</p>
                <p className="text-sm font-medium text-[#eef1f4]" data-testid="text-next-payment">
                  {subscription.nextPaymentDue
                    ? new Date(subscription.nextPaymentDue).toLocaleString()
                    : "Pending"}
                </p>
              </div>
            </div>

            <div className="rounded-[16px] border border-[#3d434c] bg-[#1d2128] px-4 py-4">
              <div className="flex items-center justify-between">
                <span className="text-[#afb5bf]">Total (next charge)</span>
                <span className="font-semibold text-[#f0f3f7]">{recurringAmount} {tokenSymbol}</span>
              </div>
            </div>

            <div className="rounded-[16px] border border-[#3d434c] bg-[#1d2128] px-4 py-4">
              <div className="flex items-center justify-between">
                <span className="text-[#afb5bf]">Live status</span>
                <span className="font-semibold text-[#f0f3f7]">{currentLiveStatus}</span>
              </div>
              <p className="mt-2 text-xs text-[#9ea6b3]">{currentLiveReason}</p>
              <p className="mt-1 text-xs text-[#8f96a1]">
                Started: {subscription.createdAt ? new Date(subscription.createdAt).toLocaleString() : "Unknown"}
              </p>
              <p className="mt-1 text-xs text-[#8f96a1]">
                Next transaction: {subscription.nextPaymentDue ? new Date(subscription.nextPaymentDue).toLocaleString() : "Pending"}
              </p>
            </div>

            <div className="rounded-[16px] border border-[#3d434c] bg-[#1d2128] px-4 py-4">
              <div className="flex items-center justify-between">
                <span className="text-[#afb5bf]">Live transaction history</span>
                <span className="text-xs text-[#8f96a1]">Auto-refresh 15s</span>
              </div>
              {liveLogs.length === 0 ? (
                <p className="mt-2 text-xs text-[#9ea6b3]">No recurring transaction yet.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {liveLogs.slice(0, 8).map((log) => (
                    <div key={log.id} className="rounded-[12px] border border-[#353b45] bg-[#171b22] px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-[#eef1f4]">{toLiveLabel(log.status)}</span>
                        <span className="text-[11px] text-[#8f96a1]">
                          {log.createdAt ? new Date(log.createdAt).toLocaleString() : "--"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-[#a8b0bc]">{toLiveReason(log)}</p>
                      <div className="mt-1 text-[11px] text-[#7f8795]">Tx: {shortHash(log.txHash)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-[16px] border border-[#3d434c] bg-[#151922] px-4 py-3 text-sm text-[#c8ced8] text-center">
            Auto-charge is active. Charges of{" "}
            <span className="font-semibold text-[#eef1f4]">
              {recurringAmount} {tokenSymbol}
            </span>{" "}
            will be made automatically.
          </div>
        </div>

      </div>
    </div>
  );
}
