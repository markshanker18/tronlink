// Chain type definitions and address utilities for multi-chain support.
// EVM chains use 0x-prefixed hex addresses; TRON uses Base58Check T-prefix addresses.

export type ChainType = "evm" | "tron";

// TRON chain IDs expressed as hex strings (same format as EVM chain IDs)
const TRON_CHAIN_IDS = new Set([
  "0x2b6653dc", // TRON Mainnet (728126428)
  "0xcd8690dc", // TRON Nile testnet (3448148188)
]);

const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
// Base58Check encoding: T-prefix + 33 Base58 chars = 34 chars total
const TRON_ADDRESS_REGEX = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export function detectChainType(networkId: string): ChainType {
  if (TRON_CHAIN_IDS.has(networkId.toLowerCase())) return "tron";
  return "evm";
}

export function isValidAddress(address: string, chainType: ChainType): boolean {
  if (!address) return false;
  if (chainType === "tron") return TRON_ADDRESS_REGEX.test(address);
  return EVM_ADDRESS_REGEX.test(address);
}

/**
 * Normalize an address for storage/comparison.
 * EVM addresses are case-insensitive → lowercase.
 * TRON Base58Check addresses are case-sensitive → preserve exactly.
 */
export function normalizeAddress(address: string, chainType: ChainType): string {
  if (!address) return address;
  if (chainType === "tron") return address; // preserve case
  return address.toLowerCase();
}

export function isTronChainId(networkId: string): boolean {
  return TRON_CHAIN_IDS.has(networkId.toLowerCase());
}

export interface NetworkMetadata {
  chainId: string;
  name: string;
  symbol: string;
  type: "mainnet" | "testnet";
}

export const SUPPORTED_EVM_NETWORKS: NetworkMetadata[] = [
  { chainId: "0x1", name: "Ethereum Mainnet", symbol: "ETH", type: "mainnet" },
  { chainId: "0x89", name: "Polygon Mainnet", symbol: "MATIC", type: "mainnet" },
  { chainId: "0x38", name: "BSC Mainnet", symbol: "BNB", type: "mainnet" },
  { chainId: "0xa86a", name: "Avalanche C-Chain", symbol: "AVAX", type: "mainnet" },
  { chainId: "0xa4b1", name: "Arbitrum One", symbol: "ETH", type: "mainnet" },
  { chainId: "0xa", name: "Optimism", symbol: "ETH", type: "mainnet" },
  { chainId: "0x2105", name: "Base", symbol: "ETH", type: "mainnet" },
  { chainId: "0xfa", name: "Fantom Opera", symbol: "FTM", type: "mainnet" },
  { chainId: "0xaa36a7", name: "Sepolia Testnet", symbol: "ETH", type: "testnet" },
];

export const SUPPORTED_TRON_NETWORKS: NetworkMetadata[] = [
  { chainId: "0x2b6653dc", name: "TRON Mainnet", symbol: "TRX", type: "mainnet" },
  { chainId: "0xcd8690dc", name: "TRON Nile Testnet", symbol: "TRX", type: "testnet" },
];

export const ALL_SUPPORTED_NETWORKS = [...SUPPORTED_EVM_NETWORKS, ...SUPPORTED_TRON_NETWORKS];
