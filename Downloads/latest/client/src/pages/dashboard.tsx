import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  connectInjectedWallet,
  isMetaMaskInstalled,
  isMobile,
  openInMetaMaskMobile,
  openInTrustWalletMobile,
  getBalance,
  onAccountsChanged,
  onChainChanged,
  getChainName,
  type WalletBrand,
  type NetworkInfo,
} from "@/lib/metamask";
import { connectTronLink } from "@/lib/tronweb";
import { isTronNetwork } from "@shared/contracts";
import type { Plan, Subscription, UserWallet, SchedulerLog } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  Wallet,
  LogOut,
  Plus,
  QrCode,
  Copy,
  Check,
  ExternalLink,
  Clock,
  Coins,
  AlertCircle,
  Pencil,
  Save,
  X,
  Users,
  Shield,
  Zap,
  Key,
  Eye,
  EyeOff,
  Trash2,
  LayoutDashboard,
  FileText,
  ArrowUpDown,
  Settings,
  TrendingUp,
  Activity,
  CheckCircle,
  XCircle,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Menu,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import CreatePlanDialog from "@/components/create-plan-dialog";
import QRCodeDialog from "@/components/qr-code-dialog";
import { TrustWalletLogo } from "@/components/trust-wallet-logo";

type DashboardSection = "overview" | "plans" | "subscribers" | "transactions" | "settings";
type ReceiverWalletChoice = "trust" | "metamask";

const TronIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M12 2.1l9.1 15.8H2.9L12 2.1z M12 5.8L5.7 16.7h12.6L12 5.8z" />
  </svg>
);

const EthIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 128 128" className={className}>
    <g fill="currentColor">
      <path d="M64 127.5L31.5 74.3L64 92.5L96.5 74.3L64 127.5z" opacity=".4"/>
      <path d="M64 127.5L96.5 74.3L64 92.5V127.5z" opacity=".6"/>
      <path d="M64 0L31.5 53.2L64 71.4L96.5 53.2L64 0z" opacity=".4"/>
      <path d="M64 0V71.4L96.5 53.2L64 0z" opacity=".6"/>
      <path d="M31.5 53.2L64 71.4L31.5 74.3L31.5 53.2z" opacity=".2"/>
      <path d="M96.5 53.2L64 71.4L96.5 74.3L96.5 53.2z" opacity=".2"/>
    </g>
  </svg>
);

const BnbIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none">
    <path d="M12 0L8.4 3.6L12 7.2L15.6 3.6L12 0Z" fill="#F0B90B"/>
    <path d="M7.2 4.8L3.6 8.4L7.2 12L10.8 8.4L7.2 4.8Z" fill="#F0B90B"/>
    <path d="M16.8 4.8L13.2 8.4L16.8 12L20.4 8.4L16.8 4.8Z" fill="#F0B90B"/>
    <path d="M12 9.6L8.4 13.2L12 16.8L15.6 13.2L12 9.6Z" fill="#F0B90B"/>
    <path d="M0 12L3.6 15.6L7.2 12L3.6 8.4L0 12Z" fill="#F0B90B"/>
    <path d="M24 12L20.4 8.4L16.8 12L20.4 15.6L24 12Z" fill="#F0B90B"/>
    <path d="M7.2 12L3.6 15.6L7.2 19.2L10.8 15.6L7.2 12Z" fill="#F0B90B"/>
    <path d="M16.8 12L13.2 15.6L16.8 19.2L20.4 15.6L16.8 12Z" fill="#F0B90B"/>
    <path d="M12 16.8L8.4 20.4L12 24L15.6 20.4L12 16.8Z" fill="#F0B90B"/>
  </svg>
);

function getNetworkIcon(networkId: string, className?: string) {
  const nid = networkId.toLowerCase();
  if (nid.startsWith("tron_")) return <TronIcon className={`${className} text-red-500`} />;
  if (nid === "0x38" || nid === "0x61") return <BnbIcon className={className} />;
  return <EthIcon className={`${className} text-[#627eea]`} />;
}

const DASHBOARD_REFRESH_MS = 15_000;
const DASHBOARD_LIVE_REFRESH_MS = 5_000;

interface DashboardStats {
  totalPlans: number;
  totalSubscribers: number;
  activeSubscribers: number;
  revenueByToken: Array<{
    planName: string;
    networkName: string;
    tokenSymbol: string;
    amount: string;
  }>;
  successRate: number;
}

interface EnrichedSubscription extends Subscription {
  planName: string;
  tokenSymbol: string | null;
  networkName: string;
}

interface EnrichedLog extends SchedulerLog {
  planName: string;
  payerAddress: string;
  tokenSymbol: string | null;
  networkId: string;
  networkName: string;
}

type TxCheckResult = {
  status: "confirmed" | "reverted" | "not_found" | "rpc_error";
  confirmed: boolean;
  message?: string;
  blockNumber?: number;
  confirmations?: number;
  txHash?: string;
  checkedAt: string;
};

function formatAddress(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatTokenAmount(value: string) {
  if (!value.includes(".")) return value;
  return value.replace(/(\.\d*?[1-9])0+$/u, "$1").replace(/\.0+$/u, "");
}

function getLiveStatusLabel(status: string): string {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "started") return "Started";
  if (normalized === "pending") return "Triggered (Pending)";
  if (normalized === "success") return "Accepted";
  if (normalized === "failed" || normalized === "error" || normalized === "insufficient_allowance") return "Failed";
  return normalized ? normalized.replace(/_/g, " ") : "Unknown";
}

function getStatusReason(status: string, errorMessage?: string | null): string {
  if (errorMessage) return errorMessage;
  const normalized = String(status || "").toLowerCase();
  if (normalized === "started") return "Session started. Waiting for next scheduled transaction.";
  if (normalized === "pending") return "Transaction broadcast to network and waiting for confirmations.";
  if (normalized === "success") return "Transaction confirmed on-chain.";
  if (normalized === "insufficient_allowance") return "Sender allowance or token balance is insufficient.";
  if (normalized === "failed" || normalized === "error") return "Execution failed.";
  return "Status updated.";
}

function getStatusTone(status: string): "success" | "pending" | "started" | "failed" {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "success") return "success";
  if (normalized === "pending") return "pending";
  if (normalized === "started") return "started";
  return "failed";
}

function getStatusBadgeClasses(status: string): string {
  const tone = getStatusTone(status);
  if (tone === "success") return "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20 hover:bg-green-500/10";
  if (tone === "pending") return "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 hover:bg-amber-500/10";
  if (tone === "started") return "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20 hover:bg-blue-500/10";
  return "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20 hover:bg-red-500/10";
}

function getTxCheckBadgeClasses(status: TxCheckResult["status"]): string {
  if (status === "confirmed") return "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20";
  if (status === "not_found") return "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20";
  return "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20";
}

function getTxCheckLabel(status: TxCheckResult["status"]): string {
  if (status === "confirmed") return "Confirmed";
  if (status === "reverted") return "Reverted";
  if (status === "not_found") return "Not Found";
  return "RPC Error";
}

function getIntervalLabel(value: number, unit: string) {
  const labels: Record<string, string> = { sec: "second", min: "minute", hrs: "hour", days: "day", months: "month" };
  const label = labels[unit] || unit;
  return value === 1 ? `Every ${label}` : `Every ${value} ${label}s`;
}

function getWalletChoiceLabel(choice: ReceiverWalletChoice): string {
  return choice === "trust" ? "Trust Wallet" : "MetaMask";
}

