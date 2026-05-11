---
name: review-security-route
description: Audit a NestJS controller, service, or middleware in Clean Connect against the project security checklist (Zod DTO, JWT and Role guards, ownership checks, rate limiting, Stripe webhook signature, PII in logs, idempotence, RGPD). Use when the user asks for a security review, security audit, security checklist, or reviewing a webhook, payment endpoint, photo upload, or auth route.
---

# Audit sécurité — Clean Connect

## Quand utiliser

- Avant de merger une route exposée publiquement
- Sur **tout** webhook (Stripe, Cloudinary, FCM)
- Sur tout endpoint paiement, photo, auth
- Sur demande explicite : « audite », « review sécu », « checklist sécurité »

## Checklist générale (toute route)

```
☐ DTO Zod (.strict()) via createZodDto + ZodValidationPipe
☐ @UseGuards(JwtAuthGuard) (sauf endpoint marqué @Public())
☐ @Roles(...) + RoleGuard si visibilité par rôle
☐ Ownership check dans le service pour ressources utilisateur
☐ @Throttle ou rate limit global appliqué
☐ Pino redactor configuré (pas de PII / tokens / cartes dans les logs)
☐ Exceptions NestJS typées (NotFoundException, ForbiddenException, etc.)
☐ @HttpCode explicite (201, 204) si non-200
☐ Idempotence si pertinent : UUID client (uploads), idempotency_key (Stripe)
☐ findMany() avec take: explicite (pagination)
☐ Pas de prisma.$queryRaw injecté depuis req.*
```

## Checklist webhook Stripe (renforcée)

```
☐ rawBody: true activé dans main.ts
☐ Vérification signature AVANT toute désérialisation
☐ stripe.webhooks.constructEvent(rawBody, sig, secret) utilisé
☐ Cohérence env : event.livemode === (NODE_ENV === 'production')
☐ Idempotence via stripe_event_id UNIQUE en DB
☐ Réponse 200 rapide, traitement réel via BullMQ
☐ Retry config attempts ≥ 5 + backoff exponentiel
☐ DLQ sur échec final (alerte Slack + dashboard admin)
☐ Si webhook peut supprimer/refunder → review humaine obligatoire
```

## Checklist photos (Cloudinary)

```
☐ DTO Zod sur signature + webhook
☐ Ownership check (prestataire de la mission ?)
☐ UUID v4 client = clé d'idempotence (UNIQUE en DB)
☐ Cloudinary type: 'private' (pas d'URL publique)
☐ Signed URL expiration ≤ 5 min
☐ Webhook Cloudinary signature vérifiée
☐ EXIF stripping côté Cloudinary
☐ Photos > 12 mois après fin de mission : purgées (cron)
```

## Checklist auth

```
☐ Password hash bcrypt cost ≥ 12
☐ Access token JWT 15 min, refresh 30 j
☐ Refresh token stocké HASHÉ en DB
☐ Rotation refresh à chaque usage
☐ Pas de log du password / token en clair
☐ Rate limit strict sur /login, /signup, /password-reset
```

## Checklist CORS

```
☐ origin lu depuis env.CORS_ORIGINS (whitelist)
☐ credentials: true seulement si nécessaire
☐ Aucun origin: '*' en production
```

## Checklist RGPD

```
☐ DELETE /users/me déclenche un soft delete + job purge T+30 j
☐ Données paiement (Stripe) conservées 10 ans (obligation légale)
☐ Photos AVANT/APRÈS purgées T+12 mois après fin de mission
☐ Export ZIP disponible via GET /users/me/export
☐ Logs structurés sans PII
```

## Red flags — refus de merge

| Pattern observé                                              | Sévérité | Action |
|--------------------------------------------------------------|----------|--------|
| Webhook Stripe sans `constructEvent`                         | 🔴 critique | Refus |
| Body Stripe parsé JSON avant signature                       | 🔴 critique | Refus |
| `req.body` Prisma sans Zod                                   | 🔴 critique | Refus |
| Endpoint métier sans `@UseGuards(JwtAuthGuard)`              | 🔴 critique | Refus |
| Ressource utilisateur sans ownership check                   | 🔴 critique | Refus |
| Cloudinary URL publique sur photo privée                     | 🔴 critique | Refus |
| `cors({ origin: '*' })` en prod                              | 🔴 critique | Refus |
| Secret en clair dans le code                                 | 🔴 critique | Refus + rotation |
| `Math.random()` pour token                                   | 🔴 critique | Refus → `crypto.randomBytes(32)` |
| `eval(...)`                                                  | 🔴 critique | Refus |
| Création PaymentIntent sans `idempotencyKey`                 | 🔴 critique | Refus |
| Upload photo sans UUID client                                | 🔴 critique | Refus |
| `catch (e) {}` silencieux                                    | 🔴 critique | Refus |
| `findMany()` sans `take:`                                    | 🟡 suggestion | Justifier |
| `as unknown as X`                                            | 🟡 suggestion | Justifier ou refactor |

## Format du rapport d'audit

```markdown
## Audit sécurité — <fichier|route>

### 🔴 Critique (bloquant)
- [Ligne X] <description> → <correction proposée>

### 🟡 Suggestion
- [Ligne X] <amélioration> → <bénéfice>

### 🟢 Conforme
- Validation Zod présente
- Guards configurés
- ...

### Verdict
✅ OK pour merge  /  ❌ Bloquant — corriger les 🔴 d'abord
```

## Anti-patterns courants

```typescript
// ❌ Webhook non vérifié
@Post('webhook')
async handle(@Body() event: any) {
  await this.process(event)
}

// ✅ Webhook vérifié
@Post('webhook')
@HttpCode(HttpStatus.OK)
async handle(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') sig: string) {
  const event = this.stripe.webhooks.constructEvent(req.rawBody, sig, env.STRIPE_WEBHOOK_SECRET)
  this.assertEnvConsistency(event)
  const existing = await this.prisma.stripeEvent.findUnique({ where: { id: event.id } })
  if (existing) return { received: true, idempotent: true }
  await this.recordAndEnqueue(event)
  return { received: true }
}
```

```typescript
// ❌ Endpoint sans ownership check
@Get(':id')
async findOne(@Param('id') id: string) {
  return this.repo.findById(id)   // n'importe qui peut lire n'importe quelle mission !
}

// ✅ Ownership check
@Get(':id')
async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
  return this.service.findOneAuthorized(id, user)
}
```
