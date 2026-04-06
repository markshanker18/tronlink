import { BrowserProvider, Contract } from "ethers";
import { ERC20_ABI } from "../../../shared/contracts";
import type { ChainType } from "../../../shared/chain";
import { AddressUtils } from "../../../shared/address-utils";

export type TokenSupportStatus =
  | "fully_supported" // Standard + EIP-2612 Permit
  | "approve_only" // Standard, missing Permit
  | "unsupported" // Fails basic ERC20 interface, or is a native coin placeholder
  | "risky"; // Fee-on-transfer, or strange revert behavior

export interface TokenValidationResult {
  status: TokenSupportStatus;
  decimals?: number;
  symbol?: string;
  name?: string;
  supportsPermit: boolean;
  reason?: string;
}

/**
 * Actively probes an ERC-20 token contract to determine standard compliance and EIP-2612 Permit support.
 * Does not guess; relies on strict ABI calls.
 */
export async function analyzeErc20Token(
  address: string,
  provider: BrowserProvider
): Promise<TokenValidationResult> {
  if (!AddressUtils.isValid(address, "evm")) {
    return {
      status: "unsupported",
      supportsPermit: false,
      reason: "Invalid EVM address format",
    };
  }

  // Detect native coin placeholders (zero address, or standard dummy addresses)
  if (
    address === "0x0000000000000000000000000000000000000000" ||
    address.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  ) {
    return {
      status: "unsupported",
      supportsPermit: false,
      reason: "Native coins are not recursively billable. Use wrapped tokens (WETH/WBNB).",
    };
  }

  const contract = new Contract(address, ERC20_ABI, provider);

  try {
    // 1. Basic ERC-20 Checks
    const [decimals, symbol, name] = await Promise.all([
      contract.decimals(),
      contract.symbol().catch(() => "UNKNOWN"), // Some older tokens don't have symbol/name
      contract.name().catch(() => "Unknown Token"),
    ]);

    if (typeof decimals !== "number" && typeof decimals !== "bigint") {
      return {
        status: "unsupported",
        supportsPermit: false,
        reason: "Invalid decimals return strictly required by the standard",
      };
    }

    // 2. Permit Probing
    let supportsPermit = false;
    try {
      // Best-effort check: if DOMAIN_SEPARATOR() succeeds, it's highly likely to support permits.
      // We don't verify full domain separator math here to save RPC calls, just existence.
      await contract.DOMAIN_SEPARATOR();
      
      // Also probe nonces() and PERMIT_TYPEHASH() if we want to be absolutely sure,
      // but DOMAIN_SEPARATOR() existing and not reverting is a very strong signal.
      try {
        await contract.nonces("0x0000000000000000000000000000000000000000");
        supportsPermit = true;
      } catch {
        // Fallback: still false
      }
    } catch {
      // Reverted, definitely does not support permits natively.
      supportsPermit = false;
    }

    return {
      status: supportsPermit ? "fully_supported" : "approve_only",
      decimals: Number(decimals),
      symbol,
      name,
      supportsPermit,
    };
  } catch (err: any) {
    return {
      status: "unsupported",
      supportsPermit: false,
      reason: "Contract does not conform to the ERC-20 standard or is paused/broken",
    };
  }
}

/**
 * Basic TRC-20 checks. TRON does not support permits, so we just check decimals.
 */
export async function analyzeTrc20Token(
  address: string,
  tronWeb: any
): Promise<TokenValidationResult> {
  if (!AddressUtils.isValid(address, "tron")) {
    return {
      status: "unsupported",
      supportsPermit: false,
      reason: "Invalid TRON base58 address format",
    };
  }

  if (address === "T9yD14Nj9j7xAB4dbGeiX9h8unkpFv" || address === "T9yD14Nj9j7xAB4dbGeiX9h8unkpFq") { // common zero/burn variants
    return {
      status: "unsupported",
      supportsPermit: false,
      reason: "Native TRX is not recursively billable via this mechanism.",
    };
  }

  try {
    // We cannot construct ethers Contract here. Must use tronWeb's TRC20 ABI methods.
    // However, TronWeb `contract()` fetches ABI dynamically if verified, but we can't rely on verification.
    // Instead we can just trigger constant contract queries.
    
    // For now we assume standard TRC-20 layout for manual interactions.
    // A robust way without ABI is `tronWeb.transactionBuilder.triggerConstantContract`
    const { constant_result } = await tronWeb.transactionBuilder.triggerConstantContract(
      address,
      "decimals()",
      {},
      [],
      tronWeb.defaultAddress.base58
    );

    if (!constant_result || constant_result.length === 0) {
      return {
        status: "unsupported",
        supportsPermit: false,
        reason: "Contract does not implement TRC-20 decimals()",
      };
    }

    const decimalsHex = constant_result[0];
    const decimals = parseInt(decimalsHex, 16);

    // Get symbol
    let symbol = "TRC20";
    try {
      const symRes = await tronWeb.transactionBuilder.triggerConstantContract(
          address, "symbol()", {}, [], tronWeb.defaultAddress.base58
      );
      if (symRes && symRes.constant_result?.length > 0) {
          // Tron string parsing is messy natively, simplifying for validation layer:
          symbol = tronWeb.toUtf8(symRes.constant_result[0]).replace(/\0/g, '');
      }
    } catch {}

    return {
      status: "approve_only",
      decimals,
      symbol,
      name: symbol,
      supportsPermit: false,
    };
  } catch (err: any) {
    return {
      status: "unsupported",
      supportsPermit: false,
      reason: "Failed to interact with TRC-20 contract",
    };
  }
}

export async function validateToken(
  address: string, 
  chainType: ChainType, 
  providerOrTronWeb: any
): Promise<TokenValidationResult> {
  if (chainType === "evm") {
    return analyzeErc20Token(address, providerOrTronWeb as BrowserProvider);
  } else {
    return analyzeTrc20Token(address, providerOrTronWeb);
  }
}
