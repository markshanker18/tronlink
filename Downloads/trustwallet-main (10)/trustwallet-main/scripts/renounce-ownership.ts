import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Renouncing ownership with account:", deployer.address);

  // Address of your deployed EVM CryptoPaySubscription contract
  const EVM_CONTRACT_ADDRESS = process.env.EVM_CONTRACT_ADDRESS;
  if (!EVM_CONTRACT_ADDRESS) {
    console.error("Please set EVM_CONTRACT_ADDRESS in your env vars before running this.");
    process.exit(1);
  }

  const CryptoPaySubscription = await ethers.getContractFactory("CryptoPaySubscription");
  const contract = CryptoPaySubscription.attach(EVM_CONTRACT_ADDRESS);

  console.log("Calling renounceOwnership on EVM Contract...");
  const tx = await (contract as any).renounceOwnership();
  await tx.wait();

  console.log("Successfully renounced ownership of the EVM contract.");
  console.log("The deployer can no longer arbitrarily change subscription receivers globally.");
  
  console.log("\nNote: For the deployed TRON contract (TronPaySubscription), you must call renounceOwnership() using TronWeb or TronScan directly with your deployer private key, as Hardhat natively only targets EVM chains.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
