# OTP Flow: End-to-End

Complete `emailVerifyOtp` showing how the primitives compose. Each numbered step exists for a reason; removing or reordering any one re-opens a known attack.

```ts
async function emailVerifyOtp(email: string, token: string, codeVerifier: string) {
  const codeChallenge = deriveCodeChallenge(codeVerifier)
  const identifier = JSON.stringify([email, codeChallenge])

  // 1. Atomic increment first — race-safe attempt counting.
  //    Must commit before any validation, otherwise concurrent guesses
  //    can each pass the limit check before any of them increments.
  const record = await db.verificationToken
    .update({ where: { identifier }, data: { attempts: { increment: 1 } } })
    .catch(() => null)

  if (!record) {
    throw new TRPCError({ code: 'NOT_FOUND', message: GENERIC_AUTH_ERROR })
  }

  // 2. Expiration — delete-and-fail rather than fail-and-leave-stale.
  if (isExpired(record.issuedAt)) {
    await db.verificationToken.delete({ where: { identifier } })
    throw new TRPCError({ code: 'BAD_REQUEST', message: GENERIC_AUTH_ERROR })
  }

  // 3. Attempt cap — uses the post-increment value, so 5 attempts means 5.
  if (record.attempts > MAX_ATTEMPTS) {
    await db.verificationToken.delete({ where: { identifier } })
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many attempts. Please request a new code.',
    })
  }

  // 4. Timing-safe hash comparison — never `===` on secrets, even hashed ones.
  //    Reuse the identifier itself as the salt — it's already unambiguous.
  const submittedHash = hashToken(token, identifier)
  if (!isValidToken(submittedHash, record.token)) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: GENERIC_AUTH_ERROR })
  }

  // 5. One-time use — delete as a CLAIM, not fire-and-forget.
  //    If two concurrent verifies both pass validation, only the one that
  //    successfully deletes the row should win. The other gets "no rows affected".
  const deleted = await db.verificationToken
    .deleteMany({ where: { identifier } })
  if (deleted.count === 0) {
    // Already consumed by a concurrent request — treat as failure.
    throw new TRPCError({ code: 'UNAUTHORIZED', message: GENERIC_AUTH_ERROR })
  }
  return upsertUserByEmail(email)
}
```

## Step-by-step reasoning

| Step | Primitive | If you skip it |
|------|-----------|----------------|
| 1 | Atomic increment | Concurrent attempts under load bypass the cap |
| 2 | Expiration | Old OTPs (from compromised inboxes/backups) remain valid forever |
| 3 | Attempt cap | Brute force eventually succeeds — 1M combinations is a few hours |
| 4 | Timing-safe comparison | Hash recoverable byte-by-byte via timing |
| 5 | Delete-as-claim on success | OTP replayable post-success; concurrent verifies could both win |

## Companion: `emailLogin`

```ts
async function emailLogin(email: string, codeChallenge: string) {
  const token = generateOtp() // CSPRNG, not Math.random
  const identifier = JSON.stringify([email, codeChallenge])
  const hashedToken = hashToken(token, identifier) // identifier doubles as salt

  await db.verificationToken.upsert({
    where: { identifier },
    update: { token: hashedToken, attempts: 0, issuedAt: new Date() },
    create: { identifier, token: hashedToken },
  })

  await mailService.sendOtp(email, token) // plain token to user, hash to DB
  return { email, otpPrefix: token.slice(0, 3) }
}
```

The user receives the plain OTP via email; the database stores only the hash. The `otpPrefix` is a UX nicety (so the user can confirm "this is the code for my session") — only the first 3 chars, not enough to brute force.

### Never return the plain token from the service layer

```ts
// ❌ Catastrophic — caller (router/controller) might forward this to the client
return { token, email, otpPrefix }

// ✅ Correct — the only place the plain token belongs is the user's inbox
return { email, otpPrefix: token.slice(0, 3) }
```

The service-layer function should make it impossible for a careless caller to leak the OTP to the response body. Even if the router doesn't currently forward the field, a future refactor (`return await emailLogin(input.email)`) would silently expose it. Don't put the plain token in any function's return value once it's been emailed.

If you absolutely need to expose the OTP for testing (e.g., E2E tests), do it behind an environment-gated branch (`NODE_ENV === 'test'`) — never as the default return shape.

See the primitive files for the building blocks:
- [tokens.md](tokens.md) — `generateOtp`, `hashToken`
- [pkce.md](pkce.md) — `deriveCodeChallenge`, identifier construction
- [timing-safe-comparison.md](timing-safe-comparison.md) — `isValidToken`
- [expiration-and-attempts.md](expiration-and-attempts.md) — `isExpired`, atomic increment, `GENERIC_AUTH_ERROR`
- [schema.md](schema.md) — `VerificationToken` table definition
