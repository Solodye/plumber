# NestJS rate limiting reference

Copy-paste snippets for the NestJS stack using [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible) wrapped in a global `APP_GUARD`. Load this file when the codebase uses `@nestjs/common`, controllers, guards, and `Reflector`.

For Next.js + tRPC codebases, use [`nextjs-trpc.md`](nextjs-trpc.md) instead.

Why a custom guard instead of `@nestjs/throttler`? The built-in throttler is fine for simple cases. The pattern below uses `rate-limiter-flexible` because it gives you `BurstyRateLimiter` (dual-bucket sustained + burst) and `insuranceLimiter` (in-memory fallback when Redis is down) out of the box — the same primitives you'd reach for if you started simple and outgrew the throttler.

## Install

```bash
pnpm add rate-limiter-flexible ioredis
```

## Throttler guard

A single guard wraps a `BurstyRateLimiter`, sets headers on every response, and respects a `@SkipThrottler()` decorator for opt-out.

```ts
// src/modules/core/throttler/throttler.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  OnApplicationShutdown,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Request, Response } from 'express'
import Redis, { Cluster } from 'ioredis'
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino'
import {
  BurstyRateLimiter,
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
} from 'rate-limiter-flexible'

import { ConfigService } from '~/modules/core/config.service'
import { SKIP_THROTTLER_KEY } from './throttler.decorator'
import { ThrottlerException } from './throttler.exception'

export const RATE_LIMIT_NAMESPACE_KEY = 'rate-limit:'
export const RATE_LIMIT_BURST_NAMESPACE_KEY = 'rate-limit-burst:'

@Injectable()
export class ThrottlerGuard implements CanActivate, OnApplicationShutdown {
  private readonly storeClient: Redis | Cluster
  private readonly memoryFallback: RateLimiterMemory
  private readonly limiter: BurstyRateLimiter

  constructor(
    @InjectPinoLogger(ThrottlerGuard.name)
    private readonly logger: PinoLogger,
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {
    this.storeClient = this.buildRedisClient()

    // Insurance fallback — used when Redis is unreachable.
    this.memoryFallback = new RateLimiterMemory({ points: 5, duration: 20 })

    this.limiter = new BurstyRateLimiter(
      new RateLimiterRedis({
        storeClient: this.storeClient,
        rejectIfRedisNotReady: true,
        points: 60,
        duration: 30,
        keyPrefix: RATE_LIMIT_NAMESPACE_KEY,
        insuranceLimiter: this.memoryFallback,
      }),
      new RateLimiterRedis({
        storeClient: this.storeClient,
        rejectIfRedisNotReady: true,
        points: 60,
        duration: 60,
        keyPrefix: RATE_LIMIT_BURST_NAMESPACE_KEY,
        insuranceLimiter: this.memoryFallback,
      }),
    )
  }

  private buildRedisClient(): Redis | Cluster {
    // Use a single node in dev/test; cluster in prod.
    if (this.config.isDevOrTestEnv) {
      return new Redis({
        host: this.config.get('cache.host'),
        port: this.config.get('cache.port'),
        username: this.config.get('cache.username'),
        password: this.config.get('cache.password'),
        retryStrategy: (attempt) => Math.min(attempt * 100, 5000),
      })
    }
    return new Cluster(
      [{
        host: this.config.get('cache.host'),
        port: this.config.get('cache.port'),
      }],
      {
        dnsLookup: (address, callback) => callback(null, address),
        redisOptions: {
          tls: {},
          username: this.config.get('cache.username'),
          password: this.config.get('cache.password'),
          // During managed-Redis (e.g. ElastiCache) failover a former primary
          // demoted to replica throws "READONLY You can't write against a
          // read only replica." Reconnecting on that error lets ioredis
          // re-resolve the new primary instead of staying stuck on the demoted
          // node. Don't blanket-reconnect on every error — that masks real bugs.
          reconnectOnError: (err: Error) => err.message.includes('READONLY'),
        },
      },
    )
  }

  private getKey(req: Request): string {
    // Prefer user ID for authenticated requests — set by your auth guard
    // earlier in the pipeline (req.session?.userId, req.user?.id, etc.).
    const userId = (req as unknown as { session?: { userId?: string } })
      .session?.userId
    if (userId) return `userId:${userId}`

    // Fall back to forwarded IP. x-forwarded-for can be a comma-separated
    // list when behind multiple proxies — take the first (client) entry.
    const xff = req.headers['x-forwarded-for']
    const ip = Array.isArray(xff) ? xff[0] : xff?.split(',')[0]?.trim()
    return `ip:${(ip ?? 'unknown').replaceAll(':', '_')}`
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_THROTTLER_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (skip) return true

    const http = context.switchToHttp()
    const req = http.getRequest<Request>()
    const res = http.getResponse<Response>()

    try {
      const result = await this.limiter.consume(this.getKey(req), 1)
      res.header(
        'X-RateLimit-Limit',
        `${result.remainingPoints + result.consumedPoints}`,
      )
      res.header('X-RateLimit-Remaining', `${result.remainingPoints}`)
      res.header(
        'X-RateLimit-Reset',
        new Date(Date.now() + result.msBeforeNext).toISOString(),
      )
      return true
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        res.header('Retry-After', `${Math.ceil(err.msBeforeNext / 1000)}`)
        throw new ThrottlerException()
      }
      throw err
    }
  }

  // Graceful shutdown — flush the Redis connection on app stop so containers
  // exit cleanly. Without this, ioredis may log reconnect attempts after the
  // process has begun shutting down.
  async onApplicationShutdown(): Promise<void> {
    if (this.storeClient.status === 'ready') {
      try {
        await this.storeClient.quit()
      } catch (err) {
        this.logger.warn({ err }, 'Failed to close Redis connection gracefully')
      }
    }
  }
}
```

