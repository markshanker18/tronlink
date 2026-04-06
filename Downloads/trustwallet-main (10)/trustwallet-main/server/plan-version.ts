// Plan versioning — bump version and record snapshot when merchant changes billing terms.
// Preserves the history of billing terms for auditing and subscriber transparency.

import { storage } from "./storage";
import type { Plan } from "../shared/schema";

/**
 * Fields that constitute "billing terms" — changes to these bump the plan version.
 * Changes to display-only fields (planName, videoUrl) do NOT bump version.
 */
const BILLING_TERM_FIELDS: Array<keyof Plan> = [
  "recurringAmount",
  "intervalAmount",
  "intervalValue",
  "intervalUnit",
  "tokenAddress",
  "tokenSymbol",
  "tokenDecimals",
  "walletAddress",
];

/**
 * Bump plan version and record the old plan state as a snapshot.
 * Returns the new version number.
 * Call this BEFORE applying the plan update to capture the old state.
 */
export async function bumpPlanVersion(planId: string): Promise<number> {
  const plan = await storage.getPlanById(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);

  // Capture snapshot of current billing terms before the change
  const snapshot: Record<string, unknown> = {};
  for (const field of BILLING_TERM_FIELDS) {
    snapshot[field] = plan[field];
  }
  snapshot.planVersion = plan.planVersion ?? 1;
  snapshot.snapshotAt = new Date().toISOString();

  await storage.createPlanVersion(planId, snapshot);
  const newVersion = await storage.incrementPlanVersion(planId);
  return newVersion;
}

/**
 * Check whether a plan update touches billing terms that require a version bump.
 */
export function doesUpdateRequireBump(
  update: Partial<Pick<Plan, "recurringAmount" | "intervalAmount" | "intervalValue" | "intervalUnit" | "tokenAddress" | "walletAddress">>
): boolean {
  return BILLING_TERM_FIELDS.some((field) => field in update && update[field as keyof typeof update] !== undefined);
}
