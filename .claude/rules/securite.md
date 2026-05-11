
# Sécurité — Clean Connect

> Activé sur auth, paiements, photos, guards. Toute route exposée publiquement est revue sécu avant merge.

---

## Checklist avant chaque route

```
☐ DTO Zod (.strict()) avec ZodValidationPipe
☐ Guard d'auth (JwtAuthGuard) sauf endpoint public explicite
☐ RoleGuard si la ressource a une visibilité par rôle
☐ Rate limiting (@Throttle ou global @nestjs/throttler)
☐ Aucune PII / token / numéro de carte dans les logs (Pino redactor configuré)
☐ Exception NestJS typée (jamais throw new Error)
☐ Code HTTP explicite (@HttpCode)
☐ Idempotence : UUID client sur uploads, idempotency_key Stripe sur paiements
```

---

## Auth — JWT

```typescript
// Access token : 15 min, signé avec JWT_ACCESS_SECRET
// Refresh token : 30 j, signé avec JWT_REFRESH_SECRET, stocké HASHÉ en DB

@Injectable()
export class AuthService {
  async login(credentials: LoginDto) {
    const user = await this.users.findByEmail(credentials.email)
    if (!user) throw new UnauthorizedException()

    const valid = await bcrypt.compare(credentials.password, user.passwordHash)
    if (!valid) throw new UnauthorizedException()

    const accessToken = this.jwt.sign({ sub: user.id, role: user.role }, {
      secret: env.JWT_ACCESS_SECRET,
      expiresIn: '15m',
    })
    const refreshToken = this.jwt.sign({ sub: user.id }, {
      secret: env.JWT_REFRESH_SECRET,
      expiresIn: '30d',
    })

    const refreshTokenHash = await bcrypt.hash(refreshToken, 12)
    await this.users.storeRefreshTokenHash(user.id, refreshTokenHash)

    return { accessToken, refreshToken }
  }
}
```

**Règles** :
- bcrypt cost ≥ 12 sur les password hashes
- Refresh token **hashé** en DB (jamais en clair)
- Rotation : le refresh est invalidé à chaque utilisation, un nouveau est émis

---

## RBAC — RoleGuard

```typescript
// guards/role.guard.ts
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext) {
    const required = this.reflector.get<Role[]>('roles', ctx.getHandler())
    if (!required) return true
    const { user } = ctx.switchToHttp().getRequest()
    return required.includes(user.role)
  }
}

// usage
@Post()
@Roles('CLIENT')
@UseGuards(JwtAuthGuard, RoleGuard)
async create(...) { }
```

### Ownership check (au-delà du rôle)

Un prestataire ne voit **que ses missions**, un client **que les siennes**.

```typescript
async findOneAuthorized(id: string, user: AuthUser) {
  const mission = await this.repo.findById(id)
  if (!mission) throw new NotFoundException()

  const isOwner =
    user.role === 'ADMIN' ||
    mission.clientId === user.id ||
    mission.prestataireId === user.id

  if (!isOwner) throw new ForbiddenException()
  return mission
}
```

---

## Webhooks Stripe — ordre absolu

```typescript
@Controller('webhooks/stripe')
export class StripeWebhookController {
  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    // 1. Vérifier la signature AVANT toute désérialisation
    let event: Stripe.Event
    try {
      event = this.stripe.webhooks.constructEvent(
        req.rawBody,
        signature,
        env.STRIPE_WEBHOOK_SECRET,
      )
    } catch (err) {
      throw new BadRequestException('Invalid signature')
    }

    // 2. Vérifier l'environnement (clé test ↔ env test)
    this.stripeService.assertEnvConsistency(event)

    // 3. Idempotence (stripe_event_id déjà traité ?)
    const already = await this.stripeService.findEvent(event.id)
    if (already) return { received: true, idempotent: true }

    // 4. Enregistrer l'event + enqueue pour traitement async
    await this.stripeService.recordAndEnqueue(event)
    return { received: true }
  }
}
```

