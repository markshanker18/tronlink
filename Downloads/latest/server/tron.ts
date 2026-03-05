import TronWeb from "tronweb";
import { type Plan } from "../shared/schema.js";
import { getRpcUrls } from "./rpc.js";

export async function verifyTronTx(
  plan: Plan,
  payerAddress: string,
  expectedAmount: string,
  txHash: string
): Promise<{ blockTimestampMs: number }> {
  const rpcUrls = getRpcUrls(plan.networkId);
  if (rpcUrls.length === 0) {
    throw new Error(`No TRON RPC configured for ${plan.networkId}`);
  }

  // Create TronWeb instance (no private key needed for read-only verification)
  const tronWeb = new TronWeb({
    fullHost: rpcUrls[0],
  });

  try {
    // 1. Fetch transaction info
    const tx = await tronWeb.trx.getTransactionInfo(txHash);
    if (!tx || !tx.id) {
      throw new Error("Transaction not found on TRON network");
    }

    if (tx.result === "FAILED") {
       throw new Error(`Transaction failed on-chain: ${tx.resMessage || "Unknown TRON error"}`);
    }

    // 2. Fetch transaction details to verify sender/receiver/amount
    const txDetails = await tronWeb.trx.getTransaction(txHash);
    if (!txDetails || !txDetails.raw_data || !txDetails.raw_data.contract) {
       throw new Error("Could not retrieve TRON transaction raw data");
    }

    const contract = txDetails.raw_data.contract[0];
    if (contract.type !== "TriggerSmartContract") {
       throw new Error("Not a smart contract transaction (TRC-20 expected)");
    }

    const { owner_address, contract_address, data } = contract.parameter.value;
    const senderBase58 = tronWeb.address.fromHex(owner_address);
    const targetContractBase58 = tronWeb.address.fromHex(contract_address);

    // Verify sender
    if (senderBase58 !== payerAddress) {
       throw new Error(`Sender mismatch: expected ${payerAddress}, got ${senderBase58}`);
    }

    // Verify token address (TRC-20 contract)
    if (targetContractBase58 !== plan.tokenAddress) {
       throw new Error(`Token mismatch: expected ${plan.tokenAddress}, got ${targetContractBase58}`);
    }

    // For TRC-20 transfers (transfer(address,uint256)), the data looks like:
    // a9059cbb000000000000000000000000<address_hex_32bytes>00000000000000000000000000000000<amount_hex_32bytes>
    // transfer method signature: a9059cbb
    if (!data || !data.startsWith("a9059cbb")) {
       throw new Error("Not a standard TRC-20 transfer(address,uint256) transaction");
    }

    const toAddressHex = "41" + data.substring(32, 72); // TRON hex addresses start with 41
    const toAddressBase58 = tronWeb.address.fromHex(toAddressHex);
    
    const amountHex = data.substring(72, 136);
    const amountSun = BigInt("0x" + amountHex);
    
    const decimals = plan.tokenDecimals || 6;
    const expectedSun = BigInt(Math.floor(parseFloat(expectedAmount) * Math.pow(10, decimals)));

    // Verify receiver
    if (toAddressBase58 !== plan.walletAddress) {
       throw new Error(`Receiver mismatch: expected ${plan.walletAddress}, got ${toAddressBase58}`);
    }

    // Verify amount (allow small rounding difference if necessary, but sun is integer)
    if (amountSun < expectedSun) {
       throw new Error(`Amount mismatch: expected ${expectedAmount}, got ${amountSun.toString()} (sun)`);
    }

    return {
      blockTimestampMs: tx.blockTimeStamp || Date.now(),
    };
  } catch (err: any) {
    console.error("[TRON Verify] Error:", err.message || err);
    throw err;
  }
}
