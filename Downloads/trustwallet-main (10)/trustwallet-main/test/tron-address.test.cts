const { expect } = require("chai");
const {
  detectChainType,
  isValidAddress,
  normalizeAddress,
} = require("../shared/chain");

describe("TRON Address Utilities (shared/chain.ts)", function () {
  // ── detectChainType ──────────────────────────────────────────────────────────
  describe("detectChainType", function () {
    it("returns 'tron' for TRON mainnet chain ID", function () {
      expect(detectChainType("0x2b6653dc")).to.equal("tron");
    });

    it("returns 'tron' for TRON Nile testnet chain ID", function () {
      expect(detectChainType("0xcd8690dc")).to.equal("tron");
    });

    it("returns 'evm' for Ethereum mainnet", function () {
      expect(detectChainType("0x1")).to.equal("evm");
    });

    it("returns 'evm' for Sepolia testnet", function () {
      expect(detectChainType("0xaa36a7")).to.equal("evm");
    });

    it("returns 'evm' for Polygon", function () {
      expect(detectChainType("0x89")).to.equal("evm");
    });

    it("returns 'evm' for unknown chain IDs", function () {
      expect(detectChainType("0xdeadbeef")).to.equal("evm");
    });

    it("handles empty string gracefully", function () {
      expect(detectChainType("")).to.equal("evm");
    });
  });

  // ── isValidAddress ───────────────────────────────────────────────────────────
  describe("isValidAddress", function () {
    const VALID_EVM = "0xAbCdEf0123456789aBcDeF0123456789AbCdEF01";
    const VALID_TRON = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";

    it("accepts a valid EVM address for evm chain type", function () {
      expect(isValidAddress(VALID_EVM, "evm")).to.equal(true);
    });

    it("rejects a TRON address for evm chain type", function () {
      expect(isValidAddress(VALID_TRON, "evm")).to.equal(false);
    });

    it("accepts a valid TRON address for tron chain type", function () {
      expect(isValidAddress(VALID_TRON, "tron")).to.equal(true);
    });

    it("rejects an EVM address for tron chain type", function () {
      expect(isValidAddress(VALID_EVM, "tron")).to.equal(false);
    });

    it("rejects empty string for both chain types", function () {
      expect(isValidAddress("", "evm")).to.equal(false);
      expect(isValidAddress("", "tron")).to.equal(false);
    });

    it("rejects TRON address shorter than 34 chars", function () {
      expect(isValidAddress("TShortAddr", "tron")).to.equal(false);
    });

    it("rejects EVM address without 0x prefix", function () {
      expect(isValidAddress("AbCdEf0123456789aBcDeF0123456789AbCdEF01", "evm")).to.equal(false);
    });

    it("rejects TRON address starting with 0x", function () {
      expect(isValidAddress("0xAbCdEf0123456789aBcDeF0123456789AbCdEF01", "tron")).to.equal(false);
    });
  });

  // ── normalizeAddress ─────────────────────────────────────────────────────────
  describe("normalizeAddress", function () {
    it("lowercases EVM addresses", function () {
      const addr = "0xAbCdEf0123456789aBcDeF0123456789AbCdEF01";
      expect(normalizeAddress(addr, "evm")).to.equal(addr.toLowerCase());
    });

    it("preserves TRON address case exactly", function () {
      const addr = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
      expect(normalizeAddress(addr, "tron")).to.equal(addr);
    });

    it("does not lowercase TRON addresses", function () {
      const addr = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
      const lower = addr.toLowerCase();
      expect(normalizeAddress(addr, "tron")).to.not.equal(lower);
    });

    it("handles empty string without throwing", function () {
      expect(normalizeAddress("", "evm")).to.equal("");
      expect(normalizeAddress("", "tron")).to.equal("");
    });
  });
});
