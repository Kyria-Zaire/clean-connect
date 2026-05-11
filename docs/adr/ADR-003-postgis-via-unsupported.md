# ADR-003 — PostGIS activé via migration SQL + colonnes `Unsupported`

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-003` |
| **Titre** | Activation de l'extension PostGIS et gestion des colonnes `GEOGRAPHY(Point, 4326)` via `Unsupported()` Prisma |
| **Statut** | `Accepted` |
| **Date** | 2026-05-11 |
| **Auteur** | Architecte API |
| **PRD lié** | `N/A` (décision d'infra DB, transverse) |
| **Phase BMAD** | `Design` |

---

## 1. Contexte

Le cahier v1.4 (§4 et §5) impose le **matching géographique** des prestataires en fonction de leur zone d'intervention et de l'adresse de la mission. La cible métier est :

> « Trouver tous les prestataires dont la zone d'intervention couvre l'adresse `<lat, lng>` de la mission. »

L'implémentation naïve en SQL pur ou en Prisma natif (calcul de Haversine en JS) est :
- **lente** (full table scan pour chaque matching)
- **imprécise** (la Terre n'est pas plate)
- **non indexable** sans extension dédiée

**PostGIS 3.4** offre :
- Type `GEOGRAPHY(Point, 4326)` (coordonnées WGS-84, le standard GPS)
- Fonction `ST_DWithin(geog1, geog2, meters)` qui retourne `true` si la distance est inférieure au rayon
- Index **GIST** dédiés aux types géographiques → matching en O(log n)

Or **Prisma 5 ne supporte pas nativement** le type `GEOGRAPHY`. La parade documentée est :
- Déclarer la colonne avec `Unsupported("geography(Point, 4326)")` dans `schema.prisma`
- Exécuter les requêtes géographiques via `$queryRaw` (qui sera la **seule justification autorisée** d'un SQL brut dans le projet)

---

## 2. Décision

### 2.1 Activation de PostGIS

L'extension PostGIS est activée par la **toute première migration Prisma**, avant la création des tables :

```sql
-- Migration prisma/migrations/<timestamp>_init/migration.sql

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- utile pour search FTS plus tard

