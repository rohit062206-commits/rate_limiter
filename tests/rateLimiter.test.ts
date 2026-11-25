import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { SlidingWindowRateLimiter } from "../src/limiter/rateLimiter.js";
import { createRateLimitMiddleware } from "../src/middleware/rateLimitMiddleware.js";
import express from "express";

describe("Rate Limiter Test Suite", () => {
  let memoryStore: MemoryStore;
  let limiter: SlidingWindowRateLimiter;

  beforeEach(() => {
    memoryStore = new MemoryStore();
    // Configure window of 2 seconds and limit of 3 requests for fast, deterministic testing
    limiter = new SlidingWindowRateLimiter({
      windowSec: 2,
      maxRequests: 3,
      store: memoryStore,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createTestApp(customLimiter = limiter) {
    const app = express();
    app.use(express.json());

    const middleware = createRateLimitMiddleware({
      store: memoryStore,
      windowSec: 2,
      maxRequests: 3,
    });

    // Unthrottled health check
    app.get("/health", (_req, res) => res.json({ status: "ok" }));

    // Protected routes
    app.get("/api/data", middleware, (_req, res) => {
      res.json({ message: "data accessed" });
    });

    app.post("/api/action", middleware, (req, res) => {
      res.json({ message: "action executed", payload: req.body });
    });

    return app;
  }

  describe("(1) Requests within the limit succeeding with proper headers", () => {
    it("should allow requests under the limit and set X-RateLimit-* headers", async () => {
      const app = createTestApp();
      const apiKey = "client-user-1";

      const res1 = await request(app)
        .get("/api/data")
        .set("X-Api-Key", apiKey);

      expect(res1.status).toBe(200);
      expect(res1.body).toEqual({ message: "data accessed" });
      expect(res1.headers["x-ratelimit-limit"]).toBe("3");
      expect(res1.headers["x-ratelimit-remaining"]).toBe("2");
      expect(res1.headers["x-ratelimit-reset"]).toBeDefined();

      const res2 = await request(app)
        .get("/api/data")
        .set("X-Api-Key", apiKey);

      expect(res2.status).toBe(200);
      expect(res2.headers["x-ratelimit-limit"]).toBe("3");
      expect(res2.headers["x-ratelimit-remaining"]).toBe("1");

      const res3 = await request(app)
        .post("/api/action")
        .set("X-Api-Key", apiKey)
        .send({ test: true });

      expect(res3.status).toBe(200);
      expect(res3.headers["x-ratelimit-limit"]).toBe("3");
      expect(res3.headers["x-ratelimit-remaining"]).toBe("0");
    });
  });

  describe("(2) Exceeding the limit returning 429 with Retry-After", () => {
    it("should block requests exceeding the limit with 429 Too Many Requests and Retry-After header", async () => {
      const app = createTestApp();
      const apiKey = "client-user-exceed";

      // Consume 3 allowed requests
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .get("/api/data")
          .set("X-Api-Key", apiKey);
        expect(res.status).toBe(200);
      }

      // 4th request exceeds limit
      const blockedRes = await request(app)
        .get("/api/data")
        .set("X-Api-Key", apiKey);

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.headers["retry-after"]).toBeDefined();
      expect(Number(blockedRes.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(blockedRes.headers["x-ratelimit-remaining"]).toBe("0");
      expect(blockedRes.headers["x-ratelimit-limit"]).toBe("3");

      expect(blockedRes.body).toMatchObject({
        error: "Too Many Requests",
        statusCode: 429,
      });
      expect(blockedRes.body.retryAfter).toBeGreaterThanOrEqual(1);
      expect(blockedRes.body.resetAt).toBeDefined();
    });
  });

  describe("(3) Window expiration/reset allowing requests again", () => {
    it("should allow requests again once the rate limit window has expired", async () => {
      vi.useFakeTimers();
      const baseTime = 1700000000000;
      vi.setSystemTime(baseTime);

      const clientId = "client-window-test";

      // Request 1, 2, 3 consume the limit
      const r1 = await limiter.consume(clientId);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);

      const r2 = await limiter.consume(clientId);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);

      const r3 = await limiter.consume(clientId);
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);

      // 4th request is blocked
      const r4 = await limiter.consume(clientId);
      expect(r4.allowed).toBe(false);
      expect(r4.retryAfterSec).toBe(2);

      // Fast-forward past the 2-second window (2100ms)
      vi.setSystemTime(baseTime + 2100);

      // Now requests should be allowed again in a fresh window
      const r5 = await limiter.consume(clientId);
      expect(r5.allowed).toBe(true);
      expect(r5.remaining).toBe(2);
      expect(r5.limit).toBe(3);
    });

    it("should reset client rate limit when explicit reset is called", async () => {
      const clientId = "client-manual-reset";

      // Consume limit
      await limiter.consume(clientId);
      await limiter.consume(clientId);
      await limiter.consume(clientId);

      const blocked = await limiter.consume(clientId);
      expect(blocked.allowed).toBe(false);

      // Reset
      await limiter.reset(clientId);

      // Immediate request succeeds
      const afterReset = await limiter.consume(clientId);
      expect(afterReset.allowed).toBe(true);
      expect(afterReset.remaining).toBe(2);
    });
  });

  describe("(4) Distinct client keys being tracked independently", () => {
    it("should track distinct client keys (API keys, IP headers) independently without cross-interference", async () => {
      const app = createTestApp();

      // Client A exhausts all 3 requests
      for (let i = 0; i < 3; i++) {
        const resA = await request(app)
          .get("/api/data")
          .set("X-Api-Key", "client-alpha");
        expect(resA.status).toBe(200);
      }

      // Client A is blocked
      const blockedA = await request(app)
        .get("/api/data")
        .set("X-Api-Key", "client-alpha");
      expect(blockedA.status).toBe(429);

      // Client B (different API key) has full quota available
      const resB = await request(app)
        .get("/api/data")
        .set("X-Api-Key", "client-beta");
      expect(resB.status).toBe(200);
      expect(resB.headers["x-ratelimit-remaining"]).toBe("2");

      // Client C (different IP via X-Forwarded-For) has full quota available
      const resC = await request(app)
        .get("/api/data")
        .set("X-Forwarded-For", "203.0.113.195");
      expect(resC.status).toBe(200);
      expect(resC.headers["x-ratelimit-remaining"]).toBe("2");
    });
  });
});
