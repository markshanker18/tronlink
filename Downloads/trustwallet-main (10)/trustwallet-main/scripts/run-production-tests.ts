import { execSync } from "child_process";

const TESTS = [
  "server/tests/production-logic.test.ts",
  "server/tests/webhook-logic.test.ts"
];

console.log("🚀 Starting CryptoPay Production Logic Verification Suite...\n");

let failed = false;

for (const test of TESTS) {
  try {
    console.log(`\n📦 Running: ${test}`);
    execSync(`npx tsx ${test}`, { stdio: "inherit" });
    console.log(`✅ ${test} passed!`);
  } catch (e) {
    console.error(`\n❌ ${test} failed!`);
    failed = true;
  }
}

if (failed) {
  console.error("\n🔴 Some tests failed. Please check the logs above.");
  process.exit(1);
} else {
  console.log("\n✨ All production logic tests passed successfully!");
}
