# Next.js + tRPC rate limiting reference

Copy-paste snippets for the Next.js + tRPC stack using [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible) with optional Redis backing. Load this file when the codebase has `@trpc/server` and `rate-limiter-flexible` (or you're about to add them).

For NestJS codebases, use [`nestjs.md`](nestjs.md) instead — the idioms (guards, decorators, `Reflector`) differ.

## Install

```bash
pnpm add rate-limiter-flexible
# Optional, for distributed limiting:
pnpm add ioredis
```

## Service layer

A single module exposes a `checkRateLimit` function and a fingerprint helper. The middleware calls into it; routers configure it via procedure metadata.

```ts
// src/server/modules/rate-limit/types.ts
export interface RateLimiterConfig {
  /** Sustained-bucket points per `duration` window */
  points?: number
  /** Sustained-bucket window in seconds */
  duration?: number
  /** Burst-bucket points per `burstDuration` window */
  burstPoints?: number
  /** Burst-bucket window in seconds */
  burstDuration?: number
  /** Namespace prefix so different limiters don't collide on the same key */
  keyPrefix?: string
}
```

```ts
// src/server/modules/rate-limit/rate-limit.service.ts
import type { RateLimiterRes } from 'rate-limiter-flexible'
import {
  BurstyRateLimiter,
  RateLimiterMemory,
  RateLimiterRedis,
} from 'rate-limiter-flexible'

import { redis } from '~/server/redis' // returns Redis | null
import type { RateLimiterConfig } from './types'

export const RATE_LIMIT_NAMESPACE_KEY = 'rate-limit:'
export const RATE_LIMIT_BURST_NAMESPACE_KEY = 'rate-limit-burst:'

// Defaults: 2 req/sec sustained, with bursts up to 5 in any 10s window.
// Override per endpoint via tRPC meta.
const defaultConfig: Required<RateLimiterConfig> = {
  points: 2,
  duration: 1,
  burstPoints: 5,
  burstDuration: 10,
  keyPrefix: 'app',
}

// Cache limiters per-config so identical configs share counter state.
const rateLimiterCache = new Map<string, BurstyRateLimiter>()

const createRateLimiter = (config: RateLimiterConfig): BurstyRateLimiter => {
  const mergedConfig = { ...defaultConfig, ...config }
  const cacheKey = JSON.stringify(mergedConfig)
  const cached = rateLimiterCache.get(cacheKey)
  if (cached) return cached

  // Memory limiter — used as insurance when Redis is healthy, or as the
  // sole limiter when there is no Redis (single-server / local dev).
  const memorySustained = new RateLimiterMemory({
    points: mergedConfig.points,
    duration: mergedConfig.duration,
  })

  if (!redis) {
    const memoryBurst = new RateLimiterMemory({
      points: mergedConfig.burstPoints,
      duration: mergedConfig.burstDuration,
    })
    const limiter = new BurstyRateLimiter(memorySustained, memoryBurst)
    rateLimiterCache.set(cacheKey, limiter)
    return limiter
  }

  const limiter = new BurstyRateLimiter(
    new RateLimiterRedis({
      storeClient: redis,
      rejectIfRedisNotReady: true,
      points: mergedConfig.points,
      duration: mergedConfig.duration,
      keyPrefix: `${RATE_LIMIT_NAMESPACE_KEY}${mergedConfig.keyPrefix}:`,
      insuranceLimiter: memorySustained,
    }),
    new RateLimiterRedis({
      storeClient: redis,
      rejectIfRedisNotReady: true,
      points: mergedConfig.burstPoints,
      duration: mergedConfig.burstDuration,
      keyPrefix: `${RATE_LIMIT_BURST_NAMESPACE_KEY}${mergedConfig.keyPrefix}:`,
      insuranceLimiter: new RateLimiterMemory({
        points: mergedConfig.burstPoints,
        duration: mergedConfig.burstDuration,
      }),
    }),
  )

  rateLimiterCache.set(cacheKey, limiter)
  return limiter
}

export const checkRateLimit = async ({
  key,
  options = {},
  pointsToConsume = 1,
}: {
  key: string
  options?: RateLimiterConfig
  pointsToConsume?: number
}): Promise<RateLimiterRes> => {
  const limiter = createRateLimiter(options)
  return limiter.consume(key, pointsToConsume)
}

export const createRateLimitFingerprint = ({
  userId,
  ipAddress,
  path,
}: {
  userId: string | undefined
  ipAddress: string | null
  path: string
}) => {
  if (userId) {
    return `userId:${userId}:${path}`
  }
  // Sanitize IPv6 colons so they don't collide with the Redis "ns:subkey" separator.
  return `ip:${ipAddress?.replaceAll(':', '_') ?? 'unknown'}:${path}`
}
```

## tRPC middleware

The middleware reads per-procedure options from `meta`, looks up the fingerprint from context, and converts `RateLimiterRes` rejections into a `TRPCError` with the right headers.

```ts
// src/server/api/trpc.ts
import { initTRPC, TRPCError } from '@trpc/server'
import { RateLimiterRes } from 'rate-limiter-flexible'

import { extractIpAddress } from '~/server/utils/request'
import {
  checkRateLimit,
  createRateLimitFingerprint,
} from '~/server/modules/rate-limit/rate-limit.service'
import type { RateLimiterConfig } from '~/server/modules/rate-limit/types'

interface Meta {
  // null = explicitly disable rate limiting (e.g. health checks).
  // undefined (default) = use default rate limit.
  // object = override with custom config.
  rateLimitOptions?: RateLimiterConfig | null
}

const t = initTRPC
  .context<typeof createTRPCContext>()
  .meta<Meta>()
  .create({
    defaultMeta: { rateLimitOptions: {} }, // default-on
    // ...transformer, errorFormatter
  })

const rateLimitMiddleware = t.middleware(async ({ ctx, next, meta, path }) => {
  const rateLimitOptions =
    meta?.rateLimitOptions === undefined ? {} : meta.rateLimitOptions

  if (rateLimitOptions === null) return next()
  if (process.env.NODE_ENV === 'test') return next()

  try {
    await checkRateLimit({
      key: createRateLimitFingerprint({
        ipAddress: extractIpAddress(ctx.headers),
        userId: ctx.session.userId,
        path,
      }),
      options: rateLimitOptions,
    })
    return next()
  } catch (error) {
    if (error instanceof RateLimiterRes) {
      const retryAfter = Math.ceil(error.msBeforeNext / 1000)
      ctx.resHeaders?.set('Retry-After', String(retryAfter))
      ctx.resHeaders?.set(
        'X-RateLimit-Reset',
        String(Math.ceil((Date.now() + error.msBeforeNext) / 1000)),
      )
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
      })
    }
    throw error
  }
})

// Every procedure gets rate limiting by default. Opt out per-procedure via `.meta()`.
export const publicProcedure = t.procedure.use(rateLimitMiddleware)
export const protectedProcedure = publicProcedure.use(authMiddleware)
```

## Per-endpoint overrides

```ts
// Strict limit for login (triggers email)
login: publicProcedure
  .meta({
    rateLimitOptions: {
      points: 5,
      duration: 60,
      keyPrefix: 'auth:login',
    },
  })
  .input(emailLoginSchema)
  .mutation(/* ... */)

// Looser limit for OTP verify (attempt limiting handles guessing)
verifyOtp: publicProcedure
  .meta({
    rateLimitOptions: {
      points: 20,
      duration: 60,
      keyPrefix: 'auth:verify',
    },
  })
  .input(verifyOtpSchema)
  .mutation(/* ... */)

// Opt out entirely for health checks
check: publicProcedure
  .meta({ rateLimitOptions: null })
  .query(() => ({ status: 'ok' }))
```

## IP extraction

`ctx.headers` typically comes from the Next.js request. Use `x-forwarded-for` (proxy/CDN-aware) with a sensible fallback. If you trust a CDN (Cloudflare, Vercel), prefer their specific headers.

```ts
// src/server/utils/request.ts
export const extractIpAddress = (headers: Headers | null): string | null => {
  if (!headers) return null
  // Prefer the most trustworthy header your edge sets. Cloudflare's
  // cf-connecting-ip is always set by Cloudflare and harder to spoof than
  // x-forwarded-for. Order: most-trusted edge header → standard proxy
  // header → fallback.
  const forwarded =
    headers.get('cf-connecting-ip') ??
    headers.get('x-forwarded-for') ??
    headers.get('x-real-ip')
  if (!forwarded) return null
  // x-forwarded-for can be a comma-separated list of hops; the first entry
  // is the original client.
  return forwarded.split(',')[0]!.trim()
}
```

If running behind Vercel, prefer `headers.get('x-vercel-forwarded-for')` (trusted) over `x-forwarded-for` (spoofable when not behind a known proxy).

## Redis client

```ts
// src/server/redis.ts
import Redis from 'ioredis'

const createRedisClient = (): Redis | null => {
  if (!process.env.CACHE_HOSTNAME) {
    console.warn('CACHE_HOSTNAME not set — using in-memory rate limiting only.')
    return null
  }
  const client = new Redis({
    host: process.env.CACHE_HOSTNAME,
    port: Number(process.env.CACHE_PORT),
    username: process.env.CACHE_USERNAME,
    password: process.env.CACHE_PASSWORD,
    retryStrategy: (attempt) => Math.min(attempt * 100, 5000),
  })
  client.on('error', (err) => console.error('redis error:', err.message))
  return client
}

const globalForRedis = global as unknown as { redis?: Redis | null }
export const redis = globalForRedis.redis ?? createRedisClient()
if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis
```

## Common pitfalls

- **`Math.random()` for nothing here** — irrelevant to rate limiting, but a frequent neighbour bug in auth code.
- **Composite keys via string concat without delimiter.** `userId123thread.create` collides with `userId12:3thread.create`. Always use a separator and JSON-serialize when in doubt.
- **Forgetting `rejectIfRedisNotReady: true`.** Without it, Redis reconnect attempts can stall every request for seconds during a brief outage instead of falling back to memory instantly.
- **Rate limiting Next.js route handlers in `app/api/*`** — the tRPC middleware doesn't cover these. Wrap them with a thin helper that calls `checkRateLimit` before the handler body, or migrate them to tRPC.
- **Skipping rate limit in tests.** Fine — but don't accidentally do this in CI for integration tests that exercise the limiter itself.
