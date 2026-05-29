# Session Cookies

Whatever library you use (`iron-session`, `next-auth`, `express-session`, NestJS sessions), every session cookie must have these flags set explicitly:

```ts
{
  httpOnly: true,           // Not accessible to JS — mitigates XSS token theft
  secure: true,             // HTTPS only (set false in local dev if needed)
  sameSite: 'lax',          // 'strict' if no cross-site flows needed
  maxAge: 60 * 60 * 24 * 7, // Explicit expiration (7 days here)
  path: '/',
}
```

## What each flag does

| Flag | Attack it prevents |
|------|--------------------|
| `httpOnly` | XSS — JavaScript on the page can't read the cookie value, so an injected script can't exfiltrate the session |
| `secure` | Network interception — cookie not sent over plain HTTP, so a passive observer on the wire can't grab it |
| `sameSite` | CSRF — browser doesn't send the cookie on cross-origin requests, so an attacker's site can't make authenticated calls on the victim's behalf |
| `maxAge` | Stale sessions — without an explicit max-age, sessions can linger past their intended lifetime |

`sameSite: 'lax'` is the right default for most apps (allows top-level navigation cookies, blocks cross-site POSTs). Use `'strict'` if your app has no cross-site flows at all — extra defense at the cost of breaking links from external sites into authenticated pages.

## `iron-session` (Next.js default)

`iron-session` encrypts the session data into the cookie itself. Stateless — no Redis or session store required.

**Pros:**
- Zero infrastructure: no session DB to provision, scale, or back up.
- Horizontal scaling: any instance can decrypt any session.
- No DB round-trip per request: session data is in the cookie.

**Tradeoffs:**
- ~4KB cookie size limit. Don't pack the user object in — store only `userId` and look up the user as needed.
- No server-side invalidation by default. To kick a user out immediately, you need a separate revocation mechanism — for example, a `tokenVersion` field on the user, embedded in the session, checked on each request, and incremented on logout-everywhere.
- Cookie tampering attempts fail noisily (decryption error), but a stolen cookie is fully usable until it expires.

## When to use a server-side session store instead

Switch to Redis-backed (or DB-backed) sessions if you need:

- **Immediate session invalidation** — security incidents, "log out everywhere" flows, admin-initiated kicks.
- **Session-bound data > 4KB** — though usually the right answer here is "don't put that in the session."
- **Audit trails of active sessions** — letting users see and revoke their own sessions across devices.

The same flag set above applies — encryption and stateless storage are about *where* the session lives, not whether you skip the cookie hygiene.

## Session fixation: when to regenerate the session id

**Server-side session stores (Redis, DB-backed): regenerate the session id on login.**

The classical session fixation attack: an attacker plants a known session id in the victim's browser, the victim logs in, the server upgrades that session from anonymous to authenticated, and the attacker — who still knows the id — now has an authenticated session. Mitigation: issue a new session id at the moment of login so the planted one becomes useless.

```ts
// express-session example after successful auth
req.session.regenerate((err) => {
  if (err) return next(err)
  req.session.userId = user.id
  res.redirect('/')
})
```

**Stateless encrypted-cookie sessions (`iron-session`): not strictly necessary.**

iron-session encrypts the entire session payload into the cookie value itself — there's no separate "session id" that persists across the anonymous→authenticated transition. Every mutation re-encrypts with a fresh IV, so the cookie value naturally changes on login. An attacker who planted `enc({})` does not possess `enc({userId, email, …})`.

Still worth doing on the iron-session path: **explicitly clear pre-login flow state** (e.g., OIDC `nonce`, OAuth `state`, PKCE verifier) once it's been consumed, so leftover values can't influence subsequent flows.

```ts
const session = await getSession()
session.userId = user.id
session.email = user.email
delete session.nonce // clear any leftover pre-login flow state
await session.save()
```
