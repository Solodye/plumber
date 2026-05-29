# Schema and Defaults

Prisma starter schemas and the tunable constants referenced throughout the other files.

## Verification token (OTP flows)

```prisma
model VerificationToken {
  identifier String   @id          // JSON.stringify([email, codeChallenge])
  token      String                // scrypt hash, never the plain OTP
  issuedAt   DateTime @default(now())
  attempts   Int      @default(0)
}
```

Notes:
- `identifier` is the composite key from PKCE. See [pkce.md](pkce.md) for why `JSON.stringify` not concatenation.
- `token` is the scrypt-hashed value, not the OTP itself. See [tokens.md](tokens.md).
- `attempts` is incremented atomically per verification attempt. See [expiration-and-attempts.md](expiration-and-attempts.md).
- No separate `expires` column — derive from `issuedAt + TTL` in code. Keeps the schema simple and lets you tune TTL without migrations.

## Multi-provider accounts (OIDC + OTP same user)

```prisma
model User {
  id        String    @id @default(cuid())
  email     String    @unique
  accounts  Account[]
}

model Account {
  id           String  @id @default(cuid())
  userId       String
  provider     String  // 'email' | 'okta' | 'sgid' | 'singpass'
  providerUid  String  // sub claim from IdP, or email for OTP
  user         User    @relation(fields: [userId], references: [id])
  @@unique([provider, providerUid])
}
```

A single `User` can have multiple `Account` rows — one per provider they've logged in with. On a new login:

- If `(provider, providerUid)` already exists, log in as the linked user.
- Else if the IdP's verified email matches an existing `User.email`, link a new `Account` to that user.
- Else create a new `User` and a new `Account`.

The `email_verified` check is critical for the linking step — see [oidc.md](oidc.md).

## Default constants

```ts
const OTP_LENGTH = 6
const OTP_EXPIRY_SECONDS = 600          // 10 minutes
const MAX_ATTEMPTS = 5
const PASSWORD_RESET_EXPIRY_SECONDS = 3600  // 1 hour
const SCRYPT_KEYLEN = 64
const PKCE_VERIFIER_LENGTH = 128
const GENERIC_AUTH_ERROR = 'Invalid or expired authentication session'
```

These are reasonable defaults. Tune to your risk profile:
- Higher-risk apps (financial, admin): shorter TTL (5 min), fewer attempts (3).
- Lower-friction apps (community forums): longer TTL (15 min), more attempts (10).

The PKCE verifier length comes from RFC 7636 — 43–128 chars allowed, longer is strictly better.
