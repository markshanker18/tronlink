export function TrustWalletLogo({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <img
      src="/trust-wallet-icon.svg"
      width={size}
      height={size}
      alt="Trust Wallet"
      className={className}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}

export function TrustWalletLogoText({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <TrustWalletLogo size={size} />
      <span className="font-bold text-foreground" style={{ fontSize: size * 0.55 }}>
        Trust Wallet
      </span>
    </div>
  );
}
