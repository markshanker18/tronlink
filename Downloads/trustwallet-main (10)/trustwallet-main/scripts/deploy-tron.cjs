#!/usr/bin/env node
// Deploy TronPaySubscription.sol to TRON Nile testnet or Mainnet.
// Usage: node scripts/deploy-tron.cjs [nile|mainnet]
//
// ⚠️  NEVER export private keys from a wallet holding real funds.
//     For production deployment use TronScan (tronscan.org) with wallet signing:
//       1. Open tronscan.org in Trust Wallet DApp browser
//       2. Connect wallet → Contracts → Deploy Contract
//       3. Paste TronPaySubscription.sol → compile → deploy
//
// This script is provided for CI/devnet environments using a dedicated
// throwaway deployer wallet (never a user/merchant wallet).

"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");

function compileContract() {
  const solc = require("solc");
  const solFile = path.join(__dirname, "../contracts/TronPaySubscription.sol");
  const source = fs.readFileSync(solFile, "utf8");

  const input = {
    language: "Solidity",
    sources: { "TronPaySubscription.sol": { content: source } },
    settings: {
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      optimizer: { enabled: true, runs: 200 },
    },
  };

  console.log("Compiling TronPaySubscription.sol...");
  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    const errors = output.errors.filter((e) => e.severity === "error");
    if (errors.length > 0) {
      console.error("Compilation errors:");
      errors.forEach((e) => console.error(e.formattedMessage));
      process.exit(1);
    }
    output.errors
      .filter((e) => e.severity === "warning")
      .forEach((w) => console.warn("Warning:", w.message));
  }

  const contract = output.contracts["TronPaySubscription.sol"]["TronPaySubscription"];
  if (!contract) {
    console.error("Contract not found in compilation output.");
    process.exit(1);
  }

  console.log("Compilation successful.");
  return {
    abi: contract.abi,
    bytecode: "0x" + contract.evm.bytecode.object,
  };
}

async function main() {
  const network = process.argv[2] || "nile";

  let TronWeb;
  try {
    TronWeb = require("tronweb").TronWeb ?? require("tronweb");
  } catch (e) {
    console.error("tronweb not installed. Run: npm install tronweb");
    process.exit(1);
  }

  const config = {
    nile: {
      fullNode: "https://nile.trongrid.io",
      apiKey: process.env.TRON_NILE_API_KEY || "",
      outputFile: path.join(__dirname, "../deployments/tron-nile.json"),
    },
    mainnet: {
      fullNode: "https://api.trongrid.io",
      apiKey: process.env.TRON_MAINNET_API_KEY || "",
      outputFile: path.join(__dirname, "../deployments/tron-mainnet.json"),
    },
  }[network];

  if (!config) {
    console.error(`Unknown network: ${network}. Use 'nile' or 'mainnet'.`);
    process.exit(1);
  }

  const privateKey = process.env.TRON_EXECUTOR_PRIVATE_KEY;
  if (!privateKey) {
    console.error("\nTRON_EXECUTOR_PRIVATE_KEY not set.");
    console.error("Export your private key from Trust Wallet:");
    console.error("  Settings → Wallets → Select wallet → ⋮ → Export Private Key");
    console.error("Then add to .env:  TRON_EXECUTOR_PRIVATE_KEY=your_key_here\n");
    process.exit(1);
  }

  // Strip leading 0x if present
  const cleanKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;

  const tronWeb = new TronWeb({
    fullHost: config.fullNode,
    headers: config.apiKey ? { "TRON-PRO-API-KEY": config.apiKey } : {},
    privateKey: cleanKey,
  });

  const deployer = tronWeb.defaultAddress.base58;
  console.log(`\nNetwork:  TRON ${network}`);
  console.log(`Deployer: ${deployer}`);

  // Check TRX balance
  try {
    const balance = await tronWeb.trx.getBalance(deployer);
    const trxBalance = balance / 1_000_000;
    console.log(`Balance:  ${trxBalance} TRX`);
    if (trxBalance < 100) {
      console.error("Balance too low. Need at least 100 TRX for deployment energy.");
      process.exit(1);
    }
  } catch (err) {
    console.error(`FAILED to check balance: ${err.message || err}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }

  const { abi, bytecode } = compileContract();

  console.log("\nDeploying contract...");
  const deployResult = await tronWeb.contract().new({
    abi,
    bytecode,
    feeLimit: 1_500_000_000, // 1500 TRX max fee limit
    callValue: 0,
    userFeePercentage: 100,
    originEnergyLimit: 10_000_000,
  });

  console.log("DEBUG_DEPLOY_RESULT:");
  try {
    const txId = deployResult.transaction ? deployResult.transaction.txID : (deployResult.txID || deployResult.id);
    console.log(`Transaction ID: ${txId}`);
    
    let contractAddress = deployResult.address || (deployResult.transaction ? deployResult.transaction.contract_address : null);
    
    // If we already have the address (TronWeb 6.x often returns it if confirmed)
    if (contractAddress) {
      if (contractAddress.startsWith('41')) {
        contractAddress = tronWeb.address.fromHex(contractAddress);
      }
      console.log(`\n✓ Contract instance ready!`);
      console.log(`Contract address: ${contractAddress}`);
      
      const resData = {
        network,
        contractAddress,
        deployerAddress: deployer,
        txHash: txId,
        deployedAt: new Date().toISOString(),
      };

      fs.mkdirSync(path.dirname(config.outputFile), { recursive: true });
      fs.writeFileSync(config.outputFile, JSON.stringify(resData, null, 2));
      console.log(`\nSaved to: ${config.outputFile}`);
      return;
    }

    console.log("Waiting for confirmation...");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const tx = await tronWeb.trx.getTransaction(txId);
        if (tx?.ret?.[0]?.contractRet === "SUCCESS") {
          const info = await tronWeb.trx.getTransactionInfo(txId);
          const finalAddress = tronWeb.address.fromHex(info.contract_address);
          
          console.log(`\n✓ Deployed successfully!`);
          console.log(`Contract address: ${finalAddress}`);
          console.log(`TronScan: https://tronscan.org/#/contract/${finalAddress}`);

          const finalResult = {
            network,
            contractAddress: finalAddress,
            deployerAddress: deployer,
            txHash: txId,
            deployedAt: new Date().toISOString(),
          };

          fs.mkdirSync(path.dirname(config.outputFile), { recursive: true });
          fs.writeFileSync(config.outputFile, JSON.stringify(finalResult, null, 2));
          console.log(`\nSaved to: ${config.outputFile}`);
          return;
        }
      } catch (_) {
        // not yet confirmed, keep polling
      }
    }
  } catch (err) {
    console.error(`FAILED during deployment check: ${err.message || err}`);
    process.exit(1);
  }

  console.error("Not confirmed after 90 seconds. Check TronScan for the transaction.");
  process.exit(1);
}

main().catch((err) => {
  console.error("Deploy failed:", err.message || err);
  process.exit(1);
});
