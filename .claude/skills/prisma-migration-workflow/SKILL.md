---
name: prisma-migration-workflow
description: Run a Prisma migration workflow in the Clean Connect monorepo (modify schema.prisma, generate migration, review the SQL, apply with migrate dev locally, deploy in prod with migrate deploy). Use when the user asks to modify the database schema, add a column, add a table, create a migration, run prisma, or alter the database structure.
---

# Workflow migration Prisma — Clean Connect

## Quand utiliser

À chaque modification du schéma DB dans `apps/api/prisma/schema.prisma`. Aucune modification SQL manuelle ne contourne ce workflow.

## Workflow complet

```
☐ 1. Modifier apps/api/prisma/schema.prisma
☐ 2. Générer migration en local : pnpm --filter @cleanconnect/api prisma migrate dev --name <name>
☐ 3. RELIRE le SQL généré dans apps/api/prisma/migrations/<timestamp>_<name>/migration.sql
☐ 4. Tester localement (typecheck + runtime + tests)
☐ 5. Commit (schema.prisma + migration.sql + Prisma Client regen)
☐ 6. Déploiement → pnpm --filter @cleanconnect/api prisma migrate deploy
```

## Étape 1 — Modifier `schema.prisma`

```prisma
// apps/api/prisma/schema.prisma
model Mission {
  id              String    @id @default(uuid())
  clientId        String
  prestataireId   String?
  status          MissionStatus
  serviceType     ServiceType
  scheduledAt     DateTime
  durationMinutes Int
  amountCents     Int

  // Nouveau champ
  notes           String?   @db.Text

  // PostGIS — colonne gérée hors Prisma via migration manuelle
  // location      Unsupported("GEOGRAPHY(Point, 4326)")

  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  completedAt     DateTime?

  client          User      @relation("ClientMissions", fields: [clientId], references: [id])
  prestataire     User?     @relation("PrestataireMissions", fields: [prestataireId], references: [id])
  photos          Photo[]

  @@index([status, scheduledAt])
  @@index([clientId])
  @@index([prestataireId])
}
```

## Étape 2 — Générer la migration

```bash
pnpm --filter @cleanconnect/api prisma migrate dev --name add_mission_notes
```

Cela crée :
- `apps/api/prisma/migrations/<timestamp>_add_mission_notes/migration.sql`
- Régénère le Prisma Client
- Applique sur la DB locale

**Règle** : `migrate dev` **uniquement** en local. Jamais en recette/preprod/prod.

## Étape 3 — Relire le SQL (étape critique)

Ouvrir `migration.sql` et vérifier :

```
☐ Fait UNIQUEMENT ce qui est attendu
☐ Pas de DROP TABLE inattendu (rename mal détecté)
☐ Les renames de colonnes sont des RENAME, pas DROP + ADD (perte de données)
☐ Les colonnes NOT NULL ajoutées ont une valeur par défaut OU le code gère la nullité
☐ Les index utiles sont créés
☐ Les FK ON DELETE / ON UPDATE sont cohérentes
```

**Si Prisma détecte mal un rename** (génère `ALTER TABLE DROP COLUMN x; ADD COLUMN y` au lieu de `RENAME`) :
- Éditer manuellement le `migration.sql`
- Garder le rename : `ALTER TABLE "Mission" RENAME COLUMN "x" TO "y";`
- Ajouter un commentaire SQL : `-- manual edit: rename x → y, Prisma generated drop+add`

## Étape 4 — PostGIS (cas particulier)

Prisma ne supporte pas nativement les types PostGIS. Pour `GEOGRAPHY(Point, 4326)` :

```sql
-- Ajout manuel après création du modèle Prisma sans le champ location
ALTER TABLE "User" ADD COLUMN "location" GEOGRAPHY(Point, 4326);
CREATE INDEX "User_location_idx" ON "User" USING GIST("location");
```

Et côté Prisma :
```prisma
model User {
  // ...
  location  Unsupported("GEOGRAPHY(Point, 4326)")?
}
```

Les requêtes spatiales se font via `$queryRaw` (cf `backend.mdc`).

## Étape 5 — Tester localement

```
☐ La table/colonne existe (psql : \d "Mission")
☐ Le Prisma Client est régénéré (pnpm tsc passe)
☐ Les requêtes existantes fonctionnent encore (tests)
☐ Les nouvelles requêtes fonctionnent
☐ Rollback testé si migration risquée (DROP, ALTER TYPE, RENAME)
```

## Étape 6 — Commit

Le commit doit contenir :
- `apps/api/prisma/schema.prisma` modifié
- `apps/api/prisma/migrations/<timestamp>_<name>/migration.sql` (généré ou édité)
- `apps/api/prisma/migrations/migration_lock.toml` (si modifié)
- Le code qui exploite le nouveau champ

**Ne jamais committer** une modif de `schema.prisma` sans la migration correspondante.

## Étape 7 — Déploiement

### Recette / Preprod / Prod

```bash
# Dans le CI/CD ou sur le serveur
pnpm --filter @cleanconnect/api prisma migrate deploy
```

**Avant migration prod** :
```
☐ Backup DB dans les 5 dernières minutes
☐ Migration testée en preprod avec données réalistes (rabattage prod anonymisé)
☐ Plan de rollback documenté si destructif
☐ Communication équipe si downtime potentiel
```

## Migrations destructives — règles dures

Toute migration contenant `DROP TABLE`, `DROP COLUMN`, `ALTER TYPE`, `RENAME` :

```
☐ Review humaine obligatoire (2 yeux minimum)
☐ Backup juste avant (pas il y a 3h)
☐ Migration en 2-3 temps si possible :
   1. N      : ajouter le nouveau champ, écrire dans les deux
   2. N+1    : déployer le code qui ne lit que le nouveau
   3. N+2    : supprimer l'ancien champ
☐ Rollback testé en preprod
☐ Pas le vendredi
```

## Anti-patterns

```bash
# ❌ migrate dev en prod (jamais)
pnpm prisma migrate dev --name fix

# ❌ db push (perd l'historique, OK pour prototypage uniquement)
pnpm prisma db push

# ❌ Modifier une migration déjà déployée
# (créer une nouvelle migration corrective à la place)

# ❌ SQL manuel via psql sans migration
psql $DATABASE_URL -c "ALTER TABLE ..."

# ❌ schema.prisma modifié sans migrate dev derrière
# (Prisma Client et DB divergent → bugs silencieux)
```

## Commandes utiles

```bash
# État actuel des migrations
pnpm --filter @cleanconnect/api prisma migrate status

# Régénérer le Prisma Client (sans toucher la DB)
pnpm --filter @cleanconnect/api prisma generate

# Prisma Studio (UI pour explorer la DB en dev)
pnpm --filter @cleanconnect/api prisma studio

# Reset DB en local (DESTRUCTIF — local uniquement)
pnpm --filter @cleanconnect/api prisma migrate reset
```
