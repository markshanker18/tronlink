import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BrowserProvider, type JsonRpcSigner } from "ethers";
import { detectWalletBrand, isMetaMaskInstalled, type WalletBrand } from "./metamask";

// This project intentionally supports *only* injected EIP-1193 wallets.
// Examples: MetaMask extension, Trust Wallet in-app browser, etc.
type WalletConnector = "injected";

type Eip1193Params = unknown[] | Record<string, unknown> | undefined;
type Eip1193RequestArgs = { method: string; params?: Eip1193Params };

export type Eip1193Provider = {
  request: (args: Eip1193RequestArgs) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

interface WalletContextType {
  connector: WalletConnector | null;
  address: string | null;
  chainId: string | null;
  connecting: boolean;
  eip1193Provider: Eip1193Provider | null;
  walletBrand: WalletBrand | null;

  connect: () => Promise<{ address: string; chainId: string; connector: WalletConnector }>;
  disconnect: () => Promise<void>;
  request: (method: string, params?: Eip1193Params) => Promise<unknown>;
  ensureChain: (targetChainIdHex: string, networkName?: string) => Promise<void>;
  getEthersProvider: () => BrowserProvider;
  getSigner: () => Promise<JsonRpcSigner>;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

function getInjectedProvider(): Eip1193Provider {
  if (!isMetaMaskInstalled()) {
    throw new Error(
      "Wallet not detected. Open this page in your wallet's in-app browser (MetaMask / Trust Wallet) or install an injected wallet extension.",
    );
  }
  return window.ethereum as Eip1193Provider;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [connector, setConnector] = useState<WalletConnector | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [eip1193Provider, setEip1193Provider] = useState<Eip1193Provider | null>(null);
  const [walletBrand, setWalletBrand] = useState<WalletBrand | null>(null);

  const connectingRef = useRef(false);

  const request = useCallback(
    async (method: string, params?: Eip1193Params): Promise<unknown> => {
      if (!eip1193Provider) {
        throw new Error("Wallet not connected");
      }
      return eip1193Provider.request({ method, params });
    },
    [eip1193Provider],
  );

  const connect = useCallback(
    async (): Promise<{ address: string; chainId: string; connector: WalletConnector }> => {
      if (connectingRef.current) {
        throw new Error("Wallet connection already in progress");
      }

      connectingRef.current = true;
      setConnecting(true);
      try {
        const provider = getInjectedProvider();
        const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
        const addr = accounts?.[0];
        if (!addr) throw new Error("No account returned from wallet");
        const injectedChainId = (await provider.request({ method: "eth_chainId" })) as string;
        const brand = detectWalletBrand(provider as any);

        setConnector("injected");
        setEip1193Provider(provider);
        setAddress(addr);
        setChainId(injectedChainId);
        setWalletBrand(brand);

        return { address: addr, chainId: injectedChainId, connector: "injected" };
      } finally {
        connectingRef.current = false;
        setConnecting(false);
      }
    },
    [],
  );

  const disconnect = useCallback(async (): Promise<void> => {
    setConnector(null);
    setEip1193Provider(null);
    setAddress(null);
    setChainId(null);
    setWalletBrand(null);
  }, []);

  const ensureChain = useCallback(
    async (targetChainIdHex: string, networkName?: string): Promise<void> => {
      if (!eip1193Provider) throw new Error("Wallet not connected");
      const current = (await eip1193Provider.request({ method: "eth_chainId" })) as string;
      if (current?.toLowerCase() === targetChainIdHex.toLowerCase()) {
        setChainId(current);
        return;
      }

      try {
        await eip1193Provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: targetChainIdHex }],
        });
      } catch {
        const name = networkName || `chain ${Number.parseInt(targetChainIdHex, 16)}`;
        throw new Error(`Please switch your wallet to ${name} (${targetChainIdHex}) and try again.`);
      }

      const after = (await eip1193Provider.request({ method: "eth_chainId" })) as string;
      setChainId(after);
    },
    [eip1193Provider],
  );

  const getEthersProvider = useCallback((): BrowserProvider => {
    if (!eip1193Provider) throw new Error("Wallet not connected");
    return new BrowserProvider(eip1193Provider as unknown as any);
  }, [eip1193Provider]);

  const getSigner = useCallback(async (): Promise<JsonRpcSigner> => {
    const provider = getEthersProvider();
    return provider.getSigner();
  }, [getEthersProvider]);

  // Restore session if the injected wallet is already authorized.
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      if (typeof window === "undefined") return;
      if (!isMetaMaskInstalled()) return;

      try {
        const provider = getInjectedProvider();
        const brand = detectWalletBrand(provider as any);
        setWalletBrand(brand);
        const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
        if (cancelled) return;

        const addr = accounts?.[0];
        if (!addr) return;

        const injectedChainId = (await provider.request({ method: "eth_chainId" })) as string;
        if (cancelled) return;

        setConnector("injected");
        setEip1193Provider(provider);
        setAddress(addr);
        setChainId(injectedChainId);
      } catch {
        // ignore
      }
    };

    restore();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep address/chain in sync with the active provider.
  useEffect(() => {
    if (!eip1193Provider?.on) return;

    const handleAccountsChanged = (accountsUnknown: unknown) => {
      const accounts = Array.isArray(accountsUnknown) ? (accountsUnknown as string[]) : [];
      const addr = accounts?.[0] || null;
      setAddress(addr);
      if (!addr) {
        setConnector(null);
        setEip1193Provider(null);
        setChainId(null);
        setWalletBrand(null);
      }
    };

    const handleChainChanged = (chainIdUnknown: unknown) => {
      const newChainId = typeof chainIdUnknown === "string" ? chainIdUnknown : null;
      if (newChainId) setChainId(newChainId);
    };

    const handleDisconnect = () => {
      setConnector(null);
      setEip1193Provider(null);
      setAddress(null);
      setChainId(null);
      setWalletBrand(null);
    };

    eip1193Provider.on("accountsChanged", handleAccountsChanged);
    eip1193Provider.on("chainChanged", handleChainChanged);
    eip1193Provider.on("disconnect", handleDisconnect);

    return () => {
      eip1193Provider.removeListener?.("accountsChanged", handleAccountsChanged);
      eip1193Provider.removeListener?.("chainChanged", handleChainChanged);
      eip1193Provider.removeListener?.("disconnect", handleDisconnect);
    };
  }, [eip1193Provider]);

  const value = useMemo<WalletContextType>(
    () => ({
      connector,
      address,
      chainId,
      connecting,
      eip1193Provider,
      walletBrand,
      connect,
      disconnect,
      request,
      ensureChain,
      getEthersProvider,
      getSigner,
    }),
    [
      connector,
      address,
      chainId,
      connecting,
      eip1193Provider,
      walletBrand,
      connect,
      disconnect,
      request,
      ensureChain,
      getEthersProvider,
      getSigner,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextType {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
