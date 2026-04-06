const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const CHAIN_ID_TO_HEX = {
  1: "0x1",
  137: "0x89",
  56: "0x38",
  43114: "0xa86a",
  42161: "0xa4b1",
  10: "0xa",
  8453: "0x2105",
  250: "0xfa",
  11155111: "0xaa36a7",
  5: "0x5",
};

const NETWORK_NAMES = {
  1: "Ethereum Mainnet",
  137: "Polygon",
  56: "BNB Smart Chain",
  43114: "Avalanche",
  42161: "Arbitrum One",
  10: "Optimism",
  8453: "Base",
  250: "Fantom",
  11155111: "Sepolia (Testnet)",
  5: "Goerli (Testnet)",
};

async function main() {
  const { ethers, network, run } = hre;
  const chainId = network.config.chainId || 31337;
  const hexChainId = CHAIN_ID_TO_HEX[chainId] || `0x${chainId.toString(16)}`;
  const networkName = NETWORK_NAMES[chainId] || network.name;

  console.log(`\n========================================`);
  console.log(`  CryptoPay Subscription Contract`);
  console.log(`  Deploying to: ${networkName}`);
  console.log(`  Chain ID: ${chainId} (${hexChainId})`);
  console.log(`========================================\n`);

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH\n`);

  if (balance === 0n && chainId !== 31337) {
    throw new Error("Deployer has no balance. Fund the deployer wallet first.");
  }

  console.log("Deploying CryptoPaySubscription...");
  const CryptoPaySubscription = await ethers.getContractFactory("CryptoPaySubscription");
  const contract = await CryptoPaySubscription.deploy();
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();
  console.log(`\nContract deployed at: ${contractAddress}`);

  const deployment = {
    network: networkName,
    chainId,
    hexChainId,
    contractAddress,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    blockNumber: await ethers.provider.getBlockNumber(),
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const deploymentFile = path.join(deploymentsDir, `${network.name}.json`);
  fs.writeFileSync(deploymentFile, JSON.stringify(deployment, null, 2));
  console.log(`Deployment saved to: ${deploymentFile}`);

  updateContractsRegistry(hexChainId, contractAddress);

  if (chainId !== 31337) {
    console.log("\nWaiting for block confirmations before verification...");
    const deployTx = contract.deploymentTransaction();
    if (deployTx) {
      await deployTx.wait(5);
    }

    try {
      console.log("Verifying contract on block explorer...");
      await run("verify:verify", {
        address: contractAddress,
        constructorArguments: [],
      });
      console.log("Contract verified successfully!");
    } catch (error) {
      if (error.message && error.message.includes("Already Verified")) {
        console.log("Contract is already verified.");
      } else {
        console.log(`Verification failed: ${error.message}`);
        console.log("You can verify manually later with:");
        console.log(`  npx hardhat verify --network ${network.name} ${contractAddress}`);
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`  Deployment Complete!`);
  console.log(`  Network:  ${networkName}`);
  console.log(`  Contract: ${contractAddress}`);
  console.log(`========================================\n`);
}

function updateContractsRegistry(hexChainId, contractAddress) {
  const contractsPath = path.join(__dirname, "..", "shared", "contracts.ts");

  if (!fs.existsSync(contractsPath)) {
    console.log("Warning: shared/contracts.ts not found, skipping registry update.");
    return;
  }

  let content = fs.readFileSync(contractsPath, "utf-8");

  if (content.includes("subscriptionContract") && content.includes(hexChainId)) {
    const subContractRegex = new RegExp(
      `(chainId:\\s*"${hexChainId}"[\\s\\S]*?)subscriptionContract:\\s*"[^"]*"`
    );
    if (subContractRegex.test(content)) {
      content = content.replace(
        subContractRegex,
        `$1subscriptionContract: "${contractAddress}"`
      );
    }
  } else {
    const insertRegex = new RegExp(
      `(chainId:\\s*"${hexChainId}",[\\s\\S]*?\\],)\\s*(\\})`
    );
    if (insertRegex.test(content)) {
      content = content.replace(
        insertRegex,
        `$1\n    subscriptionContract: "${contractAddress}",\n  $2`
      );
    }
  }

  fs.writeFileSync(contractsPath, content, "utf-8");
  console.log(`Updated shared/contracts.ts with contract address for chain ${hexChainId}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