function PlanCard({
  plan,
  onShowQr,
  onDelete,
  savedWallets,
}: {
  plan: Plan;
  onShowQr: () => void;
  onDelete: () => void;
  savedWallets: UserWallet[];
}) {
  const { toast } = useToast();
  const [editingWallet, setEditingWallet] = useState(false);
  const [editingAmount, setEditingAmount] = useState(false);
  const [editingInterval, setEditingInterval] = useState(false);
  const [newWallet, setNewWallet] = useState(plan.walletAddress);
  const [newAmount, setNewAmount] = useState(plan.recurringAmount || "");
  const [newIntervalValue, setNewIntervalValue] = useState(String(plan.intervalValue));
  const [newIntervalUnit, setNewIntervalUnit] = useState(plan.intervalUnit);

  const { data: subs } = useQuery<Subscription[]>({
    queryKey: ["/api/plans", plan.id, "subscriptions"],
    refetchInterval: DASHBOARD_REFRESH_MS,
    staleTime: DASHBOARD_REFRESH_MS / 2,
  });

  const walletMutation = useMutation({
    mutationFn: async (walletAddress: string) => {
      const res = await apiRequest("PATCH", `/api/plans/${plan.id}/wallet`, { walletAddress });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/plans"] });
      queryClient.invalidateQueries({ queryKey: ["/api/plans", plan.id, "subscriptions"] });
      setEditingWallet(false);

      const updates = data.onChainUpdates || [];
      const warning = data.onChainWarning;
      const failed = updates.filter((u: any) => u.status === "failed");

      if (warning) {
        toast({ title: "Wallet switched", description: warning, variant: "destructive" });
      } else if (updates.length > 0 && failed.length === 0) {
        toast({ title: "Wallet switched", description: `Updated plan and ${updates.length} on-chain auto-charge(s)` });
      } else if (failed.length > 0) {
        toast({ title: "Wallet switched (partial)", description: `Plan updated but ${failed.length} on-chain update(s) failed`, variant: "destructive" });
      } else {
        toast({ title: "Wallet switched", description: "Receiving wallet updated for this plan" });
      }
    },
    onError: (e: Error) => {
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });

  const amountMutation = useMutation({
    mutationFn: async (recurringAmount: string) => {
      const res = await apiRequest("PATCH", `/api/plans/${plan.id}/recurring-amount`, { recurringAmount });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plans"] });
      setEditingAmount(false);
    },
    onError: (e: Error) => {
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });

  const intervalMutation = useMutation({
    mutationFn: async ({ value, unit }: { value: string; unit: string }) => {
      const res = await apiRequest("PATCH", `/api/plans/${plan.id}/interval`, {
        intervalValue: Number(value),
        intervalUnit: unit
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plans"] });
      setEditingInterval(false);
      toast({ title: "Interval updated", description: "Payment schedule has been updated" });
    },
    onError: (e: Error) => {
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });

  const activeSubscribers = subs?.filter((s) => s.isActive).length || 0;
  const onChainSubs = subs?.filter((s) => s.onChainSubscriptionId).length || 0;
  const tokenSymbol = plan.tokenSymbol || "ETH";
  const isTokenPlan = !!plan.tokenAddress;

  return (
    <Card className="group">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base truncate" data-testid={`text-plan-name-${plan.id}`}>
              {plan.planName}
            </CardTitle>
            <CardDescription className="mt-1 flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-xs flex items-center gap-1">
                {getNetworkIcon(plan.networkId, "w-3 h-3")}
                {plan.networkName}
              </Badge>
              {isTokenPlan && (
                <Badge variant="secondary" className="text-xs" data-testid={`badge-token-${plan.id}`}>
                  <Coins className="w-3 h-3 mr-1" />
                  {tokenSymbol}
                </Badge>
              )}
              {activeSubscribers > 0 && (
                <Badge variant="secondary" className="text-xs" data-testid={`badge-subscribers-${plan.id}`}>
                  <Users className="w-3 h-3 mr-1" />
                  {activeSubscribers}
                </Badge>
              )}
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onShowQr}
            data-testid={`button-qr-${plan.id}`}
          >
            <QrCode className="w-4 h-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tabular-nums">{plan.intervalAmount}</span>
          <span className="text-sm text-muted-foreground">{tokenSymbol}</span>
        </div>
        <div className="flex items-center justify-between">
          {!editingInterval ? (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Clock className="w-3.5 h-3.5" />
              {getIntervalLabel(plan.intervalValue, plan.intervalUnit)}
            </div>
          ) : (
            <div className="flex items-center gap-2 w-full">
              <div className="flex items-center gap-1 flex-1">
                <Input
                  type="number"
                  value={newIntervalValue}
                  onChange={(e) => setNewIntervalValue(e.target.value)}
                  className="h-7 text-xs w-16 px-2"
                />
                <Select value={newIntervalUnit} onValueChange={setNewIntervalUnit}>
                  <SelectTrigger className="h-7 text-xs px-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sec">Sec</SelectItem>
                    <SelectItem value="min">Min</SelectItem>
                    <SelectItem value="hrs">Hrs</SelectItem>
                    <SelectItem value="days">Days</SelectItem>
                    <SelectItem value="months">Months</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-1">
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="h-6 px-1.5"
                  onClick={() => intervalMutation.mutate({ value: newIntervalValue, unit: newIntervalUnit })}
                  disabled={intervalMutation.isPending}
                >
                  <Save className="w-3 h-3" />
                </Button>
                <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => setEditingInterval(false)}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
            </div>
          )}
           <Button
              variant="ghost"
              size="sm"
              // className="h-6 px-1.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={() => {
                setNewIntervalValue(String(plan.intervalValue));
                setNewIntervalUnit(plan.intervalUnit);
                setEditingInterval(true);
              }}
            >
              <Pencil className="w-3 h-3" />
            </Button>
        </div>

        {isTokenPlan && onChainSubs > 0 && (
          <div className="p-2 rounded-md bg-green-500/10 border border-green-500/20 text-xs">
            <div className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-medium">
              <Zap className="w-3 h-3" />
              {onChainSubs} on-chain active
            </div>
          </div>
        )}

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Receiving Wallet</span>
            {!editingWallet ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => { setNewWallet(plan.walletAddress); setEditingWallet(true); }}
                data-testid={`button-edit-wallet-${plan.id}`}
              >
                <Pencil className="w-3 h-3 mr-1" />
                Switch
              </Button>
            ) : (
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => walletMutation.mutate(newWallet)} disabled={walletMutation.isPending || newWallet === plan.walletAddress} data-testid={`button-save-wallet-${plan.id}`}>
                  <Save className="w-3 h-3" />
                </Button>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setEditingWallet(false)}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
            )}
          </div>
          {editingWallet ? (
            <div className="space-y-2">
              {savedWallets.filter(w => {
                const isPlanTron = isTronNetwork(plan.networkId);
                const isWalletTron = /^[Tt][a-zA-Z0-9]{33}$/.test(w.address);
                return isPlanTron ? isWalletTron : !isWalletTron;
              }).length > 0 ? (
                <div className="space-y-1">
                  {savedWallets.filter(w => {
                    const isPlanTron = isTronNetwork(plan.networkId);
                    const isWalletTron = /^[Tt][a-zA-Z0-9]{33}$/.test(w.address);
                    return isPlanTron ? isWalletTron : !isWalletTron;
                  }).map((w) => (
                    <button
                      key={w.id}
                      className={`w-full flex items-center gap-2 p-2 rounded-md text-left text-xs transition-colors ${
                        newWallet === w.address
                          ? "bg-primary/10 border border-primary/30 ring-1 ring-primary/20"
                          : "bg-muted/50 hover:bg-muted border border-transparent"
                      }`}
                      onClick={() => setNewWallet(w.address)}
                      data-testid={`wallet-option-${w.id}`}
                    >
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${newWallet === w.address ? "bg-primary" : "bg-muted-foreground/30"}`} />
                      <div className="min-w-0 flex-1">
                        <span className="font-medium block truncate">{w.label || "Wallet"}</span>
                        <span className="font-mono text-muted-foreground block truncate">{formatAddress(w.address)}</span>
                      </div>
                      {w.isDefault && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 flex-shrink-0">Default</Badge>
                      )}
                      {w.address === plan.walletAddress && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 flex-shrink-0">Current</Badge>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground p-2 bg-muted/50 rounded-md">
                  No saved wallets. Add wallets in Settings first, or enter manually:
                </div>
              )}
              {savedWallets.length === 0 && (
                <Input value={newWallet} onChange={(e) => setNewWallet(e.target.value)} className="h-8 text-xs font-mono" placeholder="0x..." data-testid={`input-wallet-${plan.id}`} />
              )}
              {walletMutation.isPending && (
                <p className="text-xs text-muted-foreground">Updating wallet for all auto-charges...</p>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground font-mono truncate">{formatAddress(plan.walletAddress)}</div>
          )}
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Recurring Amount</span>
            {!editingAmount ? (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => { setNewAmount(plan.recurringAmount || plan.intervalAmount); setEditingAmount(true); }} data-testid={`button-edit-amount-${plan.id}`}>
                <Pencil className="w-3 h-3 mr-1" />
                Set
              </Button>
            ) : (
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => amountMutation.mutate(newAmount)} disabled={amountMutation.isPending} data-testid={`button-save-amount-${plan.id}`}>
                  <Save className="w-3 h-3" />
                </Button>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setEditingAmount(false)}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
            )}
          </div>
          {editingAmount ? (
            <Input type="number" step="any" value={newAmount} onChange={(e) => setNewAmount(e.target.value)} className="h-8 text-xs" placeholder={`Amount in ${tokenSymbol}`} data-testid={`input-amount-${plan.id}`} />
          ) : (
            <div className="text-xs text-muted-foreground">{plan.recurringAmount ? `${plan.recurringAmount} ${tokenSymbol}` : "Not set (using default)"}</div>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button variant="outline" size="sm" className="flex-1" onClick={onShowQr} data-testid={`button-show-qr-${plan.id}`}>
            <QrCode className="w-3.5 h-3.5 mr-1.5" />
            QR
          </Button>
          <Button variant="outline" size="sm" onClick={onDelete} className="text-destructive" data-testid={`button-delete-${plan.id}`}>
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function OverviewSection({
  stats,
  statsLoading,
  transactions,
  txLoading,
  plansCount,
  activeSubscribersCount,
}: {
  stats?: DashboardStats;
  statsLoading: boolean;
  transactions?: EnrichedLog[];
  txLoading?: boolean;
  plansCount?: number;
  activeSubscribersCount?: number;
}) {
  if (statsLoading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}><CardContent className="p-6"><Skeleton className="h-16 w-full" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  const revenueRows = stats?.revenueByToken || [];
  const totalPlansValue = Math.max(stats?.totalPlans ?? 0, plansCount ?? 0);
  const activeSubscribersValue = Math.max(stats?.activeSubscribers ?? 0, activeSubscribersCount ?? 0);
  const revenueSummary = revenueRows.length === 0
    ? "0"
    : revenueRows.length === 1
      ? `${formatTokenAmount(revenueRows[0].amount)} ${revenueRows[0].tokenSymbol}`
      : `${revenueRows.length} plan/token`;

  const kpis = [
    { label: "Total Plans", value: totalPlansValue, icon: FileText, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/10" },
    { label: "Active Subscribers", value: activeSubscribersValue, icon: Users, color: "text-green-600 dark:text-green-400", bg: "bg-green-500/10" },
    { label: "Revenue Streams", value: revenueSummary, icon: TrendingUp, color: "text-purple-600 dark:text-purple-400", bg: "bg-purple-500/10" },
    { label: "Success Rate", value: `${stats?.successRate ?? 100}%`, icon: Activity, color: "text-orange-600 dark:text-orange-400", bg: "bg-orange-500/10" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" data-testid="text-overview-title">Dashboard Overview</h2>
        <p className="text-sm text-muted-foreground">Monitor your recurring payment performance at a glance.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{kpi.label}</span>
                <div className={`p-2 rounded-md ${kpi.bg}`}>
                  <kpi.icon className={`w-4 h-4 ${kpi.color}`} />
                </div>
              </div>
              <p className="text-2xl font-bold tabular-nums" data-testid={`text-kpi-${kpi.label.toLowerCase().replace(/\s+/g, "-")}`}>{kpi.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-5">
          <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
            <Coins className="w-4 h-4" />
            Revenue by Plan and Token
          </h3>
          {revenueRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No revenue yet.</p>
          ) : (
            <div className="space-y-2">
              {revenueRows.map((row, idx) => (
                <div
                  key={`${row.planName}:${row.networkName}:${row.tokenSymbol}:${idx}`}
                  className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{row.planName}</p>
                    <p className="text-xs text-muted-foreground truncate">{row.networkName}</p>
                  </div>
                  <div className="text-right pl-3">
                    <p className="text-sm font-semibold tabular-nums">{formatTokenAmount(row.amount)} {row.tokenSymbol}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5">
          <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
            <Shield className="w-4 h-4" />
            How Recurring Payments Work
          </h3>
          <div className="grid gap-4 sm:grid-cols-3 text-xs text-muted-foreground">
            <div className="space-y-1">
              <p className="font-medium text-foreground">1. First Payment</p>
              <p>Subscriber makes an initial token payment directly to your wallet address.</p>
            </div>
            <div className="space-y-1">
              <p className="font-medium text-foreground">2. One-Time Approval</p>
              <p>Subscriber approves the smart contract to spend their tokens. Only one MetaMask popup needed.</p>
            </div>
            <div className="space-y-1">
              <p className="font-medium text-foreground">3. Automatic Execution</p>
              <p>The backend scheduler calls the smart contract to transfer tokens automatically.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5">
          <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
            <Activity className="w-4 h-4" />
            Recent Activity
          </h3>
          {txLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : !transactions || transactions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No recent activity yet.</p>
          ) : (
            <div className="space-y-2">
              {transactions.slice(0, 5).map((tx) => (
                <div key={tx.id} className="flex items-center justify-between gap-3 p-2.5 rounded-md bg-muted/50" data-testid={`activity-item-${tx.id}`}>
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`p-1.5 rounded-full ${
                      getStatusTone(tx.status) === "success"
                        ? "bg-green-500/10"
                        : getStatusTone(tx.status) === "pending"
                          ? "bg-amber-500/10"
                          : getStatusTone(tx.status) === "started"
                            ? "bg-blue-500/10"
                            : "bg-red-500/10"
                    }`}>
                      {getStatusTone(tx.status) === "success" ? (
                        <CheckCircle className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
                      ) : getStatusTone(tx.status) === "pending" ? (
                        <Clock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                      ) : getStatusTone(tx.status) === "started" ? (
                        <Activity className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{tx.planName}</p>
                      <p className="text-xs text-muted-foreground">{formatAddress(tx.payerAddress)} • {getLiveStatusLabel(tx.status)}</p>
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {tx.createdAt ? new Date(tx.createdAt).toLocaleDateString() : "--"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PlansSection({
  plans,
  plansLoading,
  hasWallets,
  onCreatePlan,
  onShowQr,
  onDeletePlan,
  savedWallets,
}: {
  plans?: Plan[];
  plansLoading: boolean;
  hasWallets: boolean;
  onCreatePlan: () => void;
  onShowQr: (plan: Plan) => void;
  onDeletePlan: (planId: string) => void;
  savedWallets: UserWallet[];
}) {
  const canCreatePlan = hasWallets;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold mb-1" data-testid="text-plans-title">Payment Plans</h2>
          <p className="text-sm text-muted-foreground">Create and manage your recurring payment plans.</p>
        </div>
        {canCreatePlan && (
          <Button onClick={onCreatePlan} data-testid="button-create-plan">
            <Plus className="w-4 h-4 mr-2" />
            Create Plan
          </Button>
        )}
      </div>

      {plansLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}><CardContent className="p-6 space-y-3"><Skeleton className="h-5 w-32" /><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-full" /></CardContent></Card>
          ))}
        </div>
      ) : !plans || plans.length === 0 ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-center">
            <div className="p-4 rounded-full bg-muted">
              <QrCode className="w-8 h-8 text-muted-foreground" />
            </div>
            <div>
              <h3 className="font-semibold">No Plans Yet</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {canCreatePlan ? "Create your first token payment plan to get started" : "Add a wallet in Settings first, then create payment plans"}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} onShowQr={() => onShowQr(plan)} onDelete={() => onDeletePlan(plan.id)} savedWallets={savedWallets} />
          ))}
        </div>
      )}
    </div>
  );
}

function SubscribersSection() {
  const { data: subscribers, isLoading } = useQuery<EnrichedSubscription[]>({
    queryKey: ["/api/dashboard/subscribers"],
    refetchInterval: DASHBOARD_LIVE_REFRESH_MS,
    staleTime: DASHBOARD_LIVE_REFRESH_MS / 2,
    refetchIntervalInBackground: true,
  });
  const { data: transactions } = useQuery<EnrichedLog[]>({
    queryKey: ["/api/dashboard/transactions"],
    refetchInterval: DASHBOARD_LIVE_REFRESH_MS,
    staleTime: DASHBOARD_LIVE_REFRESH_MS / 2,
    refetchIntervalInBackground: true,
  });

  const latestBySubscriptionId = new Map<string, EnrichedLog>();
  for (const tx of transactions || []) {
    if (!latestBySubscriptionId.has(tx.subscriptionId)) {
      latestBySubscriptionId.set(tx.subscriptionId, tx);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div><h2 className="text-xl font-semibold mb-1">Subscribers</h2></div>
        <Card><CardContent className="p-6"><Skeleton className="h-48 w-full" /></CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" data-testid="text-subscribers-title">Subscribers</h2>
        <p className="text-sm text-muted-foreground">View all subscribers across your payment plans.</p>
      </div>

      {!subscribers || subscribers.length === 0 ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-center">
            <div className="p-4 rounded-full bg-muted">
              <Users className="w-8 h-8 text-muted-foreground" />
            </div>
            <div>
              <h3 className="font-semibold">No Subscribers Yet</h3>
              <p className="text-sm text-muted-foreground mt-1">Share your payment plan QR codes to get subscribers.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-3 font-medium text-muted-foreground">Payer</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Plan</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">First Payment</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Payments</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Next Transaction</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Live Status</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Reason</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">On-Chain</th>
                </tr>
              </thead>
              <tbody>
                {subscribers.map((sub) => {
                  const latest = latestBySubscriptionId.get(sub.id);
                  const liveStatus = latest?.status || "started";
                  const reason = getStatusReason(liveStatus, latest?.errorMessage);
                  return (
                  <tr key={sub.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors" data-testid={`row-subscriber-${sub.id}`}>
                    <td className="p-3">
                      <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{formatAddress(sub.payerAddress)}</code>
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{sub.planName}</span>
                        {sub.tokenSymbol && <Badge variant="outline" className="text-xs">{sub.tokenSymbol}</Badge>}
                      </div>
                    </td>
                    <td className="p-3 font-mono text-xs">{sub.firstPaymentAmount} {sub.tokenSymbol || "ETH"}</td>
                    <td className="p-3 tabular-nums">{sub.txCount}</td>
                    <td className="p-3 text-xs whitespace-nowrap">
                      {sub.nextPaymentDue ? new Date(sub.nextPaymentDue).toLocaleString() : "--"}
                    </td>
                    <td className="p-3">
                      <Badge className={getStatusBadgeClasses(liveStatus)}>
                        {getLiveStatusLabel(liveStatus)}
                      </Badge>
                    </td>
                    <td className="p-3 max-w-[280px]">
                      <p className="text-xs text-muted-foreground truncate" title={reason}>{reason}</p>
                    </td>
                    <td className="p-3">
                      {sub.isActive ? (
                        <Badge className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20 hover:bg-green-500/10">
                          <CheckCircle className="w-3 h-3 mr-1" />
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-muted-foreground">
                          <XCircle className="w-3 h-3 mr-1" />
                          Inactive
                        </Badge>
                      )}
                    </td>
                    <td className="p-3">
                      {sub.onChainSubscriptionId ? (
                        <Badge variant="outline" className="text-xs">
                          <Zap className="w-3 h-3 mr-1" />
                          #{sub.onChainSubscriptionId}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">--</span>
                      )}
                    </td>
                  </tr>
                )})}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function TransactionsSection() {
  const { toast } = useToast();
  const { data: transactions, isLoading } = useQuery<EnrichedLog[]>({
    queryKey: ["/api/dashboard/transactions"],
    refetchInterval: DASHBOARD_LIVE_REFRESH_MS,
    staleTime: DASHBOARD_LIVE_REFRESH_MS / 2,
    refetchIntervalInBackground: true,
  });

  const { data: subscribers, isLoading: subscribersLoading } = useQuery<EnrichedSubscription[]>({
    queryKey: ["/api/dashboard/subscribers"],
    refetchInterval: DASHBOARD_LIVE_REFRESH_MS,
    staleTime: DASHBOARD_LIVE_REFRESH_MS / 2,
    refetchIntervalInBackground: true,
  });
  const [checkingTxId, setCheckingTxId] = useState<string | null>(null);
  const [txCheckResults, setTxCheckResults] = useState<Record<string, TxCheckResult>>({});

  const checkTxMutation = useMutation({
    mutationFn: async ({ txHash, networkId }: { txHash: string; networkId: string }) => {
      const res = await fetch(
        `/api/transactions/check?txHash=${encodeURIComponent(txHash)}&networkId=${encodeURIComponent(networkId)}`,
        { credentials: "include" },
      );
      const text = await res.text();
      let json: any = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = {};
      }
      if (!res.ok) {
        throw new Error(json?.message || `Failed to check transaction (${res.status})`);
      }
      return json;
    },
  });

  const handleCheckTransaction = async (tx: EnrichedLog) => {
    if (!tx.txHash) return;
    if (!tx.networkId) {
      toast({ title: "Check unavailable", description: "Network is missing for this log entry.", variant: "destructive" });
      return;
    }
    setCheckingTxId(tx.id);
    try {
      const result = await checkTxMutation.mutateAsync({
        txHash: tx.txHash,
        networkId: tx.networkId,
      });
      setTxCheckResults((prev) => ({
        ...prev,
        [tx.id]: {
          status: (result?.status || "rpc_error") as TxCheckResult["status"],
          confirmed: !!result?.confirmed,
          message: result?.message,
          blockNumber: Number.isFinite(Number(result?.blockNumber)) ? Number(result.blockNumber) : undefined,
          confirmations: Number.isFinite(Number(result?.confirmations)) ? Number(result.confirmations) : undefined,
          txHash: result?.txHash,
          checkedAt: new Date().toISOString(),
        },
      }));
    } catch (err: any) {
      const message = err?.message || "Failed to check transaction";
      setTxCheckResults((prev) => ({
        ...prev,
        [tx.id]: {
          status: "rpc_error",
          confirmed: false,
          message,
          checkedAt: new Date().toISOString(),
        },
      }));
      toast({ title: "Check failed", description: message, variant: "destructive" });
    } finally {
      setCheckingTxId(null);
    }
  };

  const latestBySubscriptionId = new Map<string, EnrichedLog>();
  for (const tx of transactions || []) {
    if (!latestBySubscriptionId.has(tx.subscriptionId)) {
      latestBySubscriptionId.set(tx.subscriptionId, tx);
    }
  }

  const activeQueue = (subscribers || [])
    .filter((sub) => sub.isActive)
    .map((sub) => {
      const latest = latestBySubscriptionId.get(sub.id);
      return {
        sub,
        liveStatus: latest?.status || "started",
        reason: getStatusReason(latest?.status || "started", latest?.errorMessage),
        lastUpdate: latest?.createdAt || sub.createdAt,
      };
    })
    .sort((a, b) => {
      const aNext = a.sub.nextPaymentDue ? new Date(a.sub.nextPaymentDue).getTime() : Number.MAX_SAFE_INTEGER;
      const bNext = b.sub.nextPaymentDue ? new Date(b.sub.nextPaymentDue).getTime() : Number.MAX_SAFE_INTEGER;
      return aNext - bNext;
    });

  if (isLoading || subscribersLoading) {
    return (
      <div className="space-y-6">
        <div><h2 className="text-xl font-semibold mb-1">Transactions</h2></div>
        <Card><CardContent className="p-6"><Skeleton className="h-48 w-full" /></CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" data-testid="text-transactions-title">Transactions</h2>
        <p className="text-sm text-muted-foreground">Live execution status plus full scheduler transaction history.</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Live Transaction Queue
          </CardTitle>
          <CardDescription>Auto-refreshes every 5 seconds with next transaction and latest status.</CardDescription>
        </CardHeader>
        <CardContent>
          {activeQueue.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active subscriptions right now.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-3 font-medium text-muted-foreground">Plan</th>
                    <th className="text-left p-3 font-medium text-muted-foreground">Payer</th>
                    <th className="text-left p-3 font-medium text-muted-foreground">Next Transaction</th>
                    <th className="text-left p-3 font-medium text-muted-foreground">Status</th>
                    <th className="text-left p-3 font-medium text-muted-foreground">Reason</th>
                    <th className="text-left p-3 font-medium text-muted-foreground">Last Update</th>
                  </tr>
                </thead>
                <tbody>
                  {activeQueue.map(({ sub, liveStatus, reason, lastUpdate }) => (
                    <tr key={sub.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm">{sub.planName}</span>
                          {sub.tokenSymbol && <Badge variant="outline" className="text-xs">{sub.tokenSymbol}</Badge>}
                        </div>
                      </td>
                      <td className="p-3">
                        <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{formatAddress(sub.payerAddress)}</code>
                      </td>
                      <td className="p-3 text-xs whitespace-nowrap">
                        {sub.nextPaymentDue ? new Date(sub.nextPaymentDue).toLocaleString() : "--"}
                      </td>
                      <td className="p-3">
                        <Badge className={getStatusBadgeClasses(liveStatus)}>
                          {getLiveStatusLabel(liveStatus)}
                        </Badge>
                      </td>
                      <td className="p-3 max-w-[340px]">
                        <p className="text-xs text-muted-foreground truncate" title={reason}>{reason}</p>
                      </td>
                      <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                        {lastUpdate ? new Date(lastUpdate).toLocaleString() : "--"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {!transactions || transactions.length === 0 ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-center">
            <div className="p-4 rounded-full bg-muted">
              <ArrowUpDown className="w-8 h-8 text-muted-foreground" />
            </div>
            <div>
              <h3 className="font-semibold">No Transactions Yet</h3>
              <p className="text-sm text-muted-foreground mt-1">Transaction logs will appear here once recurring payments start executing.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-3 font-medium text-muted-foreground">Date</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Plan</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Payer</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Status Checker</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Reason</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Tx Hash</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Gas</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => {
                  const checked = txCheckResults[tx.id];
                  return (
                  <tr key={tx.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors" data-testid={`row-transaction-${tx.id}`}>
                    <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                      {tx.createdAt ? new Date(tx.createdAt).toLocaleString() : "--"}
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{tx.planName}</span>
                        {tx.tokenSymbol && <Badge variant="outline" className="text-xs">{tx.tokenSymbol}</Badge>}
                      </div>
                    </td>
                    <td className="p-3">
                      <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{formatAddress(tx.payerAddress)}</code>
                    </td>
                    <td className="p-3">
                      <Badge className={getStatusBadgeClasses(tx.status)}>
                        {getLiveStatusLabel(tx.status)}
                      </Badge>
                    </td>
                    <td className="p-3 min-w-[210px]">
                      {!tx.txHash ? (
                        <span className="text-xs text-muted-foreground">--</span>
                      ) : !tx.networkId ? (
                        <span className="text-xs text-muted-foreground">Network unknown</span>
                      ) : (
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => handleCheckTransaction(tx)}
                              disabled={checkingTxId === tx.id}
                            >
                              {checkingTxId === tx.id ? (
                                <>
                                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                  Checking
                                </>
                              ) : (
                                "Check"
                              )}
                            </Button>
                            {checked && (
                              <Badge className={getTxCheckBadgeClasses(checked.status)}>
                                {getTxCheckLabel(checked.status)}
                              </Badge>
                            )}
                          </div>
                          {checked && (
                            <p className="text-[11px] text-muted-foreground truncate" title={checked.message || ""}>
                              {checked.confirmations !== undefined
                                ? `${checked.confirmations} confirmations`
                                : (checked.message || "Checked")}
                            </p>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="p-3 max-w-[280px]">
                      <p className="text-xs text-muted-foreground truncate" title={getStatusReason(tx.status, tx.errorMessage)}>
                        {getStatusReason(tx.status, tx.errorMessage)}
                      </p>
                    </td>
                    <td className="p-3">
                      {tx.txHash ? (
                        <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{formatAddress(tx.txHash)}</code>
                      ) : (
                        <span className="text-xs text-muted-foreground">--</span>
                      )}
                    </td>
                    <td className="p-3 text-xs tabular-nums text-muted-foreground">{tx.gasUsed || "--"}</td>
                  </tr>
                )})}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function SettingsSection({
  walletAddress,
  network,
  balance,
  isConnecting,
  onConnect,
  onAddFromWallet,
  addingWalletChoice,
  onConnectTron,
  onAddTronWallet,
}: {
  walletAddress: string | null;
  network: NetworkInfo | null;
  balance: string;
  isConnecting: boolean;
  onConnect: (choice: ReceiverWalletChoice) => void;
  onAddFromWallet: (choice: ReceiverWalletChoice) => void;
  addingWalletChoice: ReceiverWalletChoice | null;
  onConnectTron: () => void;
  onAddTronWallet: () => void;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);
  const [executorKey, setExecutorKey] = useState("");
  const [showExecutorKey, setShowExecutorKey] = useState(false);
  const [newWalletAddress, setNewWalletAddress] = useState("");
  const [newWalletLabel, setNewWalletLabel] = useState("");
  const isAddingTrustWallet = addingWalletChoice === "trust";
  const isAddingMetaMaskWallet = addingWalletChoice === "metamask";

  const { data: executorKeyStatus } = useQuery<{ hasKey: boolean }>({
    queryKey: ["/api/auth/executor-key"],
    enabled: !!user,
    refetchInterval: DASHBOARD_REFRESH_MS,
    staleTime: DASHBOARD_REFRESH_MS / 2,
  });

  const { data: userWallets, isLoading: walletsLoading } = useQuery<UserWallet[]>({
    queryKey: ["/api/wallets"],
    enabled: !!user,
    refetchInterval: DASHBOARD_REFRESH_MS,
    staleTime: DASHBOARD_REFRESH_MS / 2,
  });

  const saveExecutorKeyMutation = useMutation({
    mutationFn: async (privateKey: string) => {
      const res = await apiRequest("POST", "/api/auth/executor-key", { privateKey });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/executor-key"] });
      setExecutorKey("");
      setShowExecutorKey(false);
    },
    onError: (e: Error) => {
      toast({ title: "Failed to save key", description: e.message, variant: "destructive" });
    },
  });

  const removeExecutorKeyMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/auth/executor-key");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/executor-key"] });
    },
  });

  const addWalletMutation = useMutation({
    mutationFn: async ({ address, label }: { address: string; label: string }) => {
      const res = await apiRequest("POST", "/api/wallets", { address, label });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wallets"] });
      setNewWalletAddress("");
      setNewWalletLabel("");
    },
    onError: (e: Error) => {
      toast({ title: "Failed to add wallet", description: e.message, variant: "destructive" });
    },
  });

  const removeWalletMutation = useMutation({
    mutationFn: async (walletId: string) => {
      await apiRequest("DELETE", `/api/wallets/${walletId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wallets"] });
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: async (walletId: string) => {
      const res = await apiRequest("PATCH", `/api/wallets/${walletId}/default`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wallets"] });
    },
  });

  const copyAddress = () => {
    if (walletAddress) {
      navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" data-testid="text-settings-title">Payment Settings</h2>
        <p className="text-sm text-muted-foreground">Manage your wallets and executor key configuration.</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Wallet className="w-4 h-4" />
            Wallet Connection
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!walletAddress ? (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              {!isMetaMaskInstalled() ? (
                isMobile() ? (
                  <>
                    <div className="p-3 rounded-full bg-primary/10">
                      <Wallet className="w-6 h-6 text-primary" />
                    </div>
                    <p className="text-sm text-muted-foreground">Open this page in Trust Wallet or MetaMask browser to connect</p>
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => openInTrustWalletMobile()} data-testid="button-open-trustwallet-dashboard">
                        <Wallet className="w-4 h-4 mr-2" />
                        Open in Trust Wallet
                      </Button>
                      <Button size="sm" onClick={() => openInMetaMaskMobile()} data-testid="button-open-metamask-dashboard">
                        <Wallet className="w-4 h-4 mr-2" />
                        Open in MetaMask
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="p-3 rounded-full bg-destructive/10">
                      <AlertCircle className="w-6 h-6 text-destructive" />
                    </div>
                    <p className="text-sm text-muted-foreground">No injected wallet detected</p>
                    <Button asChild size="sm" data-testid="button-install-metamask">
                      <a href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="w-4 h-4 mr-2" />
                        Install MetaMask
                      </a>
                    </Button>
                  </>
                )
              ) : (
                <>
                  <div className="p-3 rounded-full bg-primary/10">
                    <Wallet className="w-6 h-6 text-primary" />
                  </div>
                  <p className="text-sm text-muted-foreground">Choose your receiver wallet provider</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={() => onConnect("trust")} disabled={isConnecting} size="sm" variant="outline" data-testid="button-connect-trustwallet">
                      <Wallet className="w-4 h-4 mr-2" />
                      {isConnecting ? "Connecting..." : "Connect Trust Wallet"}
                    </Button>
                    <Button onClick={() => onConnect("metamask")} disabled={isConnecting} size="sm" data-testid="button-connect-metamask">
                      <Wallet className="w-4 h-4 mr-2" />
                      {isConnecting ? "Connecting..." : "Connect MetaMask"}
                    </Button>
                    <Button onClick={() => onConnectTron()} disabled={isConnecting} size="sm" variant="outline" className="border-red-500/50 hover:bg-red-500/5">
                      <TronIcon className="w-4 h-4 mr-2 text-red-500" />
                      Connect TRON Wallet
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="p-3 rounded-md border bg-muted/30">
                <p className="text-xs text-muted-foreground mb-1">Address</p>
                <div className="flex items-center gap-2">
                  <code className="text-sm font-mono font-medium" data-testid="text-wallet-address">{formatAddress(walletAddress)}</code>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={copyAddress} data-testid="button-copy-address">
                    {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                  </Button>
                </div>
              </div>
              <div className="p-3 rounded-md border bg-muted/30">
                <p className="text-xs text-muted-foreground mb-1">Network</p>
                <Badge variant="secondary" data-testid="badge-network">{network?.name || "Unknown"}</Badge>
              </div>
              <div className="p-3 rounded-md border bg-muted/30">
                <p className="text-xs text-muted-foreground mb-1">Balance</p>
                <p className="text-sm font-bold tabular-nums" data-testid="text-balance">{balance} ETH</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Wallet className="w-4 h-4" />
            Payment Wallets
            <Badge variant="secondary" className="text-xs ml-auto">{userWallets?.length || 0} / 6</Badge>
          </CardTitle>
          <CardDescription>Add up to 6 wallets for receiving payments. Set a default wallet for new plans.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {walletsLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              {userWallets && userWallets.length > 0 ? (
                <div className="space-y-2">
                  {userWallets.map((w) => (
                    <div key={w.id} className="flex items-center gap-3 p-3 rounded-md border bg-muted/30" data-testid={`wallet-row-${w.id}`}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <code className="text-xs font-mono truncate">{formatAddress(w.address)}</code>
                          {w.label && <span className="text-xs text-muted-foreground">({w.label})</span>}
                          {w.isDefault && <Badge className="text-xs bg-primary/10 text-primary border-primary/20 hover:bg-primary/10">Default</Badge>}
                        </div>
                        {w.networkName && <p className="text-xs text-muted-foreground mt-0.5">{w.networkName}</p>}
                      </div>
                      <div className="flex gap-1">
                        {!w.isDefault && (
                          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setDefaultMutation.mutate(w.id)} disabled={setDefaultMutation.isPending} data-testid={`button-set-default-${w.id}`}>
                            Set Default
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive" onClick={() => removeWalletMutation.mutate(w.id)} disabled={removeWalletMutation.isPending} data-testid={`button-remove-wallet-${w.id}`}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  No wallets added yet. Add a wallet below.
                </div>
              )}

              {(!userWallets || userWallets.length < 6) && (
                <div className="space-y-3">
                  {isMetaMaskInstalled() ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => onAddFromWallet("trust")}
                        disabled={!!addingWalletChoice}
                        data-testid="button-add-from-trustwallet"
                      >
                        <Wallet className="w-4 h-4 mr-2" />
                        {isAddingTrustWallet ? "Connecting..." : "Add from Trust Wallet"}
                      </Button>
                      <Button
                        className="w-full"
                        onClick={() => onAddFromWallet("metamask")}
                        disabled={!!addingWalletChoice}
                        data-testid="button-add-from-metamask"
                      >
                        <Wallet className="w-4 h-4 mr-2" />
                        {isAddingMetaMaskWallet ? "Connecting..." : "Add from MetaMask"}
                      </Button>
                      <Button
                        variant="outline"
                        className="w-full border-red-500/50 hover:bg-red-500/5"
                        onClick={() => onAddTronWallet()}
                        disabled={!!addingWalletChoice}
                      >
                        <TronIcon className="w-4 h-4 mr-2 text-red-500" />
                        Add from TRON Wallet
                      </Button>
                    </div>
                  ) : isMobile() ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => openInTrustWalletMobile()}
                        data-testid="button-add-trustwallet-mobile"
                      >
                        <Wallet className="w-4 h-4 mr-2" />
                        Open Trust Wallet
                      </Button>
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => openInMetaMaskMobile()}
                        data-testid="button-add-metamask-mobile"
                      >
                        <Wallet className="w-4 h-4 mr-2" />
                        Open MetaMask
                      </Button>
                    </div>
                  ) : null}
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t" />
                    </div>
                    <div className="relative flex justify-center text-xs">
                      <span className="bg-card px-2 text-muted-foreground">or enter manually</span>
                    </div>
                  </div>
                  <div className="flex gap-2 items-end">
                    <div className="flex-1 space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Wallet Address</label>
                      <Input
                        value={newWalletAddress}
                        onChange={(e) => setNewWalletAddress(e.target.value)}
                        placeholder="0x... or T..."
                        className="h-9 text-xs font-mono"
                        data-testid="input-new-wallet-address"
                      />
                    </div>
                    <div className="w-32 space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Label</label>
                      <Input
                        value={newWalletLabel}
                        onChange={(e) => setNewWalletLabel(e.target.value)}
                        placeholder="e.g. Main"
                        className="h-9 text-xs"
                        data-testid="input-new-wallet-label"
                      />
                    </div>
                    <Button
                      size="sm"
                      className="h-9"
                      onClick={() => addWalletMutation.mutate({ address: newWalletAddress, label: newWalletLabel })}
                      disabled={!newWalletAddress || addWalletMutation.isPending}
                      data-testid="button-add-wallet"
                    >
                      <Plus className="w-3.5 h-3.5 mr-1" />
                      Add
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Key className="w-4 h-4" />
            Executor Private Key
          </CardTitle>
          <CardDescription>Provide a wallet private key for automatic payment execution. Encrypted with AES-256-GCM.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {executorKeyStatus?.hasKey ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 rounded-md border border-green-500/20 bg-green-500/5">
                <div className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-green-600 dark:text-green-400">Private key configured</p>
                  <p className="text-xs text-muted-foreground">Automatic payment execution is enabled</p>
                </div>
                <Button variant="outline" size="sm" className="text-destructive" onClick={() => removeExecutorKeyMutation.mutate()} disabled={removeExecutorKeyMutation.isPending} data-testid="button-remove-executor-key">
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  Remove
                </Button>
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input type={showExecutorKey ? "text" : "password"} value={executorKey} onChange={(e) => setExecutorKey(e.target.value)} placeholder="Update with a new key" className="pr-10 font-mono text-sm" data-testid="input-executor-key" />
                  <Button variant="ghost" size="icon" className="absolute right-0 top-0 h-full px-3" onClick={() => setShowExecutorKey(!showExecutorKey)} data-testid="button-toggle-key-visibility">
                    {showExecutorKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </Button>
                </div>
                <Button onClick={() => saveExecutorKeyMutation.mutate(executorKey)} disabled={!executorKey || saveExecutorKeyMutation.isPending} data-testid="button-save-executor-key">
                  <Save className="w-4 h-4 mr-2" />
                  Update
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 rounded-md border border-yellow-500/20 bg-yellow-500/5">
                <AlertCircle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0" />
                <p className="text-sm text-yellow-600 dark:text-yellow-400">No executor key set. Automatic payments will not execute.</p>
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input type={showExecutorKey ? "text" : "password"} value={executorKey} onChange={(e) => setExecutorKey(e.target.value)} placeholder="0x... or 64-character hex" className="pr-10 font-mono text-sm" data-testid="input-executor-key" />
                  <Button variant="ghost" size="icon" className="absolute right-0 top-0 h-full px-3" onClick={() => setShowExecutorKey(!showExecutorKey)} data-testid="button-toggle-key-visibility">
                    {showExecutorKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </Button>
                </div>
                <Button onClick={() => saveExecutorKeyMutation.mutate(executorKey)} disabled={!executorKey || saveExecutorKeyMutation.isPending} data-testid="button-save-executor-key">
                  <Save className="w-4 h-4 mr-2" />
                  Save Key
                </Button>
              </div>
            </div>
          )}

          <div className="p-3 rounded-md bg-muted/50 border">
            <p className="text-xs text-muted-foreground">
              <Shield className="w-3 h-3 inline mr-1" />
              Use a dedicated executor wallet with limited funds for safety.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const NAV_ITEMS: { key: DashboardSection; label: string; icon: any }[] = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "plans", label: "Plans", icon: FileText },
  { key: "subscribers", label: "Subscribers", icon: Users },
  { key: "transactions", label: "Transactions", icon: ArrowUpDown },
  { key: "settings", label: "Settings", icon: Settings },
];

export default function DashboardPage() {
  const [, navigate] = useLocation();
  const { user, logout, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const [activeSection, setActiveSection] = useState<DashboardSection>("overview");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [balance, setBalance] = useState<string>("0");
  const [isConnecting, setIsConnecting] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [qrPlan, setQrPlan] = useState<Plan | null>(null);
  const [welcomeDialogOpen, setWelcomeDialogOpen] = useState(false);
  const [welcomeShown, setWelcomeShown] = useState(() => sessionStorage.getItem("cryptopay_welcome_shown") === "true");

  const { data: stats, isLoading: statsLoading } = useQuery<DashboardStats>({
    queryKey: ["/api/dashboard/stats"],
    enabled: !!user,
    refetchInterval: DASHBOARD_REFRESH_MS,
    staleTime: DASHBOARD_REFRESH_MS / 2,
  });

  const { data: plans, isLoading: plansLoading } = useQuery<Plan[]>({
    queryKey: ["/api/plans"],
    enabled: !!user,
    refetchInterval: DASHBOARD_REFRESH_MS,
    staleTime: DASHBOARD_REFRESH_MS / 2,
  });

  const { data: recentTx, isLoading: recentTxLoading } = useQuery<EnrichedLog[]>({
    queryKey: ["/api/dashboard/transactions"],
    enabled: !!user,
    refetchInterval: DASHBOARD_LIVE_REFRESH_MS,
    staleTime: DASHBOARD_LIVE_REFRESH_MS / 2,
    refetchIntervalInBackground: true,
  });

  const { data: dashboardSubscribers } = useQuery<EnrichedSubscription[]>({
    queryKey: ["/api/dashboard/subscribers"],
    enabled: !!user,
    refetchInterval: DASHBOARD_LIVE_REFRESH_MS,
    staleTime: DASHBOARD_LIVE_REFRESH_MS / 2,
    refetchIntervalInBackground: true,
  });

  const { data: dashboardWallets } = useQuery<UserWallet[]>({
    queryKey: ["/api/wallets"],
    enabled: !!user,
    refetchInterval: DASHBOARD_REFRESH_MS,
    staleTime: DASHBOARD_REFRESH_MS / 2,
  });

  const deletePlanMutation = useMutation({
    mutationFn: async (planId: string) => {
      await apiRequest("DELETE", `/api/plans/${planId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plans"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
    },
  });

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/login");
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user && dashboardWallets !== undefined && !welcomeShown) {
      if (dashboardWallets.length === 0 && !walletAddress) {
        setWelcomeDialogOpen(true);
        setWelcomeShown(true);
        sessionStorage.setItem("cryptopay_welcome_shown", "true");
      }
    }
  }, [user, dashboardWallets, walletAddress, welcomeShown]);

  const refreshBalance = useCallback(async (addr: string) => {
    const bal = await getBalance(addr);
    setBalance(parseFloat(bal).toFixed(4));
  }, []);

  useEffect(() => {
    // Keep wallet connection UI user-scoped: every account starts disconnected.
    setWalletAddress(null);
    setNetwork(null);
    setBalance("0");
  }, [user?.id]);

  useEffect(() => {
    const unsubAccounts = onAccountsChanged((accounts) => {
      if (accounts.length > 0) {
        setWalletAddress(accounts[0]);
        refreshBalance(accounts[0]);
      } else {
        setWalletAddress(null);
        setNetwork(null);
        setBalance("0");
      }
    });

    const unsubChain = onChainChanged((chainId) => {
      setNetwork({ chainId, name: getChainName(chainId) });
      if (walletAddress) refreshBalance(walletAddress);
    });

    return () => {
      unsubAccounts();
      unsubChain();
    };
  }, [refreshBalance, walletAddress]);

  const [addingWalletChoice, setAddingWalletChoice] = useState<ReceiverWalletChoice | null>(null);

  const validateDetectedWallet = (
    selectedChoice: ReceiverWalletChoice,
    detectedBrand: WalletBrand
  ): boolean => {
    if (detectedBrand === "generic") return true;
    if (detectedBrand !== selectedChoice) {
      toast({
        title: "Wrong wallet detected",
        description: `You selected ${getWalletChoiceLabel(selectedChoice)} but browser injected ${detectedBrand === "trust" ? "Trust Wallet" : "MetaMask"}. Open the dashboard in your selected wallet and try again.`,
        variant: "destructive",
      });
      return false;
    }
    return true;
  };

  const handleConnect = async (selectedChoice: ReceiverWalletChoice) => {
    setIsConnecting(true);
    try {
      const { address, network: net, walletBrand } = await connectInjectedWallet();
      if (!validateDetectedWallet(selectedChoice, walletBrand)) return;

      setWalletAddress(address);
      setNetwork(net);
      refreshBalance(address);

      await apiRequest("POST", "/api/auth/wallet", {
        walletAddress: address,
        walletNetwork: `${net.name} (${getWalletChoiceLabel(selectedChoice)})`,
      });

      toast({ title: "Wallet connected", description: `${getWalletChoiceLabel(selectedChoice)} connected` });
    } catch (e: any) {
      toast({ title: "Connection failed", description: e.message, variant: "destructive" });
    } finally {
      setIsConnecting(false);
    }
  };

  const handleAddFromWallet = async (selectedChoice: ReceiverWalletChoice) => {
    setAddingWalletChoice(selectedChoice);
    try {
      const { address, network: net, walletBrand } = await connectInjectedWallet();
      if (!validateDetectedWallet(selectedChoice, walletBrand)) return;

      setWalletAddress(address);
      setNetwork(net);
      refreshBalance(address);

      await apiRequest("POST", "/api/wallets", {
        address,
        label: getWalletChoiceLabel(selectedChoice),
        networkId: net.chainId,
        networkName: net.name,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/wallets"] });

      await apiRequest("POST", "/api/auth/wallet", {
        walletAddress: address,
        walletNetwork: `${net.name} (${getWalletChoiceLabel(selectedChoice)})`,
      });

      toast({
        title: "Wallet added",
        description: `${getWalletChoiceLabel(selectedChoice)} ${address.slice(0, 6)}...${address.slice(-4)} added successfully`,
      });
    } catch (e: any) {
      if (e.message?.includes("already exists") || e.message?.includes("duplicate")) {
        toast({ title: "Wallet already added", description: "This wallet is already in your list", variant: "destructive" });
      } else {
        toast({ title: "Failed to add wallet", description: e.message, variant: "destructive" });
      }
    } finally {
      setAddingWalletChoice(null);
    }
  };

  const handleConnectTron = async () => {
    setIsConnecting(true);
    try {
      const walletInfo = await connectTronLink();
      setWalletAddress(walletInfo.address);
      setNetwork({ chainId: "tron_mainnet", name: "TRON Mainnet" });
      setBalance("---"); // TronWeb balance fetching is separate

      await apiRequest("POST", "/api/auth/wallet", {
        walletAddress: walletInfo.address,
        walletNetwork: "TRON Mainnet (TronLink)",
      });

      toast({ title: "TRON Wallet connected", description: "TronLink wallet connected" });
    } catch (e: any) {
      toast({ title: "Connection failed", description: e.message, variant: "destructive" });
    } finally {
      setIsConnecting(false);
    }
  };

  const handleAddTronWallet = async () => {
    setAddingWalletChoice("trust"); // Using trust as a proxy for spinner
    try {
      const walletInfo = await connectTronLink();
      const address = walletInfo.address;
      
      await apiRequest("POST", "/api/wallets", {
        address,
        label: "TRON Wallet",
        networkId: "tron_mainnet",
        networkName: "TRON Mainnet",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/wallets"] });

      toast({
        title: "TRON Wallet added",
        description: `TRON address ${address.slice(0, 6)}...${address.slice(-4)} added successfully`,
      });
    } catch (e: any) {
      toast({ title: "Failed to add TRON wallet", description: e.message, variant: "destructive" });
    } finally {
      setAddingWalletChoice(null);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="space-y-4 w-full max-w-xl p-6">
          <Skeleton className="h-12 w-48" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-background flex">
      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setMobileSidebarOpen(false)} />
      )}

      <aside className={`fixed lg:sticky top-0 left-0 z-50 h-screen border-r bg-card/80 backdrop-blur-sm flex flex-col transition-all duration-200 ${
        mobileSidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
      } ${sidebarCollapsed ? "w-16" : "w-60"}`}>
        <div className={`p-4 border-b flex items-center ${sidebarCollapsed ? "justify-center" : "justify-between"} gap-2`}>
          {!sidebarCollapsed && (
            <div className="flex items-center gap-2">
              <TrustWalletLogo size={24} />
              <span className="font-bold text-sm">Trust Wallet</span>
            </div>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7 hidden lg:flex" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} data-testid="button-toggle-sidebar">
            {sidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 lg:hidden" onClick={() => setMobileSidebarOpen(false)}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = activeSection === item.key;
            return (
              <button
                key={item.key}
                onClick={() => { setActiveSection(item.key); setMobileSidebarOpen(false); }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors ${
                  isActive
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                } ${sidebarCollapsed ? "justify-center" : ""}`}
                data-testid={`nav-${item.key}`}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <item.icon className="w-4 h-4 flex-shrink-0" />
                {!sidebarCollapsed && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t">
          {!sidebarCollapsed ? (
            <div className="space-y-2">
              <div className="px-2">
                <p className="text-xs text-muted-foreground truncate">Signed in as</p>
                <p className="text-sm font-medium truncate" data-testid="text-username">{user.username}</p>
              </div>
              <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" onClick={() => { logout(); navigate("/login"); }} data-testid="button-logout">
                <LogOut className="w-4 h-4 mr-2" />
                Logout
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="icon" className="w-full" onClick={() => { logout(); navigate("/login"); }} data-testid="button-logout" title="Logout">
              <LogOut className="w-4 h-4" />
            </Button>
          )}
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-30 lg:hidden">
          <div className="px-4 py-3 flex items-center gap-3">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setMobileSidebarOpen(true)} data-testid="button-mobile-menu">
              <Menu className="w-5 h-5" />
            </Button>
            <div className="flex items-center gap-2">
              <TrustWalletLogo size={24} />
              <span className="font-bold text-sm">Trust Wallet</span>
            </div>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto">
          <div className="max-w-6xl mx-auto">
            {activeSection === "overview" && (
              <OverviewSection
                stats={stats}
                statsLoading={statsLoading}
                transactions={recentTx}
                txLoading={recentTxLoading}
                plansCount={plans?.length || 0}
                activeSubscribersCount={dashboardSubscribers?.filter((sub) => sub.isActive).length || 0}
              />
            )}
            {activeSection === "plans" && (
              <PlansSection
                plans={plans}
                plansLoading={plansLoading}
                hasWallets={!!(dashboardWallets && dashboardWallets.length > 0)}
                onCreatePlan={() => setCreateDialogOpen(true)}
                onShowQr={(plan) => setQrPlan(plan)}
                onDeletePlan={(id) => deletePlanMutation.mutate(id)}
                savedWallets={dashboardWallets || []}
              />
            )}
            {activeSection === "subscribers" && <SubscribersSection />}
            {activeSection === "transactions" && <TransactionsSection />}
            {activeSection === "settings" && (
              <SettingsSection
                walletAddress={walletAddress}
                network={network}
                balance={balance}
                isConnecting={isConnecting}
                onConnect={handleConnect}
                onAddFromWallet={handleAddFromWallet}
                addingWalletChoice={addingWalletChoice}
                onConnectTron={handleConnectTron}
                onAddTronWallet={handleAddTronWallet}
              />
            )}
          </div>
        </main>
      </div>

      <CreatePlanDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        userWallets={dashboardWallets || []}
      />

      {qrPlan && (
        <QRCodeDialog
          plan={qrPlan}
          open={!!qrPlan}
          onOpenChange={(open: boolean) => !open && setQrPlan(null)}
        />
      )}

      <Dialog open={welcomeDialogOpen} onOpenChange={setWelcomeDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TrustWalletLogo size={28} />
              Welcome to Trust Wallet
            </DialogTitle>
            <DialogDescription>
              Set up your payment wallet to start creating plans and collecting recurring crypto payments.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="p-4 rounded-lg bg-primary/5 border border-primary/10 space-y-3">
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-xs font-bold text-primary">1</span>
                </div>
                <div>
                  <p className="text-sm font-medium">Add a Payment Wallet</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Add your wallet address to receive payments from subscribers</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-xs font-bold text-primary">2</span>
                </div>
                <div>
                  <p className="text-sm font-medium">Create a Payment Plan</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Set up recurring payment plans with your preferred token and interval</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-xs font-bold text-primary">3</span>
                </div>
                <div>
                  <p className="text-sm font-medium">Share QR Code</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Share the QR code with subscribers who can customize their payment amount</p>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() => {
                  setWelcomeDialogOpen(false);
                  setActiveSection("settings");
                }}
                data-testid="button-welcome-setup"
              >
                <Wallet className="w-4 h-4 mr-2" />
                Add Wallet Now
              </Button>
              <Button
                variant="outline"
                onClick={() => setWelcomeDialogOpen(false)}
                data-testid="button-welcome-dismiss"
              >
                Later
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
