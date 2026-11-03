# Add rate limiting to the public API

## Context

The `/v1/search` and `/v1/export` endpoints have no per-client limits. Last week a single integration partner issued roughly 40k requests in ten minutes and pushed p95 latency past the 2 s SLO for everyone else. We need a limiter that is cheap to evaluate, degrades safely when Redis is unavailable, and can be tuned per API key without a deploy.

This plan covers the server side only. Client SDK retry and backoff changes are tracked separately in `PLAT-412`.

## Approach

Use a token-bucket limiter keyed on API key, stored in Redis, evaluated in middleware before routing. Buckets are refilled lazily on read so there is no background job to operate.

| Setting | Default | Notes |
|---|---|---|
| `capacity` | 600 | Maximum burst per key |
| `refill_per_sec` | 10 | Sustained rate |
| `fail_open` | `true` | Allow traffic if Redis is unreachable |
| `exempt_keys` | `[]` | Internal services that bypass the limiter |

> **Decision:** fail open rather than fail closed. A limiter outage should not become an API outage. We log loudly and page on sustained `fail_open` events instead.

## Files to touch (in order)

1. `app/middleware/rate_limit.py` — new module with `TokenBucket` and `RateLimitMiddleware`.
2. `app/config.py` — add `RateLimitSettings` and wire it into `Settings`.
3. `app/main.py` — register the middleware ahead of the router.
4. `app/api/errors.py` — add a `429` response model that carries `Retry-After`.
5. `tests/middleware/test_rate_limit.py` — unit tests with a fake clock and fake Redis.
6. `docs/api/limits.md` — document the headers and defaults.

## Implementation

### 1. Token bucket

```python
@dataclass
class TokenBucket:
    capacity: int
    refill_per_sec: float

    def take(self, redis: Redis, key: str, now: float) -> tuple[bool, float]:
        """Returns (allowed, seconds_until_next_token)."""
        tokens, updated = redis.hmget(key, "tokens", "updated")
        tokens = float(tokens) if tokens else self.capacity
        updated = float(updated) if updated else now
        tokens = min(self.capacity, tokens + (now - updated) * self.refill_per_sec)
        if tokens < 1:
            return False, (1 - tokens) / self.refill_per_sec
        redis.hset(key, mapping={"tokens": tokens - 1, "updated": now})
        return True, 0.0
```

The read-modify-write above is racy under concurrency. Wrap it in a small Lua script in step 3 so the whole operation runs atomically on the Redis side.

### 2. Middleware

```python
class RateLimitMiddleware:
    def __init__(self, app: ASGIApp, settings: RateLimitSettings, redis: Redis) -> None:
        self.app, self.settings, self.redis = app, settings, redis
        self.bucket = TokenBucket(settings.capacity, settings.refill_per_sec)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        api_key = extract_api_key(scope)
        if api_key in self.settings.exempt_keys:
            return await self.app(scope, receive, send)
        try:
            allowed, wait = self.bucket.take(self.redis, f"rl:{api_key}", time.time())
        except RedisError:
            if not self.settings.fail_open:
                raise
            metrics.increment("rate_limit.fail_open")
            allowed, wait = True, 0.0
        if not allowed:
            return await too_many_requests(send, retry_after=math.ceil(wait))
        return await self.app(scope, receive, send)
```

### 3. Atomic update with Lua

```lua
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or ARGV[1])
local updated = tonumber(redis.call('HGET', KEYS[1], 'updated') or ARGV[3])
tokens = math.min(tonumber(ARGV[1]), tokens + (tonumber(ARGV[3]) - updated) * tonumber(ARGV[2]))
if tokens < 1 then return {0, (1 - tokens) / tonumber(ARGV[2])} end
redis.call('HSET', KEYS[1], 'tokens', tokens - 1, 'updated', ARGV[3])
redis.call('EXPIRE', KEYS[1], math.ceil(tonumber(ARGV[1]) / tonumber(ARGV[2])) * 2)
return {1, 0}
```

### 4. Response headers

Every response, allowed or not, gets:

- `X-RateLimit-Limit` — bucket capacity
- `X-RateLimit-Remaining` — floor of the tokens left
- `Retry-After` — only on `429`, in whole seconds

## Verification

- [ ] Unit tests: bucket refills at the configured rate with a fake clock
- [ ] Unit tests: `fail_open=false` surfaces `RedisError` as a 503
- [ ] Integration: 601 requests in a burst produce exactly one `429`
- [x] Confirm the Redis cluster has `EVAL` enabled (checked with infra on Tuesday)
- [ ] Load test against staging with `k6 run scripts/rate-limit.js --vus 50 --duration 2m`

```bash
uv run pytest tests/middleware/test_rate_limit.py -v
uv run ruff check app/middleware/rate_limit.py
```

## Risks

- **Clock skew between app nodes.** Buckets use the app server clock; a node that is 2 s ahead refills faster. Mitigation: use Redis `TIME` inside the Lua script instead of `ARGV[3]`.
- **Hot keys.** One abusive key hammers one Redis shard. Acceptable for now; revisit if `rl:*` keys exceed 1% of ops.
- **Per-key config lives in settings, not the database.** Changing a partner's limit needs a config push. Follow-up ticket to move limits into the `api_keys` table.

## Open questions

1. Should `/v1/health` be exempt by default, or only when called without an API key?
2. Do we want a separate, lower bucket for `/v1/export`, since each call is roughly 50x more expensive?
3. Who owns the alert threshold for `rate_limit.fail_open`?
