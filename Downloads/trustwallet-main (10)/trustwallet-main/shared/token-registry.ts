/**
 * Shared token registry for EVM and TRON.
 * Centralizes decimals, symbols, and icons for supported tokens.
 */

export interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
  icon?: string;
  /** Address on specific chainIds */
  addresses: Record<string, string>;
}

export const TokenRegistry: Record<string, TokenMetadata> = {
  USDT: {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6, // 6 for TRON and many EVM L2s
    addresses: {
      "0x89": "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // Polygon
      "0x38": "0x55d398326f99059fF775485246999027B3197955", // BSC
      "0x2b6653dc": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", // TRON
      "0xcd8690dc": "TXLAQyvSrqfbvUmcT9HceUvD27ZvL99m9r", // TRON Nile
      "0xaa36a7": "0xaA8E23Fb1079EA71e0a1bF189A146386c0930758", // Sepolia
    }
  },
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    addresses: {
      "0x89": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // Polygon
      "0x1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum
      "0x2b6653dc": "TEkxiTeP4f1ZrMxyvHC3qSZBfY9reN1zXY", // TRON (uncommon)
    }
  },
  TRX: {
    symbol: "TRX",
    name: "TRON",
    decimals: 6,
    addresses: {
      "0x2b6653dc": "native",
      "0xcd8690dc": "native",
    }
  },
  ETH: {
    symbol: "ETH",
    name: "Ethereum",
    decimals: 18,
    addresses: {
      "0x1": "native",
      "0xaa36a7": "native",
    }
  }
};

export function getTokenBySymbol(symbol: string): TokenMetadata | undefined {
  return TokenRegistry[symbol.toUpperCase()];
}

export function getTokenAddress(symbol: string, chainId: string): string | undefined {
  return TokenRegistry[symbol.toUpperCase()]?.addresses[chainId.toLowerCase()];
}

export function getTokenDecimals(symbol: string, chainId: string): number {
  return TokenRegistry[symbol.toUpperCase()]?.decimals ?? 18;
}
