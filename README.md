# Distributed Rate Limiter Service (Node.js + TypeScript + Redis)

A high-performance Express & TypeScript rate limiting service backed by Redis, with an automatic in-memory fallback when Redis is unavailable.

---

## 1. Architecture Overview

The application is structured into decoupled, modular layers:

```
[ Incoming HTTP Request ]
           │
           ▼
[ Express Middleware: rateLimitMiddleware ]
           │
           ├─► Extracts Client Identifier (X-Api-Key > X-Forwarded-For > req.ip)
           │
           ▼
[ Rate Limiter Engine: SlidingWindowRateLimiter ]
           │
           ▼
[ Storage Abstraction Layer: IRateLimitStore ]
           │
     ┌─────┴────────────────────────┐
     ▼                              ▼
[ RedisStore (ioredis) ]    [ MemoryStore (fallback) ]
  (Atomic Lua script)        (Map with lazy expiry)
```

- **Clean Abstraction:** The rate limiter depends solely on `IRateLimitStore` rather than directly coupling to Redis or in-memory stores.
- **Resilient Fallback:** If Redis goes down or is unreachable during local development/testing, the store automatically and gracefully falls back to an in-memory Map store without throwing 500 errors to clients.
- **Separation of Concerns:** `app.ts` (Express routing & configuration) is isolated from `server.ts` (network listener & environment loading), allowing seamless testing with Supertest without port collisions.

---

## 2. Unstructured Data Model

Rate limiting state is modeled as an unstructured / key-value record:

```typescript
interface RateLimitRecord {
  key: string;         // Unique client identifier (e.g., "ip:127.0.0.1", "api-key:secret-key")
  count: number;       // Number of requests consumed in the current window
  windowStart: number; // Unix epoch millisecond timestamp marking the start of the window
  expiresAt: number;   // Unix epoch millisecond timestamp when the window expires
}
```

### Redis Representation
In Redis, each record is persisted as a **Redis Hash** under the key `rl:<clientKey>`:
- `count`: integer counter incremented atomically.
- `windowStart`: epoch ms of the window start.
- `expiresAt`: epoch ms when the window expires.
- **TTL (`EXPIRE`)**: Redis TTL is set to match `windowSec`, enabling automatic cleanup of inactive keys from Redis memory.

---

## 3. Rate-Limiting Algorithm

This service implements a **Sliding Window Counter** algorithm:

1. **Client Identification**: The client is identified in order of precedence:
   - `X-Api-Key` header
   - First IP in `X-Forwarded-For` header
   - Express `req.ip` / `socket.remoteAddress`
2. **Window Evaluation**:
   - If no existing record exists or the current timestamp exceeds `expiresAt`, a new window is initialized with `count = 1`, `windowStart = now`, and `expiresAt = now + windowSec * 1000`.
   - If an active window exists:
     - If `count >= maxRequests`, the request is **rejected** with HTTP `429 Too Many Requests`. The `Retry-After` duration is computed as `ceil((expiresAt - now) / 1000)`.
     - Otherwise, the request is **allowed**, incrementing `count` by 1.
3. **Atomic Operations**: For Redis, an atomic **Lua script** (`EVAL`) runs on the server, guaranteeing that read, increment, window assignment, and TTL setting happen atomically without race conditions under concurrent load.

---

## 4. Response Headers

All rate-limited endpoints include standard rate-limiting headers:

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Maximum allowed requests in the window |
| `X-RateLimit-Remaining` | Remaining requests allowed within the current window |
| `X-RateLimit-Reset` | Unix timestamp (in seconds) when the rate limit window resets |
| `Retry-After` | (Only on 429) Number of seconds to wait before retrying |

---

## 5. Setup & Running Instructions

### Prerequisites
- Node.js (v20+ recommended) or Docker & Docker Compose

### Environment Variables
Copy `.env.example` to `.env`:
```bash
PORT=3000
RATE_LIMIT_WINDOW_SEC=60
RATE_LIMIT_MAX_REQUESTS=100
REDIS_URL=redis://localhost:6379
```

### Option A: Running with Docker Compose (Recommended)
Spins up both the Node.js application and Redis automatically:

```bash
docker compose up --build
```

The service will be available at `http://localhost:3000`.

### Option B: Running Locally

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server (with live reload):
   ```bash
   npm run dev
   ```

3. Build for production:
   ```bash
   npm run build
   node dist/server.js
   ```

4. Run the test suite:
   ```bash
   npm test
   ```

---

## 6. API Endpoints & Example Curl Commands

### 1. Health Check (Unthrottled)
```bash
curl -i http://localhost:3000/health
```
**Response (HTTP 200 OK):**
```json
{
  "status": "ok",
  "uptime": 12.34,
  "timestamp": "2026-11-25T07:30:00.000Z"
}
```

---

### 2. Protected GET Endpoint (HTTP 200 Success)
```bash
curl -i -H "X-Api-Key: test-client" http://localhost:3000/api/data
```
**Headers:**
```http
HTTP/1.1 200 OK
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1764056460
Content-Type: application/json; charset=utf-8
```
**Body:**
```json
{
  "status": "success",
  "message": "You have accessed the protected GET /api/data endpoint.",
  "timestamp": "2026-11-25T07:30:00.000Z",
  "clientIp": "::1"
}
```

---

### 3. Exceeding the Limit (HTTP 429 Too Many Requests)
To test exceeding the limit quickly, set `RATE_LIMIT_MAX_REQUESTS=3` in your `.env` or send requests exceeding your limit:

```bash
curl -i -H "X-Api-Key: spam-client" http://localhost:3000/api/data
```
**Headers (When blocked):**
```http
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 3
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1764056460
Retry-After: 45
Content-Type: application/json; charset=utf-8
```
**Body:**
```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Try again in 45 seconds.",
  "statusCode": 429,
  "retryAfter": 45,
  "resetAt": "2026-11-25T07:31:00.000Z"
}
```

---

### 4. Protected POST Endpoint
```bash
curl -i -X POST http://localhost:3000/api/action \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: test-client" \
  -d '{"action": "process_payment", "amount": 50}'
```

---

### 5. Admin / Debug Reset Rate Limit
Manually reset any client's rate limit window:
```bash
curl -i -X DELETE http://localhost:3000/api/rate-limit/test-client
```
**Response (HTTP 200 OK):**
```json
{
  "status": "success",
  "message": "Rate limit reset successfully for key: test-client"
}
```
