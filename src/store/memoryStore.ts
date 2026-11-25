import { IRateLimitStore, RateLimitRecord } from "./types.js";

export class MemoryStore implements IRateLimitStore {
  private store = new Map<string, RateLimitRecord>();

  async getRecord(key: string): Promise<RateLimitRecord | null> {
    const record = this.store.get(key);
    if (!record) {
      return null;
    }

    const now = Date.now();
    if (record.expiresAt <= now) {
      this.store.delete(key);
      return null;
    }

    return { ...record };
  }

  async incrementWithExpiry(key: string, windowSec: number): Promise<RateLimitRecord> {
    const now = Date.now();
    const existing = await this.getRecord(key);

    if (!existing) {
      const windowStart = now;
      const expiresAt = now + windowSec * 1000;
      const newRecord: RateLimitRecord = {
        key,
        count: 1,
        windowStart,
        expiresAt,
      };
      this.store.set(key, newRecord);
      return { ...newRecord };
    }

    const updatedRecord: RateLimitRecord = {
      ...existing,
      count: existing.count + 1,
    };
    this.store.set(key, updatedRecord);
    return { ...updatedRecord };
  }

  async resetKey(key: string): Promise<void> {
    this.store.delete(key);
  }
}
