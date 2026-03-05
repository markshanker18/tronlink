export const SUBSCRIPTION_CONTRACT_ABI = [
  {
    inputs: [],
    stateMutability: "nonpayable",
    type: "constructor",
  },
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
      { internalType: "uint256", name: "_initialAmount", type: "uint256" },
      { internalType: "uint256", name: "_recurringAmount", type: "uint256" },
      { internalType: "uint256", name: "_interval", type: "uint256" },
      { internalType: "uint256", name: "_permitValue", type: "uint256" },
      { internalType: "uint256", name: "_permitDeadline", type: "uint256" },
      { internalType: "uint8", name: "v", type: "uint8" },
      { internalType: "bytes32", name: "r", type: "bytes32" },
      { internalType: "bytes32", name: "s", type: "bytes32" },
    ],
    name: "activateWithPermit",
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
        internalType: "struct CryptoPaySubscription.Subscription",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
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

export const ERC20_ABI = [
  {
    inputs: [],
    name: "name",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "address", name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "nonces",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "version",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "DOMAIN_SEPARATOR",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface TokenInfo {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
}

export interface NetworkTokens {
  chainId: string;
  tokens: TokenInfo[];
  subscriptionContract?: string;
}

export const NETWORK_TOKENS: NetworkTokens[] = [
  {
    chainId: "0x1",
    tokens: [
      { symbol: "USDT", name: "Tether USD", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
      { symbol: "USDC", name: "USD Coin", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      { symbol: "DAI", name: "Dai Stablecoin", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
    ],
  },
  {
    chainId: "0x89",
    tokens: [
      { symbol: "USDT", name: "Tether USD", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
      { symbol: "USDC", name: "USD Coin", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
      { symbol: "DAI", name: "Dai Stablecoin", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18 },
    ],
  },
  {
    chainId: "0x38",
    tokens: [
      { symbol: "USDT", name: "Tether USD", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
      { symbol: "USDC", name: "USD Coin", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
      { symbol: "DAI", name: "Dai Stablecoin", address: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", decimals: 18 },
    ],
    subscriptionContract: "0xE5D1E242bA4554c0dd69fE65b4c327665405dfd5", // Placeholder: replace with BSC mainnet contract
  },
  {
    chainId: "0xa86a",
    tokens: [
      { symbol: "USDT", name: "Tether USD", address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
      { symbol: "USDC", name: "USD Coin", address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
      { symbol: "DAI", name: "Dai Stablecoin", address: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70", decimals: 18 },
    ],
  },
  {
    chainId: "0xa4b1",
    tokens: [
      { symbol: "USDT", name: "Tether USD", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
      { symbol: "USDC", name: "USD Coin", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
      { symbol: "DAI", name: "Dai Stablecoin", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18 },
    ],
  },
  {
    chainId: "0xa",
    tokens: [
      { symbol: "USDT", name: "Tether USD", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6 },
      { symbol: "USDC", name: "USD Coin", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
      { symbol: "DAI", name: "Dai Stablecoin", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18 },
    ],
  },
  {
    chainId: "0x2105",
    tokens: [
      { symbol: "USDC", name: "USD Coin", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
      { symbol: "DAI", name: "Dai Stablecoin", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
    ],
  },
  {
    chainId: "0xfa",
    tokens: [
      { symbol: "USDT", name: "Tether USD", address: "0x049d68029688eAbF473097a2fC38ef61633A3C7A", decimals: 6 },
      { symbol: "USDC", name: "USD Coin", address: "0x04068DA6C83AFCFA0e13ba15A6696662335D5B75", decimals: 6 },
      { symbol: "DAI", name: "Dai Stablecoin", address: "0x8D11eC38a3EB5E956B052f67Da8Bdc9bef8Abf3E", decimals: 18 },
    ],
  },
  {
    chainId: "0xaa36a7",
    tokens: [
      { symbol: "USDT", name: "Test Tether", address: "0x7169D38820dfd117C3FA1f22a697dBA58d90BA06", decimals: 6 },
      { symbol: "USDC", name: "Test USD Coin", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6 },
      { symbol: "DAI", name: "Test Dai", address: "0x68194a729C2450ad26072b3D33ADaCbcef39D574", decimals: 18 },
    ],
    subscriptionContract: "0xE5D1E242bA4554c0dd69fE65b4c327665405dfd5",
  },
  {
    chainId: "0x5",
    tokens: [
      { symbol: "USDT", name: "Test Tether", address: "0xC2C527C0CACF457746Bd31B2a698Fe89de2b6d49", decimals: 6 },
      { symbol: "USDC", name: "Test USD Coin", address: "0x07865c6E87B9F70255377e024ace6630C1Eaa37F", decimals: 6 },
      { symbol: "DAI", name: "Test Dai", address: "0x11fE4B6AE13d2a6055C8D9cF65c55bac32B5d844", decimals: 18 },
    ],
  },
  {
    chainId: "0x61",
    tokens: [
      { symbol: "USDT", name: "Test Tether", address: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd", decimals: 18 },
      { symbol: "USDC", name: "Test USD Coin", address: "0x64544969ed336C697C5E245b8ca0deC196f4BA7C", decimals: 18 },
    ],
    subscriptionContract: "0xE5D1E242bA4554c0dd69fE65b4c327665405dfd5", // Placeholder: replace with BSC testnet contract
  },
];

export function getTokensForNetwork(chainId: string): TokenInfo[] {
  const network = NETWORK_TOKENS.find(
    (n) => n.chainId.toLowerCase() === chainId.toLowerCase()
  );
  return network?.tokens || [];
}

// TRON Mainnet tokens (TRC-20)
export const TRON_NETWORK_TOKENS: NetworkTokens[] = [
  {
    chainId: "tron_mainnet",
    tokens: [
      { symbol: "USDT", name: "Tether USD", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 },
      { symbol: "USDC", name: "USD Coin", address: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8", decimals: 6 },
    ],
    subscriptionContract: "TX9yA7K7K7K7K7K7K7K7K7K7K7K7K7K7K", // Placeholder: replace with TRON mainnet contract
  },
  {
    chainId: "tron_shasta",
    tokens: [
      { symbol: "USDT", name: "Test Tether", address: "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs", decimals: 6 },
    ],
    subscriptionContract: "TX9yA7K7K7K7K7K7K7K7K7K7K7K7K7K7K", // Placeholder: replace with TRON Shasta contract
  },
];

export function isTronNetwork(chainId: string): boolean {
  return chainId.startsWith("tron_");
}

export function getTronTokensForNetwork(chainId: string): TokenInfo[] {
  const network = TRON_NETWORK_TOKENS.find(
    (n) => n.chainId.toLowerCase() === chainId.toLowerCase()
  );
  return network?.tokens || [];
}

export function getContractForNetwork(chainId: string): string | undefined {
  const network = NETWORK_TOKENS.find(
    (n) => n.chainId.toLowerCase() === chainId.toLowerCase()
  );
  return network?.subscriptionContract;
}
