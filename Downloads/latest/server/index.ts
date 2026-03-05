import "dotenv/config";
import { serveStatic } from "./static";
import { createServer } from "http";
import { startScheduler } from "./scheduler";
import { createApp, log } from "./app";

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

  httpServer.listen(listenOptions, () => {
    log(`serving on port ${port}`);
    startScheduler();
  });
})().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
