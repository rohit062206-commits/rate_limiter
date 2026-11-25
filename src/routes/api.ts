import { Router, Request, Response } from "express";
import { rateLimitMiddleware } from "../middleware/index.js";
import { defaultRateLimiter } from "../limiter/index.js";

const router = Router();

// Rate-limited sample GET endpoint
router.get("/data", rateLimitMiddleware, (req: Request, res: Response) => {
  res.json({
    status: "success",
    message: "You have accessed the protected GET /api/data endpoint.",
    timestamp: new Date().toISOString(),
    clientIp: req.ip,
  });
});

// Rate-limited sample POST endpoint
router.post("/action", rateLimitMiddleware, (req: Request, res: Response) => {
  res.json({
    status: "success",
    message: "Action executed successfully under rate-limited endpoint.",
    receivedPayload: req.body,
    timestamp: new Date().toISOString(),
  });
});

// Admin / Debug route for resetting rate limits during testing (bypasses rate limit)
router.delete("/rate-limit/:key", async (req: Request, res: Response) => {
  try {
    const rawKey = req.params.key;
    if (!rawKey) {
      res.status(400).json({ error: "Rate limit key parameter is required." });
      return;
    }

    // Support resetting either with raw key or prefixes (ip: / api-key:)
    await defaultRateLimiter.reset(rawKey);

    // Also reset prefixed versions if rawKey was passed without prefix
    if (!rawKey.includes(":")) {
      await defaultRateLimiter.reset(`ip:${rawKey}`);
      await defaultRateLimiter.reset(`api-key:${rawKey}`);
    }

    res.json({
      status: "success",
      message: `Rate limit reset successfully for key: ${rawKey}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({
      error: "Internal Server Error",
      message,
    });
  }
});

export default router;
