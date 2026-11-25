export interface RateLimitRecord {
  key: string;
  count: number;
  windowStart: number;
  expiresAt: number;
}

export interface IRateLimitStore {
  getRecord(key: string): Promise<RateLimitRecord | null>;
  incrementWithExpiry(key: string, windowSec: number): Promise<RateLimitRecord>;
  resetKey(key: string): Promise<void>;
}
