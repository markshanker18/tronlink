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
  getBalance,
  onAccountsChanged,
  onChainChanged,
  getCurrentNetwork,
  getChainName,
} from "@/lib/metamask";
import { connectTronLink, detectTronChainId, getTronNetworkInfo } from "@/lib/tronlink";
import type { WalletBrand, NetworkInfo } from "@/lib/metamask";
import type { Plan, Subscription, UserWallet, SchedulerLog } from "@shared/schema";
import { hasMinimumSubscriptionInterval, MIN_SUBSCRIPTION_INTERVAL_SECONDS } from "@shared/interval";
import type { ChainType } from "@shared/chain";
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
  ShieldCheck,
  Smartphone,
  Menu,
  Send,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import CreatePlanDialog from "@/components/create-plan-dialog";
import QRCodeDialog from "@/components/qr-code-dialog";


type DashboardSection = "overview" | "plans" | "subscribers" | "transactions" | "settings";
type ReceiverWalletChoice = "metamask" | "tronlink" | "trustwallet" | "other";
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
  amount: string | null;
  receiverAddress: string | null;
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
  if (normalized === "success" || normalized === "accepted") return "Accepted";
  if (normalized === "scheduled") return "Scheduled";
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

function getIntervalValidationMessage(value: number, unit: string): string | null {
  if (!Number.isFinite(value) || value <= 0) return "Enter a valid positive interval.";
  if (!hasMinimumSubscriptionInterval(value, unit)) {
    return `Minimum recurring interval is ${MIN_SUBSCRIPTION_INTERVAL_SECONDS} seconds.`;
  }
  return null;
}

