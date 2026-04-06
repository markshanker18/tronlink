import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { BrowserProvider, JsonRpcSigner, Eip1193Provider } from "ethers";
import { type ChainType, detectTronChainId, isTronLinkInstalled, isTronLinkReady } from "./metamask";
import { AddressUtils } from "@shared/address-utils";
import { detectActiveAdapter, type WalletAdapter, type WalletBrand } from "./wallet-adapters";

export type UI_STATE =
  | "NOT_CONNECTED"
  | "CONNECTED"
  | "WRONG_CHAIN"
  | "CONNECTING"
  | "ACTIVE"
  | "FAILED";

export interface WalletContextType {
  adapter: WalletAdapter | null;
  address: string | null;
  chainId: string | null;
  chainType: ChainType | null;
  connecting: boolean;
  isRestoring: boolean;
  uiState: UI_STATE;
  walletBrand: WalletBrand | "tronlink" | "unknown" | null;
  /** window.tronWeb when connected via TronLink, otherwise null */
  tronWeb: any | null;

  connect: (preferredChain?: ChainType) => Promise<{ address: string; chainId: string }>;
  connectTron: () => Promise<{ address: string; chainId: string }>;
  disconnect: () => Promise<void>;
  request: (method: string, params?: any) => Promise<unknown>;
  ensureChain: (targetChainIdHex: string, networkName?: string) => Promise<void>;
  getEthersProvider: () => BrowserProvider;
  getSigner: () => Promise<JsonRpcSigner>;
  getTronWeb: () => any;
  setUiState: (state: UI_STATE) => void;
  eip1193Provider: Eip1193Provider | null;
  getAddressForNetwork: (chainId: string) => string | null;
  evmAddress: string | null;
  tronAddress: string | null;
  readonly capabilities: WalletAdapter["capabilities"] | null;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [adapter, setAdapter] = useState<WalletAdapter | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [chainType, setChainType] = useState<ChainType | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);
  const [tronWebState, setTronWebState] = useState<any | null>(null);
  const [internalUiState, setInternalUiState] = useState<UI_STATE>("NOT_CONNECTED");

  // Sync basic states
  useEffect(() => {
    if (!address) {
      setInternalUiState("NOT_CONNECTED");
    } else if (internalUiState === "NOT_CONNECTED") {
      setInternalUiState("ACTIVE");
    }
  }, [address]);

  const connectingRef = useRef(false);

  const connect = useCallback(
    async (preferredChain?: ChainType): Promise<{ address: string; chainId: string }> => {
      if (connectingRef.current) {
        throw new Error("Wallet connection already in progress");
      }

      connectingRef.current = true;
      setConnecting(true);
      try {
        const detected = detectActiveAdapter();
        if (!detected) {
          throw new Error("No wallet detected. Please install MetaMask or TronLink.");
        }
        const result = await detected.connect();
        const detectedChainType: ChainType =
          result.address.startsWith("T") ? "tron" : "evm";

        setAdapter(detected);
        setAddress(result.address);
        setChainId(result.chainId);
        setChainType(detectedChainType);
        
        if (detectedChainType === "tron") {
          setTronWebState((window as any).tronWeb || null);
        }

        return { address: result.address, chainId: result.chainId };
      } finally {
        connectingRef.current = false;
        setConnecting(false);
      }
    },
    [],
  );

  const connectTron = useCallback(() => connect("tron"), [connect]);

  const disconnect = useCallback(async (): Promise<void> => {
    if (adapter) await adapter.disconnect();
    setAdapter(null);
    setAddress(null);
    setChainId(null);
    setChainType(null);
    setTronWebState(null);
  }, [adapter]);

  const request = useCallback(
    async (method: string, params?: any): Promise<unknown> => {
      const provider = (window as any).ethereum;
      if (!provider?.request) throw new Error("EVM provider not found");
      return provider.request({ method, params });
    },
    [],
  );

  const ensureChain = useCallback(
    async (targetChainIdHex: string, networkName?: string): Promise<void> => {
      if (!adapter) {
        const detected = detectActiveAdapter();
        if (detected) {
          await detected.ensureChain(targetChainIdHex, networkName);
          return;
        }
        throw new Error("Wallet not connected");
      }
      await adapter.ensureChain(targetChainIdHex, networkName);
    },
    [adapter],
  );


  const getEthersProvider = useCallback((): BrowserProvider => {
    const provider = (window as any).ethereum;
    if (!provider) throw new Error("MetaMask provider not found");
    return new BrowserProvider(provider);
  }, []);

  const getSigner = useCallback(async (): Promise<JsonRpcSigner> => {
    const provider = getEthersProvider();
    return provider.getSigner();
  }, [getEthersProvider]);

  const getTronWeb = useCallback((): any => {
    if (tronWebState) return tronWebState;
    if ((window as any).tronWeb?.defaultAddress?.base58) return (window as any).tronWeb;
    throw new Error("TRON provider (tronWeb) not found");
  }, [tronWebState]);

  // Restore session
  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      if (typeof window === "undefined") return;
      const detected = detectActiveAdapter();
      if (!detected || cancelled) return;

      try {
        let addr: string | null = null;
        let chain: string | null = null;

        if (detected.brand === "tronlink") {
          if (isTronLinkInstalled() && isTronLinkReady()) {
            addr = (window as any).tronWeb.defaultAddress.base58;
            chain = detectTronChainId();
          }
        } else {
          const provider = (window as any).ethereum;
          if (provider) {
            const accounts = await provider.request({ method: "eth_accounts" });
            if (accounts?.[0]) {
              addr = AddressUtils.normalize(accounts[0], "evm");
              chain = await provider.request({ method: "eth_chainId" });
            }
          }
        }

        if (addr && !cancelled) {
          setAdapter(detected);
          setAddress(addr);
          setChainId(chain);
          const detectedChainType: ChainType = addr.startsWith("T") ? "tron" : "evm";
          setChainType(detectedChainType);
          
          if (detectedChainType === "tron") {
            setTronWebState((window as any).tronWeb);
          }
        }
      } catch { /* ignore */ } finally {
        if (!cancelled) setIsRestoring(false);
      }
    };

    const timer = setTimeout(restore, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  // Event Listeners (EVM)
  useEffect(() => {
    const provider = (window as any).ethereum;
    if (!provider?.on) return;

    const handleAccounts = (accounts: any) => {
      const account = Array.isArray(accounts) ? accounts[0] : accounts;
      if (account) {
        const norm = AddressUtils.normalize(account, "evm");
        setAddress(norm);
      } else {
        disconnect();
      }
    };

    const handleChain = (hex: any) => setChainId(hex);
    
    provider.on("accountsChanged", handleAccounts);
    provider.on("chainChanged", handleChain);
    provider.on("disconnect", disconnect);

    return () => {
      provider?.removeListener?.("accountsChanged", handleAccounts);
      provider?.removeListener?.("chainChanged", handleChain);
      provider?.removeListener?.("disconnect", disconnect);
    };
  }, [disconnect]);

  const value = useMemo<WalletContextType>(
    () => ({
      adapter,
      address,
      chainId,
      chainType,
      connecting,
      isRestoring,
      uiState: internalUiState,
      walletBrand: adapter?.brand ?? null,
      tronWeb: tronWebState,
      connect,
      connectTron,
      disconnect,
      request,
      ensureChain,
      getEthersProvider,
      getSigner,
      getTronWeb,
      setUiState: setInternalUiState,
      eip1193Provider: (window as any).ethereum ?? null,
      evmAddress: chainType === "evm" ? address : null,
      tronAddress: chainType === "tron" ? address : null,
      getAddressForNetwork: (targetId: string) => {
        const isTargetTron = targetId === "0x2b6653dc" || targetId === "0xcd8690dc";
        if (isTargetTron) return chainType === "tron" ? address : null;
        return chainType === "evm" ? address : null;
      },
      capabilities: adapter?.capabilities ?? null,
    }),
    [adapter, address, chainId, chainType, connecting, isRestoring, internalUiState, tronWebState, connect, connectTron, disconnect, request, ensureChain, getEthersProvider, getSigner, getTronWeb],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return context;
}
