# NestJS: Global `AuthGuard` Pattern

The canonical NestJS authentication pattern: a global guard that protects every route by default, with an explicit opt-out for anonymous endpoints.

## The model

A global `AuthGuard` (`CanActivate`) is registered via `APP_GUARD`, so every route is protected unless explicitly opted out with `@PublicRoute()`. Forgetting the opt-out keeps the route protected — fails closed.

## The guard

```ts
// auth.guard.ts
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly usersService: UsersService,
    private readonly apiKeyService: ApiKeyService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PreAuthRequest>()

    // Routes marked @PublicRoute() bypass auth.
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      PUBLIC_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (isPublic) return true

    // Try API key first (header), then session (cookie).
    const apiKey = getApiKeyFromHeader(req)
    if (apiKey) return this.authenticateApiKey(req, apiKey)
    return this.authenticateUser(req)
  }

  private async authenticateUser(req: PreAuthRequest): Promise<boolean> {
    if (!req.session?.userId) return false
    try {
      const user = await this.usersService.findOneOrFail(req.session.userId)
      if (!user.enabled) return false
      req.user = user
      return true
    } catch {
      return false
    }
  }

  private async authenticateApiKey(req: PreAuthRequest, apiKey: string): Promise<boolean> {
    try {
      const entity = await this.apiKeyService.getFromApiKey(apiKey)
      const user = await this.usersService.findOneOrFail(entity.user.id)
      if (!user.enabled) return false
      req.user = user
      return true
    } catch {
      return false
    }
  }
}

interface PreAuthRequest extends Request {
  user: User
}
```

## Register globally

```ts
// app.module.ts
@Module({
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class AppModule {}
```

## Supporting decorators

```ts
// public-route.decorator.ts
export const PUBLIC_ROUTE_KEY = 'PUBLIC_ROUTE'
export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE_KEY, true)

// current-user.decorator.ts
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const { user } = ctx.switchToHttp().getRequest<Request>()
    if (!user) throw new Error('User does not exist on request')
    return user
  },
)
```

## Controller usage

```ts
@Controller('threads')
export class ThreadsController {
  constructor(private readonly threadsService: ThreadsService) {}

  @Post('login')
  @PublicRoute()              // ← anonymous endpoint, opts out of AuthGuard
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto)
  }

  @Post()                      // ← protected by default (global AuthGuard)
  create(@CurrentUser() user: User, @Body() dto: CreateThreadDto) {
    return this.threadsService.create({ ...dto, authorId: user.id })
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateThreadDto,
  ) {
    const thread = await this.threadsService.findOneOrFail(id)
    if (thread.authorId !== user.id) {
      throw new ForbiddenException()
    }
    return this.threadsService.update(id, dto)
  }
}
```

## Anti-IDOR rule

Same as tRPC: the authenticated user comes from `@CurrentUser()`, never from request body or path params. Compare resource ownership against `user.id`.

## Putting the pieces together

- The guard handles **identity** (who is this user?). It does not handle **authority** (can this user access this resource?). Do ownership/role checks inside the controller or service.
- Put hashing/comparison/PKCE/OIDC logic in an `AuthService` injected into the guard or into controllers — not in the guard itself, which should only verify the request is from a valid identity.
- Use Zod (via `nestjs-zod`) for DTO validation. Validation errors return 400 before reaching the guard.
- API key auth and session auth both end at the same `req.user` — controllers don't care which one was used.

## Why default-on matters

In NestJS controllers, "forgot to require auth" looks like a normal `@Post()` route — there's no syntactic difference between a protected handler and an anonymous one. Without a global guard, those routes silently accept anonymous traffic. With the guard, the same code stays protected and the developer has to explicitly opt out with `@PublicRoute()` — failing closed instead of failing open.

The end result: every authenticated handler sees a verified user identity that did not come from client input.
