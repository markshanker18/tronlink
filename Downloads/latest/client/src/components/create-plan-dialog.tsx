import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { SUPPORTED_NETWORKS, isTronChainId } from "@/lib/metamask";
import { getTokensForNetwork, getTronTokensForNetwork, isTronNetwork, type TokenInfo } from "@shared/contracts";
import { isAllowedVideoUrl } from "@shared/video";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Coins, Copy, Check } from "lucide-react";

const createPlanSchema = z.object({
  planName: z.string().min(1, "Plan name is required"),
  networkChainId: z.string().min(1, "Network is required"),
  tokenAddress: z.string().min(1, "Token is required"),
  walletAddress: z.string().min(1, "Receiving wallet is required"),
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
  userWallets: any[];
}

export default function CreatePlanDialog({ open, onOpenChange, userWallets }: Props) {
  const { toast } = useToast();
  const [availableTokens, setAvailableTokens] = useState<TokenInfo[]>([]);
  const [copiedTokenAddress, setCopiedTokenAddress] = useState<string | null>(null);

  const form = useForm<CreatePlanInput>({
    resolver: zodResolver(createPlanSchema),
    defaultValues: {
      planName: "",
      networkChainId: "",
      tokenAddress: "",
      intervalAmount: "",
      intervalValue: "1",
      intervalUnit: "months",
      walletAddress: "",
      videoUrl: "",
    },
  });

  const selectedNetwork = form.watch("networkChainId");
  const isTron = selectedNetwork ? isTronNetwork(selectedNetwork) : false;

  const filteredWallets = userWallets.filter(w => {
    const addr = w.address || "";
    const isTronAddr = /^[Tt][a-zA-Z0-9]{33}$/.test(addr);
    return isTron ? isTronAddr : !isTronAddr;
  });

  useEffect(() => {
    if (selectedNetwork) {
      const tokens = isTron
        ? getTronTokensForNetwork(selectedNetwork)
        : getTokensForNetwork(selectedNetwork);
      setAvailableTokens(tokens);
      form.setValue("tokenAddress", "");
      
      // Auto-select default wallet for network if available
      const defaultForNet = filteredWallets.find(w => w.isDefault) || filteredWallets[0];
      if (defaultForNet) {
        form.setValue("walletAddress", defaultForNet.address);
      } else {
        form.setValue("walletAddress", "");
      }
    } else {
      setAvailableTokens([]);
    }
  }, [selectedNetwork, form, isTron]);

  const mutation = useMutation({
    mutationFn: async (data: CreatePlanInput) => {
      const network = SUPPORTED_NETWORKS.find((n) => n.chainId === data.networkChainId);
      if (!network) throw new Error("Invalid network");

      const token = availableTokens.find((t) => t.address === data.tokenAddress);
      if (!token) throw new Error("Invalid token");

      const res = await apiRequest("POST", "/api/plans", {
        planName: data.planName,
        walletAddress: data.walletAddress,
        networkId: network.chainId,
        networkName: network.name,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        intervalAmount: data.intervalAmount,
        intervalValue: parseInt(data.intervalValue),
        intervalUnit: data.intervalUnit,
        videoUrl: data.videoUrl || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plans"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      form.reset();
      onOpenChange(false);
    },
    onError: (e: Error) => {
      toast({ title: "Failed to create plan", description: e.message, variant: "destructive" });
    },
  });

  const onSubmit = (data: CreatePlanInput) => {
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
          <DialogTitle className="flex items-center gap-2">
            <Coins className="w-5 h-5" />
            Create Auto-charge
          </DialogTitle>
          <DialogDescription>
            Set up a recurring token auto-charge. Users approve once and charges execute automatically.
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

            <FormField
              control={form.control}
              name="walletAddress"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Receiving Wallet ({isTron ? "TRON" : "EVM"})</FormLabel>
                  {filteredWallets.length > 0 ? (
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select receiving wallet" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {filteredWallets.map((w) => (
                          <SelectItem key={w.id} value={w.address}>
                            {w.label || "Wallet"} ({w.address.slice(0, 6)}...{w.address.slice(-4)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20 text-xs text-destructive">
                      No {isTron ? "TRON" : "Ethereum/BSC"} wallet found. Please add one in Settings first.
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

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

            <FormField
              control={form.control}
              name="intervalAmount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount per interval ({availableTokens.find(t => t.address === form.getValues("tokenAddress"))?.symbol || "tokens"})</FormLabel>
                  <FormControl>
                    <Input type="number" step="any" placeholder="10.00" data-testid="input-interval-amount" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

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
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
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

            {isTronChainId(selectedNetwork) ? (
              <div className="p-3 rounded-md bg-purple-500/10 border border-purple-500/20 text-xs text-purple-700 dark:text-purple-300">
                TRC-20 token transfer on TRON network. Users will send tokens directly using TronLink wallet. No subscription contract needed.
              </div>
            ) : (
              <div className="p-3 rounded-md bg-blue-500/10 border border-blue-500/20 text-xs text-blue-700 dark:text-blue-300">
                Users will approve a one-time token allowance. After approval, recurring charges execute automatically without wallet popups.
              </div>
            )}

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
