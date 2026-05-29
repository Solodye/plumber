# Rate Limiting

Rate limiting for authentication is subtle. The naive approach reintroduces the DoS attack you just spent PKCE fighting off.

## The anti-pattern: per-email cooldown

```ts
// ❌ DON'T — an attacker can lock anyone out by spamming requests for their email
const recent = await db.verificationToken.findMany({
  where: {
    identifier: { startsWith: `["${email}",` },
    issuedAt: { gt: new Date(Date.now() - 60_000) },
  },
})
if (recent.length > 0) {
  throw new Error('Wait before requesting another code')
}
```

**Why this fails:** an attacker sending one request per minute for `victim@example.com` permanently blocks the legitimate user from requesting an OTP. PKCE was specifically designed to let multiple concurrent sessions for the same email coexist — per-email request blocking undoes that.

## What to do instead

1. **Rate limit by IP at the gateway/proxy layer.** Sliding window, token bucket — let your infrastructure handle this. Application code shouldn't be in the rate-limiting business.

2. **Combine signals when needed.** IP + endpoint + fingerprint (rough, since IPs are shared and spoofed). Distributed-state rate limiters (Redis + `rate-limiter-flexible` or similar) handle this without the per-email pitfall.

3. **Send-side caps, not request-side blocks.** If you need to protect a specific email from being spammed:
   - ✅ "Don't send more than N OTPs per day to address X" — bounds the abuse, doesn't block the victim from trying to log in.
   - ❌ "Don't process requests for address X more than once per minute" — blocks the victim.

   The difference: the request succeeds (no error returned to the attacker, no oracle), the OTP simply isn't emailed. The legitimate user can still complete a verify if they happen to have a code already.

4. **CAPTCHA on the request endpoint** when high-volume abuse is observed. Cost: friction. Value: shifts attack cost from cheap-and-automated to expensive-and-manual.

   :::caution Virtual-browser compatibility
   Before recommending CAPTCHA, check whether the user population accesses the application through virtual browsers or remote-browser-isolation environments — these are common in government agencies and large enterprises. Many CAPTCHA providers (Google reCAPTCHA, hCaptcha, Cloudflare Turnstile) behave poorly or break entirely in those environments: pages don't load, scoring degrades, or challenges become unsolvable. If virtual browsers are in scope, either pick a CAPTCHA provider with documented support for them, or fall back to a non-CAPTCHA strategy (stricter IP limits, manual review of flagged accounts, proof-of-work challenges that don't depend on browser fingerprinting).
   :::

## Where attempt limiting fits

The per-session attempt cap in [expiration-and-attempts.md](expiration-and-attempts.md) covers brute-forcing the OTP *within* a session. Rate limiting covers spam of *new* OTP requests. They solve different problems:

| Concern | Mechanism |
|---------|-----------|
| Guessing the OTP for a specific session | Per-session attempt cap (max 5, atomic increment) |
| Requesting unlimited new OTPs (inbox spam, cost) | Per-IP rate limit at gateway |
| Distributed brute force across many sessions | Combined IP + session attempt limits |

The PKCE + attempt-limiting model already gives strong per-session brute-force protection independent of any gateway rate limiter — so even with a poorly configured gateway, the auth code itself is not the weak link.
