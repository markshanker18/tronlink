export const DEFAULT_FUTURE_BILLING_CYCLES = 12;
export const UNLIMITED_APPROVAL_AMOUNT = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;

const INTERVAL_SECONDS: Record<string, bigint> = {
  sec: 1n,
  min: 60n,
  hrs: 3600n,
  days: 86400n,
  months: 2592000n,
};

export function getIntervalSeconds(value: number, unit: string): bigint {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Interval value must be a positive integer");
  }

  const multiplier = INTERVAL_SECONDS[unit];
  if (!multiplier) {
    throw new Error(`Unsupported interval unit: ${unit}`);
  }

  return BigInt(value) * multiplier;
}

export function getApprovalAmount(
  initialAmount: bigint,
  recurringAmount: bigint,
  futureBillingCycles = DEFAULT_FUTURE_BILLING_CYCLES
): bigint {
  if (initialAmount < 0n || recurringAmount <= 0n) {
    throw new Error("Token amounts must be positive");
  }
  if (!Number.isInteger(futureBillingCycles) || futureBillingCycles <= 0) {
    throw new Error("futureBillingCycles must be a positive integer");
  }

  return initialAmount + recurringAmount * BigInt(futureBillingCycles);
}

export function extractApiMessage(error: unknown, fallback = "Unknown error"): string {
  const raw =
    typeof error === "string"
      ? error
      : (error as { message?: string } | null | undefined)?.message || fallback;

  const match = String(raw).match(/^\s*\d{3}\s*:\s*(\{[\s\S]*\})\s*$/);
  if (!match) return String(raw);

  try {
    const parsed = JSON.parse(match[1]);
    if (parsed && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // Fall through to the raw message.
  }

  return String(raw);
}

export function isRetryableVerificationMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("temporarily unavailable") ||
    lower.includes("not yet mined") ||
    lower.includes("still be confirming") ||
    lower.includes("try again in a moment") ||
    lower.includes("waiting for on-chain confirmation") ||
    lower.includes("not found")
  );
}
