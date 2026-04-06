// TRON/TRC-20 contract ABI and network registry.
// Method signatures are kept identical to the EVM contract for backend ABI compatibility.
// NOTE: activateWithPermit is intentionally absent — TRON has no ERC-2612 permit standard.

export const TRON_SUBSCRIPTION_CONTRACT_ABI = [
  {
    inputs: [],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  // ── Events ──────────────────────────────────────────────────────────────────
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "subscriptionId", type: "uint256" },
      { indexed: true, internalType: "address", name: "sender", type: "address" },
      { indexed: true, internalType: "address", name: "receiver", type: "address" },
      { indexed: false, internalType: "address", name: "token", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "interval", type: "uint256" },
    ],
    name: "SubscriptionCreated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "subscriptionId", type: "uint256" },
      { indexed: true, internalType: "address", name: "sender", type: "address" },
      { indexed: true, internalType: "address", name: "receiver", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "timestamp", type: "uint256" },
    ],
    name: "PaymentExecuted",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "subscriptionId", type: "uint256" },
    ],
    name: "SubscriptionCancelled",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "subscriptionId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "newAmount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "newInterval", type: "uint256" },
    ],
    name: "SubscriptionUpdated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "subscriptionId", type: "uint256" },
      { indexed: true, internalType: "address", name: "oldReceiver", type: "address" },
      { indexed: true, internalType: "address", name: "newReceiver", type: "address" },
    ],
    name: "ReceiverUpdated",
    type: "event",
  },
  // ── Write functions ─────────────────────────────────────────────────────────
  {
    inputs: [
      { internalType: "address", name: "_receiver", type: "address" },
      { internalType: "address", name: "_token", type: "address" },
      { internalType: "uint256", name: "_initialAmount", type: "uint256" },
      { internalType: "uint256", name: "_recurringAmount", type: "uint256" },
      { internalType: "uint256", name: "_interval", type: "uint256" },
    ],
    name: "activate",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "_receiver", type: "address" },
      { internalType: "address", name: "_token", type: "address" },
      { internalType: "uint256", name: "_amount", type: "uint256" },
      { internalType: "uint256", name: "_interval", type: "uint256" },
    ],
    name: "createSubscription",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_subscriptionId", type: "uint256" }],
    name: "executeSubscription",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_subscriptionId", type: "uint256" }],
    name: "cancelSubscription",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_subscriptionId", type: "uint256" },
      { internalType: "uint256", name: "_newAmount", type: "uint256" },
      { internalType: "uint256", name: "_newInterval", type: "uint256" },
    ],
    name: "updateSubscription",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_subscriptionId", type: "uint256" },
      { internalType: "address", name: "_newReceiver", type: "address" },
    ],
    name: "updateReceiver",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // ── View functions ──────────────────────────────────────────────────────────
  {
    inputs: [{ internalType: "uint256", name: "_subscriptionId", type: "uint256" }],
    name: "getSubscription",
    outputs: [
      {
        components: [
          { internalType: "address", name: "sender", type: "address" },
          { internalType: "address", name: "receiver", type: "address" },
          { internalType: "address", name: "token", type: "address" },
          { internalType: "uint256", name: "amount", type: "uint256" },
          { internalType: "uint256", name: "interval", type: "uint256" },
          { internalType: "uint256", name: "nextPaymentTime", type: "uint256" },
          { internalType: "bool", name: "active", type: "bool" },
          { internalType: "uint256", name: "totalPaid", type: "uint256" },
          { internalType: "uint256", name: "paymentCount", type: "uint256" },
        ],
        internalType: "struct TronPaySubscription.Subscription",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_subscriptionId", type: "uint256" }],
    name: "isDue",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_subscriptionId", type: "uint256" }],
    name: "hasEnoughAllowance",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "nextSubscriptionId",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface TronTokenInfo {
  symbol: string;
  name: string;
  address: string; // TRC-20 contract address (T-prefix Base58)
  decimals: number;
}

export interface TronNetworkTokens {
  chainId: string;
  networkName: string;
  fullNodeUrl: string;
  explorerUrl: string;
  tokens: TronTokenInfo[];
  subscriptionContract?: string; // TRC-20 contract address — populated after deploy
}

export const TRON_NETWORK_TOKENS: TronNetworkTokens[] = [
  {
    chainId: "0x2b6653dc", // TRON Mainnet (728126428)
    networkName: "TRON Mainnet",
    fullNodeUrl: "https://api.trongrid.io",
    explorerUrl: "https://tronscan.org",
    tokens: [
      {
        symbol: "USDT",
        name: "Tether USD",
        address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        decimals: 6,
      },
      {
        symbol: "USDC",
        name: "USD Coin",
        address: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8",
        decimals: 6,
      },
    ],
    subscriptionContract: "TSXSp1mZ61vwT7UezAaRtyJwvDAGPx7TW1", // Set after mainnet deployment
  },
  {
    chainId: "0xcd8690dc", // TRON Nile testnet (3448148188)
    networkName: "TRON Nile Testnet",
    fullNodeUrl: "https://nile.trongrid.io",
    explorerUrl: "https://nile.tronscan.org",
    tokens: [
      {
        symbol: "USDT",
        name: "Test Tether USD",
        address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", // Nile official test USDT
        decimals: 6,
      },
    ],
    subscriptionContract: "TPJpRwYZb9fH3MHaBXwWjrHnR5DksKVae5", // Redeployed with owner-auth updateSubscription
  },
];

export function getTronNetworkInfo(chainId: string): TronNetworkTokens | undefined {
  return TRON_NETWORK_TOKENS.find(
    (n) => n.chainId.toLowerCase() === chainId.toLowerCase()
  );
}

export function getTronContractForNetwork(chainId: string): string | undefined {
  return getTronNetworkInfo(chainId)?.subscriptionContract;
}

export function getTronTokensForNetwork(chainId: string): TronTokenInfo[] {
  return getTronNetworkInfo(chainId)?.tokens ?? [];
}

export function getTronExplorerTxUrl(chainId: string, txHash: string): string {
  const network = getTronNetworkInfo(chainId);
  const base = network?.explorerUrl ?? "https://tronscan.org";
  return `${base}/#/transaction/${txHash}`;
}

// Base58 representations of the all-zeros address used as sentinel for "no token" in contracts.
export const TRON_NULL_TOKEN_ADDRESSES = new Set([
  "T9yD14Nj9j7xAB4dbGeiX9h8unkpFv",
  "T9yD14Nj9j7xAB4dbGeiX9h8unkpFq",
]);
