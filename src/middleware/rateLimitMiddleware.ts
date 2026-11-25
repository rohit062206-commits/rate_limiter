import { Request, Response, NextFunction } from "express";
import {
  SlidingWindowRateLimiter,
  defaultRateLimiter,
  extractClientIdentifier,
  RateLimiterOptions,
} from "../limiter/index.js";

export interface RateLimitMiddlewareOptions extends RateLimiterOptions {
  keyGenerator?: (req: Request) => string;
}

/**
 * Creates an Express middleware that enforces rate limiting.
 */
export function createRateLimitMiddleware(options?: RateLimitMiddlewareOptions) {
  const limiter =
    options?.windowSec || options?.maxRequests || options?.store
      ? new SlidingWindowRateLimiter(options)
      : defaultRateLimiter;

  const keyGenerator = options?.keyGenerator ?? extractClientIdentifier;

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const clientId = keyGenerator(req);
      const result = await limiter.consume(clientId);

      // Attach standard rate limit headers
      res.setHeader("X-RateLimit-Limit", result.limit);
      res.setHeader("X-RateLimit-Remaining", result.remaining);
      // X-RateLimit-Reset is typically epoch seconds
      res.setHeader("X-RateLimit-Reset", Math.ceil(result.resetAt / 1000));

      if (!result.allowed) {
        res.setHeader("Retry-After", result.retryAfterSec);

        res.status(429).json({
          error: "Too Many Requests",
          message: `Rate limit exceeded. Try again in ${result.retryAfterSec} seconds.`,
          statusCode: 429,
          retryAfter: result.retryAfterSec,
          resetAt: new Date(result.resetAt).toISOString(),
        });
        return;
      }

      next();
    } catch (err) {
      // In case of an unexpected rate limiter error, pass control to global error handler
      next(err);
    }
  };
}

export const rateLimitMiddleware = createRateLimitMiddleware();
