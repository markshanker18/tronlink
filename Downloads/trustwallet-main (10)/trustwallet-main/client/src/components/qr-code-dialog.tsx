import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type { Plan } from "@shared/schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, Check, ExternalLink, Clock, Download, Smartphone } from "lucide-react";
import { getMetaMaskDappUrl } from "@/lib/metamask";
import { getTronLinkDappUrl } from "@/lib/tronlink";

interface Props {
  plan: Plan;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function withWalletHint(url: string, wallet: "metamask"): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("wallet", wallet);
    return parsed.toString();
  } catch {
    return url;
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function generateDefaultQr(data: string): Promise<string> {
  return await QRCode.toDataURL(data, {
    width: 280,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });
}

export default function QRCodeDialog({ plan, open, onOpenChange }: Props) {
  const [qrDataUrls, setQrDataUrls] = useState<Record<string, string>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [signedPayload, setSignedPayload] = useState<string | null>(null);

  const isTron = (plan as any).chainType === "tron";
  const planVersion = (plan as any).planVersion as number | undefined;

  const payUrl = `${window.location.origin}/pay/${plan.planCode}`;

  const metamaskPayUrl = withWalletHint(payUrl, "metamask");
  const tronLinkPayUrl = getTronLinkDappUrl(payUrl);

  // Build signed QR URL when available
  const signedPayUrl = useMemo(() => {
    if (!signedPayload) return payUrl;
    try {
      const url = new URL(payUrl);
      url.searchParams.set("qr", signedPayload);
      return url.toString();
    } catch {
      return payUrl;
    }
  }, [payUrl, signedPayload]);

  // Fetch signed QR payload from server
  useEffect(() => {
    if (!open) return;
    fetch(`/api/plans/${plan.id}/signed-qr`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) setSignedPayload(JSON.stringify(data));
      })
      .catch(() => {});
  }, [open, plan.id]);

  const qrConfigs = useMemo(() => {
    const base = [
      {
        key: "universal",
        label: "Universal QR",
        description: "Works with any scanner",
        url: signedPayUrl,
        openUrl: signedPayUrl,
      }
    ];

    if (isTron) {
      return [
        ...base,
        {
          key: "tronlink",
          label: "TronLink QR",
          description: "Opens directly in TronLink (Recommended)",
          url: tronLinkPayUrl,
          openUrl: payUrl,
        },
      ] as const;
    }
    return [
      ...base,
      {
        key: "metamask",
        label: "MetaMask QR",
        description: "Opens directly in MetaMask (Recommended)",
        url: getMetaMaskDappUrl(metamaskPayUrl),
        openUrl: metamaskPayUrl,
      },
    ] as const;
  }, [isTron, signedPayUrl, metamaskPayUrl, tronLinkPayUrl, payUrl]);

  useEffect(() => {
    if (open) {
      let cancelled = false;

      const renderQrs = async () => {
        const entries = await Promise.all(
          qrConfigs.map(async (item) => {
            const dataUrl = await generateDefaultQr(item.url);
            return [item.key, dataUrl] as const;
          })
        );

        if (!cancelled) {
          setQrDataUrls(Object.fromEntries(entries));
        }
      };

      renderQrs();
      return () => {
        cancelled = true;
      };
    }
  }, [open, qrConfigs]);

  const copyLink = (key: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const downloadQR = (key: string, label: string) => {
    const dataUrl = qrDataUrls[key];
    if (!dataUrl) return;
    const link = document.createElement("a");
    const safePlan = plan.planName.replace(/\s+/g, "-").toLowerCase();
    const safeLabel = label.replace(/\s+/g, "-").toLowerCase();
    link.download = `${safePlan}-${safeLabel}-qr.png`;
    link.href = dataUrl;
    link.click();
  };

  const getIntervalLabel = (value: number, unit: string) => {
    const labels: Record<string, string> = { sec: "second", min: "minute", hrs: "hour", days: "day", months: "month" };
    const label = labels[unit] || unit;
    return value === 1 ? `Every ${label}` : `Every ${value} ${label}s`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="left-0 top-0 h-screen w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0 p-0 sm:rounded-none">
        <div className="h-full overflow-y-auto bg-background px-4 py-6 sm:px-6">
          <div className="mx-auto max-w-5xl">
            <DialogHeader className="pr-10">
              <DialogTitle className="flex items-center gap-2">
                {plan.planName}
                {planVersion && planVersion > 1 && (
                  <Badge variant="secondary" className="text-xs">v{planVersion}</Badge>
                )}
                {isTron && (
                  <Badge variant="outline" className="text-xs text-red-400 border-red-400/30">TRON</Badge>
                )}
              </DialogTitle>
              <DialogDescription>
                Share this QR code or link with your customers to collect recurring payments
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 flex flex-col items-center gap-4">
              <div className="w-full grid gap-4 lg:grid-cols-3">
                {qrConfigs.map((item) => (
                  <div key={item.key} className="rounded-lg border bg-card p-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">{item.label}</p>
                        <p className="text-xs text-muted-foreground">{item.description}</p>
                      </div>
                    </div>

                    {qrDataUrls[item.key] && (
                      <div
                        className="mx-auto w-fit p-4 bg-white rounded-md"
                        data-testid={item.key === "universal" ? "qr-code-image" : `qr-code-image-${item.key}`}
                      >
                        <img src={qrDataUrls[item.key]} alt={`${item.label} QR Code`} className="w-56 h-56" />
                      </div>
                    )}

                    <div className="flex items-center gap-2">
                      <div className="flex-1 p-2.5 rounded-md bg-muted text-xs font-mono truncate">
                        {item.openUrl}
                      </div>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => copyLink(item.key, item.openUrl)}
                        data-testid={item.key === "universal" ? "button-copy-link" : `button-copy-link-${item.key}`}
                      >
                        {copiedKey === item.key ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                      </Button>
                    </div>

                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => downloadQR(item.key, item.label)}
                        data-testid={item.key === "universal" ? "button-download-qr" : `button-download-qr-${item.key}`}
                      >
                        <Download className="w-4 h-4 mr-2" />
                        Download
                      </Button>
                      <Button variant="outline" className="flex-1" asChild>
                        <a
                          href={item.openUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid={item.key === "universal" ? "link-open-payment" : `link-open-payment-${item.key}`}
                        >
                          <ExternalLink className="w-4 h-4 mr-2" />
                          Open
                        </a>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="w-full p-3 rounded-md bg-blue-500/10 border border-blue-500/20 text-xs space-y-1.5" data-testid="qr-scan-instructions">
                <div className="flex items-center gap-1.5 font-medium text-blue-700 dark:text-blue-300">
                  <Smartphone className="w-3.5 h-3.5" />
                  How to scan
                </div>
                <p className="text-muted-foreground leading-relaxed">
                  {isTron ? (
                    <>
                      Use <strong>Universal QR</strong> for general sharing, or scan <strong>TronLink QR</strong>
                      to jump directly into a supported TRON wallet flow.
                    </>
                  ) : (
                    <>
                      Use <strong>Universal QR</strong> for general sharing, or scan <strong>MetaMask QR</strong>
                      to jump directly into the MetaMask wallet app flow.
                    </>
                  )}
                </p>
              </div>

              <div className="w-full space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold tabular-nums">{plan.intervalAmount}</span>
                    <span className="text-sm text-muted-foreground">{plan.tokenSymbol || "ETH"}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Clock className="w-3.5 h-3.5" />
                    {getIntervalLabel(plan.intervalValue, plan.intervalUnit)}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Badge variant="outline">{plan.networkName}</Badge>
                  {plan.tokenSymbol && <Badge variant="secondary">{plan.tokenSymbol}</Badge>}
                </div>

                <div className="text-[11px] text-muted-foreground leading-relaxed">
                  Direct link (if already inside a wallet browser): <span className="font-mono">{payUrl}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
