const { expect } = require("chai");
const { signQrPayload, verifyQrPayloadSignature, verifyQrPayload } = require("../server/qr-signing");

// Set a stable signing secret for tests
process.env.QR_SIGNING_SECRET = "test-qr-signing-secret-for-unit-tests";

function makeFakePlan(overrides = {}) {
  return {
    id: "plan-test-id",
    planCode: "TEST123",
    planVersion: 1,
    planName: "Test Plan",
    walletAddress: "0xdeadbeef",
    networkId: "0xaa36a7",
    tokenAddress: "0xtoken",
    tokenSymbol: "USDT",
    tokenDecimals: 6,
    intervalAmount: "10",
    recurringAmount: "10",
    intervalValue: 1,
    intervalUnit: "months",
    ...overrides,
  };
}

describe("QR Signing (server/qr-signing.ts)", function () {
  // ── signQrPayload ────────────────────────────────────────────────────────────
  describe("signQrPayload", function () {
    it("returns a payload with all required fields", function () {
      const plan = makeFakePlan();
      const payload = signQrPayload(plan);

      expect(payload).to.have.property("v", 1);
      expect(payload).to.have.property("planId", plan.id);
      expect(payload).to.have.property("planVersion", plan.planVersion);
      expect(payload).to.have.property("planCode", plan.planCode);
      expect(payload).to.have.property("nonce").that.is.a("string").with.length(64); // 32 bytes hex
      expect(payload).to.have.property("issuedAt").that.is.a("number");
      expect(payload).to.have.property("expiresAt").that.is.a("number");
      expect(payload).to.have.property("sig").that.is.a("string").with.length(64);
    });

    it("sets expiresAt in the future", function () {
      const plan = makeFakePlan();
      const payload = signQrPayload(plan);
      const nowSec = Math.floor(Date.now() / 1000);
      expect(payload.expiresAt).to.be.greaterThan(nowSec);
    });

    it("generates a unique nonce each call", function () {
      const plan = makeFakePlan();
      const p1 = signQrPayload(plan);
      const p2 = signQrPayload(plan);
      expect(p1.nonce).to.not.equal(p2.nonce);
    });
  });

  // ── verifyQrPayloadSignature ─────────────────────────────────────────────────
  describe("verifyQrPayloadSignature", function () {
    it("accepts a valid payload", function () {
      const plan = makeFakePlan();
      const payload = signQrPayload(plan);
      expect(() => verifyQrPayloadSignature(payload)).to.not.throw();
    });

    it("rejects a tampered signature", function () {
      const plan = makeFakePlan();
      const payload = signQrPayload(plan);
      const tampered = { ...payload, sig: "a".repeat(64) };
      expect(() => verifyQrPayloadSignature(tampered)).to.throw(/invalid qr signature/i);
    });

    it("rejects a payload with modified planId", function () {
      const plan = makeFakePlan();
      const payload = signQrPayload(plan);
      const tampered = { ...payload, planId: "evil-plan" };
      expect(() => verifyQrPayloadSignature(tampered)).to.throw(/invalid qr signature/i);
    });

    it("rejects an expired payload", function () {
      const plan = makeFakePlan();
      const payload = signQrPayload(plan);
      // Re-sign with past expiresAt by manipulating the env-based sig — use a manually constructed expired payload
      const expiredFields = {
        v: payload.v,
        planId: payload.planId,
        planVersion: payload.planVersion,
        planCode: payload.planCode,
        nonce: payload.nonce,
        issuedAt: payload.issuedAt - 7200,
        expiresAt: payload.issuedAt - 3600, // already expired
      };
      const expiredPayload = { ...expiredFields, sig: payload.sig };
      // sig won't match because expiresAt changed — but we want to test the expiry check,
      // so sign it fresh with a fabricated past expiry
      const { createHmac } = require("crypto");
      const sorted = Object.fromEntries(Object.entries(expiredFields).sort(([a], [b]) => a.localeCompare(b)));
      const sig = createHmac("sha256", process.env.QR_SIGNING_SECRET).update(JSON.stringify(sorted)).digest("hex");
      const freshExpiredPayload = { ...expiredFields, sig };
      expect(() => verifyQrPayloadSignature(freshExpiredPayload)).to.throw(/expired/i);
    });

    it("rejects unsupported payload version", function () {
      const plan = makeFakePlan();
      const payload = signQrPayload(plan);
      const { createHmac } = require("crypto");
      const badFields = {
        v: 99,
        planId: payload.planId,
        planVersion: payload.planVersion,
        planCode: payload.planCode,
        nonce: payload.nonce,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
      };
      const sorted = Object.fromEntries(Object.entries(badFields).sort(([a], [b]) => a.localeCompare(b)));
      const sig = createHmac("sha256", process.env.QR_SIGNING_SECRET).update(JSON.stringify(sorted)).digest("hex");
      const badVersionPayload = { ...badFields, sig };
      expect(() => verifyQrPayloadSignature(badVersionPayload)).to.throw(/unsupported.*version/i);
    });
  });

  // ── verifyQrPayload (nonce replay) ───────────────────────────────────────────
  describe("verifyQrPayload nonce replay protection", function () {
    it("accepts first use and records nonce", async function () {
      const plan = makeFakePlan();
      const payload = signQrPayload(plan);
      const usedNonces = new Set();

      await verifyQrPayload(
        payload,
        async (nonce, planId, expiresAt) => { usedNonces.add(nonce); },
        async (nonce) => usedNonces.has(nonce)
      );
      expect(usedNonces.has(payload.nonce)).to.equal(true);
    });

    it("rejects replay of a used nonce", async function () {
      const plan = makeFakePlan();
      const payload = signQrPayload(plan);
      const usedNonces = new Set([payload.nonce]);

      try {
        await verifyQrPayload(
          payload,
          async () => {},
          async (nonce) => usedNonces.has(nonce)
        );
        expect.fail("Expected rejection but did not throw");
      } catch (err) {
        expect(String(err.message)).to.match(/already used|nonce/i);
      }
    });
  });
});
