import express, { Express, Request, Response } from "express";
import apiRouter from "./routes/api.js";

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  // Public unthrottled health check route
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Mount API router under /api
  app.use("/api", apiRouter);

  return app;
}

export const app = createApp();
