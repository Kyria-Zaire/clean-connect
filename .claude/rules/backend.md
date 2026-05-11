# Backend — Patterns transverses

> Complément à `architecte-api.md`. Référence rapide pour tout fichier dans `apps/api/`.

---

## Squelette controller

```typescript
@Controller('resource')
@UseGuards(JwtAuthGuard)
export class ResourceController {
  constructor(private readonly service: ResourceService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateResourceDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user.id)
  }
}
```

---

## Types Zod auto-générés depuis Prisma

Le projet utilise **`zod-prisma-types`** : à chaque `prisma generate`, des schémas Zod sont générés dans `packages/shared-types/zod/`.

```typescript
// ✅ Réutiliser le schéma généré comme base
import { MissionSchema, UserSchema } from '@cleanconnect/shared-types/zod'

// Étendre pour des DTOs métier (sans dupliquer)
export const createMissionSchema = MissionSchema
  .pick({ serviceType: true, scheduledAt: true, durationMinutes: true, amountCents: true })
  .extend({
    address: AddressSchema.omit({ id: true, missionId: true }),
  })
  .strict()

// ❌ Réécrire à la main les champs déjà dans Prisma
// (source de divergence entre le modèle DB et l'API)
```

**Règle** : ne pas modifier les fichiers générés dans `packages/shared-types/zod/*`. Toute modification du modèle passe par `schema.prisma` + `prisma generate`.

---

## Prisma — règles

```typescript
// ✅ Limit explicite (take:)
await this.prisma.mission.findMany({
  where: { status: 'PENDING' },
  take: 100,
  orderBy: { createdAt: 'desc' },
})

// ✅ Transaction pour opérations multi-tables
await this.prisma.$transaction(async (tx) => {
  await tx.mission.update({ where: { id }, data: { status: 'ACCEPTED' } })
  await tx.escrowHistory.create({ data: { missionId: id, status: 'BLOCKED' } })
})

// ❌ findMany sans take (sauf pagination explicite ou commentaire justificatif)
await this.prisma.user.findMany()

// ❌ $queryRaw sans commentaire
await this.prisma.$queryRaw`SELECT * FROM users WHERE ...`

// ✅ $queryRaw justifié (ex: PostGIS, pas d'API Prisma)
// PostGIS ST_DWithin n'est pas exposé par Prisma — requête raw justifiée.
await this.prisma.$queryRaw<User[]>`
  SELECT * FROM users
  WHERE ST_DWithin(
    location,
    ST_MakePoint(${lng}, ${lat})::geography,
    zone_intervention_km * 1000
  )
  LIMIT 100
`
```

---

## Logger Pino

```typescript
// ❌ console.log
// ✅
this.logger.info({ missionId, status }, 'Mission status updated')
this.logger.error({ err, missionId }, 'Failed to release escrow')
this.logger.warn({ source: 'stripe', attempt: 2 }, 'Webhook retry')
```

Pino doit être configuré avec un **redactor** pour masquer les champs sensibles :
```typescript
{
  redact: ['req.headers.authorization', '*.password', '*.cardNumber', '*.cvv', '*.token']
}
```

---

## BullMQ — patterns

### Producer (depuis un service)

```typescript
@InjectQueue('escrow') private readonly escrowQueue: Queue

await this.escrowQueue.add(
  'auto-release',
  { missionId, releaseAt: targetDate.toISOString() },
  {
    delay: msUntilTarget,
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 1000,
    removeOnFail: false,        // garde les jobs en échec pour la DLQ
  },
)
```

### Consumer

```typescript
@Processor('escrow')
export class EscrowProcessor {
  @Process('auto-release')
  async handleAutoRelease(job: Job<{ missionId: string }>) {
    this.logger.info({ jobId: job.id, missionId: job.data.missionId }, 'Auto-release start')
    try {
      await this.escrowService.releaseIfEligible(job.data.missionId)
    } catch (err) {
      this.logger.error({ err, missionId: job.data.missionId }, 'Auto-release failed')
      throw err  // BullMQ retry selon la config attempts/backoff
    }
  }
}
```

---

## Réponses HTTP — codes explicites

| Cas                          | Code |
|------------------------------|------|
| OK lecture                   | 200  |
| Création                     | 201  |
| Suppression (sans body)      | 204  |
| Validation Zod échouée       | 400  |
| Auth manquante               | 401  |
| Auth présente mais KO        | 403  |
| Ressource absente            | 404  |
| Conflit (idempotence)        | 409  |
| Erreur métier 4xx générique  | 422  |
| Rate limit                   | 429  |
| Erreur serveur               | 500  |
| Service externe KO           | 502 / 503 |

`@HttpCode(HttpStatus.X)` explicite sur tout endpoint qui ne renvoie pas 200.

---

## Tests d'intégration

```typescript
describe('POST /api/missions', () => {
  it('crée une mission avec body valide (201)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/missions')
      .set('Authorization', `Bearer ${clientToken}`)
      .send(validMissionPayload)
    expect(res.status).toBe(201)
    expect(res.body.id).toMatch(UUID_REGEX)
  })

  it('refuse un body invalide (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/missions')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('refuse sans auth (401)', async () => {
    const res = await request(app.getHttpServer()).post('/api/missions').send(validMissionPayload)
    expect(res.status).toBe(401)
  })
})
```

Au minimum un test pour chaque code de retour métier.
