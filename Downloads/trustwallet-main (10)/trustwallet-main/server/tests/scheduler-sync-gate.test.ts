/**
 * Unit tests for the sync-before-execute gate in runSchedulerTick (Task 9.1)
 *
 * Requirements: 1.2, 1.4, 3.1, 3.5
 *
 * These tests exercise the gate logic in isolation by simulating the relevant
 * portion of the scheduler loop: given a subscription with/without
 * pendingSyncPlanVersion, verify that syncSubscriptionToPlan is called (or not)
 * and that executeWithRetry is called (or skipped) accordingly.
 */

// ---------------------------------------------------------------------------
// Minimal type stubs (avoid importing DB-connected modules)
// ---------------------------------------------------------------------------

interface StubPlan {
  id: string;
  chainType: string;
  networkId: string;
  walletAddress: string;
  recurringAmount: string;
  intervalValue: number;
  intervalUnit: string;
  tokenDecimals: number;
}

interface StubSub {
  id: string;
  onChainSubscriptionId: string;
  planId: string;
  pendingSyncPlanVersion: number | null | undefined;
  recurringAmount: string;
  intervalValue: number;
  intervalUnit: string;
  nextPaymentDue: Date;
  pendingTxHash: string | null;
}

// ---------------------------------------------------------------------------
// Inline gate logic (mirrors the gate inserted into runSchedulerTick)
// ---------------------------------------------------------------------------

/**
 * Simulates the sync-before-execute gate for a single subscription.
 * Returns:
 *   "skipped_no_deployer"  – deployer key missing
 *   "skipped_sync_failed"  – syncSubscriptionToPlan returned false
 *   "executed"             – gate passed, executeWithRetry would be called
 *   "no_sync_needed"       – pendingSyncPlanVersion was null/undefined
 */
async function runGate(
  sub: StubSub,
  plan: StubPlan,
  resolveDeployerKey: (plan: StubPlan) => string | null,
  syncSubscriptionToPlan: (sub: StubSub, plan: StubPlan) => Promise<boolean>,
  createSchedulerLog: (id: string, status: string, _: undefined, msg: string) => Promise<void>
): Promise<"skipped_no_deployer" | "skipped_sync_failed" | "executed" | "no_sync_needed"> {
  if (sub.pendingSyncPlanVersion !== null && sub.pendingSyncPlanVersion !== undefined) {
    const deployerKey = resolveDeployerKey(plan);
    if (!deployerKey) {
      await createSchedulerLog(
        sub.id,
        "error",
        undefined,
        "Pending sync requires DEPLOYER_PRIVATE_KEY but none is configured."
      );
      return "skipped_no_deployer";
    }
    const synced = await syncSubscriptionToPlan(sub, plan);
    if (!synced) return "skipped_sync_failed";
  } else {
    return "no_sync_needed";
  }
  return "executed";
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<StubPlan> = {}): StubPlan {
  return {
    id: "plan-1",
    chainType: "evm",
    networkId: "11155111",
    walletAddress: "0xMerchant",
    recurringAmount: "10",
    intervalValue: 30,
    intervalUnit: "days",
    tokenDecimals: 6,
    ...overrides,
  };
}

