import { Request } from "express";
import { IRateLimitStore, rateLimitStore } from "../store/index.js";

export interface RateLimiterOptions {
  windowSec?: number;
  maxRequests?: number;
  store?: IRateLimitStore;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSec: number;
}

/**
 * Extracts client identifier from incoming HTTP request.
 * Priority:
 * 1. X-Api-Key header
 * 2. X-Forwarded-For header (first IP in list)
 * 3. Express req.ip or socket remoteAddress
 */
export function extractClientIdentifier(req: Request): string {
  const apiKey = req.headers["x-api-key"];
  if (apiKey && typeof apiKey === "string" && apiKey.trim().length > 0) {
    return `api-key:${apiKey.trim()}`;
  }

  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) {
    const rawIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor.split(",")[0];
    if (rawIp && rawIp.trim().length > 0) {
      return `ip:${rawIp.trim()}`;
    }
  }

  const clientIp = req.ip || req.socket?.remoteAddress || "127.0.0.1";
  return `ip:${clientIp}`;
}

export class SlidingWindowRateLimiter {
  private windowSec: number;
  private maxRequests: number;
  private store: IRateLimitStore;

  constructor(options?: RateLimiterOptions) {
    this.windowSec =
      options?.windowSec ??
      Number(process.env.RATE_LIMIT_WINDOW_SEC) ||
      60;

    this.maxRequests =
      options?.maxRequests ??
      Number(process.env.RATE_LIMIT_MAX_REQUESTS) ||
      100;

    this.store = options?.store ?? rateLimitStore;
  }

  /**
   * Evaluates rate limit for a client identifier using sliding window counter.
   */
  async consume(clientId: string): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = this.windowSec * 1000;

    // Check existing record
    const existing = await this.store.getRecord(clientId);

    if (!existing || existing.expiresAt <= now) {
      // First request or window already expired: start new window
      const record = await this.store.incrementWithExpiry(clientId, this.windowSec);
      const remaining = Math.max(0, this.maxRequests - record.count);
      const resetAt = record.expiresAt;

      return {
        allowed: true,
        limit: this.maxRequests,
        remaining,
        resetAt,
        retryAfterSec: 0,
      };
    }

    // Existing active window: calculate sliding window progress
    const elapsedMs = now - existing.windowStart;
    const timeRemainingMs = Math.max(0, existing.expiresAt - now);
    const retryAfterSec = Math.ceil(timeRemainingMs / 1000);

    // If limit already exceeded
    if (existing.count >= this.maxRequests) {
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        resetAt: existing.expiresAt,
        retryAfterSec,
      };
    }

    // Still within limit: increment
    const updatedRecord = await this.store.incrementWithExpiry(clientId, this.windowSec);
    const remaining = Math.max(0, this.maxRequests - updatedRecord.count);

    return {
      allowed: true,
      limit: this.maxRequests,
      remaining,
      resetAt: existing.expiresAt,
      retryAfterSec: 0,
    };
  }

  /**
   * Reset rate limit state for a client identifier.
   */
  async reset(clientId: string): Promise<void> {
    await this.store.resetKey(clientId);
  }
}

export const defaultRateLimiter = new SlidingWindowRateLimiter();
