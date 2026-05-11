# CLAUDE.md — Projet Clean Connect

> Lu automatiquement par Claude Code à chaque session.
> Définit la stack, l'architecture, et les conventions Clean Connect.
> La posture transverse (Senior Engineer, langue) est dans `~/.claude/CLAUDE.md` (global utilisateur).

---

## Méthode de delivery — BMAD-light (lecture obligatoire)

**Tout travail sur ce projet suit la méthode [BMAD-light](docs/method/BMAD.md).**
4 phases : **Discover → Design → Build → Verify**. Chaque phase a une Definition of Done figée.

| Artefact | Chemin |
|---|---|
| **Méthode complète** | [`docs/method/BMAD.md`](docs/method/BMAD.md) |
| **Template PRD** (1 par feature) | [`docs/templates/PRD-template.md`](docs/templates/PRD-template.md) |
| **PRDs actifs** | `docs/prd/*.md` |
| **ADRs** | `docs/adr/ADR-*.md` |
| **Règle BMAD chargée en session** | `.claude/rules/bmad-method.md` (actif partout) |

**Règle dure** : pas de code sans PRD validé en Discover, pas de Build sans Design validé, pas de merge sans rapport `reviewer-securite-code` en Verify.

---

## Vue d'ensemble

**Clean Connect** — plateforme de mise en relation pour nettoyage spécialisé à domicile.
Source de vérité fonctionnelle : [`docs/CAHIER-DES-CHARGES-v1.4.md`](docs/CAHIER-DES-CHARGES-v1.4.md).
Mobile : **application unique** Client + Prestataire (RoleGuard, switch UI par rôle).

---

## Stack — non négociable

### Backend
- **NestJS 10+** (TypeScript strict, ESM)
- **Prisma 5+** (PostgreSQL 16 + PostGIS pour matching géographique)
- **Validation** : `nestjs-zod` (DTOs + OpenAPI) + `zod-prisma-types` (génération Zod depuis schema.prisma)
- **BullMQ + Redis 7** (jobs, webhooks, sync, delayed jobs, cron) — **AOF activé** pour persistance
- **Business dates** : `date-fns`, `date-fns-tz` (Europe/Paris), `date-fns-business-days` (T+48h ouvrées)
- **Pino** (logger structuré JSON, redactor PII)

### Mobile
- **Expo SDK 51+** + **React Native** + **TypeScript strict**
- **TanStack Query** (state serveur) — jamais `useEffect + fetch`
- **react-hook-form** + **zod** (formulaires)
- **MMKV** (file de sync offline) + **expo-file-system** (photos)
- **expo-background-fetch** + **expo-task-manager** (sync background)

### Admin Web
- **Vite + React + TS** (strict)
- **TanStack Query** + **react-hook-form** + **zod**
- UI minimaliste, blanc + vert `#22c55e`, cards `border-radius: 16-20px`

### Monorepo
- **Turborepo + pnpm workspaces**

### Services externes
- **Stripe Connect Express** (paiements + séquestre + KYC délégué)
- **Cloudinary** (storage photos, dossiers privés par mission, URLs signées)
- **Firebase Cloud Messaging** (push)
- **SendGrid** ou **Postmark** (emails)

---

## TypeScript — strict obligatoire

```json
{
  "strict": true,
  "noImplicitAny": true,
  "strictNullChecks": true,
  "noUncheckedIndexedAccess": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true
}
```

Aucune dérogation. Pas de `any`, pas de `as unknown as X`, pas de `@ts-ignore` non justifié en commentaire.

---

## Architecture backend (NestJS)

```
HTTP → Guards (Auth, Role) → Pipes (ZodValidationPipe) → Controller → Service → Repository (Prisma) → DB
                                                              ↓
                                                          BullMQ producer
                                                              ↓
                                                          BullMQ Processor (job consumer)
```

### Découpage en modules

```
apps/api/src/
├── modules/
│   ├── auth/                 # JWT + refresh + guards
│   ├── users/                # Client / Prestataire / Admin
│   ├── missions/             # Création, acceptation, lifecycle
│   ├── payments/             # Stripe + séquestre + webhooks
│   ├── photos/               # Upload Cloudinary + idempotence UUID
│   ├── notifications/        # FCM + emails
│   ├── matching/             # PostGIS + zone d'intervention
│   ├── disputes/             # Process litige
│   └── admin/                # Dashboard + DLQ + monitoring
├── common/
│   ├── filters/              # ExceptionFilter centralisé
│   ├── interceptors/         # Logging, response shape
│   ├── pipes/                # ZodValidationPipe
│   ├── guards/               # JwtAuthGuard, RoleGuard
│   └── decorators/           # @CurrentUser, @Roles
├── queue/
│   ├── processors/           # BullMQ consumers (webhooks, sync, auto-release)
│   └── producers/
└── main.ts
```

### Règle de découpage

```
Controller    → HTTP I/O uniquement, jamais de logique métier
Service       → logique métier, orchestration, transactions
Repository    → accès Prisma, requêtes typées (pas de logique métier)
Processor     → consommation de jobs BullMQ (asynchrone)
Module        → boundary fonctionnelle, exports minimaux
```

---

## Sécurité — règles absolues Clean Connect

1. **Secrets** : `process.env.*` validés au boot via Zod. Crash au démarrage si un secret manque.
2. **Input** : tout DTO passe par `ZodValidationPipe`. Aucune route ne traite `req.body` brut.
3. **Webhooks Stripe** : signature vérifiée AVANT toute désérialisation. Body brut requis (`@Req() req: RawBodyRequest<Request>`).
4. **Idempotence** :
   - Webhooks : `stripe_event_id` unique en DB
   - Uploads photos : UUID v4 client = clé unique
   - PaymentIntents : `idempotency_key` Stripe
