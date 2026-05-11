---
name: create-nestjs-endpoint
description: Create a new NestJS endpoint in apps/api following Clean Connect conventions (Zod DTO via nestjs-zod, controller for HTTP only, service for business logic, Prisma repository, JWT + Role guards, structured tests). Use when the user asks to create a new endpoint, add a route, expose a new API, or build a controller in the NestJS backend.
---

# Créer un endpoint NestJS — Clean Connect

## Quand utiliser

Création d'un **nouveau** endpoint HTTP dans `apps/api/`. Ne pas utiliser pour modifier un endpoint existant.

## Workflow

```
☐ 1. Schéma Zod + DTO via nestjs-zod
☐ 2. Repository (Prisma typé)
☐ 3. Service (logique métier)
☐ 4. Controller (HTTP I/O uniquement)
☐ 5. Module (boundary + exports)
☐ 6. Branchement dans AppModule
☐ 7. Tests d'intégration (au minimum : 201, 400, 401, 403)
```

## Étape 1 — Schéma Zod + DTO

```typescript
// modules/missions/dto/create-mission.dto.ts
import { z } from 'zod'
import { createZodDto } from 'nestjs-zod'

export const createMissionSchema = z.object({
  scheduledAt: z.coerce.date(),
  durationMinutes: z.number().int().min(30).max(480),
  serviceType: z.enum(['STANDARD', 'DEEP', 'POST_RENOVATION']),
  address: z.object({
    street: z.string().min(1).max(255),
    city: z.string().min(1).max(100),
    postalCode: z.string().regex(/^\d{5}$/),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
}).strict()

export class CreateMissionDto extends createZodDto(createMissionSchema) {}
```

`.strict()` obligatoire pour rejeter les champs inattendus.

## Étape 2 — Repository (Prisma)

```typescript
// modules/missions/missions.repository.ts
import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../common/prisma/prisma.service'

@Injectable()
export class MissionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: Prisma.MissionCreateInput, tx?: Prisma.TransactionClient) {
    return (tx ?? this.prisma).mission.create({ data: input })
  }

  findById(id: string) {
    return this.prisma.mission.findUnique({ where: { id } })
  }

  findManyByClient(clientId: string, take = 50) {
    return this.prisma.mission.findMany({
      where: { clientId },
      take,
      orderBy: { createdAt: 'desc' },
    })
  }
}
```

**Règle** : aucune logique métier ici. Pas de `if (status === ...)`. Toutes les méthodes typées par Prisma.

## Étape 3 — Service

```typescript
// modules/missions/missions.service.ts
import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino'
import { MissionsRepository } from './missions.repository'
import { CreateMissionDto } from './dto/create-mission.dto'
import { MatchingService } from '../matching/matching.service'

@Injectable()
export class MissionsService {
  constructor(
    private readonly repo: MissionsRepository,
    private readonly matching: MatchingService,
    @InjectQueue('missions') private readonly queue: Queue,
    @InjectPinoLogger(MissionsService.name) private readonly logger: PinoLogger,
  ) {}

  async create(dto: CreateMissionDto, clientId: string) {
    this.logger.info({ clientId, serviceType: dto.serviceType }, 'Creating mission')

    const mission = await this.repo.create({
      ...dto,
      client: { connect: { id: clientId } },
      status: 'PENDING',
    })

    await this.matching.notifyEligiblePrestataires(mission)
    await this.queue.add('mission.created', { missionId: mission.id })

    return mission
  }

  async findOneAuthorized(id: string, user: { id: string; role: string }) {
    const mission = await this.repo.findById(id)
    if (!mission) throw new NotFoundException('Mission not found')

    const isAuthorized =
      user.role === 'ADMIN' ||
      mission.clientId === user.id ||
      mission.prestataireId === user.id

    if (!isAuthorized) throw new ForbiddenException()
    return mission
  }
}
```

**Règles service** :
- Toute la logique métier ici
- Exceptions NestJS typées (jamais `throw new Error`)
- BullMQ pour actions asynchrones (notifications, sync, webhooks)
- Pino logger structuré

## Étape 4 — Controller

```typescript
// modules/missions/missions.controller.ts
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RoleGuard } from '../auth/guards/role.guard'
import { Roles } from '../auth/decorators/roles.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { MissionsService } from './missions.service'
import { CreateMissionDto } from './dto/create-mission.dto'

@Controller('missions')
@UseGuards(JwtAuthGuard)
export class MissionsController {
  constructor(private readonly service: MissionsService) {}

  @Post()
  @Roles('CLIENT')
  @UseGuards(RoleGuard)
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateMissionDto, @CurrentUser() user: { id: string; role: string }) {
    return this.service.create(dto, user.id)
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string; role: string }) {
    return this.service.findOneAuthorized(id, user)
  }
}
```

**Règles controller** :
- Aucune logique métier
- Aucun appel direct à Prisma
- `@HttpCode` explicite pour les codes non-200
- `ParseUUIDPipe` sur tout `:id` UUID
- `@UseGuards(JwtAuthGuard)` au minimum

## Étape 5 — Module

```typescript
// modules/missions/missions.module.ts
import { Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { MissionsController } from './missions.controller'
import { MissionsService } from './missions.service'
import { MissionsRepository } from './missions.repository'
import { MatchingModule } from '../matching/matching.module'

@Module({
  imports: [
    MatchingModule,
    BullModule.registerQueue({ name: 'missions' }),
  ],
  controllers: [MissionsController],
  providers: [MissionsService, MissionsRepository],
  exports: [MissionsService],
})
export class MissionsModule {}
```

## Étape 6 — Branchement

```typescript
// app.module.ts
@Module({
  imports: [
    // ...
    MissionsModule,
  ],
})
export class AppModule {}
```

## Étape 7 — Tests d'intégration

```typescript
// modules/missions/tests/missions.controller.spec.ts
describe('POST /api/missions', () => {
  it('crée une mission avec body valide (201)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/missions')
      .set('Authorization', `Bearer ${clientToken}`)
      .send(validPayload)
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
    const res = await request(app.getHttpServer()).post('/api/missions').send(validPayload)
    expect(res.status).toBe(401)
  })

  it('refuse un prestataire sur une route CLIENT (403)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/missions')
      .set('Authorization', `Bearer ${prestataireToken}`)
      .send(validPayload)
    expect(res.status).toBe(403)
  })
})
```

## Checklist de fin

- [ ] Schéma Zod `.strict()`
- [ ] DTO via `createZodDto`
- [ ] Controller : pas de logique, pas de Prisma direct
- [ ] Service : logique métier + transactions + BullMQ si async
- [ ] Repository : Prisma uniquement, méthodes typées
- [ ] `@UseGuards(JwtAuthGuard)` (sauf endpoint public marqué `@Public()`)
- [ ] `@Roles(...)` + `@UseGuards(RoleGuard)` si visibilité par rôle
- [ ] Ownership check dans le service (pour ressources utilisateur)
- [ ] `@HttpCode` explicite pour 201, 204
- [ ] `ParseUUIDPipe` sur tout `:id` UUID
- [ ] Tests : 201, 400, 401, 403 (et 404 si lecture)
- [ ] Pas de `any`, pas de `as unknown`
- [ ] Pino logger (jamais `console.log`)

## Anti-patterns

❌ Logique métier dans le controller
❌ `prisma.X.findMany()` direct dans le service
❌ `try { ... } catch (e) { res.status(500).send() }` — bypass de l'exception filter
❌ DTO sans `.strict()` (champs parasites acceptés)
❌ Retour `Promise<any>` ou `Promise<unknown>`
❌ Validation manuelle au lieu de Zod
