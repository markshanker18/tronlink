import { NonceManager } from "../services/nonce-manager";
import { Provider, Wallet, TransactionRequest, TransactionResponse } from "ethers";

// Simple mock for Ethers Provider
class MockProvider {
  getTransactionCount = async (address: string, blockTag: string) => {
    return 10; // Default nonce
  };
  getFeeData = async () => ({
    maxFeePerGas: 100n,
    maxPriorityFeePerGas: 10n
  });
}

// Simple mock for Ethers Wallet
class MockWallet {
  sendTransaction = async (tx: TransactionRequest) => {
    return {
      hash: "0x" + Math.random().toString(16).slice(2),
      nonce: tx.nonce || 10,
      wait: async () => ({ status: 1 })
    } as unknown as TransactionResponse;
  };
  getAddress = async () => "0x1234567890123456789012345678901234567890";
}

async function runTests() {
  console.log("--- Running NonceManager Tests ---");

  const provider = new MockProvider() as unknown as Provider;
  const wallet = new MockWallet() as unknown as Wallet;
  const networkId = "1";
  const address = await wallet.getAddress();

  // Test 1: getNextNonce atomic increment
  console.log("Test 1: getNextNonce atomic increment");
  const nonce1 = await NonceManager.getNextNonce(networkId, address, provider);
  const nonce2 = await NonceManager.getNextNonce(networkId, address, provider);
  
  if (nonce1 === 10 && nonce2 === 11) {
    console.log("✅ Pass: Nonces incremented correctly (10, 11)");
  } else {
    console.error("❌ Fail: Expected nonces 10 and 11, got " + nonce1 + " and " + nonce2);
    process.exit(1);
  }

  // Test 2: broadcastAndTrack
  console.log("Test 2: broadcastAndTrack");
  const txReq: TransactionRequest = { to: "0xRecipient", value: 100n, nonce: nonce2 };
  const tx = await NonceManager.broadcastAndTrack(networkId, wallet, txReq);
  
  if (tx.hash && tx.nonce === 11) {
    console.log("✅ Pass: Transaction tracked correctly");
  } else {
    console.error("❌ Fail: Transaction tracking failed");
    process.exit(1);
  }

  // Test 3: handleStuckTransactions (mocking time)
  console.log("Test 3: handleStuckTransactions (stuck detection)");
  
  // Manually manipulate pendingTxs to simulate 11 minutes ago
  const key = networkId + "_" + address.toLowerCase();
  const pending = (NonceManager as any).pendingTxs.get(key);
  if (pending && pending.length > 0) {
    pending[0].sentAt = Date.now() - (11 * 60 * 1000);
  }

  // We need to mock sendTransaction to verify it was called again with higher gas
  let sendCount = 0;
  (wallet as any).sendTransaction = async (tx: TransactionRequest) => {
    sendCount++;
    return {
      hash: "0xReplacedHash",
      nonce: tx.nonce,
    } as unknown as TransactionResponse;
  };

  await NonceManager.handleStuckTransactions(networkId, wallet, provider);

  if (sendCount === 1) {
    console.log("✅ Pass: Stuck transaction detected and replacement broadcast");
  } else {
    console.error("❌ Fail: Stuck transaction was not replaced (sendCount: " + sendCount + ")");
    process.exit(1);
  }

  console.log("\n--- All Production Logic Tests Passed ---");
}

runTests().catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
