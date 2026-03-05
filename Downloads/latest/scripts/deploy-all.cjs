const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const NETWORKS = [
  "ethereum",
  "polygon",
  "bsc",
  "avalanche",
  "arbitrum",
  "optimism",
  "base",
  "fantom",
];

const TESTNETS = ["sepolia", "goerli"];

async function main() {
  const args = process.argv.slice(2);
  const deployTestnets = args.includes("--testnets");
  const deployMainnets = args.includes("--mainnets");
  const deployAll = args.includes("--all");
  const specificNetwork = args.find((a) => !a.startsWith("--"));

  let targetNetworks = [];

  if (specificNetwork) {
    targetNetworks = [specificNetwork];
  } else if (deployAll) {
    targetNetworks = [...TESTNETS, ...NETWORKS];
  } else if (deployTestnets) {
    targetNetworks = TESTNETS;
  } else if (deployMainnets) {
    targetNetworks = NETWORKS;
  } else {
    console.log("Usage:");
    console.log("  npx hardhat run scripts/deploy-all.cjs -- --testnets     Deploy to all testnets");
    console.log("  npx hardhat run scripts/deploy-all.cjs -- --mainnets     Deploy to all mainnets");
    console.log("  npx hardhat run scripts/deploy-all.cjs -- --all          Deploy everywhere");
    console.log("  npx hardhat run scripts/deploy-all.cjs -- sepolia        Deploy to specific network");
    process.exit(0);
  }

  console.log(`\nDeploying to ${targetNetworks.length} network(s): ${targetNetworks.join(", ")}\n`);

  const results = [];

  for (const net of targetNetworks) {
    console.log(`\n--- Deploying to ${net} ---`);
    try {
      execSync(`TS_NODE_PROJECT=tsconfig.hardhat.json npx hardhat run scripts/deploy.cjs --network ${net}`, {
        stdio: "inherit",
        cwd: path.join(__dirname, ".."),
      });

      const deploymentFile = path.join(__dirname, "..", "deployments", `${net}.json`);
      if (fs.existsSync(deploymentFile)) {
        const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf-8"));
        results.push({ network: net, status: "success", address: deployment.contractAddress });
      } else {
        results.push({ network: net, status: "success" });
      }
    } catch (error) {
      results.push({ network: net, status: "failed", error: error.message });
      console.error(`Failed to deploy to ${net}: ${error.message}`);
    }
  }

  console.log("\n========================================");
  console.log("  Deployment Summary");
  console.log("========================================");
  for (const r of results) {
    const icon = r.status === "success" ? "OK" : "FAIL";
    const addr = r.address ? ` -> ${r.address}` : "";
    const err = r.error ? ` (${r.error.substring(0, 50)})` : "";
    console.log(`  [${icon}] ${r.network}${addr}${err}`);
  }
  console.log("========================================\n");
}

main();
