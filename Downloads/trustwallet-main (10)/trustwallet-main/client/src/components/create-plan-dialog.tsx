import { useState, useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { SUPPORTED_NETWORKS, isTronChain } from "@/lib/metamask";
import { getTokensForNetwork, type TokenInfo } from "@shared/contracts";
import { hasMinimumSubscriptionInterval, MIN_SUBSCRIPTION_INTERVAL_SECONDS } from "@shared/interval";
import { getTronTokensForNetwork, type TronTokenInfo } from "@shared/tron-contracts";
import { isAllowedVideoUrl } from "@shared/video";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Coins, Copy, Check, Repeat, Wallet } from "lucide-react";
import { useWallet } from "@/lib/wallet";

const FREQUENCY_PRESETS = [
  { label: "Daily",   intervalValue: "1",  intervalUnit: "days" },
  { label: "Weekly",  intervalValue: "7",  intervalUnit: "days" },
  { label: "Monthly", intervalValue: "1",  intervalUnit: "months" },
  { label: "Custom",  intervalValue: null, intervalUnit: null },
] as const;

function formatFrequencySummary(amount: string, value: string, unit: string, symbol: string): string {
  if (!amount || !value || !unit) return "";
  const unitLabel: Record<string, string> = {
    sec: "second", min: "minute", hrs: "hour", days: "day", months: "month",
  };
  const base = unitLabel[unit] ?? unit;
  const plural = Number(value) !== 1 ? `${value} ${base}s` : base;
  return `Charge ${amount} ${symbol || "tokens"} every ${plural}`;
}

const createPlanSchema = z.object({
  planName: z.string().min(1, "Plan name is required"),
  networkChainId: z.string().min(1, "Network is required"),
  tokenAddress: z.string().min(1, "Token is required").refine((val) => {
    const low = val.toLowerCase();
    return low !== "0x0000000000000000000000000000000000000000" && 
           low !== "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" &&
           low !== "trx";
  }, "Native tokens (ETH/BNB/MATIC/TRX) are not supported for recurring subscriptions. Use ERC-20/TRC-20 tokens."),
  intervalAmount: z.string().min(1, "Amount is required").refine((val) => !isNaN(Number(val)) && Number(val) > 0, "Must be a positive number"),
  intervalValue: z.string().min(1, "Interval is required").refine((val) => !isNaN(Number(val)) && Number(val) > 0, "Must be a positive number"),
  intervalUnit: z.string().min(1, "Unit is required"),
  videoUrl: z
    .string()
    .optional()
    .refine((value) => !value || isAllowedVideoUrl(value), "Use an https YouTube/Vimeo URL or direct .mp4/.webm/.ogg file"),
});

type CreatePlanInput = z.infer<typeof createPlanSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  savedWallets?: any[];
}

