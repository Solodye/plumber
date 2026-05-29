# OIDC / OAuth Callback Validation

When integrating an external identity provider (Singpass, SGID, WOG AAD, Okta, Google), the callback handler must validate everything the IdP returns. A missing check turns the entire OIDC flow into an open door.

## The mandatory validations

```ts
import { jwtVerify, createRemoteJWKSet } from 'jose'

// 1. Validate `state` — CSRF protection.
//    Compare against the session-stored value with timingSafeEqual.
if (!isValidToken(receivedState, session.state)) {
  throw new Error('Invalid state — possible CSRF')
}

// 2. Exchange code for tokens — TLS, server-side, with client_secret.
//    Include the PKCE code_verifier if your flow uses PKCE (most do now).
const tokens = await fetchTokens({ code, codeVerifier: session.codeVerifier })

// 3. Verify ID token signature via JWKS.
//    Never trust an unverified JWT — anyone can mint one with the right shape.
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`))
const { payload } = await jwtVerify(tokens.id_token, jwks, {
  issuer,        // enforces `iss` claim
  audience: clientId, // enforces `aud` claim
})
// jose also checks `exp` and `iat` automatically.

// 4. Validate `nonce` — replay protection.
//    The nonce in the ID token must match the one we sent in the auth request.
if (payload.nonce !== session.nonce) {
  throw new Error('Invalid nonce — possible replay')
}
```

## The checklist

| Field | What | Why |
|-------|------|-----|
| `state` | Random value generated at auth-request time, returned by IdP, compared with `timingSafeEqual` | CSRF — without it, an attacker can complete an OAuth flow on the victim's behalf |
| `nonce` | Random value sent in the auth request, returned in the ID token | Replay — without it, a stolen ID token can be reused |
| ID token signature | Verified via JWKS endpoint of the IdP | Without verification, an attacker can mint their own ID tokens |
| `iss` | Must match your configured issuer URL | Prevents accepting tokens from a different IdP |
| `aud` | Must match your `client_id` | Prevents accepting tokens minted for a different relying party |
| `exp` | Must be in the future | Stops replay of expired tokens |
| `iat` | Must not be in the future (small clock skew tolerance OK) | Catches forged or misconfigured tokens |

## `client_secret` rules

- Server-side only — never include in frontend bundles, mobile binaries, or anything shipped to a client.
- Never commit to git — use `.env`, secrets manager, or environment-level injection.
- Rotate when an employee with access leaves, or on suspicion of leak.
- Use one secret per environment (dev/staging/prod) — leaks contained to one tier.

## PKCE in OIDC

OIDC flows for server-side apps traditionally used `client_secret` only, but modern guidance is to add PKCE on top — it protects against authorization code interception even if TLS is somehow compromised. Generate a `code_verifier` at auth-request time, send the `code_challenge`, and include the verifier in the token exchange. See [pkce.md](pkce.md).

## Common mistakes

- **Decoding the JWT without verifying signature.** Libraries make this too easy (`jwt.decode()` vs `jwt.verify()`). Always verify.
- **Trusting the `email` claim without checking `email_verified`.** Some providers issue tokens with `email_verified: false` — don't auto-link accounts based on those.
- **Reusing `state` across requests.** Each auth-request needs a fresh `state` and fresh `nonce`.
- **Validating `iss` against a substring** (e.g., `iss.includes('okta')`). Use exact match — an attacker controlling `okta.attacker.com` could otherwise issue tokens that pass.

## Multi-provider account linking

If a user logs in via OTP and later via OIDC with the same email (`email_verified: true`), link the accounts rather than creating duplicates. See the `User`/`Account` schema in [schema.md](schema.md).
