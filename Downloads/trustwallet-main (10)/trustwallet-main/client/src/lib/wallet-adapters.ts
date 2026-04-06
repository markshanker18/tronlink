import { BrowserProvider, type JsonRpcSigner } from "ethers";
import { detectWalletBrand, type WalletBrand } from "./metamask";
export type { WalletBrand };
import { isTronLinkInstalled, isTronLinkReady, connectTronLink, detectTronChainId } from "./tronlink";
import type { ChainType } from "../../../shared/chain";
import { AddressUtils } from "../../../shared/address-utils";
import { SUPPORTED_NETWORKS } from "./metamask";

function getAddChainParameters(chainIdHex: string) {
  const network = SUPPORTED_NETWORKS.find((n) => n.chainId.toLowerCase() === chainIdHex.toLowerCase());
  if (!network) return null;
  
  const rpcs: Record<string, string[]> = {
    "0x89": ["https://polygon-rpc.com"],
    "0x38": ["https://bsc-dataseed.binance.org"],
    "0xa86a": ["https://api.avax.network/ext/bc/C/rpc"],
    "0xa4b1": ["https://arb1.arbitrum.io/rpc"],
    "0xa": ["https://mainnet.optimism.io"],
    "0x2105": ["https://mainnet.base.org"],
    "0xfa": ["https://rpc.ftm.tools"],
    "0xaa36a7": ["https://rpc.sepolia.org"]
  };
  
  const explorers: Record<string, string[]> = {
    "0x89": ["https://polygonscan.com"],
    "0x38": ["https://bscscan.com"],
    "0xa86a": ["https://snowtrace.io"],
    "0xa4b1": ["https://arbiscan.io"],
    "0xa": ["https://optimistic.etherscan.io"],
    "0x2105": ["https://basescan.org"],
    "0xfa": ["https://ftmscan.com"],
    "0xaa36a7": ["https://sepolia.etherscan.io"]
  };

  return {
    chainId: chainIdHex,
    chainName: network.name,
    nativeCurrency: { name: network.symbol, symbol: network.symbol, decimals: 18 },
    rpcUrls: rpcs[chainIdHex.toLowerCase()] || [],
    blockExplorerUrls: explorers[chainIdHex.toLowerCase()] || []
  };
}

export interface WalletAdapter {
  readonly brand: WalletBrand | "tronlink" | "unknown";
  readonly supportedChains: ChainType[];
  
  connect(): Promise<{ address: string; chainId: string }>;
  disconnect(): Promise<void>;
  ensureChain(chainIdHex: string, networkName?: string): Promise<void>;
  isChainSupported(chainType: ChainType): boolean;
  
  /** True if the wallet is currently "active" in the browser (injected) */
  isDetected(): boolean;
  /** Capability flags for UX routing */
  readonly capabilities: {
    readonly canSwitchEVM: boolean;
    readonly canSwitchTRON: boolean;
    readonly hasInAppBrowser: boolean;
    readonly supportsPermit: boolean;
  };
}

export class MetaMaskAdapter implements WalletAdapter {
  readonly brand = "metamask";
  readonly supportedChains: ChainType[] = ["evm"];
  readonly capabilities = {
    canSwitchEVM: true,
    canSwitchTRON: false,
    hasInAppBrowser: true,
    supportsPermit: true,
  };

  isDetected() {
    return typeof window !== "undefined" && !!(window as any).ethereum?.isMetaMask;
  }

  isChainSupported(chainType: ChainType): boolean {
    return chainType === "evm";
  }

  async connect() {
    const provider = (window as any).ethereum;
    if (!provider) throw new Error("MetaMask not found");
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const chainId = await provider.request({ method: "eth_chainId" });
    return { address: AddressUtils.normalize(accounts[0], "evm"), chainId };
  }

  async disconnect() {}

  async ensureChain(targetChainIdHex: string, networkName?: string) {
    if (!this.isChainSupported("evm")) return; // double check

    const provider = (window as any).ethereum;
    const current = await provider.request({ method: "eth_chainId" });
    if (current && current.toLowerCase() === targetChainIdHex.toLowerCase()) return;

    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetChainIdHex }],
      });
    } catch (err: any) {
      if (err.code === 4902) {
        const addParams = getAddChainParameters(targetChainIdHex);
        if (addParams && addParams.rpcUrls.length > 0) {
          try {
            await provider.request({
              method: "wallet_addEthereumChain",
              params: [addParams],
            });
            return;
          } catch (addErr: any) {
            throw new Error(`Failed to add network. Error: ${addErr.message}`);
          }
        }
        throw new Error(`Network ${networkName || targetChainIdHex} not found in MetaMask. Please add it manually.`);
      }
      throw new Error(`Please switch MetaMask to ${networkName || targetChainIdHex}`);
    }
  }
}

export class TronLinkAdapter implements WalletAdapter {
  readonly brand = "tronlink";
  readonly supportedChains: ChainType[] = ["tron"];
  readonly capabilities = {
    canSwitchEVM: false,
    canSwitchTRON: false, // TronLink does not support programmatic switch
    hasInAppBrowser: true,
    supportsPermit: false,
  };

  isDetected() {
    return isTronLinkInstalled();
  }

  isChainSupported(chainType: ChainType): boolean {
    return chainType === "tron";
  }

  async connect() {
    const result = await connectTronLink();
    return { address: result.address, chainId: result.networkId };
  }

  async disconnect() {}

  async ensureChain(targetChainIdHex: string, networkName?: string) {
    const current = detectTronChainId();
    if (current === targetChainIdHex) return;
    throw new Error(`Please switch TronLink to ${networkName || targetChainIdHex}`);
  }
}

export function getAllAdapters(): WalletAdapter[] {
  return [
    new MetaMaskAdapter(), 
    new TronLinkAdapter()
  ];
}

export function detectActiveAdapter(): WalletAdapter | null {
  return getAllAdapters().find(a => a.isDetected()) || null;
}

