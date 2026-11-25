import Redis from "ioredis";
import { IRateLimitStore, RateLimitRecord } from "./types.js";
import { MemoryStore } from "./memoryStore.js";

// Lua script to atomically increment or initialize rate limit record with TTL in Redis
const INCREMENT_SCRIPT = `
local key = KEYS[1]
local windowSec = tonumber(ARGV[1])
local now = tonumber(ARGV[2])

local exists = redis.call('EXISTS', key)

if exists == 0 then
  local windowStart = now
  local expiresAt = now + (windowSec * 1000)
  redis.call('HSET', key, 'count', 1, 'windowStart', windowStart, 'expiresAt', expiresAt)
  redis.call('EXPIRE', key, windowSec)
  return { 1, windowStart, expiresAt }
else
  local count = redis.call('HINCRBY', key, 'count', 1)
  local windowStart = tonumber(redis.call('HGET', key, 'windowStart'))
  local expiresAt = tonumber(redis.call('HGET', key, 'expiresAt'))
  return { count, windowStart, expiresAt }
end
`;

export class RateLimitStore implements IRateLimitStore {
  private redisClient: Redis | null = null;
  private memoryStore: MemoryStore = new MemoryStore();
  private isRedisAvailable = false;
  private readonly redisKeyPrefix = "rl:";

  constructor(redisUrl?: string) {
    const url = redisUrl || process.env.REDIS_URL;

    if (url) {
      try {
        this.redisClient = new Redis(url, {
          lazyConnect: false,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          retryStrategy(times) {
            // Reconnect backoff with max 2 seconds retry, safe for testing environments
            return Math.min(times * 200, 2000);
          },
          reconnectOnError(_err) {
            return false;
          },
        });

        this.redisClient.on("connect", () => {
          this.isRedisAvailable = true;
          console.log("[RateLimitStore] Connected to Redis.");
        });

        this.redisClient.on("ready", () => {
          this.isRedisAvailable = true;
        });

        this.redisClient.on("error", (err) => {
          if (this.isRedisAvailable) {
            console.warn("[RateLimitStore] Redis error encountered, falling back to memory:", err.message);
          }
          this.isRedisAvailable = false;
        });

        this.redisClient.on("close", () => {
          this.isRedisAvailable = false;
        });
      } catch (err: unknown) {
        console.warn("[RateLimitStore] Failed to initialize Redis client. Defaulting to in-memory store.", err);
        this.isRedisAvailable = false;
      }
    } else {
      console.log("[RateLimitStore] No REDIS_URL provided. Using in-memory store.");
    }
  }

  public get isConnectedToRedis(): boolean {
    return this.isRedisAvailable;
  }

  async getRecord(key: string): Promise<RateLimitRecord | null> {
    const storageKey = `${this.redisKeyPrefix}${key}`;

    if (this.isRedisAvailable && this.redisClient) {
      try {
        const raw = await this.redisClient.hgetall(storageKey);
        if (!raw || Object.keys(raw).length === 0) {
          return null;
        }

        const now = Date.now();
        const expiresAt = Number(raw.expiresAt);
        if (expiresAt && expiresAt <= now) {
          await this.resetKey(key);
          return null;
        }

        return {
          key,
          count: Number(raw.count),
          windowStart: Number(raw.windowStart),
          expiresAt,
        };
      } catch (err) {
        console.warn("[RateLimitStore] Redis getRecord failed, falling back to memory store:", err);
        this.isRedisAvailable = false;
      }
    }

    return this.memoryStore.getRecord(key);
  }

  async incrementWithExpiry(key: string, windowSec: number): Promise<RateLimitRecord> {
    const storageKey = `${this.redisKeyPrefix}${key}`;
    const now = Date.now();

    if (this.isRedisAvailable && this.redisClient) {
      try {
        const result = (await this.redisClient.eval(
          INCREMENT_SCRIPT,
          1,
          storageKey,
          windowSec,
          now
        )) as [number, number, number];

        return {
          key,
          count: Number(result[0]),
          windowStart: Number(result[1]),
          expiresAt: Number(result[2]),
        };
      } catch (err) {
        console.warn("[RateLimitStore] Redis incrementWithExpiry failed, falling back to memory store:", err);
        this.isRedisAvailable = false;
      }
    }

    return this.memoryStore.incrementWithExpiry(key, windowSec);
  }

  async resetKey(key: string): Promise<void> {
    const storageKey = `${this.redisKeyPrefix}${key}`;

    if (this.isRedisAvailable && this.redisClient) {
      try {
        await this.redisClient.del(storageKey);
      } catch (err) {
        console.warn("[RateLimitStore] Redis resetKey failed, falling back to memory store:", err);
        this.isRedisAvailable = false;
      }
    }

    await this.memoryStore.resetKey(key);
  }
}

export const rateLimitStore = new RateLimitStore();