function getWalletChoiceLabel(choice: ReceiverWalletChoice): string {
  if (choice === "tronlink") return "TronLink";
  if (choice === "trustwallet") return "Trust Wallet";
  if (choice === "other") return "Mobile Wallet";
  return "MetaMask";
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
  const [editingBilling, setEditingBilling] = useState(false);
  const [newWallet, setNewWallet] = useState(plan.walletAddress);
  const [newAmount, setNewAmount] = useState(plan.recurringAmount || plan.intervalAmount || "");
  const [newVal, setNewVal] = useState(plan.intervalValue.toString());
  const [newUnit, setNewUnit] = useState(plan.intervalUnit);
  const [proposingChange, setProposingChange] = useState(false);
  const [propAmount, setPropAmount] = useState(plan.recurringAmount || plan.intervalAmount || "");
  const [propVal, setPropVal] = useState(plan.intervalValue.toString());
  const [propUnit, setPropUnit] = useState(plan.intervalUnit);
  const [propNote, setPropNote] = useState("");
  const billingIntervalError = getIntervalValidationMessage(Number(newVal), newUnit);
  const proposalIntervalError = getIntervalValidationMessage(Number(propVal), propUnit);

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

  const billingMutation = useMutation({
    mutationFn: async (billing: { amount?: string, value?: number, unit?: string }) => {
      if (billing.value && billing.unit) {
        const intervalError = getIntervalValidationMessage(billing.value, billing.unit);
        if (intervalError) throw new Error(intervalError);
      }
      const res = await apiRequest("PATCH", `/api/plans/${plan.id}/billing`, {
        recurringAmount: billing.amount,
        intervalValue: billing.value,
        intervalUnit: billing.unit
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/plans"] });
      setEditingBilling(false);
      toast({
        title: "Billing updated",
        description: data?.note ?? undefined,
      });
    },
    onError: (e: Error) => {
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });

  const proposeMutation = useMutation({
    mutationFn: async (p: { amount: string; val: number; unit: string; note: string }) => {
      const intervalError = getIntervalValidationMessage(p.val, p.unit);
      if (intervalError) throw new Error(intervalError);
      const res = await apiRequest("POST", `/api/plans/${plan.id}/propose-billing`, {
        proposedAmount: p.amount,
        proposedIntervalValue: p.val,
        proposedIntervalUnit: p.unit,
        merchantNote: p.note || undefined,
        deadlineDays: 7,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      setProposingChange(false);
      toast({ title: "Proposal sent", description: data?.message ?? `Sent to ${data?.count ?? 0} subscriber(s)` });
    },
    onError: (e: Error) => {
      toast({ title: "Proposal failed", description: e.message, variant: "destructive" });
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
              <Badge variant="outline" className="text-xs">
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
          <span className="text-2xl font-bold tabular-nums" data-testid={`text-amount-${plan.id}`}>
            {plan.recurringAmount || plan.intervalAmount}
          </span>
          <span className="text-sm text-muted-foreground">{tokenSymbol}</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Clock className="w-3.5 h-3.5" />
          {getIntervalLabel(plan.intervalValue, plan.intervalUnit)}
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
              {savedWallets.length > 0 ? (
                <div className="space-y-1">
                  {savedWallets.map((w) => (
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
            <span className="text-xs font-medium text-muted-foreground">Billing Terms</span>
            {!editingBilling ? (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => { 
                setNewAmount(plan.recurringAmount || plan.intervalAmount); 
                setNewVal(plan.intervalValue.toString());
                setNewUnit(plan.intervalUnit);
                setEditingBilling(true); 
              }} data-testid={`button-edit-billing-${plan.id}`}>
                <Pencil className="w-3 h-3 mr-1" />
                Edit
              </Button>
            ) : (
              <div className="flex gap-1">
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="h-6 px-2 text-xs" 
                  onClick={() => billingMutation.mutate({ amount: newAmount, value: Number(newVal), unit: newUnit })} 
                  disabled={billingMutation.isPending || !!billingIntervalError} 
                  data-testid={`button-save-billing-${plan.id}`}
                >
                  <Save className="w-3 h-3 text-primary" />
                </Button>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setEditingBilling(false)}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
            )}
          </div>
          {editingBilling ? (
            <div className="space-y-2 p-2 bg-muted/30 rounded-lg">
              <div className="flex gap-2">
                <Input type="number" step="any" value={newAmount} onChange={(e) => setNewAmount(e.target.value)} className="h-8 text-xs flex-1" placeholder="Amount" />
                <Badge variant="outline" className="h-8">{tokenSymbol}</Badge>
              </div>
              <div className="flex gap-2">
                <Input type="number" value={newVal} onChange={(e) => setNewVal(e.target.value)} className="h-8 text-xs w-16" placeholder="Value" />
                <select
                  value={newUnit}
                  onChange={(e) => setNewUnit(e.target.value)}
                  className="h-8 flex-1 text-xs bg-background border rounded-md px-2"
                >
                  <option value="sec">Seconds</option>
                  <option value="min">Minutes</option>
                  <option value="hrs">Hours</option>
                  <option value="days">Days</option>
                  <option value="months">Months</option>
                </select>
              </div>
              {billingIntervalError && (
                <p className="text-[10px] text-red-500">{billingIntervalError}</p>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground flex items-center justify-between">
               <span>{plan.recurringAmount || plan.intervalAmount} {tokenSymbol}</span>
               <span className="opacity-70">{getIntervalLabel(plan.intervalValue, plan.intervalUnit)}</span>
            </div>
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
            How ERC-20 Recurring Payments Work
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
                {canCreatePlan ? "Create your first ERC-20 token payment plan to get started" : "Add a wallet in Settings first, then create payment plans"}
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
        liveStatus: (latest?.status === "success" || latest?.status === "accepted") ? "scheduled" : (latest?.status || "started"),
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
                  <th className="text-left p-3 font-medium text-muted-foreground">Amount</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Receiver</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Payer</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Status Checker</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Reason</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Tx Hash</th>
                  <th className="text-left p-3 font-medium text-muted-foreground">Gas</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const groupedMap = new Map<string, EnrichedLog>();
                  for (const tx of transactions) {
                    const key = tx.cycleId || tx.id;
                    const existing = groupedMap.get(key);
                    const statusRank: Record<string, number> = {
                      "started": 1,
                      "triggered": 2,
                      "pending": 3,
                      "failed": 4,
                      "success": 5,
                      "accepted": 6,
                      "error": 4
                    };
                    if (!existing || (statusRank[tx.status] || 0) > (statusRank[existing.status] || 0)) {
                      groupedMap.set(key, tx);
                    }
                  }
                  
                  return Array.from(groupedMap.values()).map((tx) => {
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
                    <td className="p-3 text-xs font-mono whitespace-nowrap">
                      {tx.amount ? `${tx.amount} ${tx.tokenSymbol || ""}`.trim() : "--"}
                    </td>
                    <td className="p-3">
                      <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
                        {tx.receiverAddress ? formatAddress(tx.receiverAddress) : "--"}
                      </code>
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
                    );
                  });
                })()}
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
}: {
  walletAddress: string | null;
  network: NetworkInfo | null;
  balance: string;
  isConnecting: boolean;
  onConnect: (choice: ReceiverWalletChoice) => void;
  onAddFromWallet: (choice: ReceiverWalletChoice) => void;
  addingWalletChoice: ReceiverWalletChoice | null;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);  const [evmExecutorKey, setEvmExecutorKey] = useState("");
  const [showEvmExecutorKey, setShowEvmExecutorKey] = useState(false);
  const [tronExecutorKey, setTronExecutorKey] = useState("");
  const [showTronExecutorKey, setShowTronExecutorKey] = useState(false);

  const [newWalletAddress, setNewWalletAddress] = useState("");
  const [newWalletLabel, setNewWalletLabel] = useState("");
  const isAddingTronLink = addingWalletChoice === "tronlink";
  const isAddingMetaMaskWallet = addingWalletChoice === "metamask";

  const { data: executorKeyStatus } = useQuery<{ hasEvmKey: boolean, hasTronKey: boolean }>({
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
    mutationFn: async ({ key, type }: { key: string, type: "evm" | "tron" }) => {
      await apiRequest("POST", "/api/auth/executor-key", { privateKey: key, type });
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/executor-key"] });
      toast({ title: `${variables.type.toUpperCase()} executor key saved` });
      if (variables.type === "evm") setEvmExecutorKey("");
      else setTronExecutorKey("");
    },
    onError: (e: Error) => {
      toast({ title: "Failed to save key", description: e.message, variant: "destructive" });
    },
  });

  const removeExecutorKeyMutation = useMutation({
    mutationFn: async (type: "evm" | "tron") => {
      await apiRequest("DELETE", `/api/auth/executor-key?type=${type}`);
    },
    onSuccess: (_, type) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/executor-key"] });
      toast({ title: `${type.toUpperCase()} executor key removed` });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to remove key", description: e.message, variant: "destructive" });
    },
  });

  const addWalletMutation = useMutation({
    mutationFn: async ({ address, label, networkId, networkName }: { address: string; label: string; networkId?: string; networkName?: string }) => {
      const res = await apiRequest("POST", "/api/wallets", { address, label, networkId, networkName });
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
                    <p className="text-sm text-muted-foreground">Open this page in a crypto-enabled browser to connect</p>
                    <div className="flex flex-wrap justify-center gap-2">

                      <Button size="sm" onClick={() => openInMetaMaskMobile(window.location.href)} data-testid="button-open-metamask-dashboard">
                        <Wallet className="w-4 h-4 mr-2" />
                        Open Wallet
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
                        Install Wallet
                      </a>
                    </Button>
                  </>
                )
              ) : (
                <>
                  <div className="p-3 rounded-full bg-primary/10">
                    <Wallet className="w-6 h-6 text-primary" />
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">Choose your active session wallet</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 w-full max-w-2xl px-4">
                    {/* MetaMask */}
                    <Button 
                      variant="outline"
                      className="h-10 text-xs hover:border-orange-500/50 hover:bg-orange-500/5 transition-all"
                      onClick={() => onConnect("metamask")} 
                      disabled={isConnecting}
                    >
                      <img src="https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg" className="w-3.5 h-3.5 mr-1.5" alt="" />
                      {isConnecting ? "..." : "MetaMask"}
                    </Button>

                    {/* Trust Wallet */}
                    <Button 
                      variant="outline"
                      className="h-10 text-xs hover:border-blue-500/50 hover:bg-blue-500/5 transition-all"
                      onClick={() => onConnect("trustwallet")} 
                      disabled={isConnecting}
                    >
                      <ShieldCheck className="w-3.5 h-3.5 mr-1.5 text-blue-500" />
                      {isConnecting ? "..." : "Trust Wallet"}
                    </Button>

                    {/* TronLink */}
                    <Button 
                      variant="outline"
                      className="h-10 text-xs hover:border-red-500/50 hover:bg-red-500/5 transition-all"
                      onClick={() => onConnect("tronlink")} 
                      disabled={isConnecting}
                    >
                      <Shield className="w-3.5 h-3.5 mr-1.5 text-red-500" />
                      {isConnecting ? "..." : "TronLink"}
                    </Button>

                    {/* Generic Mobile */}
                    <Button 
                      variant="outline"
                      className="h-10 text-xs hover:border-primary/50 hover:bg-primary/5 transition-all"
                      onClick={() => onConnect("other")} 
                      disabled={isConnecting}
                    >
                      <Smartphone className="w-3.5 h-3.5 mr-1.5 text-primary" />
                      {isConnecting ? "..." : "Mobile Wallet"}
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
                <div className="space-y-4 pt-4 border-t border-muted-foreground/10">
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Connect & Add Wallet</label>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      {/* MetaMask */}
                      <Button
                        variant="outline"
                        className="h-10 text-xs px-2 hover:border-orange-500/50 hover:bg-orange-500/5 transition-all"
                        onClick={async () => {
                          try {
                            const { address, network: net } = await connectInjectedWallet();
                            addWalletMutation.mutate({ 
                              address, 
                              label: `MetaMask (${net.name})`
                            });
                          } catch (e: any) {
                            toast({ title: "Connect failed", description: e.message, variant: "destructive" });
                          }
                        }}
                        disabled={addWalletMutation.isPending}
                      >
                        <img src="https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg" className="w-3.5 h-3.5 mr-1.5" alt="" />
                        MetaMask
                      </Button>

                      {/* Trust Wallet */}
                      <Button
                        variant="outline"
                        className="h-10 text-xs px-2 hover:border-blue-500/50 hover:bg-blue-500/5 transition-all"
                        onClick={async () => {
                          try {
                            const { address, network: net } = await connectInjectedWallet();
                            addWalletMutation.mutate({ 
                              address, 
                              label: `Trust Wallet (${net.name})`
                            });
                          } catch (e: any) {
                            toast({ title: "Connect failed", description: e.message, variant: "destructive" });
                          }
                        }}
                        disabled={addWalletMutation.isPending}
                      >
                        <ShieldCheck className="w-3.5 h-3.5 mr-1.5 text-blue-500" />
                        Trust Wallet
                      </Button>

                      {/* TronLink */}
                      <Button
                        variant="outline"
                        className="h-10 text-xs px-2 hover:border-red-500/50 hover:bg-red-500/5 transition-all"
                        onClick={async () => {
                          try {
                            const { address } = await connectTronLink();
                            const netId = detectTronChainId();
                            const net = getTronNetworkInfo(netId);
                            addWalletMutation.mutate({
                              address,
                              label: `TronLink (${net?.networkName || "TRON"})`,
                              networkId: netId,
                              networkName: net?.networkName,
                            });
                          } catch (e: any) {
                            toast({ title: "Connect failed", description: e.message, variant: "destructive" });
                          }
                        }}
                        disabled={addWalletMutation.isPending}
                      >
                        <Shield className="w-3.5 h-3.5 mr-1.5 text-red-500" />
                        TronLink
                      </Button>

                      {/* Generic Injected */}
                      <Button
                        variant="outline"
                        className="h-10 text-xs px-2 hover:border-primary/50 hover:bg-primary/5 transition-all"
                        onClick={async () => {
                          try {
                            const { address, network: net } = await connectInjectedWallet();
                            addWalletMutation.mutate({ 
                              address, 
                              label: `Mobile Wallet (${net.name})`
                            });
                          } catch (e: any) {
                            toast({ title: "Connect failed", description: e.message, variant: "destructive" });
                          }
                        }}
                        disabled={addWalletMutation.isPending}
                      >
                        <Smartphone className="w-3.5 h-3.5 mr-1.5 text-primary" />
                        Other / Mobile
                      </Button>
                    </div>
                  </div>

                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-muted-foreground/10" />
                    </div>
                    <div className="relative flex justify-center text-[10px] uppercase tracking-widest font-bold">
                      <span className="bg-card px-2 text-muted-foreground/50">or enter manually</span>
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
                        placeholder="e.g. Savings"
                        className="h-9 text-xs"
                        data-testid="input-new-wallet-label"
                      />
                    </div>
                    <Button
                      size="sm"
                      className="h-9 font-bold"
                      onClick={() => addWalletMutation.mutate({ address: newWalletAddress, label: newWalletLabel })}
                      disabled={!newWalletAddress || addWalletMutation.isPending}
                      data-testid="button-add-wallet"
                    >
                      <Plus className="w-4 h-4 mr-1" />
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
            <Shield className="w-5 h-5 text-primary" />
            Executor Private Keys
          </CardTitle>
          <CardDescription>Provide dedicated wallet keys for automatic payment execution. Encrypted with AES-256-GCM.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* EVM Key Section */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
              ERC-20 / EVM Networks
            </h4>
            
            {executorKeyStatus?.hasEvmKey ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 rounded-md border border-green-500/20 bg-green-500/5">
                  <div className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="text-xs font-medium text-green-600 dark:text-green-400">EVM key configured</p>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 text-[10px] text-destructive hover:bg-destructive/10" onClick={() => removeExecutorKeyMutation.mutate("evm")} disabled={removeExecutorKeyMutation.isPending}>
                    <Trash2 className="w-3 h-3 mr-1" />
                    Remove
                  </Button>
                </div>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input type={showEvmExecutorKey ? "text" : "password"} value={evmExecutorKey} onChange={(e) => setEvmExecutorKey(e.target.value)} placeholder="0x... (update with new key)" className="pr-10 font-mono text-xs h-9" />
                    <Button variant="ghost" size="icon" className="absolute right-0 top-0 h-full px-3" onClick={() => setShowEvmExecutorKey(!showEvmExecutorKey)}>
                      {showEvmExecutorKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </Button>
                  </div>
                  <Button size="sm" className="h-9 px-4 font-bold" onClick={() => saveExecutorKeyMutation.mutate({ key: evmExecutorKey, type: "evm" })} disabled={!evmExecutorKey || saveExecutorKeyMutation.isPending}>
                    Update
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 rounded-md border border-amber-500/20 bg-amber-500/5">
                  <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                  <p className="text-xs text-amber-600">No EVM executor set. Sepolia/Mainnet charges will fail.</p>
                </div>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input type={showEvmExecutorKey ? "text" : "password"} value={evmExecutorKey} onChange={(e) => setEvmExecutorKey(e.target.value)} placeholder="0x... (64-char hex)" className="pr-10 font-mono text-xs h-9" />
                    <Button variant="ghost" size="icon" className="absolute right-0 top-0 h-full px-3" onClick={() => setShowEvmExecutorKey(!showEvmExecutorKey)}>
                      {showEvmExecutorKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </Button>
                  </div>
                  <Button size="sm" className="h-9 px-4 font-bold" onClick={() => saveExecutorKeyMutation.mutate({ key: evmExecutorKey, type: "evm" })} disabled={!evmExecutorKey || saveExecutorKeyMutation.isPending}>
                    Save
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-muted" />

          {/* TRON Key Section */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
              TRC-20 / TRON Networks
            </h4>
            
            {executorKeyStatus?.hasTronKey ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 rounded-md border border-green-500/20 bg-green-500/5">
                  <div className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="text-xs font-medium text-green-600 dark:text-green-400">TRON key configured</p>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 text-[10px] text-destructive hover:bg-destructive/10" onClick={() => removeExecutorKeyMutation.mutate("tron")} disabled={removeExecutorKeyMutation.isPending}>
                    <Trash2 className="w-3 h-3 mr-1" />
                    Remove
                  </Button>
                </div>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input type={showTronExecutorKey ? "text" : "password"} value={tronExecutorKey} onChange={(e) => setTronExecutorKey(e.target.value)} placeholder="64-char hex (update with new key)" className="pr-10 font-mono text-xs h-9" />
                    <Button variant="ghost" size="icon" className="absolute right-0 top-0 h-full px-3" onClick={() => setShowTronExecutorKey(!showTronExecutorKey)}>
                      {showTronExecutorKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </Button>
                  </div>
                  <Button size="sm" className="h-9 px-4 font-bold" onClick={() => saveExecutorKeyMutation.mutate({ key: tronExecutorKey, type: "tron" })} disabled={!tronExecutorKey || saveExecutorKeyMutation.isPending}>
                    Update
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 rounded-md border border-amber-500/20 bg-amber-500/5">
                  <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                  <p className="text-xs text-amber-600">No TRON executor set. Nile/Mainnet charges will fail.</p>
                </div>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input type={showTronExecutorKey ? "text" : "password"} value={tronExecutorKey} onChange={(e) => setTronExecutorKey(e.target.value)} placeholder="64-char hex" className="pr-10 font-mono text-xs h-9" />
                    <Button variant="ghost" size="icon" className="absolute right-0 top-0 h-full px-3" onClick={() => setShowTronExecutorKey(!showTronExecutorKey)}>
                      {showTronExecutorKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </Button>
                  </div>
                  <Button size="sm" className="h-9 px-4 font-bold" onClick={() => saveExecutorKeyMutation.mutate({ key: tronExecutorKey, type: "tron" })} disabled={!tronExecutorKey || saveExecutorKeyMutation.isPending}>
                    Save
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="p-3 rounded-md bg-primary/5 border border-primary/20">
            <p className="text-[10px] text-muted-foreground flex items-center gap-1.5 leading-relaxed">
              <Shield className="w-3 h-3 text-primary flex-shrink-0" />
              Use dedicated wallets with limited funds for safety. EVM keys start with 0x. TRON keys are 64-character hex strings found in TronLink.
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

  const [planToDelete, setPlanToDelete] = useState<string | null>(null);

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
    if (detectedBrand !== selectedChoice) {
      toast({
        title: "Wrong wallet detected",
        description: `You selected ${getWalletChoiceLabel(selectedChoice)} but browser injected ${detectedBrand === "tronlink" ? "TronLink" : "an unexpected provider"}. Open the dashboard in your wallet and try again.`,
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
              <Wallet className="w-5 h-5 text-primary" />
              <span className="font-bold text-sm">CryptoPay</span>
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
              <Wallet className="w-5 h-5 text-primary" />
              <span className="font-bold text-sm">CryptoPay</span>
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
                onDeletePlan={(id) => setPlanToDelete(id)}
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
              />
            )}
          </div>
        </main>
      </div>

      <CreatePlanDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        savedWallets={dashboardWallets || []}
      />

      <AlertDialog open={!!planToDelete} onOpenChange={(open) => !open && setPlanToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete plan?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the plan and all its data. Active subscribers will no longer be billed. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (planToDelete) deletePlanMutation.mutate(planToDelete);
                setPlanToDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
              <Wallet className="w-5 h-5 text-primary" />
              Welcome to CryptoPay
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