5. **JWT** : access 15 min, refresh 30 j. Refresh stocké hashé côté DB.
6. **RBAC** : `RoleGuard` sur toute route métier. Un prestataire ne voit que ses missions, un client les siennes, l'admin tout.
7. **Cloudinary** : dossiers privés `missions/<mission_id>/<phase>/`, signed URLs avec expiration courte (5 min).
8. **CORS** : whitelist stricte par env via `CORS_ORIGINS`. Jamais `*` en prod.
9. **Rate limiting** : `@nestjs/throttler` global + override par route sensible.
10. **PII / cartes / tokens** : interdits dans les logs (filter Pino redactor configuré).

---

## Stripe Connect Express — règles métier

| Phase | Action |
|---|---|
| Onboarding prestataire | `AccountLink` Stripe Express → redirect → callback `account.updated` |
| Création mission payée | `PaymentIntent` avec `transfer_data` différé (séquestre) |
| Validation client | `Transfer` immédiat vers compte prestataire (moins commission 18 % HT) |
| Auto-release T+48h ouvrées | BullMQ delayed job + cron de sécurité horaire |
| Litige | Statut `LITIGE_OUVERT` bloque tout auto-release jusqu'à décision admin |

Voir [`docs/CAHIER-DES-CHARGES-v1.4.md`](docs/CAHIER-DES-CHARGES-v1.4.md) §4.3 et §4.4 pour les détails complets.

---

## Mode offline (mobile)

- **Compression photos** : 1600 px max + JPEG qualité 75 → ~150-300 KB/photo
- **UUID v4 côté client** sur chaque photo (clé d'idempotence backend)
- **File de sync MMKV** (rapide, persistante)
- **Retry exponentiel** : 5 s, 30 s, 2 min, 10 min, 1 h (max 5 tentatives)
- **Démarrage mission autorisé** avec photos AVANT non sync
- **Règle dure backend** : pas de libération séquestre tant que photos AVANT non sync

---

## RGPD — règles dures

- Données paiement : conservation 10 ans (Code de commerce)
- Photos AVANT/APRÈS : 12 mois après fin de mission
- Compte supprimé : soft delete 30 j puis purge (sauf obligation légale)
- Routes RGPD : `GET /users/me/export`, `PATCH /users/me`, `DELETE /users/me`

---

## Environnements

| Env | DB | Stripe | Cloudinary folder | Domaine |
|---|---|---|---|---|
| development | `cleanconnect_dev` | `sk_test_*` | `dev/` | localhost |
| recette | `cleanconnect_rec` | `sk_test_*` | `rec/` | rec.cleanconnect.fr |
| preprod | `cleanconnect_preprod` | `sk_test_*` | `preprod/` | preprod.cleanconnect.fr |
| production | `cleanconnect_prod` | `sk_live_*` | `prod/` | cleanconnect.fr |

**Critique** : aucun webhook test ne touche la DB de prod, aucun webhook live ne touche les DB de test. Vérification du préfixe de clé (`sk_test_` vs `sk_live_`) sur réception de webhook.

---

## Refus explicites (sur ce projet)

- `any` / `as unknown as X` / `@ts-ignore` non justifié
- Route NestJS sans DTO Zod
- Webhook Stripe sans `constructEvent`
- `console.log` (toujours Pino)
- `prisma.$queryRaw` sans commentaire justificatif
- Upload photo sans UUID client
- Création de PaymentIntent sans `idempotency_key`
- `prisma db push` en production (toujours `prisma migrate dev` en local, `prisma migrate deploy` en prod/preprod)
- `git push --force` sur `main` ou `develop`

---

## Index des règles ciblées (`.claude/rules/` ou `.cursor/rules/`)

| Quand tu travailles sur                                | Règle(s) à consulter                          |
|--------------------------------------------------------|------------------------------------------------|
| **Tout fichier du projet** (toujours actif)            | `bmad-method` (4 phases, DoD, PRD obligatoire) |
| **Posture transverse** (toujours actif)                | `senior-dev`                                   |
| `apps/api/src/modules/**/*.controller.ts`              | `architecte-api`                               |
| `apps/api/src/modules/**/*.service.ts`                 | `architecte-api` + `backend`                   |
| `apps/api/src/main.ts`, `app.module.ts`, `common/**`   | `ingenieur`                                    |
| `apps/api/src/modules/payments/**`                     | `securite` + `stripe`                          |
| `apps/api/src/modules/photos/**`                       | `securite` + `photos-rgpd`                     |
| `apps/mobile/**`                                       | `mobile` + `seniordev-frontend`                |
| `apps/admin/**`                                        | `seniordev-frontend`                           |
| `.github/workflows/**`, `docker-compose*`, `scripts/**`| `createur-workflow`                            |
| **Audit / revue** (à la demande)                       | `reviewer-securite-code` (méthode + rapport)   |

---

## Index des skills (`.claude/skills/` ou `.cursor/skills/`)

| Tâche                                              | Skill                                       |
|----------------------------------------------------|---------------------------------------------|
| Créer un endpoint NestJS (module/controller/DTO)   | `create-nestjs-endpoint`                    |
| Audit sécurité d'un controller / webhook           | `review-security-route`                     |
| Intégrer Stripe Connect / Cloudinary / FCM         | `integrate-external-service`                |
| Modifier schéma Prisma + migration                 | `prisma-migration-workflow`                 |
| Déployer / sync DB entre environnements            | `deploy-environment`                        |
| Implémenter un flow Stripe avec séquestre          | `stripe-escrow-flow`                        |
| Implémenter sync offline avec idempotence          | `offline-sync-pattern`                      |
