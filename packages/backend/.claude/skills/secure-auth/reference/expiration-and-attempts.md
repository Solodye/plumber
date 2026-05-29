# Expiration, Atomic Attempt Limiting, Generic Errors

Three rules that live together in the verify path. Skipping any one of them reopens a closed attack vector.

## Token expiration

```ts
const OTP_EXPIRY_SECONDS = 600 // 10 minutes

function isExpired(issuedAt: Date): boolean {
  return Date.now() - issuedAt.getTime() > OTP_EXPIRY_SECONDS * 1000
}
```

Check expiration **before** validating the secret, and delete expired rows as a side effect of the check so the table doesn't accumulate stale records.

**Why:** without a TTL, an OTP found in an old email (months-old inbox compromise, archived backup) remains valid indefinitely. A 10-minute window matches user behavior (most people enter the code within a minute) while collapsing the attacker's exploitation window.

## Atomic attempt increment

**The race to avoid:** read `attempts`, check against limit, increment. Two concurrent requests both read `4`, both pass the check, both write `5`. The attacker just got a free attempt under concurrent load.

Use a database-level atomic increment instead:

```ts
// Prisma — increment happens in one query
const record = await db.verificationToken
  .update({
    where: { identifier },
    data: { attempts: { increment: 1 } },
  })
  .catch(() => null) // null if not found

if (!record) {
  throw new TRPCError({ code: 'NOT_FOUND', message: GENERIC_AUTH_ERROR })
}

if (record.attempts > MAX_ATTEMPTS) {
  await db.verificationToken.delete({ where: { identifier } })
  throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many attempts.' })
}
```

**Increment first, then validate.** The increment must be committed regardless of whether the OTP turns out to be correct, otherwise a flood of concurrent guesses can each pass the limit check before any of them commits.

**Why this is critical:** security-critical race conditions are hard to reproduce in unit tests (timing-dependent) but trivial for an attacker to trigger with a few concurrent connections. The atomic database operation is your only reliable defense — application-level locks don't survive multiple processes or instances.

## Generic error messages

```ts
const GENERIC_AUTH_ERROR = 'Invalid or expired authentication session'
```

Use the same message for every failure mode in the verify path:

| Failure | What the attacker learns from distinct messages |
|---|---|
| "No OTP record found" | This email isn't in the system (enables enumeration) |
| "OTP expired" | An OTP *was* issued for this email |
| "Invalid OTP" | The session exists; only the code is wrong |
| "Wrong code verifier" | OTP guessed correctly, just need verifier |

Each distinct error is a small information leak. Combined, they give an attacker enough signal to enumerate users, time guesses, or know when they're one step away from success.

The legitimate user doesn't lose anything from a single generic message — they just request a new code. The attacker loses the only oracle they had.
