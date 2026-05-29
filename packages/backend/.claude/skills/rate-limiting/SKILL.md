---
name: rate-limiting
description: Apply rate limiting to public endpoints, auth flows, and expensive handlers. Covers IP vs userId fingerprinting, the per-email DoS anti-pattern, burst + sustained buckets, Redis with insurance fallback, and rate limiting vs attempt limiting. Use when adding or reviewing login/OTP/reset endpoints, handlers that trigger email/SMS/external calls, or any public route. Next.js + tRPC and NestJS snippets included.
---

# Rate Limiting

Rate limiting is the difference between an endpoint that works and one that survives the open internet. Most outages and harassment vectors blamed on "DDoS" are actually unprotected endpoints being abused by a single attacker with a script.

## When this skill applies

Trigger on any of:

- Login, signup, OTP, password-reset, magic-link, or email-verification endpoints
- Any handler that triggers an outbound side effect: email, SMS, push, webhook, third-party API call
- Search, report, export, or aggregation endpoints that touch large tables
- File upload / processing endpoints
- Public unauthenticated endpoints of any kind
- A PR that adds a new public procedure, controller, or route
- A bug report involving inbox spam, "the site is slow", shared-office IPs getting blocked, or 429s on legitimate use

If the endpoint can be hit by an unauthenticated client, or it triggers anything more expensive than a single indexed read, it needs a rate limit. Assume yes by default.

## Core principles

1. **Rate limit by what the attacker controls, never by what they target.** Limit by IP for unauthenticated traffic, by user ID for authenticated traffic. *Never* limit by email, account, or victim-supplied identifier — that turns rate limiting into a denial-of-service weapon against the victim (attacker spams `victim@example.com` and locks them out of their own login). *Why:* the goal is to constrain abusers, not to give them a tool to silence anyone they name.
2. **Use a battle-tested library.** Counters look trivial; correct counters under concurrent load are not. Race conditions in rate limit code mean attackers bypass limits. `rate-limiter-flexible` handles atomic increments, expiration, distributed stores, and burst patterns. Don't write your own. *Why:* a rate limiter that is "mostly right" is worse than none — it gives a false sense of security.
3. **Rate limit in middleware, before business logic.** A blocked request must not validate input, query the database, or open external connections. Rate limiting belongs ahead of every handler, not inside it. *Why:* if checking the limit costs as much as serving the request, you've built a DoS amplifier instead of a defense.
4. **Default on, opt-out for exceptions.** Register the rate limit middleware/guard globally so every new endpoint inherits protection. Opt-out (health checks, internal probes) is explicit and visible in code. *Why:* "I forgot to add rate limiting" is the most common production vulnerability for this class; design the system so forgetting is impossible.
5. **Compose fingerprints; don't pick one identifier.** `userId:<id>` when authenticated, `ip:<addr>` when not. Sanitize IPv6 (replace `:` with `_`) so keys don't collide with Redis namespace separators. Optionally include the route path so heavy use of one endpoint doesn't block the others. *Why:* IP alone punishes shared networks (offices, NAT, mobile carriers); user ID alone leaves pre-auth endpoints unprotected.
6. **Use dual-bucket (burst + sustained) limits, not a single flat rate.** Real users are bursty — a page load can fire 10–20 parallel requests in under a second. A flat "2 req/sec" blocks normal navigation. Pair a tight burst window (e.g. 5 req/sec) with a wider sustained window (e.g. 20 req/10s) and require *both* to pass. *Why:* tight limits without bursts frustrate real users; loose limits without sustained caps don't stop sustained abuse.
7. **Use Redis (or equivalent shared store) once you have more than one server, with an in-memory insurance limiter.** In-memory counters scale linearly with server count — 10 servers means an attacker gets 10× the allowed requests. Redis gives a shared counter; the `insuranceLimiter` option falls back to per-server memory when Redis is unreachable, so a cache outage degrades gracefully instead of taking the app down. *Why:* both fail-open (no protection) and fail-closed (total outage) are unacceptable; graceful degradation is the only correct behavior.
8. **Configure per-endpoint, not one-size-fits-all.** Login (sends email) gets stricter limits than a feed read. Health checks get none. Expose configuration as procedure metadata, controller decorators, or route options — not a global magic number. *Why:* the cost of being too strict (frustrated users) and too loose (vulnerable endpoint) are both real, and they tip in different directions per endpoint.
9. **Return `Retry-After` and `X-RateLimit-Reset` headers on 429.** Clients can implement proper backoff; CDNs and load balancers can act on them; observability tooling can show what's being limited. A bare 429 leaves clients hammering uselessly. *Why:* a well-behaved client should be able to recover without escalation; surfacing the reset time is what makes that possible.
10. **Rate limiting ≠ attempt limiting.** They solve different problems and you usually need both. Rate limiting caps *how often* a key (IP, user) can make *requests*. Attempt limiting caps *how many times* a single secret (OTP, password) can be *guessed within one session*. Without attempt limiting, an attacker who stays under the rate limit can still brute-force the OTP given enough time. *Why:* defense in depth — the two limits cover overlapping but distinct attack patterns. *Corollary:* once you have strong per-session attempt limiting (PKCE session-binding + atomic increment + low max-attempts), you can safely run *tighter* request-rate limits on verify endpoints than the default table suggests, because legitimate users don't legitimately retry verifies very often.

## Workflow when adding a rate-limited endpoint

