/**
 * Shared interval-to-time conversion utilities used by both the scheduler and routes.
 * Previously duplicated in server/scheduler.ts and server/routes.ts.
 */

const INTERVAL_MS_MULTIPLIERS: Record<string, number> = {
  sec: 1_000,
  min: 60 * 1_000,
  hrs: 3_600 * 1_000,
  days: 86_400 * 1_000,
  months: 2_592_000 * 1_000,
};

const INTERVAL_SEC_MULTIPLIERS: Record<string, number> = {
  sec: 1,
  min: 60,
  hrs: 3_600,
  days: 86_400,
  months: 2_592_000,
};

export const MIN_SUBSCRIPTION_INTERVAL_SECONDS = 60;

export function getIntervalMs(value: number, unit: string): number {
  return value * (INTERVAL_MS_MULTIPLIERS[unit] ?? 1_000);
}

export function getIntervalSeconds(value: number, unit: string): number {
  return value * (INTERVAL_SEC_MULTIPLIERS[unit] ?? 1);
}

export function hasMinimumSubscriptionInterval(value: number, unit: string): boolean {
  return getIntervalSeconds(value, unit) >= MIN_SUBSCRIPTION_INTERVAL_SECONDS;
}
