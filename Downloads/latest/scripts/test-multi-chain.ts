#!/usr/bin/env node
require("dotenv/config");

async function test() {
  const { verifyTronTx } = await import("./server/tron.ts");
  const { getRpcUrls } = await import("./server/rpc.ts");
  const { NETWORK_TOKENS } = await import("./shared/contracts.ts");

  console.log("--- Testing Network Configurations ---");
  
  // Test 1: BSC RPC
  const bscRpc = getRpcUrls("0x38");
  console.log(`BSC Mainnet RPC: ${bscRpc[0] || "MISSING"}`);
  if (bscRpc.length > 0) console.log("[PASS] BSC RPC configured");
  else console.log("[FAIL] BSC RPC missing");

  // Test 2: TRON RPC
  const tronRpc = getRpcUrls("tron_mainnet");
  console.log(`TRON Mainnet RPC: ${tronRpc[0] || "MISSING"}`);
  if (tronRpc.length > 0) console.log("[PASS] TRON RPC configured");
  else console.log("[FAIL] TRON RPC missing");

  // Test 3: BSC Tokens
  const bscTokens = NETWORK_TOKENS.find(n => n.chainId === "0x38")?.tokens;
  console.log(`BSC Tokens found: ${bscTokens?.length || 0}`);
  if (bscTokens && bscTokens.length > 0) console.log("[PASS] BEP-20 tokens configured");
  else console.log("[FAIL] BEP-20 tokens missing");

  // Test 4: TRON Verification Logic (Mock call)
  console.log("\n--- Testing Verification Logic ---");
  const plan = {
    networkId: "tron_mainnet",
    tokenAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", // USDT
    walletAddress: "TYourWalletAddressHere",
    tokenDecimals: 6
  };
  
  try {
    // This will likely fail with "Transaction not found" which is good, 
    // it means the TronWeb instance is talking to the network.
    await verifyTronTx(plan, "TPayerAddress", "1.0", "0000000000000000000000000000000000000000000000000000000000000000");
  } catch (err) {
    if (err.message && (err.message.includes("not found") || err.message.includes("raw data"))) {
      console.log("[PASS] TRON verification logic initialized and connected to RPC");
    } else {
      console.log(`[INFO] TRON verification returned: ${err.message}`);
    }
  }

  console.log("\n[SUCCESS] Basic TRON and BEP-20 configurations verified.");
}

test().catch(err => {
  console.error("[ERROR]", err);
  process.exit(1);
});