export default function CreatePlanDialog({ open, onOpenChange, savedWallets = [] }: Props) {
  const { toast } = useToast();
  const { getAddressForNetwork } = useWallet();
  const [availableTokens, setAvailableTokens] = useState<(TokenInfo | TronTokenInfo)[]>([]);
  const [copiedTokenAddress, setCopiedTokenAddress] = useState<string | null>(null);
  const [frequencyPreset, setFrequencyPreset] = useState<string>("Monthly");
  const [manualTronAddress, setManualTronAddress] = useState("");
  const [manualTronError, setManualTronError] = useState("");
  const [selectedSavedWalletId, setSelectedSavedWalletId] = useState<string>("auto");

  const form = useForm<CreatePlanInput>({
    resolver: zodResolver(createPlanSchema),
    defaultValues: {
      planName: "",
      networkChainId: "",
      tokenAddress: "",
      intervalAmount: "",
      intervalValue: "1",
      intervalUnit: "months",
      videoUrl: "",
    },
  });

  const selectedNetwork = form.watch("networkChainId");
  const isSelectedTron = isTronChain(selectedNetwork);

  // Filter saved wallets for the current network type
  const filteredSavedWallets = useMemo(() => {
    if (!selectedNetwork) return [];
    return savedWallets.filter(w => {
      const isAddrTron = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(w.address);
      return isSelectedTron ? isAddrTron : !isAddrTron;
    });
  }, [savedWallets, isSelectedTron, selectedNetwork]);

  // Determine the final wallet address to use
  const autoWalletAddress = selectedNetwork ? getAddressForNetwork(selectedNetwork) : null;
  
  const walletAddrToUse = useMemo(() => {
    if (selectedSavedWalletId === "auto") return autoWalletAddress;
    if (selectedSavedWalletId === "manual") return isSelectedTron ? manualTronAddress.trim() : null;
    return savedWallets.find(w => w.id.toString() === selectedSavedWalletId)?.address || null;
  }, [selectedSavedWalletId, autoWalletAddress, manualTronAddress, isSelectedTron, savedWallets]);

  const watchedAmount = form.watch("intervalAmount");
  const watchedValue = form.watch("intervalValue");
  const watchedUnit = form.watch("intervalUnit");
  const watchedToken = form.watch("tokenAddress");
  const selectedTokenSymbol = useMemo(
    () => availableTokens.find((t) => t.address === watchedToken)?.symbol ?? "",
    [availableTokens, watchedToken]
  );
  const frequencySummary = formatFrequencySummary(watchedAmount, watchedValue, watchedUnit, selectedTokenSymbol);
  const isCustomFrequency = frequencyPreset === "Custom";

  useEffect(() => {
    if (selectedNetwork) {
      const tokens = isSelectedTron
        ? getTronTokensForNetwork(selectedNetwork)
        : getTokensForNetwork(selectedNetwork);
      setAvailableTokens(tokens);
      form.setValue("tokenAddress", "");
      // Default to auto-detected if available, else first saved, else manual
      if (autoWalletAddress) setSelectedSavedWalletId("auto");
      else if (filteredSavedWallets.length > 0) setSelectedSavedWalletId(filteredSavedWallets[0].id.toString());
      else setSelectedSavedWalletId("manual");
    } else {
      setAvailableTokens([]);
    }
  }, [selectedNetwork, isSelectedTron, form, autoWalletAddress, filteredSavedWallets]);

  const mutation = useMutation({
    mutationFn: async (data: CreatePlanInput) => {
      const network = SUPPORTED_NETWORKS.find((n) => n.chainId === data.networkChainId);
      if (!network) throw new Error("Invalid network");

      const token = availableTokens.find((t) => t.address === data.tokenAddress);
      if (!token) throw new Error("Invalid token");

      if (!walletAddrToUse) throw new Error(isSelectedTron ? "Select or enter your TRON receiving wallet" : "Connect your wallet or select a saved one");
      if (isSelectedTron && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(walletAddrToUse)) {
        throw new Error("Invalid TRON address — must start with T and be 34 characters");
      }

      if (!hasMinimumSubscriptionInterval(parseInt(data.intervalValue), data.intervalUnit)) {
        throw new Error(`Minimum recurring interval is ${MIN_SUBSCRIPTION_INTERVAL_SECONDS} seconds.`);
      }

      const res = await apiRequest("POST", "/api/plans", {
        planName: data.planName,
        walletAddress: walletAddrToUse,
        networkId: network.chainId,
        networkName: network.name,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        intervalAmount: data.intervalAmount,
        intervalValue: parseInt(data.intervalValue),
        intervalUnit: data.intervalUnit,
        videoUrl: data.videoUrl || undefined,
        ...(isSelectedTron && { chainType: "tron" }),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api/plans"] });
      queryClient.invalidateQueries({ queryKey: ["api/dashboard/stats"] });
      form.reset();
      onOpenChange(false);
    },
    onError: (e: Error) => {
      toast({ title: "Failed to create plan", description: e.message, variant: "destructive" });
    },
  });

  const onSubmit = (data: CreatePlanInput) => {
    if (!walletAddrToUse) {
      toast({
        title: "Wallet address required",
        description: isSelectedTron ? "Please select or enter your TRON receiving address" : "Connect your wallet first",
        variant: "destructive",
      });
      return;
    }
    if (isSelectedTron && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(walletAddrToUse)) {
      setManualTronError("Invalid TRON address — must start with T and be 34 characters");
      return;
    }
    if (!hasMinimumSubscriptionInterval(parseInt(data.intervalValue), data.intervalUnit)) {
      toast({
        title: "Invalid interval",
        description: `Minimum recurring interval is ${MIN_SUBSCRIPTION_INTERVAL_SECONDS} seconds.`,
        variant: "destructive",
      });
      return;
    }
    setManualTronError("");
    mutation.mutate(data);
  };

  const copyTokenAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedTokenAddress(address);
      setTimeout(() => setCopiedTokenAddress((current) => (current === address ? null : current)), 1200);
      toast({ title: "Token address copied" });
    } catch {
      toast({ title: "Could not copy token address", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-primary">
            <Coins className="w-5 h-5" />
            Create Auto-charge
          </DialogTitle>
          <DialogDescription>
            {isSelectedTron ? "Set up a recurring TRC-20 auto-charge on TRON." : "Set up a recurring ERC-20 auto-charge."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pb-2">
            <FormField
              control={form.control}
              name="planName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Plan Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., Monthly Access" data-testid="input-plan-name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Receiving wallet — saved choice or manual entry */}
            <div className="space-y-2.5">
              <label className="text-sm font-medium flex items-center gap-1.5 overflow-hidden text-ellipsis">
                <Wallet className="w-4 h-4 text-primary" />
                Who receives the funds?
              </label>

              {selectedNetwork ? (
                <div className="space-y-2">
                  <Select value={selectedSavedWalletId} onValueChange={setSelectedSavedWalletId}>
                    <SelectTrigger className="w-full text-xs h-9 bg-muted/20">
                      <SelectValue placeholder="Choose a receiving wallet" />
                    </SelectTrigger>
                    <SelectContent>
                      {autoWalletAddress && (
                        <SelectItem value="auto" className="text-xs">
                          <div className="flex flex-col">
                            <span className="font-semibold text-primary/80">Current Wallet (Connected)</span>
                            <span className="text-[10px] font-mono opacity-60">{autoWalletAddress}</span>
                          </div>
                        </SelectItem>
                      )}
                      
                      {filteredSavedWallets.length > 0 && (
                        <>
                          <div className="px-2 py-1.5 text-[10px] font-bold uppercase text-muted-foreground bg-muted/30">Saved Wallets</div>
                          {filteredSavedWallets.map(w => (
                            <SelectItem key={w.id} value={w.id.toString()} className="text-xs">
                              <div className="flex flex-col">
                                <span className="font-medium">{w.label || "Untitled Wallet"}</span>
                                <span className="text-[10px] font-mono opacity-60">{w.address}</span>
                              </div>
                            </SelectItem>
                          ))}
                        </>
                      )}
                      
                      <SelectItem value="manual" className="text-xs">
                        <span className="font-medium text-amber-600 dark:text-amber-400">Enter address manually...</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Show final address preview or manual input */}
                  {selectedSavedWalletId === "manual" ? (
                    <div className="space-y-2 animate-in slide-in-from-top-1 duration-200">
                      <Input
                        placeholder={isSelectedTron ? "T... (Tron address)" : "0x... (EVM address)"}
                        value={manualTronAddress}
                        onChange={(e) => { 
                          setManualTronAddress(e.target.value.trim()); 
                          setManualTronError(""); 
                        }}
                        className="font-mono text-xs h-9"
                      />
                      {manualTronError && <p className="text-xs text-destructive">{manualTronError}</p>}
                    </div>
                  ) : walletAddrToUse ? (
                    <div className="flex items-center gap-2 p-2.5 rounded-md bg-primary/5 border border-primary/20 animate-in slide-in-from-top-1 duration-200">
                      <div className="w-2 h-2 rounded-full bg-primary shrink-0" />
                      <span className="text-[10px] font-mono truncate text-primary/80">
                        Funds will go to: {walletAddrToUse}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="p-3 rounded-md bg-muted/50 text-[11px] text-muted-foreground text-center border border-dashed">
                  Select a network below to configure your receiving wallet
                </div>
              )}
            </div>

            <FormField
              control={form.control}
              name="networkChainId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Network</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-network">
                        <SelectValue placeholder="Select a network" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">Mainnets</div>
                      {SUPPORTED_NETWORKS.filter((n) => n.type === "mainnet").map((net) => (
                        <SelectItem key={net.chainId} value={net.chainId} data-testid={`option-network-${net.chainId}`}>
                          {net.name} ({net.symbol})
                        </SelectItem>
                      ))}
                      <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground mt-1">Testnets</div>
                      {SUPPORTED_NETWORKS.filter((n) => n.type === "testnet").map((net) => (
                        <SelectItem key={net.chainId} value={net.chainId} data-testid={`option-network-${net.chainId}`}>
                          {net.name} ({net.symbol})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="tokenAddress"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Payment Token</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value} disabled={availableTokens.length === 0}>
                    <FormControl>
                      <SelectTrigger data-testid="select-token">
                        <SelectValue placeholder={availableTokens.length === 0 ? "Select a network first" : "Select token"} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {availableTokens.map((token) => (
                        <SelectItem key={token.address} value={token.address} data-testid={`option-token-${token.symbol}`}>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{token.symbol}</span>
                            <span className="text-muted-foreground text-xs">{token.name}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {field.value && (
                    <div className="mt-1 rounded-md border bg-muted/40 p-2">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-mono break-all leading-5">{field.value}</p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs shrink-0"
                          onClick={() => copyTokenAddress(field.value)}
                          data-testid="button-copy-token-address"
                        >
                          {copiedTokenAddress === field.value ? (
                            <>
                              <Check className="w-3 h-3 mr-1" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3 mr-1" />
                              Copy
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* ── Charge Frequency ── */}
            <div className="space-y-3 rounded-lg border p-3 bg-muted/30">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Repeat className="w-4 h-4" />
                Charge Frequency
              </div>

              {/* Amount */}
              <FormField
                control={form.control}
                name="intervalAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Amount per interval
                      {selectedTokenSymbol && (
                        <span className="ml-1 text-muted-foreground font-normal">({selectedTokenSymbol})</span>
                      )}
                    </FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Input
                          type="number"
                          step="any"
                          placeholder="10.00"
                          className="pr-16"
                          data-testid="input-interval-amount"
                          {...field}
                        />
                        {selectedTokenSymbol && (
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium pointer-events-none">
                            {selectedTokenSymbol}
                          </span>
                        )}
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Frequency presets */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Billing Interval</label>
                <div className="grid grid-cols-4 gap-1.5">
                  {FREQUENCY_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => {
                        setFrequencyPreset(preset.label);
                        if (preset.intervalValue !== null) {
                          form.setValue("intervalValue", preset.intervalValue, { shouldValidate: true });
                          form.setValue("intervalUnit", preset.intervalUnit!, { shouldValidate: true });
                        }
                      }}
                      className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                        frequencyPreset === preset.label
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background hover:bg-muted"
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom interval inputs */}
              {isCustomFrequency && (
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="intervalValue"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Every</FormLabel>
                        <FormControl>
                          <Input type="number" min="1" placeholder="1" data-testid="input-interval-value" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="intervalUnit"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Unit</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-interval-unit">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="sec">Seconds</SelectItem>
                            <SelectItem value="min">Minutes</SelectItem>
                            <SelectItem value="hrs">Hours</SelectItem>
                            <SelectItem value="days">Days</SelectItem>
                            <SelectItem value="months">Months</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              )}

              {/* Live summary */}
              {frequencySummary && (
                <div className="flex items-center gap-2 rounded-md bg-primary/10 border border-primary/20 px-3 py-2 text-xs text-primary font-medium">
                  <Repeat className="w-3.5 h-3.5 shrink-0" />
                  {frequencySummary}
                </div>
              )}
            </div>

            <FormField
              control={form.control}
              name="videoUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Video URL (optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="https://youtube.com/watch?v=... or direct video URL" data-testid="input-video-url" {...field} />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    Users will see this video after enabling auto-charge.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="p-3 rounded-md bg-blue-500/10 border border-blue-500/20 text-xs text-blue-700 dark:text-blue-300">
              Users will approve a one-time ERC-20 token allowance. After approval, recurring charges execute automatically without wallet popups.
            </div>

            <Button type="submit" className="w-full" disabled={mutation.isPending} data-testid="button-submit-plan">
              <Plus className="w-4 h-4 mr-2" />
              {mutation.isPending ? "Creating..." : "Create Plan"}
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