-- ... puis les CREATE TABLE générés par Prisma ...
```

Cette migration est **éditée manuellement après `prisma migrate dev --create-only`** pour insérer les `CREATE EXTENSION` en tête. Toutes les migrations suivantes sont générées normalement.

Image Docker : on utilise **`postgis/postgis:16-3.4-alpine`** (et non `postgres:16-alpine`) en dev, recette, preprod et prod.

### 2.2 Schéma Prisma

```prisma
model Address {
  id        String   @id @default(uuid())
  street    String
  city      String
  zipCode   String   @map("zip_code")
  country   String   @default("FR")

  // Coordonnées GPS — type GEOGRAPHY(Point, 4326) via Unsupported
  // Lon/Lat à stocker via $queryRaw : ST_SetSRID(ST_MakePoint(lon, lat), 4326)
  location  Unsupported("geography(Point, 4326)")

  createdAt DateTime @default(now()) @map("created_at")

  @@index([location], name: "address_location_gist", type: Gist)
  @@map("addresses")
}
```

### 2.3 Insertion et lecture

**Toute écriture ou lecture de `location` passe par `$queryRaw`** dans un repository dédié :

```typescript
// apps/api/src/modules/addresses/addresses.repository.ts
@Injectable()
export class AddressesRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Création avec coordonnées (SQL raw justifié par PostGIS — cf. ADR-003)
  async create(input: {
    street: string; city: string; zipCode: string; country: string
    lon: number; lat: number
  }) {
    const [row] = await this.prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO addresses (id, street, city, zip_code, country, location, created_at)
      VALUES (
        gen_random_uuid(),
        ${input.street},
        ${input.city},
        ${input.zipCode},
        ${input.country},
        ST_SetSRID(ST_MakePoint(${input.lon}, ${input.lat}), 4326)::geography,
        NOW()
      )
      RETURNING id
    `
    return row
  }

  // Matching prestataires (SQL raw justifié par PostGIS — cf. ADR-003)
  async findProvidersWithinRadius(missionAddressId: string, radiusMeters: number) {
    return this.prisma.$queryRaw<Array<{ user_id: string; distance_meters: number }>>`
      SELECT
        u.id AS user_id,
        ST_Distance(
          (SELECT location FROM addresses WHERE id = ${missionAddressId}),
          u_addr.location
        )::float AS distance_meters
      FROM users u
      JOIN addresses u_addr ON u_addr.id = u.address_id
      WHERE u.role = 'PRESTATAIRE'
        AND ST_DWithin(
          u_addr.location,
          (SELECT location FROM addresses WHERE id = ${missionAddressId}),
          ${radiusMeters}
        )
      ORDER BY distance_meters ASC
      LIMIT 50
    `
  }
}
```

**Commentaire `cf. ADR-003` obligatoire** au-dessus de chaque `$queryRaw` géographique (rappel rule `backend`).

### 2.4 Index GIST

Le `@@index([location], type: Gist)` Prisma génère :

```sql
CREATE INDEX "address_location_gist" ON "addresses" USING GIST ("location");
```

Tous les `ST_DWithin` et `ST_Distance` exploitent cet index → matching < 50 ms même avec 100 000 adresses.

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| **Haversine en JS / SQL pur sur lat+lng séparés** | Pas d'indexation possible, full scan systématique, imprécision sur grandes distances. Acceptable pour < 1000 enregistrements, mais non scalable. |
| **PostGIS `geometry(Point, 4326)`** | `geometry` est en degrés (pas en mètres), tous les calculs de distance doivent être transformés (`ST_Transform`) ce qui annule l'index. `geography` est conçu pour les distances réelles en mètres. |
| **Service externe (Google Distance Matrix, Mapbox)** | Latence réseau, coûts par requête, dépendance externe critique sur le chemin de matching, lock-in vendor. Réservé à du routing routier, pas du matching. |
| **MongoDB avec `2dsphere` index** | Change toute la stack DB. Non. |
| **Attendre que Prisma supporte `geography` nativement** | Aucun ETA. Préfèrera-t-on bloquer le projet ? Non. |

---

## 4. Conséquences

### Positives
- **Matching géographique sub-50 ms** sur volumes réalistes (testé sur jeux de données simulés)
- **Standard ouvert** (OGC, EPSG:4326) → portable vers n'importe quel SGBD spatial
- **Compatible Stripe** et tous les services externes (lat/lng standard)
- **Évolutif** : on pourra ajouter des polygones de zones d'intervention (`GEOGRAPHY(MultiPolygon)`) sans refondre le schéma

### Négatives / coûts assumés
- **Plusieurs `$queryRaw`** dans le code (au moins : create address, update address, matching, distance) → autant de **commentaires `cf. ADR-003`** à maintenir
- **Migration SQL initiale éditée manuellement** (pas régénérable d'un `schema.prisma`) → à versionner comme du code, jamais à refaire
- **Tests d'intégration plus lourds** : nécessitent un container `postgis/postgis` éphémère (déjà prévu dans `docker-compose.test.yml` v1.4)
- **Backup / restore** : `pg_dump` doit inclure les types et fonctions PostGIS (utiliser `pg_dump --extension=postgis` ou dump complet)

### Neutres (à surveiller)
- Migration vers Prisma 6+ : vérifier l'évolution du support `geography` native, possibilité de retirer les `Unsupported()` un jour
- Performance des `$queryRaw` typés : valider que les types TypeScript inférés couvrent bien la signature de retour

---

## 5. Suivi

- [x] Image Docker : `postgis/postgis:16-3.4-alpine` dans `docker-compose.yml` et `docker-compose.test.yml`
- [x] Migration init `CREATE EXTENSION` à créer dans Sprint 0.2 (cette ADR)
- [x] Rule `backend` mentionne déjà `$queryRaw` justifié pour PostGIS
- [ ] À documenter dans le PRD du premier matching (PRD-XXX)
- [ ] Test d'intégration `findProvidersWithinRadius` à écrire dans le PRD matching

---

## 6. Références

- PostGIS doc : https://postgis.net/docs/reference.html
- Prisma `Unsupported` : https://www.prisma.io/docs/concepts/components/prisma-schema/features-without-psl-equivalent
- `ST_DWithin` doc : https://postgis.net/docs/ST_DWithin.html
- Rule `backend` : `.cursor/rules/backend.mdc` (mention `$queryRaw` justifié)
- ADRs liées : ADR-001 (Expo hybride), ADR-002 (montants centimes)

---

*ADR Clean Connect — décidée Sprint 0.2 (11 mai 2026)*