1. **Identify the cost.** What does each request do? Sends an email? Hits an LLM? Generates a report? Cheap operations want generous limits; expensive or victim-affecting ones (email, SMS, audit log entries) want strict ones.
2. **Identify the fingerprint.** Authenticated? Use user ID. Pre-auth (login, signup, reset)? Use IP. Mixed? Use composite (user ID when present, IP otherwise). Optionally namespace by path so endpoints don't share buckets.
3. **Pick the limits.** Start from the defaults in the table below. Adjust based on the cost and expected legitimate use. When unsure, log first, then tighten.
4. **Wire it in middleware/guard, not the handler.** Use the procedure-meta (tRPC) or decorator (NestJS) pattern in the reference files. Inline checks rot.
5. **Confirm headers.** Verify `Retry-After` and `X-RateLimit-Reset` are set on 429 responses.
6. **Confirm opt-out exists for monitoring endpoints.** Health checks, k8s liveness/readiness, metrics scrapes — all need explicit `skip`/`null` markers.

## Default configurations

The values below are starting points, not commandments. Validate against real traffic before treating them as production-ready.

| Endpoint type | Sustained | Burst | Key strategy | Why |
|---|---|---|---|---|
| Login / OTP request | 5 / 60s | — | IP | Each request triggers an email; expensive and abusable. |
| OTP verify / password verify | 20 / 60s | — | IP | Attempt limiting handles guessing; rate limit blocks automation. |
| Password reset | 5 / 60s | — | IP | Same as login — triggers email. |
| Authenticated write (create / update / delete) | 30 / 60s | 5 / 1s | userId | Generous for legit users, blocks runaway scripts. |
| Authenticated read | 2 / 1s | 20 / 10s | userId | Default; supports bursty page loads. |
| Public read | 2 / 1s | 20 / 10s | IP | Same shape, IP keyed. |
| Search / export / report | 10 / 60s | — | userId | Expensive — tighten further if queries are unbounded. |
| Webhook / external trigger | per-source signing | — | source ID | Authentication is the gate; rate limit per known source. |
| Health check / liveness | none, or a loose cap (e.g. 10 / 1s) | — | n/a | Probes poll constantly; full opt-out is simplest, a loose cap is acceptable if you want to bound runaway probes. |

## Pre-merge checklist

Fingerprint
- [ ] No code path rate limits by victim-supplied identifier (email, target user, account number)
- [ ] Authenticated traffic keys on user ID; unauthenticated keys on IP
- [ ] IPv6 colons are sanitized (`:` → `_`) so they don't collide with Redis key separators
- [ ] Composite keys use a clear delimiter (`userId:abc:thread.create`), not ambiguous concatenation
- [ ] The unknown-client fallback returns a labeled, non-empty value (e.g. `'ip:unknown'`) — never an empty string, `null`, or a bare value with no prefix. Empty/unlabeled fallbacks make every anonymous client share a single bucket, and collide with keys that happen to have no prefix.

Configuration
- [ ] Rate limiting is registered globally (`APP_GUARD`, default procedure, default middleware) — not per-endpoint opt-in
- [ ] Sensitive endpoints (login, OTP, password reset, exports) carry an explicit stricter override
- [ ] Health-check and monitoring routes carry an explicit opt-out marker

Mechanics
- [ ] Limits run before any business logic, validation, or DB query
- [ ] Counters use atomic operations (provided by the library — not hand-rolled read-then-write)
- [ ] Burst + sustained dual buckets are used for general-purpose endpoints
- [ ] Multi-instance deployments use Redis (or equivalent) with an in-memory insurance fallback
- [ ] `rejectIfRedisNotReady: true` so Redis hiccups fall back instantly instead of hanging requests

Client experience
- [ ] 429 responses include `Retry-After` (seconds)
- [ ] 429 responses include `X-RateLimit-Reset` (unix timestamp or ISO date) — match what your clients expect
- [ ] Error message is generic ("Rate limit exceeded. Try again in N seconds.") — no internal state disclosure

Defense in depth (auth endpoints specifically)
- [ ] Rate limit is paired with per-session attempt limiting (OTP/password verify)
- [ ] No per-email cooldown (that would re-introduce DoS-against-victim)
- [ ] CAPTCHA is considered for very high-volume abuse, with awareness that virtual browsers (common in gov/enterprise) often break popular CAPTCHA providers

Operational
- [ ] Insurance-limiter activations are logged or emitted as a metric — you want to know when Redis is the weak link
- [ ] 429 rates are observable per endpoint — sudden spikes indicate attack *or* mis-tuned limits

## When to break these rules

- **Single-server deployments**: skip Redis. In-memory limiting with the same library is fine. Add Redis when you scale out, not pre-emptively.
- **Internal-only services behind a private network**: lighter limits may be acceptable; the trust boundary is the network.
- **Throwaway prototypes**: skip rate limiting entirely, but add it back before the first external user touches the system.
- **Service-to-service calls with mutual TLS or signed requests**: the authentication itself is the gate. A flat per-source bucket is usually enough.
- **Append-only ingest endpoints with idempotency keys**: rate limit by source, but be careful — too-strict limits cause backpressure upstream.

The defaults are defaults. Know which one you're skipping and why.

## Pick your reference

Read the principles above first. When you reach for code, load the reference file that matches the codebase:

- [`reference/nextjs-trpc.md`](reference/nextjs-trpc.md) — Next.js + tRPC. Look for `@trpc/server`, `rate-limiter-flexible`, procedure `.meta()` configuration, `t.middleware`.
- [`reference/nestjs.md`](reference/nestjs.md) — NestJS with `rate-limiter-flexible` wrapped in a global `APP_GUARD`. Look for `@nestjs/common`, `CanActivate`, `Reflector`, `SetMetadata` decorators.

The principles are the same across both. The mechanism — declarative tRPC meta vs NestJS decorator + reflector — is what differs. Don't apply tRPC code shapes to NestJS or vice versa.

## See also

- `rate-limiter-flexible` docs — algorithms, store backends, `BurstyRateLimiter`, `insuranceLimiter`
- OWASP API4:2023 — Unrestricted Resource Consumption
