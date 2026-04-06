import { cn } from "@/lib/utils";

export function PaymentLoader({ className }: { className?: string }) {
  return (
    <div className={cn("payment-loader-wrap", className)} aria-hidden="true">
      <div className="payment-loader-box">
        <div className="payment-loader-bars">
          <div className="payment-loader-bar payment-loader-bar1" />
          <div className="payment-loader-bar payment-loader-bar2" />
          <div className="payment-loader-bar payment-loader-bar3" />
          <div className="payment-loader-bar payment-loader-bar4" />
        </div>
      </div>
    </div>
  );
}
