# Secure Auth — Reference Index

Open the file matching the pattern you need. Each file is self-contained and includes a short "Why" so the snippet is judgment-safe, not cargo-culted.

## Primitives

- [tokens.md](tokens.md) — secure random generation (`nanoid`, `crypto.randomBytes`) and token hashing (`scrypt`).
- [timing-safe-comparison.md](timing-safe-comparison.md) — `crypto.timingSafeEqual` with the length-mismatch trick.
- [pkce.md](pkce.md) — client (Web Crypto) and server (Node `crypto`) PKCE, identifier construction, verifier lifecycle.

## Flow

- [expiration-and-attempts.md](expiration-and-attempts.md) — TTL check, atomic attempt increment, race-safe ordering, generic error messages.
- [otp-flow.md](otp-flow.md) — complete `emailVerifyOtp` pulling every primitive together.
- [schema.md](schema.md) — Prisma starter for `VerificationToken` + multi-provider `User`/`Account`, plus default constants.

## Identity providers

- [oidc.md](oidc.md) — state, nonce, JWKS signature verification, `iss`/`aud`/`exp`/`iat` validation, `client_secret` handling.

## Sessions and rate limiting

- [sessions.md](sessions.md) — required cookie flags, `iron-session` tradeoffs, when to switch to a server-side store.
- [rate-limiting.md](rate-limiting.md) — the per-email anti-pattern and what to do instead.

## Framework integration

- [nextjs-trpc.md](nextjs-trpc.md) — `protectedProcedure` + `authMiddleware`, anti-IDOR rule.
- [nestjs.md](nestjs.md) — global `AuthGuard`, `@PublicRoute()`, `@CurrentUser()`.
