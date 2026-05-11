# Clean Connect

> **Plateforme de mise en relation pour nettoyage spécialisé à domicile.**
> Porteur : Arisnova Solution · Zone de lancement : Soissons + 30–50 km.

Clean Connect met en relation des **clients** (particuliers ayant besoin d'un nettoyage spécialisé) et des **prestataires** (professionnels) via une application mobile unique. Le paiement transite par un séquestre Stripe Connect Express, libéré automatiquement après validation client (T+48h ouvrées).

---

## État du projet

| Phase | Statut |
|---|---|
| Phase 0 — Cadrage produit + méthode | ✅ Terminée |
| Phase 1 — Bootstrap monorepo (Sprint 0.2) | ✅ **Terminé** — usine logicielle prête |
| Phase 1 bis — Premier PRD (PRD-001 Auth JWT) | 🟡 À démarrer |
| Phase 2 — MVP fonctionnel | ⏳ À venir |
| Phase 3 — Mise en production Soissons | ⏳ À venir |

---

## Cockpit — points d'entrée

| Tu veux… | Lis | Pourquoi |
|---|---|---|
| Comprendre **le produit** | [`docs/CAHIER-DES-CHARGES-v1.4.md`](docs/CAHIER-DES-CHARGES-v1.4.md) | Source de vérité fonctionnelle |
| Comprendre **la méthode** | [`docs/method/BMAD.md`](docs/method/BMAD.md) | 4 phases : Discover → Design → Build → Verify |
| Cadrer **une nouvelle feature** | [`docs/templates/PRD-template.md`](docs/templates/PRD-template.md) | Template PRD à dupliquer dans `docs/prd/` |
| Acter **une décision technique** | [`docs/adr/ADR-template.md`](docs/adr/ADR-template.md) | Template ADR léger |
| Comprendre **les conventions code** | [`CLAUDE.md`](CLAUDE.md) | Stack, archi NestJS, sécurité, RGPD |
| Voir **les personas IA** | [`.cursor/rules/`](.cursor/rules/) (Cursor) ou [`.claude/rules/`](.claude/rules/) (Claude Code) | 12 rules : `senior-dev`, `architecte-api`, `mobile`, `stripe`, etc. |
| Voir **les workflows IA** | [`.cursor/skills/`](.cursor/skills/) ou [`.claude/skills/`](.claude/skills/) | 7 skills : créer un endpoint, audit sécu, migration Prisma, séquestre, etc. |

---

## Stack technique (résumé)

| Couche | Choix | Pourquoi |
|---|---|---|
| Backend | NestJS 10 + Prisma 5 + `nestjs-zod` + `zod-prisma-types` | Type-safety end-to-end, OpenAPI auto |
| Base | PostgreSQL 16 + **PostGIS 3.4** | Matching géographique natif (`ST_DWithin`) |
| Queue | BullMQ + Redis 7 (**AOF activé**) | Jobs persistants, delayed pour auto-release séquestre |
| Mobile | Expo SDK 51 + **NativeWind** + TanStack Query | **App unique** Client + Prestataire (RoleGuard) |
| Admin | Vite + React + **shadcn/ui** + TanStack Query | DX rapide, tokens partagés via `packages/design-tokens` |
| Paiements | **Stripe Connect Express** | KYC délégué, séquestre, split de commission 18 % HT |
| Photos | Cloudinary (dossiers privés, signed URLs) | Idempotence UUID v4 client |
| Push | Firebase Cloud Messaging | Topics `user:<id>` |
| Mail | SendGrid ou Postmark (à trancher) | — |
| Monitoring | Sentry + Pino structuré | Redactor PII actif |
| Monorepo | Turborepo + pnpm workspaces | Cache de build partagé |
| CI | **GitHub Actions** | Validé Phase 0 |
| Tests backend | **Jest** + container Postgres+PostGIS **éphémère** (`tmpfs`) | Couverture services Payment / Escrow / Matching |
| Tests mobile | **Detox** (Happy Path) | Login → Photo → Validation |
| Business dates | `date-fns-tz` (Europe/Paris) + `date-fns-business-days` | T+48h ouvrées, jours fériés FR |

---

## Architecture monorepo cible

```
clean-connect/
├── apps/
│   ├── api/                    NestJS — backend (port 3000)
│   ├── mobile/                 Expo — Client + Prestataire (RoleGuard)
│   └── admin/                  Vite — dashboard admin Clean Connect
├── packages/
│   ├── shared-types/           Zod + types générés via zod-prisma-types
│   ├── design-tokens/          Couleurs / radius / typo partagés
│   └── eslint-config/          Config ESLint partagée
├── docs/
│   ├── CAHIER-DES-CHARGES-v1.4.md   Source de vérité fonctionnelle
│   ├── method/BMAD.md               Méthode delivery
│   ├── templates/                   PRD-template, etc.
│   ├── prd/                         PRDs actifs (un par feature)
│   ├── adr/                         Decision records
│   └── security-reviews/            Rapports `reviewer-securite-code`
├── .github/                    Workflows CI, PR template (Phase 1)
├── .cursor/rules/ + skills/    Personas et workflows pour Cursor
├── .claude/rules/ + skills/    Pendants pour Claude Code
├── docker-compose.yml          Dev local : Postgres+PostGIS AOF + Redis AOF
├── docker-compose.test.yml     Tests CI : tmpfs, jetables
├── turbo.json                  Pipeline Turborepo
├── pnpm-workspace.yaml         Workspaces
├── package.json                Racine
├── tsconfig.base.json          Strict mode partagé
├── .env.example                Référence secrets (sans valeurs)
└── CLAUDE.md                   Config Claude Code projet
```

**Sprint 0.2** : tous les éléments ci-dessus sont **désormais en place** (squelettes prêts à recevoir le code feature au fil des PRDs).

---

## Comment travailler sur ce projet

### 1. Toute tâche suit BMAD-light

```
Discover (PRD)  →  Design (contrats)  →  Build (PR)  →  Verify (audit sécu + QA)
```

- Pas de code sans **PRD validé** en Discover (`docs/prd/<slug>.md`)
- Pas de Build sans **Design validé** (Zod + Prisma + API figés)
- Pas de merge sans **rapport sécu** en Verify (0 Critical / 0 Important non traité)

Détails complets : [`docs/method/BMAD.md`](docs/method/BMAD.md).

### 2. Conventions de commit

Conventional Commits — référencer le PRD :

```
feat(missions): création route POST /missions (PRD-007)
fix(payments): idempotency-key manquant sur retry (PRD-003)
docs(adr): ADR-002 — choix PostGIS pour matching
chore(monorepo): bootstrap apps/api
```

### 3. Branches

| Type | Préfixe | Exemple |
|---|---|---|
| Feature | `feat/PRD-XXX-<slug>` | `feat/PRD-001-auth-jwt` |
| Bug | `fix/PRD-XXX-<slug>` | `fix/PRD-007-rating-overflow` |
| Infra / outillage | `chore/<slug>` | `chore/bootstrap-monorepo` |
| Doc seule | `docs/<slug>` | `docs/adr-002-postgis` |

---

## Démarrage

### Prérequis
- Node `>=20.11` (`.nvmrc` fixé à `20.18.0` — utiliser `nvm use`)
- pnpm `>=9` (`corepack enable && corepack prepare pnpm@9.12.3 --activate`)
- Docker Desktop (Postgres+PostGIS + Redis)
- Expo Go installé sur ton iPhone/Android (pour le mobile) — cf. ADR-001

### Installation

```bash
git clone <repo>
cd clean-connect
cp .env.example .env.local        # remplir les secrets locaux
pnpm install
```

### Services Docker (Postgres+PostGIS AOF + Redis AOF)

**Prérequis** : Docker Desktop démarré (daemon actif).

```bash
pnpm db:up                         # démarre postgres + redis (dev)
# DATABASE_URL doit pointer sur localhost:5434 (voir .env.example)
pnpm --filter @cc/api run db:migrate:deploy   # applique les migrations existantes (ne régénère rien)
pnpm --filter @cc/api run db:seed             # seed (vide pour l'instant)
```

Pour **créer** une nouvelle migration après modification de `schema.prisma` : `pnpm --filter @cc/api run db:migrate:dev` (uniquement en dev, jamais sur la migration manuelle PostGIS sans relecture).

#### Vérifier que les services tournent (Sprint 0 — sanity check)

```bash
docker compose ps
docker exec cc-postgres psql -U cc -d cleanconnect_dev -c "SELECT PostGIS_Version();"
docker exec cc-redis redis-cli ping
```

Attendu : `cc-postgres` et `cc-redis` en **healthy**, PostGIS `3.4`, Redis `PONG`.

**Port Postgres sur l'hôte : `5434`** (et non `5432`) : sur Windows, un PostgreSQL installé en local occupe souvent `127.0.0.1:5432`. Le compose mappe donc le conteneur vers **`localhost:5434`** pour éviter les connexions Prisma vers le mauvais serveur. La variable `DATABASE_URL` dans `.env.example` utilise ce port.

### Prisma, PostGIS et readiness (`/readyz`)

Après `pnpm db:up`, avec `DATABASE_URL` alignée sur le port **5434** (fichier `.env.local` ou variable d'environnement) :

```bash
pnpm --filter @cc/api run db:generate       # Prisma Client + zod-prisma-types → packages/shared-types/src/zod/generated
pnpm --filter @cc/api run db:migrate:deploy # applique migrations (dont CREATE EXTENSION postgis)
docker exec cc-postgres psql -U cc -d cleanconnect_dev -c "\dx"   # doit lister postgis
```

Démarrer l’API (variables JWT / Stripe / Redis obligatoires — voir `.env.example`), puis :

```bash
curl -s http://localhost:3000/v1/readyz
```

Réponse attendue : JSON avec `status: "ok"` et l’indicateur `database` en **up** (ping SQL via Prisma). Le préfixe `/v1` provient du versioning URI de NestJS (`enableVersioning`) configuré dans `apps/api/src/main.ts`.

### Dev (tout en parallèle via Turborepo)

```bash
pnpm dev
# Lance : @cc/api (http://localhost:3000) + @cc/mobile (Expo) + @cc/admin (http://localhost:5173)
```

### Commandes utiles

| Commande | Effet |
|---|---|
| `pnpm typecheck` | TypeScript strict sur tout le monorepo |
| `pnpm lint` | ESLint sur tout le monorepo |
| `pnpm test` | Tests unitaires |
| `pnpm test:integration` | Tests d'intégration (containers test éphémères requis : `pnpm db:test:up`) |
| `pnpm db:test:up` / `pnpm db:test:down` | Démarre/arrête Postgres+Redis éphémères pour tests |
| `pnpm --filter @cc/api db:studio` | Prisma Studio |
| `pnpm --filter @cc/api dev` | API seule en mode watch |
| `pnpm --filter @cc/mobile dev` | Expo Go (QR code) |
| `pnpm --filter @cc/admin dev` | Admin Vite |

---

## Environnements

| Env | DB | Stripe | Domaine |
|---|---|---|---|
| development | `cleanconnect_dev` | `sk_test_*` | localhost |
| recette | `cleanconnect_rec` | `sk_test_*` | rec.cleanconnect.fr |
| preprod | `cleanconnect_preprod` | `sk_test_*` | preprod.cleanconnect.fr |
| production | `cleanconnect_prod` | `sk_live_*` | cleanconnect.fr |

Hébergement à trancher en Phase 1.

---

## Sécurité & RGPD (rappel)

- Données paiement : conservation 10 ans (Code de commerce)
- Photos AVANT/APRÈS : 12 mois après fin de mission
- Soft delete compte : 30 j puis purge (sauf obligation légale)
- Routes RGPD : `GET /users/me/export`, `PATCH /users/me`, `DELETE /users/me`
- Aucun webhook test ne touche la DB de prod — vérification préfixe `sk_test_` / `sk_live_`

Règles complètes : [`.cursor/rules/securite.mdc`](.cursor/rules/securite.mdc) + [`.cursor/rules/stripe.mdc`](.cursor/rules/stripe.mdc) + [`.cursor/rules/photos-rgpd.mdc`](.cursor/rules/photos-rgpd.mdc).

---

## Licence

Propriétaire — Arisnova Solution. Tous droits réservés.

---

*Clean Connect — v1.4 — README cockpit (Sprint 0.1, 11 mai 2026)*
