import crypto from "crypto";

// Logic extraction from WebhookWorker for pure unit testing
function generateSignature(payload: any, secret: string) {
  const payloadStr = JSON.stringify(payload);
  return crypto
    .createHmac("sha256", secret)
    .update(payloadStr)
    .digest("hex");
}

function calculateNextAttempt(attempts: number, baseDelayMs: number) {
  const backoffMs = baseDelayMs * Math.pow(2, attempts - 1);
  return new Date(Date.now() + backoffMs);
}

async function runWebhookTests() {
  console.log("--- Running Webhook Logic Tests ---");

  const secret = "test_merchant_secret";
  const payload = { event: "subscription.paid", id: "sub_123" };

  // Test 1: Signature Generation
  console.log("Test 1: HMAC-SHA256 Signature Generation");
  const sig1 = generateSignature(payload, secret);
  const sig2 = generateSignature(payload, secret);
  
  if (sig1 === sig2 && sig1.length === 64) {
    console.log("✅ Pass: Signature is deterministic and correct length");
  } else {
    console.error("❌ Fail: Signature mismatch or invalid format");
    process.exit(1);
  }

  // Verify signature manually
  const expectedSig = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
  if (sig1 === expectedSig) {
     console.log("✅ Pass: Signature matches manual HMAC calculation");
  } else {
     console.error("❌ Fail: Signature does not match manual calculation");
     process.exit(1);
  }

  // Test 2: Exponential Backoff Calculation
  console.log("Test 2: Exponential Backoff Calculation");
  const baseDelay = 60000; // 1 minute
  
  const attempt1 = calculateNextAttempt(1, baseDelay);
  const attempt2 = calculateNextAttempt(2, baseDelay);
  const attempt3 = calculateNextAttempt(3, baseDelay);

  const diff1 = attempt1.getTime() - Date.now();
  const diff2 = attempt2.getTime() - Date.now();
  const diff3 = attempt3.getTime() - Date.now();

  // Tolerance for execution time
  const tolerance = 1000;

  if (Math.abs(diff1 - 60000) < tolerance && 
      Math.abs(diff2 - 120000) < tolerance && 
      Math.abs(diff3 - 240000) < tolerance) {
    console.log("✅ Pass: Backoff intervals are correct (1m, 2m, 4m)");
  } else {
    console.error("❌ Fail: Backoff calculation incorrect. Diffs: " + diff1 + ", " + diff2 + ", " + diff3);
    process.exit(1);
  }

  console.log("\n--- Webhook Logic Tests Passed ---");
}

runWebhookTests().catch(err => {
  console.error("Webhook test suite failed:", err);
  process.exit(1);
});
