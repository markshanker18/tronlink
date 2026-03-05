import type { Express } from "express";

let appPromise: Promise<Express> | null = null;

export default async function handler(req: any, res: any) {
  try {
    const { createApp } = await import("../server/app.js");
    if (!appPromise) {
      appPromise = createApp();
    }
    const app = await appPromise;
    return app(req, res);
  } catch (err: any) {
    console.error("Initialization error:", err);
    res.status(500).json({
      error: "Initialization error",
      message: err.message,
      stack: err.stack,
    });
  }
}