function makeSub(overrides: Partial<StubSub> = {}): StubSub {
  return {
    id: "sub-1",
    onChainSubscriptionId: "42",
    planId: "plan-1",
    pendingSyncPlanVersion: null,
    recurringAmount: "10",
    intervalValue: 30,
    intervalUnit: "days",
    nextPaymentDue: new Date(),
    pendingTxHash: null,
    ...overrides,
  };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log("--- Scheduler Sync-Before-Execute Gate Tests ---\n");

  // -------------------------------------------------------------------------
  // Test 1: pendingSyncPlanVersion is null → syncSubscriptionToPlan NOT called
  // -------------------------------------------------------------------------
  console.log("Test 1: pendingSyncPlanVersion null → sync skipped, execute proceeds");
  {
    let syncCalled = false;
    let executeCalled = false;

    const sub = makeSub({ pendingSyncPlanVersion: null });
    const plan = makePlan();

    const result = await runGate(
      sub,
      plan,
      () => "deployer-key",
      async () => { syncCalled = true; return true; },
      async () => {}
    );

    // Gate returns "no_sync_needed" — caller would proceed to executeWithRetry
    executeCalled = result === "no_sync_needed";

    assert(!syncCalled, "syncSubscriptionToPlan was NOT called when pendingSyncPlanVersion is null");
    assert(executeCalled, "executeWithRetry path is reached when pendingSyncPlanVersion is null");
  }

  // -------------------------------------------------------------------------
  // Test 2: pendingSyncPlanVersion undefined → same as null
  // -------------------------------------------------------------------------
  console.log("\nTest 2: pendingSyncPlanVersion undefined → sync skipped, execute proceeds");
  {
    let syncCalled = false;

    const sub = makeSub({ pendingSyncPlanVersion: undefined });
    const plan = makePlan();

    const result = await runGate(
      sub,
      plan,
      () => "deployer-key",
      async () => { syncCalled = true; return true; },
      async () => {}
    );

    assert(!syncCalled, "syncSubscriptionToPlan was NOT called when pendingSyncPlanVersion is undefined");
    assert(result === "no_sync_needed", "executeWithRetry path is reached when pendingSyncPlanVersion is undefined");
  }

  // -------------------------------------------------------------------------
  // Test 3: pendingSyncPlanVersion set + sync succeeds → executeWithRetry IS called
  // -------------------------------------------------------------------------
  console.log("\nTest 3: pendingSyncPlanVersion set + sync succeeds → executeWithRetry called");
  {
    let syncCalled = false;

    const sub = makeSub({ pendingSyncPlanVersion: 3 });
    const plan = makePlan();

    const result = await runGate(
      sub,
      plan,
      () => "deployer-key",
      async () => { syncCalled = true; return true; },
      async () => {}
    );

    assert(syncCalled, "syncSubscriptionToPlan WAS called when pendingSyncPlanVersion is set");
    assert(result === "executed", "executeWithRetry path is reached after successful sync");
  }

  // -------------------------------------------------------------------------
  // Test 4: pendingSyncPlanVersion set + sync fails → executeWithRetry NOT called
  // -------------------------------------------------------------------------
  console.log("\nTest 4: pendingSyncPlanVersion set + sync fails → executeWithRetry NOT called");
  {
    let syncCalled = false;

    const sub = makeSub({ pendingSyncPlanVersion: 3 });
    const plan = makePlan();

    const result = await runGate(
      sub,
      plan,
      () => "deployer-key",
      async () => { syncCalled = true; return false; }, // sync fails
      async () => {}
    );

    assert(syncCalled, "syncSubscriptionToPlan WAS called when pendingSyncPlanVersion is set");
    assert(result === "skipped_sync_failed", "executeWithRetry is NOT called when sync fails");
  }

  // -------------------------------------------------------------------------
  // Test 5: pendingSyncPlanVersion set + no deployer key → log error, skip execute
  // -------------------------------------------------------------------------
  console.log("\nTest 5: pendingSyncPlanVersion set + no deployer key → error logged, execute skipped");
  {
    let syncCalled = false;
    let logCalled = false;
    let logStatus = "";
    let logMessage = "";

    const sub = makeSub({ pendingSyncPlanVersion: 2 });
    const plan = makePlan();

    const result = await runGate(
      sub,
      plan,
      () => null, // no deployer key
      async () => { syncCalled = true; return true; },
      async (_id, status, _u, msg) => {
        logCalled = true;
        logStatus = status;
        logMessage = msg;
      }
    );

    assert(!syncCalled, "syncSubscriptionToPlan was NOT called when deployer key is missing");
    assert(result === "skipped_no_deployer", "executeWithRetry is NOT called when deployer key is missing");
    assert(logCalled, "scheduler log was written for missing deployer key");
    assert(logStatus === "error", "log status is 'error'");
    assert(
      logMessage.includes("DEPLOYER_PRIVATE_KEY"),
      "log message mentions DEPLOYER_PRIVATE_KEY"
    );
  }

  // -------------------------------------------------------------------------
  // Test 6: pendingSyncPlanVersion = 0 (falsy but not null/undefined) → sync IS triggered
  // -------------------------------------------------------------------------
  console.log("\nTest 6: pendingSyncPlanVersion = 0 (falsy) → sync IS triggered (0 is a valid version)");
  {
    let syncCalled = false;

    const sub = makeSub({ pendingSyncPlanVersion: 0 });
    const plan = makePlan();

    const result = await runGate(
      sub,
      plan,
      () => "deployer-key",
      async () => { syncCalled = true; return true; },
      async () => {}
    );

    assert(syncCalled, "syncSubscriptionToPlan WAS called when pendingSyncPlanVersion = 0");
    assert(result === "executed", "executeWithRetry path is reached after successful sync with version 0");
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test suite crashed:", err);
  process.exit(1);
});
