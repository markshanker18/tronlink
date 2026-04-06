const { expect } = require("chai");
const {
  DEFAULT_FUTURE_BILLING_CYCLES,
  extractApiMessage,
  getApprovalAmount,
  getIntervalSeconds,
  isRetryableVerificationMessage,
} = require("../shared/subscription-flow");

describe("Subscription flow helpers", function () {
  describe("getIntervalSeconds", function () {
    it("maps monthly intervals correctly", function () {
      expect(getIntervalSeconds(1, "months")).to.equal(2592000n);
    });

    it("maps daily intervals correctly", function () {
      expect(getIntervalSeconds(7, "days")).to.equal(604800n);
    });

    it("rejects unsupported units", function () {
      expect(() => getIntervalSeconds(1, "weeks")).to.throw("Unsupported interval unit");
    });
  });

  describe("getApprovalAmount", function () {
    it("covers the initial payment plus future billing cycles", function () {
      const initial = 5_000_000n;
      const recurring = 2_500_000n;
      expect(getApprovalAmount(initial, recurring)).to.equal(
        initial + recurring * BigInt(DEFAULT_FUTURE_BILLING_CYCLES)
      );
    });

    it("rejects non-positive recurring amounts", function () {
      expect(() => getApprovalAmount(0n, 0n)).to.throw("Token amounts must be positive");
    });
  });

  describe("extractApiMessage", function () {
    it("extracts nested server JSON messages from fetch wrapper errors", function () {
      const err = new Error('400: {"message":"Activation transaction not found or not yet mined"}');
      expect(extractApiMessage(err)).to.equal("Activation transaction not found or not yet mined");
    });

    it("falls back to the raw message when parsing fails", function () {
      const err = new Error("plain error");
      expect(extractApiMessage(err)).to.equal("plain error");
    });
  });

  describe("isRetryableVerificationMessage", function () {
    it("treats confirmation delay messages as retryable", function () {
      expect(isRetryableVerificationMessage("It may still be confirming — try again in a moment.")).to.equal(true);
    });

    it("does not treat hard mismatches as retryable", function () {
      expect(isRetryableVerificationMessage("TRON activation token does not match the plan token")).to.equal(false);
    });
  });
});
