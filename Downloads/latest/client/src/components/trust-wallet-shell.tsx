import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function TrustWalletBackdrop({
  children,
  maxWidthClass = "max-w-[420px]",
  className,
}: {
  children: ReactNode;
  maxWidthClass?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-h-screen relative overflow-hidden flex items-center justify-center px-4 py-8",
        className,
      )}
      style={{ background: "linear-gradient(135deg, #0A64BC 0%, #2D9FFF 45%, #0A64BC 100%)" }}
    >
      <div className="absolute inset-0">
        <div
          className="absolute -top-56 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full opacity-70"
          style={{ background: "radial-gradient(circle, rgba(255,255,255,0.30) 0%, transparent 70%)" }}
        />
        <div
          className="absolute top-40 -left-44 h-[520px] w-[520px] rotate-12 rounded-[90px] opacity-60"
          style={{ background: "radial-gradient(circle, rgba(255,255,255,0.16) 0%, transparent 68%)" }}
        />
        <div
          className="absolute -bottom-72 right-[-140px] h-[640px] w-[640px] -rotate-12 rounded-[110px] opacity-60"
          style={{ background: "radial-gradient(circle, rgba(0,0,0,0.12) 0%, transparent 70%)" }}
        />
      </div>

      <div className={cn("relative z-10 w-full", maxWidthClass)}>{children}</div>
    </div>
  );
}

export function TrustWalletSheet({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-3xl border border-white/25 bg-white/95 dark:bg-zinc-950/85 backdrop-blur-md shadow-[0_30px_80px_rgba(0,0,0,0.25)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
