import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type { Plan } from "@shared/schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, Check, ExternalLink, Clock, Download, Smartphone, Wifi } from "lucide-react";
import { getMetaMaskDappUrl, getTrustWalletDappUrl } from "@/lib/metamask";

/** Replace localhost with LAN IP if available so QR codes work on phones */
function toLanUrl(url: string, lanIp: string | null): string {
  if (!lanIp) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      parsed.hostname = lanIp;
      return parsed.toString();
    }
  } catch {
    // ignore invalid URLs
  }
  return url;
}

interface Props {
  plan: Plan;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function withWalletHint(url: string, wallet: "trust" | "metamask"): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("wallet", wallet);
    return parsed.toString();
  } catch {
    return url;
  }
}

const TRUST_SHIELD_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000000" d="M12 2l7 3v6c0 5-3.5 9.74-7 11-3.5-1.26-7-6-7-11V5l7-3z"/></svg>`
)}`;

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

async function generateTrustStyledQr(data: string): Promise<string> {
  try {
    const imported = await import("qr-code-styling");
    const QRCodeStylingCtor = (imported as any).default;
    if (!QRCodeStylingCtor) {
      return await generateDefaultQr(data);
    }

    const styled = new QRCodeStylingCtor({
      width: 280,
      height: 280,
      type: "canvas",
      data,
      image: TRUST_SHIELD_ICON,
      qrOptions: {
        errorCorrectionLevel: "H",
      },
      dotsOptions: {
        color: "#000000",
        type: "rounded",
      },
      cornersSquareOptions: {
        color: "#000000",
        type: "extra-rounded",
      },
      cornersDotOptions: {
        color: "#000000",
        type: "dot",
      },
      imageOptions: {
        hideBackgroundDots: true,
        imageSize: 0.22,
        margin: 8,
      },
      backgroundOptions: {
        color: "#ffffff",
      },
    });

    const raw = await styled.getRawData("png");
    if (raw instanceof Blob) {
      return await blobToDataUrl(raw);
    }

    return await generateDefaultQr(data);
  } catch {
    return await generateDefaultQr(data);
  }
}

export default function QRCodeDialog({ plan, open, onOpenChange }: Props) {
  const [qrDataUrls, setQrDataUrls] = useState<Record<string, string>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [lanIp, setLanIp] = useState<string | null>(null);

  // Fetch the server's LAN IP so QR codes work when scanned by phones on the same Wi-Fi
  useEffect(() => {
    if (open) {
      fetch("/api/local-ip")
        .then((r) => r.json())
        .then((data: { ip: string | null }) => setLanIp(data.ip ?? null))
        .catch(() => setLanIp(null));
    }
  }, [open]);

  // Build origin: prefer LAN IP for QR codes when on localhost
  const isLocalhost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  const qrOrigin =
    isLocalhost && lanIp
      ? `${window.location.protocol}//${lanIp}:${window.location.port}`
      : window.location.origin;

  const shareUrl = `${qrOrigin}/open/pay/${plan.planCode}`;
  const payUrl = `${qrOrigin}/pay/${plan.planCode}`;

  // Browser-visible links still use window.location.origin (works on the local machine)
  const browserShareUrl = `${window.location.origin}/open/pay/${plan.planCode}`;
  const browserPayUrl = `${window.location.origin}/pay/${plan.planCode}`;

  const trustPayUrl = withWalletHint(payUrl, "trust");
  const metamaskPayUrl = withWalletHint(payUrl, "metamask");

  const qrConfigs = useMemo(
    () =>
      [
        {
          key: "universal",
          label: "Universal QR",
          description: "Works with any scanner",
          url: shareUrl,
          openUrl: browserShareUrl,
          qrUrl: shareUrl,
        },
        {
          key: "trust",
          label: "Trust Wallet QR",
          description: "Opens directly in Trust Wallet",
          url: getTrustWalletDappUrl(trustPayUrl),
          openUrl: withWalletHint(browserPayUrl, "trust"),
          qrUrl: getTrustWalletDappUrl(trustPayUrl),
        },
        {
          key: "metamask",
          label: "MetaMask QR",
          description: "Opens directly in MetaMask",
          url: getMetaMaskDappUrl(metamaskPayUrl),
          openUrl: withWalletHint(browserPayUrl, "metamask"),
          qrUrl: getMetaMaskDappUrl(metamaskPayUrl),
        },
      ] as const,
    [shareUrl, trustPayUrl, metamaskPayUrl, browserShareUrl, browserPayUrl]
  );

  useEffect(() => {
    if (open) {
      let cancelled = false;

      const renderQrs = async () => {
        const entries = await Promise.all(
          qrConfigs.map(async (item) => {
            // Use qrUrl (LAN IP version) so phones on the same Wi-Fi can reach the server
            const dataUrl = item.key === "trust"
              ? await generateTrustStyledQr(item.qrUrl)
              : await generateDefaultQr(item.qrUrl);
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
              <DialogTitle>{plan.planName}</DialogTitle>
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

              {isLocalhost && lanIp && (
                <div className="w-full p-3 rounded-md bg-green-500/10 border border-green-500/20 text-xs space-y-1.5">
                  <div className="flex items-center gap-1.5 font-medium text-green-700 dark:text-green-300">
                    <Wifi className="w-3.5 h-3.5" />
                    Phone-ready QR codes
                  </div>
                  <p className="text-muted-foreground leading-relaxed">
                    QR codes point to <strong className="font-mono">{lanIp}</strong> — phones on the same Wi-Fi network can scan and open this payment page directly.
                  </p>
                </div>
              )}

              <div className="w-full p-3 rounded-md bg-blue-500/10 border border-blue-500/20 text-xs space-y-1.5" data-testid="qr-scan-instructions">
                <div className="flex items-center gap-1.5 font-medium text-blue-700 dark:text-blue-300">
                  <Smartphone className="w-3.5 h-3.5" />
                  How to scan
                </div>
                <p className="text-muted-foreground leading-relaxed">
                  Use <strong>Universal QR</strong> for general sharing, or scan <strong>Trust Wallet QR</strong> / <strong>MetaMask QR</strong>
                  to jump directly into that wallet app flow.
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
