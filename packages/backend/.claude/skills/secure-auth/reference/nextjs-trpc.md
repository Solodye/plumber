# Next.js + tRPC: `protectedProcedure` Pattern

The canonical tRPC authentication pattern: a middleware that gates procedures behind a session check and narrows the context type so authenticated routes can't typecheck without it.

## The model

Routers default to `publicProcedure`. Any route that requires a logged-in user uses `protectedProcedure`. Forgetting to mark a route as protected fails loudly — any reference to `ctx.session.userId` requires the narrowed type, which TypeScript catches at compile time.

## Setup

```ts
// server/api/trpc.ts
import { initTRPC, TRPCError } from '@trpc/server'

const t = initTRPC.context<typeof createTRPCContext>().create({ /* ... */ })

const authMiddleware = t.middleware(({ ctx, next }) => {
  if (!ctx.session.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  return next({
    ctx: {
      // Narrow the type so downstream procedures see session.userId as non-nullable.
      session: { ...ctx.session, userId: ctx.session.userId },
    },
  })
})

const defaultProcedure = t.procedure
  .use(loggerMiddleware)
  .use(rateLimitMiddleware)

export const publicProcedure = defaultProcedure
export const protectedProcedure = defaultProcedure.use(authMiddleware)
```

The middleware does two things:
1. Throws `UNAUTHORIZED` if there's no session. This is the runtime guarantee.
2. Re-emits the context with a narrower type via `next({ ctx })`. This is the compile-time guarantee — anything downstream that reads `ctx.session.userId` only typechecks behind `protectedProcedure`.

## Router usage

```ts
export const threadRouter = createTRPCRouter({
  // Login, OTP request/verify, anything pre-auth → publicProcedure
  list: publicProcedure.query(...),

  // Everything that requires a logged-in user → protectedProcedure
  create: protectedProcedure
    .input(z.object({ title: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return db.thread.create({
        data: {
          title: input.title,
          authorId: ctx.session.userId, // ← from session, NEVER from input
        },
      })
    }),

  update: protectedProcedure
    .input(z.object({ id: z.string(), title: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Ownership check — protectedProcedure proves identity, not authority.
      const thread = await db.thread.findUniqueOrThrow({ where: { id: input.id } })
      if (thread.authorId !== ctx.session.userId) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      return db.thread.update({ where: { id: input.id }, data: { title: input.title } })
    }),
})
```

## Anti-IDOR rule

**The authenticated user id must come from `ctx.session.userId`, never from a client-supplied field.**

```ts
// ❌ Catastrophic — client can act as any user
create: protectedProcedure
  .input(z.object({ title: z.string(), authorId: z.string() }))
  .mutation(({ input }) => db.thread.create({ data: input })),

// ✅ Correct
create: protectedProcedure
  .input(z.object({ title: z.string() }))
  .mutation(({ ctx, input }) => db.thread.create({
    data: { ...input, authorId: ctx.session.userId },
  })),
```

Same rule for ownership checks: compare resource ownership against `ctx.session.userId`, not against a client claim.

## Error codes

Map auth failures to tRPC error codes — the framework converts them to HTTP statuses:

| Situation | Code |
|-----------|------|
| Not logged in | `UNAUTHORIZED` (401) |
| Logged in but no permission for this resource | `FORBIDDEN` (403) |
| Resource doesn't exist (or shouldn't be revealed to exist) | `NOT_FOUND` (404) |
| Rate limited | `TOO_MANY_REQUESTS` (429) |
| Validation failure | `BAD_REQUEST` (400) — usually thrown automatically by Zod |

## Why this is safe enough

The pattern relies on TypeScript catching mistakes. If you write:

```ts
foo: publicProcedure.mutation(({ ctx }) => {
  return db.thing.create({ data: { ownerId: ctx.session.userId } })
})
```

TypeScript flags `ctx.session.userId` as possibly `null` — because `publicProcedure` doesn't narrow it. The error is loud and at compile time, not silent at runtime. So even though authentication is opt-in per route, you can't accidentally write a handler that reads the user id without first gating it behind `protectedProcedure`.

The end result: every authenticated handler sees a verified user identity that did not come from client input.
