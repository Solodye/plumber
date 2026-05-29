# PKCE (Proof Key for Code Exchange)

Bind a secret to the specific session that requested it. Use for OTP login, OAuth/OIDC flows, password reset — any two-step flow where a request from session A must not be completable by session B.

**The mechanism in one line:** the client generates a random `verifier`, sends `SHA256(verifier)` (the `challenge`) with the request, keeps the verifier locally, and proves possession of the verifier at completion time.

## Client (browser, Web Crypto)

```ts
import { customAlphabet } from 'nanoid'

// RFC 7636 unreserved character set
const PKCE_CHARSET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
export const generateCodeVerifier = customAlphabet(PKCE_CHARSET, 128)

export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(hashBuffer)
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}
```

## Server (Node `crypto`)

```ts
import { createHash } from 'crypto'

export function deriveCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url')
}
```

## Identifier construction

When storing the verification record, the identifier must combine the user-facing key (email) with the PKCE challenge:

```ts
const identifier = JSON.stringify([email, codeChallenge])
```

**Never use string concatenation.** `email + codeChallenge` is ambiguous: `"alice" + "xyz" === "alicexyz" === "alic" + "exyz"`. `JSON.stringify([...])` produces an unambiguous, parseable key.

## Verifier lifecycle (browser)

Hold the verifier in **React context** or a closure — not `sessionStorage`, not `localStorage`.

**Why not `sessionStorage`:** persisting through page refreshes adds no value (a refreshed page should request a fresh OTP anyway), and any persistence increases XSS exposure. Context dies with the page, which matches the security model.

```tsx
// contexts/pkce-context.tsx
const PkceContext = createContext<{
  codeVerifier: string | null
  setCodeVerifier: (v: string | null) => void
} | null>(null)

export function PkceProvider({ children }: { children: ReactNode }) {
  const [codeVerifier, setCodeVerifier] = useState<string | null>(null)
  return (
    <PkceContext.Provider value={{ codeVerifier, setCodeVerifier }}>
      {children}
    </PkceContext.Provider>
  )
}

export function usePkce() {
  const ctx = useContext(PkceContext)
  if (!ctx) throw new Error('usePkce must be used within PkceProvider')
  return ctx
}
```

## What PKCE buys you

- **Intercepted OTP is useless** — an attacker who reads the OTP from email cannot complete the login without the verifier sitting in the legitimate session.
- **Concurrent sessions don't interfere** — two tabs requesting OTPs for the same email get two independent verification records keyed by their own challenges.
- **DoS via attempt exhaustion is isolated** — an attacker burning through attempts only burns through *their own* session's attempts, not the victim's.

Without PKCE, fixing any one of these requires per-email rate limiting, which itself reintroduces DoS — see [rate-limiting.md](rate-limiting.md).
