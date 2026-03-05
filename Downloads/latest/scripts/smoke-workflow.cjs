#!/usr/bin/env node
/* eslint-disable no-console */

const { createServer } = require("node:http");

async function main() {
  // Load env first (DATABASE_URL, SESSION_SECRET, etc.).
  require("dotenv/config");

  const { createApp } = await import("../server/app.ts");
  const { storage } = await import("../server/storage.ts");
  const { db } = await import("../server/db.ts");
  const { users, plans, subscriptions, schedulerLogs, wallets } = await import("../shared/schema.ts");
  const { eq, inArray } = await import("drizzle-orm");

  const createdUserIds = [];
  const createdPlanIds = [];
  const createdSubIds = [];
  let httpServer = null;

  class CookieClient {
    constructor(baseUrl) {
      this.baseUrl = baseUrl;
      this.cookies = new Map();
    }

    _applySetCookie(response) {
      const setCookies =
        typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie()
          : (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);

      for (const raw of setCookies) {
        if (!raw) continue;
        const first = raw.split(";")[0];
        const idx = first.indexOf("=");
        if (idx <= 0) continue;
        const name = first.slice(0, idx).trim();
        const value = first.slice(idx + 1).trim();
        if (!name) continue;
        this.cookies.set(name, value);
      }
    }

    _cookieHeader() {
      if (this.cookies.size === 0) return undefined;
      return Array.from(this.cookies.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    }

    async request(method, path, body) {
      const headers = {};
      const cookie = this._cookieHeader();
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers["content-type"] = "application/json";

      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      this._applySetCookie(res);

      let json = null;
      let text = "";
      try {
        text = await res.text();
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { res, json, text };
    }
  }

  function expectStatus(label, actual, expected) {
    if (actual !== expected) {
      throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
    console.log(`[PASS] ${label} (${actual})`);
  }

  function expectTruthy(label, value) {
    if (!value) throw new Error(`${label}: expected truthy value`);
    console.log(`[PASS] ${label}`);
  }

  try {
    const app = await createApp();
    httpServer = createServer(app);

    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });

    const addr = httpServer.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Could not resolve local test server address");
    }
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    console.log(`[INFO] Smoke server started at ${baseUrl}`);

    const anon = new CookieClient(baseUrl);
    const owner = new CookieClient(baseUrl);
    const other = new CookieClient(baseUrl);

    const suffix = Date.now().toString(36);
    const ownerUsername = `smoke_owner_${suffix}`;
    const otherUsername = `smoke_other_${suffix}`;
    const password = "smokePass123";

    const ownerReg = await owner.request("POST", "/api/auth/register", {
      username: ownerUsername,
      password,
    });
    expectStatus("Register owner", ownerReg.res.status, 200);
    expectTruthy("Owner id exists", ownerReg.json && ownerReg.json.id);
    createdUserIds.push(ownerReg.json.id);

    const otherReg = await other.request("POST", "/api/auth/register", {
      username: otherUsername,
      password,
    });
    expectStatus("Register second user", otherReg.res.status, 200);
    expectTruthy("Second user id exists", otherReg.json && otherReg.json.id);
    createdUserIds.push(otherReg.json.id);

    const createPlan = await owner.request("POST", "/api/plans", {
      planName: `Smoke Plan ${suffix}`,
      walletAddress: "0x1111111111111111111111111111111111111111",
      networkId: "0xaa36a7",
      networkName: "Sepolia Testnet",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      intervalAmount: "1",
      intervalValue: 1,
      intervalUnit: "days",
    });
    expectStatus("Create plan", createPlan.res.status, 200);
    expectTruthy("Plan id exists", createPlan.json && createPlan.json.id);
    const planId = createPlan.json.id;
    createdPlanIds.push(planId);

    const ownerGetPlan = await owner.request("GET", `/api/plans/${planId}`);
    expectStatus("Owner can read /api/plans/:id", ownerGetPlan.res.status, 200);

    const otherGetPlan = await other.request("GET", `/api/plans/${planId}`);
    expectStatus("Non-owner blocked from /api/plans/:id", otherGetPlan.res.status, 404);

    const anonGetPlan = await anon.request("GET", `/api/plans/${planId}`);
    expectStatus("Anonymous blocked from /api/plans/:id", anonGetPlan.res.status, 401);

    const badPayerCheck = await anon.request(
      "GET",
      `/api/subscriptions/check/${planId}/not-a-wallet-address`
    );
    expectStatus("Invalid payer address rejected in /check", badPayerCheck.res.status, 400);

    const payerAddress = "0x3333333333333333333333333333333333333333";
    const seeded = await storage.createSubscription({
      planId,
      payerAddress,
      firstPaymentAmount: "1",
      firstPaymentTxHash: `0x${"a".repeat(64)}`,
      approvalTxHash: `0x${"b".repeat(64)}`,
      approvedAmount: "12000000",
      onChainSubscriptionId: "42",
    });
    createdSubIds.push(seeded.id);
    expectTruthy("Seeded subscription id exists", seeded.id);

    const publicCheck = await anon.request(
      "GET",
      `/api/subscriptions/check/${planId}/${payerAddress}`
    );
    expectStatus("Public /check returns existing subscription", publicCheck.res.status, 200);
    expectTruthy("Public /check payload has id", publicCheck.json && publicCheck.json.id);

    const badTxHash = await owner.request("POST", `/api/subscriptions/${seeded.id}/tx`, {
      txHash: "0x1234",
    });
    expectStatus("Bad tx hash rejected in /:id/tx", badTxHash.res.status, 400);

    const txMismatch = await owner.request("POST", `/api/subscriptions/${seeded.id}/tx`, {
      txHash: `0x${"c".repeat(64)}`,
      payerAddress: "0x4444444444444444444444444444444444444444",
    });
    expectStatus("Mismatched payer rejected in /:id/tx", txMismatch.res.status, 400);

    const txVerify = await owner.request("POST", `/api/subscriptions/${seeded.id}/tx`, {
      txHash: `0x${"d".repeat(64)}`,
      payerAddress,
    });
    if (txVerify.res.status !== 400 && txVerify.res.status !== 503) {
      throw new Error(
        `Execution tx should be verified and fail safely (400/503), got ${txVerify.res.status}`
      );
    }
    console.log(
      `[PASS] /api/subscriptions/:id/tx enforces on-chain verification (${txVerify.res.status})`
    );

    console.log("\n[OK] Smoke workflow checks passed.");
  } finally {
    // Best-effort cleanup to avoid DB pollution.
    try {
      if (createdSubIds.length > 0) {
        await db.delete(schedulerLogs).where(inArray(schedulerLogs.subscriptionId, createdSubIds));
        await db.delete(subscriptions).where(inArray(subscriptions.id, createdSubIds));
      }
      if (createdPlanIds.length > 0) {
        await db.delete(plans).where(inArray(plans.id, createdPlanIds));
      }
      if (createdUserIds.length > 0) {
        for (const userId of createdUserIds) {
          await db.delete(wallets).where(eq(wallets.userId, userId));
          await db.delete(users).where(eq(users.id, userId));
        }
      }
    } catch (cleanupErr) {
      console.warn("[WARN] Cleanup failed:", cleanupErr && cleanupErr.message ? cleanupErr.message : cleanupErr);
    }

    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
  }
}

main().catch((err) => {
  console.error("[FAIL] Smoke workflow failed:", err && err.message ? err.message : err);
  process.exit(1);
});
