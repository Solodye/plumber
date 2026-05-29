# Timing-Safe Comparison

Use for every comparison of a user-submitted value against a stored secret — including hashes. Hashes are still strings, and `===` still short-circuits on first mismatch, which is enough for a timing attack to recover them byte by byte over a network.

```ts
import { timingSafeEqual } from 'crypto'

export function isValidToken(submitted: string, stored: string): boolean {
  try {
    const a = Buffer.from(submitted)
    const b = Buffer.from(stored)

    // Length mismatch must not short-circuit — compare against self to keep timing constant.
    if (a.length !== b.length) {
      timingSafeEqual(a, a)
      return false
    }
    return timingSafeEqual(a, b)
  } catch {
    // Any edge-case error (unexpected input type, etc.) → reject closed.
    return false
  }
}
```

**Why the length-mismatch dance:** `crypto.timingSafeEqual` throws if buffer lengths differ, and an early `return false` from your wrapper would itself be measurably faster than the matching branch. Running `timingSafeEqual` against the buffer-with-itself before returning preserves a near-constant execution time so an attacker can't even learn the stored secret's length.

**Why the outer try/catch:** `Buffer.from` and `timingSafeEqual` can throw on unexpected input types or non-UTF8 byte sequences. A thrown exception that propagates would either crash the request handler or be caught by generic error middleware that responds differently from a normal "invalid token" — both of which leak information. Catching and returning `false` keeps the failure path indistinguishable from any other invalid comparison.

**Where this matters:**
- Comparing submitted OTP hash vs stored OTP hash.
- Comparing OAuth `state` cookie vs returned `state` parameter.
- Comparing OIDC `nonce` claim vs session-stored `nonce`.
- Comparing HMAC signatures (webhooks, API request signing).
- Comparing API keys.

If a comparison involves a user-controlled value and a stored secret, it goes through `timingSafeEqual`. Full stop.
