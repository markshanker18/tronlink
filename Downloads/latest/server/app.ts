import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { registerRoutes } from "./routes";
import { ensureDatabaseCompatibility } from "./db";

declare module "http" {
  interface IncomingMessage {
    rawBody?: Buffer;
  }
}

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export async function createApp() {
  const app = express();
  const isProduction = process.env.NODE_ENV === "production";

  // Required for secure cookies behind proxies (Vercel, Render, etc.).
  app.set("trust proxy", 1);

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.use(express.urlencoded({ extended: false }));

  app.use((req, res, next) => {
    const start = Date.now();
    const requestPath = req.path;
    let capturedJsonResponse: unknown;

    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };

    res.on("finish", () => {
      const duration = Date.now() - start;
      if (!requestPath.startsWith("/api")) {
        return;
      }

      let logLine = `${req.method} ${requestPath} ${res.statusCode} in ${duration}ms`;
      // Avoid logging full JSON responses in production to prevent leaking sensitive data into logs.
      // In development, include a small preview to speed up debugging.
      if (capturedJsonResponse && !isProduction) {
        try {
          const text = JSON.stringify(capturedJsonResponse);
          const preview = text.length > 800 ? `${text.slice(0, 800)}...` : text;
          logLine += ` :: ${preview}`;
        } catch {
          // ignore
        }
      }

      log(logLine);
    });

    next();
  });

  await ensureDatabaseCompatibility();
  await registerRoutes(app);

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const status =
      typeof err === "object" && err && "status" in err
        ? Number((err as { status: number }).status)
        : typeof err === "object" && err && "statusCode" in err
          ? Number((err as { statusCode: number }).statusCode)
          : 500;

    const message =
      typeof err === "object" && err && "message" in err
        ? String((err as { message: string }).message)
        : "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  return app;
}
