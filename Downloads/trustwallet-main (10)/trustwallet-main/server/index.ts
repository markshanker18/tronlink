import "dotenv/config";
import { serveStatic } from "./static";
import { createServer } from "http";
import { startScheduler } from "./scheduler";
import { createApp, log } from "./app";
import "./workers-billing";
import "./workers-webhooks";
import { executionQueue, webhookQueue } from "./queue";

(async () => {
  const app = await createApp();
  const httpServer = createServer(app);

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // Always serve the app on the port specified in the environment variable PORT.
  // Default to 5000 if not specified.
  const port = parseInt(process.env.PORT || "5000", 10);
  const listenOptions: { port: number; host: string } = {
    port,
    host: "0.0.0.0",
  };

  httpServer.on("error", (err) => {
    console.error("[server] httpServer error:", err);
    process.exit(1);
  });

  httpServer.listen(listenOptions, async () => {
    log(`serving on port ${port}`);
    startScheduler();
    console.log("[Worker] Queues and workers initialized.");
    
    // Initialize real-time Blockchain Indexing for all active networks
    // This allows the server to detect payment finalization and trigger webhooks.
    if (process.env.NODE_ENV === "production" || process.env.INDEXER_ENABLED === "true") {
      try {
        const { BlockchainIndexer } = await import("./services/indexer");
        const { SUPPORTED_EVM_NETWORKS, SUPPORTED_TRON_NETWORKS } = await import("../shared/chain");
        const sharedContracts = await import("../shared/contracts");
        const tronContracts = await import("../shared/tron-contracts");

        // EVM Networks
        for (const network of SUPPORTED_EVM_NETWORKS) {
          const contractAddress = sharedContracts.getContractForNetwork(network.chainId);
          const { getRpcUrls } = await import("./rpc");
          const rpcUrls = getRpcUrls(network.chainId);
          if (contractAddress && rpcUrls[0]) {
            BlockchainIndexer.startTracking(network.chainId, contractAddress, rpcUrls[0]).catch(err => {
               console.error(`[Indexer] Failed to start tracking EVM ${network.chainId}: ${err.message}`);
            });
          }
        }

        // TRON Networks
        for (const network of SUPPORTED_TRON_NETWORKS) {
          const contractAddress = tronContracts.getTronContractForNetwork(network.chainId);
          if (contractAddress) {
            BlockchainIndexer.startTracking(network.chainId, contractAddress, "").catch(err => {
              console.error(`[Indexer] Failed to start tracking TRON ${network.chainId}: ${err.message}`);
            });
          }
        }
      } catch (err: any) {
        console.error("[Indexer] Failed to initialize indexers:", err.message);
      }
    }
  });
})().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
