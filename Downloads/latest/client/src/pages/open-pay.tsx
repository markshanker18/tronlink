import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { detectWalletBrand, isMobile, openInMetaMaskMobile, openInTrustWalletMobile } from "@/lib/metamask";
import { AlertCircle, ArrowLeft, Copy, ExternalLink, Wallet } from "lucide-react";

function withWalletHint(pathOrUrl: string, brand: "trust" | "metamask"): string {
  try {
    const url = new URL(pathOrUrl, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    url.searchParams.set("wallet", brand);
    return url.toString();
  } catch {
    return pathOrUrl;
  }
}

export default function OpenPayPage() {
  const params = useParams<{ code: string }>();
  const [, navigate] = useLocation();

  const code = params.code;
  const payPath = code ? `/pay/${code}` : "/";

  const payUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}${payPath}`;
  }, [payPath]);
  const trustPayUrl = useMemo(() => withWalletHint(payUrl, "trust"), [payUrl]);
  const metamaskPayUrl = useMemo(() => withWalletHint(payUrl, "metamask"), [payUrl]);

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!code) return;

    if (typeof window.ethereum !== "undefined") {
      const detected = detectWalletBrand((window as any).ethereum);
      if (detected === "trust" || detected === "metamask") {
        const hinted = withWalletHint(`${window.location.origin}${payPath}`, detected);
        const url = new URL(hinted);
        navigate(`${url.pathname}${url.search}`, { replace: true });
        return;
      }
      navigate(payPath, { replace: true });
      return;
    }

    if (!isMobile()) {
      navigate(payPath, { replace: true });
      return;
    }
  }, [code, navigate, payPath]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(payUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="min-h-screen bg-[#101214] text-[#f3f5f7] flex justify-center">
      <div className="w-full max-w-[430px] min-h-screen px-4 pb-6 pt-4 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.06),rgba(255,255,255,0)_40%),linear-gradient(180deg,#15181D_0%,#111419_46%,#0F1116_100%)]">
        <header className="relative flex items-center justify-center py-2">
          <button
            type="button"
            onClick={() => navigate(payPath)}
            className="absolute left-0 top-1 inline-flex h-10 w-10 items-center justify-center rounded-full text-[#d8dbe1] hover:bg-white/5"
            data-testid="button-open-pay-back"
          >
            <ArrowLeft className="h-7 w-7" />
          </button>
          <h1 className="text-2xl font-semibold">Open in your wallet</h1>
          <div className="absolute right-0 top-1 h-10 w-10" />
        </header>

        <section className="mt-8 rounded-[20px] border border-[#2e6f4e] bg-[#143524] p-4">
          <div className="flex items-center gap-2 text-[#c7f6dd] font-semibold">
            <AlertCircle className="h-4 w-4" />
            Wallet not detected in this browser
          </div>
          <p className="mt-2 text-sm text-[#b6edcf]">
            Open this link inside Trust Wallet or MetaMask in-app browser to continue payment.
          </p>
        </section>

        <section className="mt-6 space-y-3">
          <button
            type="button"
            className="flex h-14 w-full items-center justify-center rounded-full bg-[#4bf58c] text-lg font-semibold text-[#112218] hover:bg-[#43e381]"
            onClick={() => openInTrustWalletMobile(trustPayUrl)}
            data-testid="button-open-trustwallet"
          >
            <Wallet className="mr-2 h-5 w-5" />
            Open Trust Wallet
          </button>

          <button
            type="button"
            className="flex h-14 w-full items-center justify-center rounded-full border border-[#3d434c] bg-[#1d2128] text-lg font-semibold text-[#eef1f4] hover:bg-[#232832]"
            onClick={() => openInMetaMaskMobile(metamaskPayUrl)}
            data-testid="button-open-metamask"
          >
            <Wallet className="mr-2 h-5 w-5" />
            Open MetaMask
          </button>

          <button
            type="button"
            className="flex h-14 w-full items-center justify-center rounded-full border border-[#3d434c] bg-[#1d2128] text-lg font-semibold text-[#eef1f4] hover:bg-[#232832]"
            onClick={copyLink}
            data-testid="button-copy-pay-link"
          >
            <Copy className="mr-2 h-5 w-5" />
            {copied ? "Copied" : "Copy link"}
          </button>

          <button
            type="button"
            className="flex h-14 w-full items-center justify-center rounded-full border border-transparent bg-transparent text-lg font-semibold text-[#c8ced8] hover:bg-white/5"
            onClick={() => navigate(payPath)}
            data-testid="button-continue-to-pay"
          >
            <ExternalLink className="mr-2 h-5 w-5" />
            Continue in browser
          </button>
        </section>

        <div className="mt-8 rounded-[16px] border border-[#3d434c] bg-[#151922] px-4 py-3">
          <p className="text-xs uppercase tracking-[0.12em] text-[#8f96a1]">Payment URL</p>
          <p className="mt-2 break-all font-mono text-sm text-[#dbe0e6]">{payUrl}</p>
        </div>
      </div>
    </div>
  );
}
