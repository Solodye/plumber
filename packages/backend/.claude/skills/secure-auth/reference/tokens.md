# Tokens: Secure Random Generation and Hashing

Anything you generate as a secret (OTP, API key, session ID, password reset token, PKCE verifier) must use a CSPRNG. Anything you persist must be hashed.

## 1. Cryptographically secure random generation

**Never use `Math.random()`** — it's a predictable PRNG. Given enough observed output, an attacker can infer future values, which lets them pre-compute OTPs or guess "random" tokens.

```ts
import { customAlphabet, nanoid } from 'nanoid'

// OTP: 6 chars from an unambiguous alphabet (no 0/O, 1/I/L)
const OTP_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export const generateOtp = customAlphabet(OTP_ALPHABET, 6)

// API key: longer, full alphabet
export const generateApiKey = () => nanoid(32)
```

For raw bytes (not strings), use Node's `crypto.randomBytes(n)` or the Web Crypto API's `crypto.getRandomValues(new Uint8Array(n))`.

**Why the unambiguous alphabet:** users read OTPs from emails and type them in. Removing `0/O` and `1/I/L` cuts down on typos without weakening entropy meaningfully.

## 2. Token hashing (scrypt)

Use for any secret you persist — OTPs, password reset tokens, API keys. Passwords specifically should use Argon2id (or bcrypt) with a tuned work factor; scrypt is a reasonable choice for short-lived tokens.

```ts
import { scryptSync } from 'crypto'

const SCRYPT_KEYLEN = 64

export function hashToken(token: string, salt: string): string {
  return scryptSync(token, salt, SCRYPT_KEYLEN).toString('hex')
}
```

**Why scrypt over SHA-256:** scrypt is intentionally slow and memory-hard. A 6-digit OTP has only 1,000,000 possibilities — SHA-256 lets an attacker with a database dump crack it in milliseconds. scrypt forces ~100ms per guess, turning the same brute force into ~28 hours of compute. The same property applies to any short, low-entropy secret.

**Salt:** for per-user secrets, use a per-record value. When PKCE is in play, the cleanest choice is **the verification identifier itself** — `JSON.stringify([email, codeChallenge])` — since it's already unambiguous (see [pkce.md](pkce.md) on why concatenation is dangerous). Avoid hand-rolled concatenations like `email + codeChallenge`: same collision class as identifier construction. Never reuse a global salt — that enables a single rainbow table for the entire database.

**Async variant:** in high-traffic paths, use `scrypt` (callback) or `promisify(scrypt)` to avoid blocking the event loop. For verification flows (infrequent), `scryptSync` is fine.