**Règles dures** :
- `rawBody: true` doit être activé dans `main.ts`
- Vérification signature **avant** toute désérialisation
- Cohérence env : un webhook test ne touche **jamais** une DB prod (et vice-versa)
- Idempotence via `stripe_event_id` unique en DB
- Traitement réel **asynchrone** via BullMQ (le webhook répond 200 rapidement)
- **DLQ** : jobs en échec après N retries → table `webhook_dead_letter` + alerte Slack

---

## CORS

```typescript
app.enableCors({
  origin: env.CORS_ORIGINS.split(','),   // whitelist par env
  credentials: true,
})
```

**Interdiction** : `origin: '*'` en production. Même en dev, lister explicitement `localhost:3000`, `localhost:8081` (Expo), etc.

---

## Tokens & crypto

```typescript
// ❌ Math.random() pour un token de sécurité
const token = Math.random().toString(36).slice(2)

// ✅ crypto.randomBytes
import { randomBytes } from 'node:crypto'
const token = randomBytes(32).toString('hex')
```

---

## Paiements — règles dures Stripe Connect Express

- Aucun log de numéro de carte / CVV / expiration (Pino redactor)
- Aucune persistence de données carte (PaymentMethod IDs Stripe uniquement)
- `idempotency_key` Stripe sur **toute** création de PaymentIntent / Transfer
- Clés `sk_test_*` ≠ `sk_live_*` — vérifié au boot (`ingenieur.mdc`)
- Onboarding prestataire via `AccountLink` Stripe Express (KYC délégué)
- Pas de transfert avant validation client ou auto-release T+48h ouvrées
- Webhook test ne touche **jamais** la DB de prod

---

## RGPD — implémentation backend

| Route                          | Effet |
|--------------------------------|---|
| `GET /api/users/me/export`     | Export ZIP : données utilisateur + photos signed URLs |
| `PATCH /api/users/me`          | Rectification |
| `DELETE /api/users/me`         | Soft delete + job BullMQ `user.purge` programmé à T+30 j |

**Soft delete** :
```typescript
await this.prisma.user.update({
  where: { id },
  data: { deletedAt: new Date(), email: `deleted-${id}@anon.local` },
})
await this.queue.add('user.purge', { userId: id }, { delay: 30 * 24 * 3600 * 1000 })
```

**Purge** :
- Supprime PII (email, nom, téléphone, photo de profil, adresses)
- **Conserve** : transactions Stripe (10 ans légal), agrégats anonymisés
- Photos AVANT/APRÈS : supprimées 12 mois après fin de mission (cron quotidien)

---

## Logs — données interdites

Pino redactor doit masquer :

```typescript
{
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["stripe-signature"]',
    '*.password',
    '*.passwordHash',
    '*.refreshToken',
    '*.accessToken',
    '*.cardNumber',
    '*.cvv',
    '*.iban',
    '*.token',
    '*.apiKey',
  ],
  censor: '[REDACTED]',
}
```

---

## Red flags — refus de merge

| Pattern observé                                             | Sévérité | Action |
|-------------------------------------------------------------|----------|--------|
| Webhook Stripe sans `constructEvent`                        | 🔴 critique | Refus |
| Body Stripe parsé en JSON avant vérif signature             | 🔴 critique | Refus |
| `req.body` Prisma sans Zod                                  | 🔴 critique | Refus |
| `cors({ origin: '*' })` en prod                             | 🔴 critique | Refus |
| Secret en clair dans le code                                | 🔴 critique | Refus + rotation |
| `eval(...)`                                                 | 🔴 critique | Refus |
| `Math.random()` pour token                                  | 🔴 critique | Refus → `crypto.randomBytes(32)` |
| Route métier sans `@UseGuards(JwtAuthGuard)`                | 🔴 critique | Refus (sauf endpoint public marqué `@Public()`) |
| Ownership check absent sur ressource utilisateur            | 🔴 critique | Refus |
| `findMany()` sans `take:` ni pagination                     | 🟡 suggestion | À justifier |
| `as unknown as X` pour contourner les types                 | 🟡 suggestion | À justifier ou refactor |
| `catch (e) {}` silencieux                                   | 🔴 critique | Refus |