```ts
// src/modules/core/throttler/throttler.decorator.ts
import { SetMetadata } from '@nestjs/common'

export const SKIP_THROTTLER_KEY = 'SKIP_THROTTLER_KEY'
export const SkipThrottler = () => SetMetadata(SKIP_THROTTLER_KEY, true)
```

```ts
// src/modules/core/throttler/throttler.exception.ts
import { HttpException, HttpStatus } from '@nestjs/common'

export class ThrottlerException extends HttpException {
  constructor(message = 'Too Many Requests') {
    super(message, HttpStatus.TOO_MANY_REQUESTS)
  }
}
```

## Register globally

Use `APP_GUARD` so every controller method inherits rate limiting automatically. Opt-out is explicit per-handler.

```ts
// src/modules/api.module.ts
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'

import { ThrottlerGuard } from '~/modules/core/throttler'

@Module({
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // ...other guards (auth, etc.) — order them so auth runs first so
    // userId is populated before the throttler reads it.
  ],
})
export class ApiModule {}
```

## Opting out

Health checks, k8s probes, and metrics endpoints should bypass the limiter so probes don't trigger 429s.

```ts
// src/modules/healthcheck/healthcheck.controller.ts
import { Controller, Get } from '@nestjs/common'
import { SkipThrottler } from '~/modules/core/throttler/throttler.decorator'

@Controller('healthcheck')
export class HealthcheckController {
  @Get()
  @SkipThrottler()
  check() {
    return { status: 'ok' }
  }
}
```

## Per-endpoint overrides

The single global guard uses one set of limits. For per-endpoint configuration (stricter login, looser reads), extend the pattern: store config in metadata via a `@Throttle({ points, duration })` decorator, and have the guard read it through `Reflector` before falling back to defaults.

```ts
// src/modules/core/throttler/throttle.decorator.ts
import { SetMetadata } from '@nestjs/common'

export interface ThrottleOptions {
  points: number
  duration: number
  burstPoints?: number
  burstDuration?: number
  keyPrefix?: string
}

export const THROTTLE_OPTIONS_KEY = 'THROTTLE_OPTIONS'
export const Throttle = (options: ThrottleOptions) =>
  SetMetadata(THROTTLE_OPTIONS_KEY, options)
```

Inside `canActivate`, read the decorator and look up (or lazily create) a limiter matching that config — mirror the `rateLimiterCache` Map pattern from the Next.js reference. Apply per-handler:

```ts
@Post('login')
@Throttle({ points: 5, duration: 60, keyPrefix: 'auth:login' })
async login(@Body() dto: EmailLoginDto) {
  // ...
}
```

## IP extraction notes

- Behind a load balancer or CDN, `req.ip` is the proxy's IP, not the client's. Use `x-forwarded-for` (and trust it only when actually behind a known proxy — otherwise it's spoofable).
- On AWS ALB, `x-forwarded-for` is appended to; the **first** entry is the client.
- On Cloudflare, prefer `cf-connecting-ip` (always set by Cloudflare, harder to spoof).
- Enable Express trust proxy if you want `req.ip` to honour `x-forwarded-for`:
  ```ts
  app.set('trust proxy', 1)
  ```
  Be deliberate — naively trusting forwarded headers from arbitrary upstreams is a spoofing vector.

## Common pitfalls

- **Guard order matters.** The throttler reads `req.session.userId`; if your auth guard sets that *after* the throttler runs, you'll always key on IP even for logged-in users. Put auth before throttler in the global guard registration, or have the throttler accept that auth hasn't populated session yet (which is fine — just degrades to IP keying for everyone).
- **Never let `getKey` return an empty string, `undefined`, or a bare unprefixed value.** A common bug: `xff?.split(',')[0] ?? ''` — every anonymous client with no `x-forwarded-for` then shares a single empty-string bucket, and the key is also ambiguous against any prefixed keys. Return `'ip:unknown'` (or similar) as the explicit fallback. If a code comment in your guard claims "public routes don't reach this", verify it against the actual `APP_GUARD` registration — they almost always do.
- **One global limiter is coarse.** The starter `ThrottlerGuard` above uses one `BurstyRateLimiter` for the whole app. That's a sensible default; add the `@Throttle()` decorator pattern when you need per-endpoint tuning (login, exports, search).
- **Redis cluster in dev hurts more than it helps.** Use a single Redis instance locally; switch to cluster in deployed environments via env config.
- **`rejectIfRedisNotReady: true`** is required. Without it, requests hang waiting for Redis reconnect instead of falling back to memory.
- **Cluster failover hangs without `reconnectOnError`.** On managed Redis (ElastiCache, MemoryDB), a former primary can be demoted to a replica during failover. ioredis keeps writing to it and gets `READONLY` errors. Add `reconnectOnError: (err) => err.message.includes('READONLY')` to your cluster options so it re-resolves the new primary. Don't blanket-reconnect on every error — that hides real bugs.
- **Graceful shutdown.** Implement `OnApplicationShutdown` and call `storeClient.quit()` when status is `ready`. Without this, containers exit with ioredis still trying to reconnect, polluting logs and occasionally hanging Kubernetes pod termination.
- **Test environment.** Add `if (this.config.isTestEnv) return true` early in `canActivate` if your test suite is hitting the limiter unintentionally — or use a memory-only limiter with high points in test config.
