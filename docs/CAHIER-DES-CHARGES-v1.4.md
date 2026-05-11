# CLEAN CONNECT — Cahier des Charges v1.4

**Plateforme de mise en relation pour nettoyage spécialisé à domicile**

- **Porteur** : Arisnova Solution
- **Date** : 11 mai 2026
- **Version** : 1.4 — Validée pour développement MVP
- **Statut** : Prêt pour Phase 0 (boilerplate + spec technique)
- **Remplace** : v1.3 (archive maintenue dans le dossier `docs/`)

---

## Changelog v1.3 → v1.4

| # | Sujet | Résolution v1.4 |
|---|---|---|
| 1 | App mobile | **Application unique** Client + Prestataire (Option A) — un seul binaire, switch UI par rôle |
| 2 | DTO / types | Confirmation **`nestjs-zod`** + ajout **`zod-prisma-types`** (génération auto Zod ← schéma Prisma) |
| 3 | Tests backend | **Jest + container Postgres+PostGIS éphémère** pour les services Payment, Escrow, Matching |
| 4 | Tests mobile | **Detox** sur le "Happy Path" : Login → Photo → Validation |
| 5 | Fuseau horaire | **`date-fns-tz`** (Europe/Paris) pour tous les calculs business |
| 6 | Heures ouvrées | **`date-fns-business-days`** pour T+48h ouvrées du séquestre |
| 7 | Redis | **AOF activé** (persistance) — pas de perte de delayed jobs sur restart |
| 8 | PostGIS | **Migration Prisma SQL** explicite (CREATE EXTENSION) + colonnes `GEOGRAPHY` via `Unsupported()` |
| 9 | CI/CD | **GitHub Actions** (typecheck + lint + tests + build Docker, déploiement à câbler quand l'hébergeur sera tranché) |
| 10 | Design system | **NativeWind** (mobile, Tailwind RN) + **shadcn/ui** (admin web) — tokens Tailwind partagés via `packages/design-tokens` |
| 11 | Hébergement | **À trancher en Phase 1** — démarrage en local Docker uniquement, pas de blocage pour démarrer le code |

Tout le contenu non-listé ici reste identique à v1.3.

---

## 1. Vision & Positionnement (inchangé v1.3)

### Identité visuelle

| Élément | Valeur |
|---|---|
| Couleurs | Blanc `#FFFFFF` + Vert principal `#22c55e` |
| Style | Épuré, minimaliste, premium, beaucoup d'espace blanc |
| Cartes | `border-radius: 16-20px`, **sans dégradés** |
| Typographie | Inter (fallback : system font) |
| Icônes | Sobres (Lucide ou Heroicons), monoligne |

### Objectifs business

| Métrique | Cible |
|---|---|
| Panier moyen | 160 – 220 € |
| Panier minimum | 99 € (avec upsell) |
| Commission Clean Connect | 18 % HT |
| Zone de lancement | **Soissons + 30-50 km** |

---

## 2. Stratégie Mobile — Application Unique (nouveau v1.4)

### Décision

**Un seul binaire mobile** pour Client + Prestataire. Pas d'app séparée.

### Justifications

| Bénéfice | Détail |
|---|---|
| Maintenance × 2 | Splash, icônes, certificats Apple/Google, releases → 1 seul de chaque |
| Cycle stores accéléré | 1 review Apple + 1 review Play au lieu de 2 |
| UX cross-rôle | Un prestataire peut **être** client (après chantier sale chez lui) — bascule fluide |
| Code partagé | Auth, photo capture, notifications, navigation, design system |
| Marketing | Une seule URL de download, une seule fiche store, un seul ASO |

### Implémentation technique

#### RoleGuard mobile

```typescript
// apps/mobile/src/lib/auth/useCurrentRole.ts
type Role = 'CLIENT' | 'PRESTATAIRE' | 'BOTH'

// Au login, le serveur renvoie les rôles activés sur le compte.
// Un utilisateur peut avoir les deux. Une préférence "mode actif" est stockée localement.
```

#### Switch UI

| Critère | Mode CLIENT | Mode PRESTATAIRE |
|---|---|---|
| Couleur primary nav | Blanc / gris neutre | Vert `#22c55e` |
| Onglets bottom | Recherche, Mes missions, Messages, Profil | Tableau de bord, Mes interventions, Photos, Profil |
| CTA principal | "Demander un nettoyage" | "Démarrer la mission" |
| Permissions | Géoloc à la commande | Géoloc + camera + background fetch + push |

#### Bascule de mode (utilisateur "BOTH")

Bouton dans le profil : « Passer en mode Prestataire » / « Passer en mode Client ». L'état est persisté en MMKV (`active-role`) et change le navigateur racine immédiatement (Expo Router).

#### Onboarding différencié

| Étape | Client | Prestataire |
|---|---|---|
| Signup | Email + mot de passe + nom | Email + mot de passe + nom |
| KYC | Carte bancaire (Stripe SetupIntent) | Stripe Connect Express onboarding (redirection 5-10 min) |
| Documents | — | RIB, statut juridique (auto-entrepreneur, SIRET) |
| Délai avant 1ʳᵉ mission | < 5 min | Variable (Stripe peut demander des justificatifs) |

#### Notifications push différenciées

| Topic FCM | Cibles |
|---|---|
| `client.<userId>` | Confirmations, validations, rappels paiement |
| `prestataire.<userId>` | Nouvelles missions, urgences, paiements reçus |
| `both.<userId>` | Messages in-app, alertes compte |

Pour un utilisateur dual, l'app souscrit aux 3 topics.

#### Permissions natives

Demandées à l'usage (pas au login) :
- Caméra + galerie : à la première photo
- Géoloc : à la première recherche / acceptation mission
- Notifications : après le premier login

---

## 3. Stack Technique v1.4

### Backend (inchangé sauf ajouts)

- **NestJS 10+** (TypeScript strict, ESM)
- **Prisma 5+** (PostgreSQL 16 + extension PostGIS 3.4)
- **Validation** : **`nestjs-zod`** (DTOs runtime + OpenAPI) + **`zod-prisma-types`** (génération auto Zod depuis `schema.prisma`)
- **BullMQ** + **Redis 7** (AOF activé pour persistance des delayed jobs)
- **Pino** + `nestjs-pino` (logger structuré JSON, redactor PII)
- **Business dates** : `date-fns`, **`date-fns-tz`** (Europe/Paris), **`date-fns-business-days`** (T+48h ouvrées)

### Mobile (mise à jour app unique)

- **Expo SDK 51+** + **React Native** + **TypeScript strict**
- **TanStack Query** (state serveur)
- **react-hook-form** + **zod** (formulaires)
- **MMKV** (file de sync + préférences rôle actif)
- **expo-file-system**, **expo-background-fetch**, **expo-task-manager**
- **expo-secure-store** (tokens JWT)
- **expo-router** (navigation file-based)
- **Detox** (tests E2E happy path)

### Web Admin (inchangé)

- **Vite + React + TS strict**
- **TanStack Query** + **react-hook-form** + **zod**
- UI : blanc + vert `#22c55e`, cards `border-radius: 16-20px`

### Monorepo & infra

- **Turborepo + pnpm workspaces**
- **Docker** + **docker-compose** (dev) / Dockerfiles multi-stage (prod)
- **CI/CD** : GitHub Actions
- **Monitoring** : Sentry (front + back), Pino → ELK ou Grafana Loki

### Services externes (inchangé)

- **Stripe Connect Express** (paiements + séquestre + KYC délégué)
- **Cloudinary** (storage photos privés)
- **Firebase Cloud Messaging** (push)
- **SendGrid** ou **Postmark** (emails transactionnels)

### Génération de types

```
schema.prisma  ──prisma generate──>  @prisma/client (types DB)
       │
       ├──zod-prisma-types──>  packages/shared-types/zod  (schémas Zod auto)
       │
       └─ extension via nestjs-zod (DTOs additionnels métier)
```

---

## 4. Tests & Fiabilité (nouveau v1.4)

### Stratégie globale

> Un système financier (séquestre) ne se met **pas** en prod sans filet. La couverture testes est traitée comme du code de prod, pas comme une option.

### Backend (Jest)

#### Unit tests

- Tout service avec une logique non-triviale
- Mock du Prisma via `jest-mock-extended` (rapide, pas de DB)

#### Tests d'intégration (container éphémère)

```yaml
# docker-compose.test.yml
services:
  postgres-test:
    image: postgis/postgis:16-3.4-alpine
    environment:
      POSTGRES_DB: cleanconnect_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    tmpfs: /var/lib/postgresql/data   # RAM, jamais persisté
    ports: ['5433:5432']

  redis-test:
    image: redis:7-alpine
    command: redis-server --save '' --appendonly no   # pas de persistance pour les tests
    ports: ['6380:6379']
```

#### Couverture obligatoire

| Module | Seuil minimum |
|---|---|
| `modules/payments/**` | **90 %** lignes + branches |
| `modules/escrow/**` (ou intégré dans payments) | **90 %** lignes + branches |
| `modules/matching/**` (PostGIS) | **80 %** + scénarios géographiques explicites |
| `modules/photos/**` | **75 %** |
| Reste du backend | **70 %** |

#### Scénarios obligatoires Payment + Escrow

```
☐ Création PaymentIntent avec idempotency_key (mock Stripe)
☐ Webhook reçu avec signature invalide → 400
☐ Webhook reçu 2× avec même event_id → idempotent (1 traitement)
☐ Cohérence env : webhook live sur env test → 400
☐ Validation client manuelle → libération immédiate
☐ Auto-release T+48h ouvrées (mock du temps via `jest.useFakeTimers`)
☐ Auto-release bloqué si photos AVANT non synchronisées
☐ Auto-release bloqué si litige ouvert
☐ Prolongation client avant T+24h → re-programmation T+96h
☐ Litige ouvert → job auto-release annulé
☐ DLQ : 5 retries en échec → entrée DLQ + alerte Slack mockée
☐ Calculs heures ouvrées (jours fériés FR 2026)
```

### Mobile (Detox)

#### Happy Path E2E

```
1. Login prestataire → home prestataire (vert)
2. Accepter une mission disponible
3. Check-in → caméra → 3 photos AVANT (offline simulé)
4. Démarrer la mission avec photos pending sync
5. Réactiver le réseau → sync background déclenchée → photos UPLOADED
6. Photos APRÈS (5) → submit mission
7. Bascule mode CLIENT (utilisateur "BOTH")
8. Valider la mission (UI vert → blanc)
9. Vérifier libération séquestre côté API mock
```

#### Tests unitaires (Jest)

- Compression photo
- File de sync (enqueue, dedup UUID, retry backoff)
- Hooks TanStack Query (mocks API)

### Cible CI

```
☐ Lint passe
☐ Typecheck passe
☐ Tests unitaires passent
☐ Tests d'intégration passent (container éphémère)
☐ Couverture ≥ seuils définis par module
☐ Detox happy path passe (job optionnel sur PR, obligatoire sur main)
☐ Audit npm critique propre
```

---

## 5. Implémentation PostGIS (précision v1.4)

### Migration Prisma SQL

```sql
-- apps/api/prisma/migrations/<timestamp>_init_postgis/migration.sql

-- 1. Activer l'extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- 2. Colonnes GEOGRAPHY (pas POINT — GEOGRAPHY gère la sphère)
ALTER TABLE "User" ADD COLUMN "location" GEOGRAPHY(Point, 4326);
ALTER TABLE "Mission" ADD COLUMN "location" GEOGRAPHY(Point, 4326);

-- 3. Index spatiaux (critique pour les perfs ST_DWithin)
CREATE INDEX "User_location_idx" ON "User" USING GIST("location");
CREATE INDEX "Mission_location_idx" ON "Mission" USING GIST("location");

-- 4. Zone d'intervention prestataire (rayon en km)
ALTER TABLE "User" ADD COLUMN "zoneInterventionKm" INTEGER DEFAULT 30;
```

### Côté Prisma

```prisma
model User {
  // ...
  location           Unsupported("GEOGRAPHY(Point, 4326)")?
  zoneInterventionKm Int? @default(30)
}
```

### Requêtes (via `$queryRaw` typé)

```typescript
// modules/matching/matching.repository.ts
async findEligiblePrestataires(missionLat: number, missionLng: number, missionId: string) {
  // PostGIS ST_DWithin avec GEOGRAPHY → distance en mètres, calcul sphérique
  return this.prisma.$queryRaw<EligiblePrestataire[]>`
    SELECT
      u.id,
      u."firstName",
      u."lastName",
      u."zoneInterventionKm",
      ST_Distance(u.location, ST_MakePoint(${missionLng}, ${missionLat})::geography) AS distance_meters
    FROM "User" u
    WHERE u.role IN ('PRESTATAIRE', 'BOTH')
      AND u."deletedAt" IS NULL
      AND u.location IS NOT NULL
      AND ST_DWithin(
        u.location,
        ST_MakePoint(${missionLng}, ${missionLat})::geography,
        COALESCE(u."zoneInterventionKm", 30) * 1000
      )
    ORDER BY distance_meters ASC
    LIMIT 50
  `
}
```

**Règles** :
- Utiliser **`GEOGRAPHY`**, pas `GEOMETRY` (le calcul sphérique sphère gère les distances réelles)
- Index GIST obligatoire (sans ça, `ST_DWithin` fait un seq scan)
- Toujours `LIMIT` sur les requêtes de matching
- Le `$queryRaw` est justifié en commentaire (PostGIS non couvert par l'API Prisma)

---

## 6. Redis — Configuration AOF (nouveau v1.4)

### Pourquoi AOF

BullMQ stocke ses **delayed jobs** dans Redis. Sans persistance, un redémarrage Redis (crash, mise à jour OS, etc.) **perd tous les jobs en attente** — y compris :
- Les auto-releases programmés (T+48h ouvrées)
- Les rappels (T+24h, T+36h, T+47h)
- Les purges RGPD utilisateur (T+30 j)

C'est **inacceptable** pour un système financier.

### Configuration

```conf
# redis.conf (prod)
appendonly yes
appendfsync everysec      # compromis raisonnable perf/durabilité
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
```

### docker-compose

```yaml
redis:
  image: redis:7-alpine
  command: >
    redis-server
    --appendonly yes
    --appendfsync everysec
  volumes:
    - redis_data:/data
  healthcheck:
    test: ['CMD', 'redis-cli', 'ping']
    interval: 5s
volumes:
  redis_data:
```

### Cron de sécurité

Malgré AOF, un cron horaire scanne les missions en `EN_ATTENTE_VALIDATION_CLIENT` dépassant T+48h ouvrées et ré-enqueue les auto-releases manquants. Filet de dernier recours (cf §4.3 v1.3 + skill `stripe-escrow-flow`).

---

## 7. Fuseau horaire & Business Days (nouveau v1.4)

### Règle

**Tous les calculs business utilisent `Europe/Paris`.** Le stockage en DB reste en UTC (Postgres `timestamptz`).

### Implémentation

```typescript
import { utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz'
import { addBusinessDays } from 'date-fns-business-days'

const TIMEZONE = 'Europe/Paris'

function addBusinessHoursParis(date: Date, hours: number): Date {
  // 1. Convertir UTC → Paris
  const parisDate = utcToZonedTime(date, TIMEZONE)

  // 2. Calculer en heures ouvrées (9h-18h lun-ven, hors fériés FR)
  let remaining = hours
  let cursor = parisDate
  while (remaining > 0) {
    if (isBusinessHour(cursor)) {
      cursor = addHours(cursor, 1)
      remaining -= 1
    } else {
      cursor = nextBusinessHour(cursor)
    }
  }

  // 3. Reconvertir Paris → UTC
  return zonedTimeToUtc(cursor, TIMEZONE)
}

function isBusinessHour(d: Date): boolean {
  const day = d.getDay()
  const hour = d.getHours()
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18 && !isFrenchHoliday(d)
}
```

### Jours fériés français

Lib `date-fns-business-days` accepte une liste de fériés. Pour 2026 :

```typescript
const FR_HOLIDAYS_2026 = [
  '2026-01-01', '2026-04-06', '2026-05-01', '2026-05-08',
  '2026-05-14', '2026-05-25', '2026-07-14', '2026-08-15',
  '2026-11-01', '2026-11-11', '2026-12-25',
]
```

Fériés régionaux Alsace-Moselle : non applicables (Soissons = Aisne, Hauts-de-France).

---

## 8. Structure Monorepo v1.4

```
clean-connect/
├── apps/
│   ├── api/                    # NestJS backend
│   ├── mobile/                 # React Native Expo (Client + Prestataire — UNIQUE)
│   └── admin/                  # Vite React (dashboard admin)
├── packages/
│   ├── shared-types/           # Zod schemas générés (zod-prisma-types) + DTOs métier
│   ├── shared-config/          # Configs ESLint, TSConfig, Prettier
│   └── api-client/             # Client TS généré pour mobile + admin
├── docs/
│   ├── CAHIER-DES-CHARGES-v1.4.md  (ce fichier)
│   ├── CAHIER-DES-CHARGES-v1.3.md  (archive)
│   ├── architecture.md
│   ├── rgpd/
│   └── personas.md
├── docker-compose.yml          # Postgres+PostGIS + Redis (dev)
├── docker-compose.test.yml     # Postgres+PostGIS + Redis éphémères (tests)
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

---

## 9. Environnements (inchangé v1.3)

| Env | DB | Stripe | Cloudinary | Domaine |
|---|---|---|---|---|
| development | `cleanconnect_dev` (local) | `sk_test_*` | dossier `dev/` | localhost |
| recette | `cleanconnect_rec` | `sk_test_*` | dossier `rec/` | rec.cleanconnect.fr |
| preprod | `cleanconnect_preprod` | `sk_test_*` | dossier `preprod/` | preprod.cleanconnect.fr |
| production | `cleanconnect_prod` | `sk_live_*` | dossier `prod/` | cleanconnect.fr |

Vérification de cohérence Stripe ↔ env au boot serveur (refus si mismatch).

---

## 10. Roadmap MVP v1.4

### Phase 0 — Setup (2 semaines)

- [ ] Monorepo Turborepo + pnpm + tsconfig partagés
- [ ] `apps/api` NestJS minimal : health check, env Zod, Pino, AllExceptionsFilter, ZodValidationPipe
- [ ] `apps/mobile` Expo : login factice + theme tokens + RoleGuard squelette
- [ ] `apps/admin` Vite React : login factice
- [ ] `packages/shared-types` avec `zod-prisma-types` configuré
- [ ] Schéma Prisma initial : User, Mission, Photo, Payment, EscrowHistory, StripeEvent, Dispute
- [ ] Migration PostGIS (CREATE EXTENSION + GEOGRAPHY + index GIST)
- [ ] docker-compose.yml dev (Postgres+PostGIS + Redis AOF)
- [ ] docker-compose.test.yml (containers éphémères)
- [ ] CI GitHub Actions (lint + typecheck + test + build)
- [ ] Comptes Stripe Connect Express sandbox configurés
- [ ] Compte Cloudinary configuré, presets sandbox + EXIF stripping
- [ ] Sentry init backend + mobile + admin
- [ ] Documentation : `docs/CAHIER-DES-CHARGES-v1.4.md`, `architecture.md`, `rgpd/registre-traitements.md`

### Phase 1 — MVP core (9-11 semaines)

(Identique v1.3, mais avec :)
- App mobile **unique** Client + Prestataire avec RoleGuard
- Tests Jest + container Postgres+PostGIS éphémère sur Payment, Escrow, Matching
- Detox happy path mobile

### Phase 2 — Polissage & extensions (inchangé v1.3)

---

## 11. Critères d'acceptation MVP v1.4

(En plus de ceux de v1.3 :)

- [ ] Couverture tests : Payment + Escrow ≥ 90 %, Matching ≥ 80 %, reste backend ≥ 70 %
- [ ] Detox happy path passe en CI
- [ ] L'app mobile unique gère client ET prestataire (utilisateur dual testé)
- [ ] Bascule de mode (Client ↔ Prestataire) instantanée et persistée
- [ ] PostGIS `ST_DWithin` indexé (EXPLAIN ANALYZE montre `Index Scan`, pas `Seq Scan`)
- [ ] Redis AOF activé, vérifié par redémarrage Redis sans perte de delayed jobs

---

## 12. Risques identifiés (mise à jour v1.4)

| Risque | Impact | Probabilité | Mitigation |
|---|---|---|---|
| Sync offline défaillante | Élevé | Moyenne | Retry exponentiel + démarrage avec sync pending |
| Webhook Stripe perdu | Critique | Faible | Idempotence + DLQ + cron horaire + Redis AOF |
| Chargeback client | Élevé | Moyenne | Stripe Radar + photos AVANT/APRÈS comme preuves |
| Litige photos truquées | Moyen | Faible | EXIF + timestamp serveur sur upload |
| Concurrence acceptation mission | Faible | Moyenne | Lock optimiste DB |
| RGPD non conforme | Critique | Faible | Registre + procédures d'effacement |
| Bug de switch de rôle mobile | Moyen | Moyenne | Tests Detox sur bascule + clear cache TanStack Query à la bascule |
| Perte de delayed jobs Redis | Critique | Faible | **AOF activé + cron de sécurité horaire** |
| Décalage horaire (jours fériés) | Moyen | Moyenne | `date-fns-business-days` + table de fériés FR mise à jour annuellement |

---

## 13. Hors-scope MVP (V2+) — inchangé v1.3

- Paiement en plusieurs fois
- Abonnement prestataire
- API publique
- Multi-pays
- Mode hors-ligne client
- Chat vidéo client ↔ prestataire

---

*Fin du document — v1.4*
