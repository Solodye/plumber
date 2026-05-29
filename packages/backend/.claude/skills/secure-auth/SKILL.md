---
name: secure-auth
description: Apply hardened authentication patterns when writing or reviewing code that handles authentication, secrets, or session management. Covers OTP login, OIDC/OAuth flows, password reset, API tokens, session cookies, and any code that stores, compares, or transmits a secret. Use when the user is writing an `emailLogin`, `verifyOtp`, OIDC callback, session/cookie setup, password reset, API key issuance, or any function that touches `crypto`, `scrypt`, `bcrypt`, `argon2`, `timingSafeEqual`, `Math.random`, `nanoid`, `iron-session`, `next-auth`, `jsonwebtoken`, `jose`, PKCE, JWT, or HMAC. Also use when reviewing existing auth code or before merging changes to auth-related modules. Framework-agnostic but tuned for Next.js and NestJS.
---

# Secure Authentication Patterns

Apply these whenever you write code that handles secrets, login, sessions, or identity. Each principle below encodes a defense against a known attack class; the **why** lines explain what breaks if you skip it.

## When this skill applies

Trigger on any of:

- Login / signup / logout endpoints
- OTP issuance and verification
- Password reset, magic links, email verification
- OAuth 2.0 / OIDC flows (state, nonce, PKCE, token exchange)
- Session creation, cookies, JWTs
- API token / personal access token issuance
- Any comparison of a user-submitted value against a stored secret
- Any storage of a secret in a database or cache

If you're unsure whether it applies, it probably does. Authentication failures are silent until exploited.

## Core principles

1. **Never store secrets in plaintext.** Hash with scrypt/Argon2/bcrypt before persistence — including OTPs and short-lived tokens, not just passwords. *Why:* a database read (SQL injection, leaked backup, insider access) becomes trivial account takeover when secrets are plaintext.
2. **Never use `Math.random()` for anything security-relevant.** Use `crypto.randomBytes`, `crypto.randomUUID`, or `nanoid`. *Why:* `Math.random` is a predictable PRNG — given enough output, future values can be inferred.
3. **Never compare secrets with `===` or `!==`.** Use `crypto.timingSafeEqual`. *Why:* string comparison short-circuits on first mismatch; an attacker measuring response times can recover the secret one byte at a time, even over a network.
4. **Bind secrets to a session.** Use PKCE (or an equivalent challenge/verifier) so a leaked OTP/code can't be replayed by a different client. *Why:* without binding, an intercepted OTP authenticates from any device; and concurrent requests for the same email overwrite each other, enabling DoS.
5. **Atomic state changes for counters.** Increment attempts in the database (`{ increment: 1 }`), never read-then-write. *Why:* concurrent requests both read the same value and both write `+1`, giving attackers free attempts under load.
6. **Generic error messages.** "Invalid or expired authentication session" — never "no OTP found" or "wrong code". *Why:* distinct messages let attackers enumerate emails, confirm a code was issued, or learn which validation step failed.
7. **Enforce expiration.** Every issued secret has a TTL; check it before validating. *Why:* a code stolen from an old email or compromised inbox remains valid forever otherwise.
8. **Rate limit by IP, not by email.** Per-email cooldowns reintroduce a DoS vector — an attacker can spam an email to lock out the real user. *Why:* PKCE already isolates sessions per email; per-email request blocking undoes that protection.
9. **Validate everything from identity providers.** State, nonce, ID token signature (via JWKS), `iss`, `aud`, `exp`, `iat`. *Why:* without these, OIDC callbacks accept forged tokens, replayed tokens, or tokens minted for a different relying party.
10. **Session cookies need `httpOnly`, `secure`, `sameSite`.** No exceptions in production. *Why:* missing flags allow XSS token theft (`httpOnly`), interception on plaintext networks (`secure`), and CSRF (`sameSite`).

## Workflow when writing auth code

1. **Identify the secret.** What is being stored/transmitted/compared? (OTP, password, API key, JWT, OAuth code, PKCE verifier, session token.)
2. **Pick the right primitives.** See the [reference/](reference/README.md) directory for the canonical snippet per pattern.
3. **Walk the checklist below** against your code before considering it done.

## Pre-merge checklist

Token security
- [ ] Secrets hashed with scrypt/Argon2/bcrypt before storage
- [ ] Random generation via `crypto.randomBytes` or `nanoid` — never `Math.random`
- [ ] Stored secret deleted after successful use
- [ ] Expiration enforced (typical TTL: 10 min for OTP, 1 hr for reset links)

Comparison & validation
- [ ] All secret comparisons use `crypto.timingSafeEqual`
- [ ] Input validation (Zod or equivalent) on every endpoint
- [ ] Error messages generic — no information disclosure about which step failed

Session isolation
- [ ] PKCE (or equivalent) used to bind secrets to the requesting session
- [ ] Attempts incremented atomically *before* validation, capped (default: 5)
- [ ] Identifier built with `JSON.stringify([email, challenge])`, not string concat
- [ ] Session cookies: `httpOnly`, `secure`, `sameSite: 'lax' | 'strict'`
- [ ] HTTPS enforced in production

OIDC / OAuth specific
- [ ] `state` parameter generated, stored, validated (CSRF protection)
- [ ] `nonce` parameter generated, stored, validated (replay protection)
- [ ] ID token signature verified via JWKS
- [ ] ID token claims validated: `iss`, `aud`, `exp`, `iat`
- [ ] Client secret never exposed to frontend / committed to repo

Rate limiting
- [ ] IP-based rate limiting at the gateway / API layer
- [ ] No per-email rate limiting that an attacker can use to lock out a victim
- [ ] CAPTCHA considered for high-volume endpoints

Database
- [ ] Atomic ops for counters (`{ increment: 1 }`)
- [ ] Transactions for user/account creation flows
- [ ] No sensitive data stored as plaintext

## Patterns reference

Detailed snippets live in [reference/](reference/README.md). Open the file matching the pattern you need:

**Primitives**
- [reference/tokens.md](reference/tokens.md) — secure random generation (`nanoid`, `crypto.randomBytes`) and token hashing (`scrypt`).
- [reference/timing-safe-comparison.md](reference/timing-safe-comparison.md) — `crypto.timingSafeEqual` with length-mismatch handling.
- [reference/pkce.md](reference/pkce.md) — client (Web Crypto) and server (Node) PKCE, identifier construction, verifier lifecycle.

**Verify flow**
- [reference/expiration-and-attempts.md](reference/expiration-and-attempts.md) — TTL check, atomic attempt increment, generic errors.
- [reference/otp-flow.md](reference/otp-flow.md) — complete `emailVerifyOtp` end-to-end.
- [reference/schema.md](reference/schema.md) — Prisma starter and default constants.

**Identity providers and sessions**
- [reference/oidc.md](reference/oidc.md) — state, nonce, JWKS, claim validation.
- [reference/sessions.md](reference/sessions.md) — cookie flags, `iron-session` tradeoffs.
- [reference/rate-limiting.md](reference/rate-limiting.md) — the per-email anti-pattern, CAPTCHA caveats.

**Framework integration**
- [reference/nextjs-trpc.md](reference/nextjs-trpc.md) — `protectedProcedure` + `authMiddleware` pattern.
- [reference/nestjs.md](reference/nestjs.md) — global `AuthGuard` + `@PublicRoute()` + `@CurrentUser()` pattern.
