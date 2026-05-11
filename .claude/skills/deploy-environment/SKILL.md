---
name: deploy-environment
description: Deploy the Clean Connect monorepo (api + admin + mobile) to a specific environment (dev, recette, preprod, prod) or sync DB between environments following the strict directionality rules. Use when the user asks to deploy, ship, release, push to recette/preprod/prod, sync database, dump prod, or restore a database.
---

# Déploiement & sync DB — Clean Connect

## Environnements

| Env | DB | Stripe | Cloudinary folder | Domaine | Branche source |
|---|---|---|---|---|---|
| development | `cleanconnect_dev` | `sk_test_*` | `dev/` | localhost | feature/* |
| recette | `cleanconnect_rec` | `sk_test_*` | `rec/` | rec.cleanconnect.fr | develop |
| preprod | `cleanconnect_preprod` | `sk_test_*` | `preprod/` | preprod.cleanconnect.fr | release/* |
| production | `cleanconnect_prod` | `sk_live_*` | `prod/` | cleanconnect.fr | main |

## Workflow de déploiement

```
☐ 1. CI verte (typecheck + lint + test + audit critique + build)
☐ 2. Validation en preprod (pour un déploiement prod)
☐ 3. Backup DB de l'env cible (si prod/preprod)
☐ 4. Migration Prisma : prisma migrate deploy
☐ 5. Déploiement du nouveau code (zero downtime via blue/green ou rolling)
☐ 6. Health check /api/health
☐ 7. Smoke test des routes critiques
☐ 8. Communication équipe (Slack)
```

## Script de déploiement (squelette)

```bash
#!/bin/bash
set -euo pipefail

ENV="${1:-}"
if [[ -z "$ENV" ]]; then
  echo "Usage: $0 <recette|preprod|prod>" >&2
  exit 1
fi

# Confirmation manuelle obligatoire pour prod
if [[ "$ENV" == "prod" ]]; then
  read -rp "⚠️  Déploiement PRODUCTION Clean Connect. Confirmer (yes/no) ? " confirm
  [[ "$confirm" == "yes" ]] || { echo "Annulé."; exit 0; }

  read -rp "Avez-vous validé en preprod ? (yes/no) " preprod_ok
  [[ "$preprod_ok" == "yes" ]] || { echo "Annulé. Validez en preprod d'abord."; exit 0; }
fi

echo "🚀 Déploiement Clean Connect → $ENV"

# 1. Build images
docker-compose -f "docker-compose.${ENV}.yml" build api admin

# 2. Migrations Prisma
docker-compose -f "docker-compose.${ENV}.yml" run --rm api pnpm --filter @cleanconnect/api prisma migrate deploy

# 3. Déploiement
docker-compose -f "docker-compose.${ENV}.yml" up -d --no-deps api admin

# 4. Health check
echo "🩺 Health check..."
sleep 5
curl -fsS "https://${ENV}.cleanconnect.fr/api/health" \
  | jq -e '.status == "ok"' > /dev/null \
  || { echo "❌ Health check KO"; exit 1; }

echo "✅ Déploiement $ENV OK"
```

## Synchronisation DB — règle de directionnalité

```
✅ AUTORISÉ
   prod    → preprod   (avec anonymisation PII)
   prod    → recette   (avec anonymisation PII)
   preprod → recette
   preprod → dev       (avec anonymisation PII si données réelles)

❌ INTERDIT — JAMAIS
   dev     → prod
   recette → prod
   recette → preprod
   *       → prod (sauf restore d'un backup prod)
```

**Pourquoi** : un environnement aval ne peut jamais polluer un environnement amont. Les données de prod sont une vérité, pas une variable.

## Script sync DB

```bash
#!/bin/bash
set -euo pipefail

SOURCE="${1:-}"
TARGET="${2:-}"

case "${SOURCE}→${TARGET}" in
  "prod→preprod"|"prod→recette"|"prod→dev"|"preprod→recette"|"preprod→dev")
    ;;
  *)
    echo "❌ Sens interdit : ${SOURCE} → ${TARGET}" >&2
    exit 1
    ;;
esac

if [[ "$TARGET" != "dev" ]]; then
  read -rp "Sync $SOURCE → $TARGET. Confirmer (yes/no) ? " confirm
  [[ "$confirm" == "yes" ]] || exit 0
fi

DUMP="/tmp/cleanconnect_${SOURCE}_$(date +%s).sql"

echo "📦 Dump $SOURCE..."
pg_dump "$(env_db_url "$SOURCE")" --no-owner --no-acl -f "$DUMP"

if [[ "$SOURCE" == "prod" ]]; then
  echo "🔒 Anonymisation PII..."
  ./scripts/anonymize-cleanconnect.sh "$DUMP"
fi

echo "📥 Restore vers $TARGET..."
psql "$(env_db_url "$TARGET")" < "$DUMP"

rm "$DUMP"
echo "✅ Sync $SOURCE → $TARGET OK"
```

## Anonymisation PII (Clean Connect)

| Champ | Transformation |
|---|---|
| `email` | `<hash(id)>@anon.cleanconnect.fr` |
| `phone` | `+33000000000` |
| `firstName` / `lastName` | `Utilisateur <hash(id)>` |
| `address.street` | masquage (garder code postal) |
| `User.passwordHash` | hash bcrypt fixe (mot de passe partagé `test1234`) |
| `Photo.cloudinaryPublicId` | placeholder (les blobs ne sont pas synchronisés) |
| `User.stripeAccountId` | conservé (sandbox, mais isolé) |
| Logs / tokens / refreshTokens | tronqués ou NULL |

## Health check après déploiement

```typescript
GET /api/health
→ 200 OK
{
  "status": "ok",
  "environment": "prod",
  "services": { "database": "ok", "redis": "ok" }
}
```

Si `status !== 'ok'` → **rollback immédiat**.

## Rollback

```bash
# Stratégie : tag Docker précédent (toujours conservé 7 j)
docker-compose -f docker-compose.prod.yml up -d --no-deps api:${PREV_TAG} admin:${PREV_TAG}

# Si la migration Prisma est destructive :
#   - restore du backup pris juste avant
#   - puis rollback image
```

**Règle** : toujours garder le tag précédent disponible **7 jours** après un déploiement.

## Vérification de cohérence Stripe ↔ DB

Le serveur vérifie au boot :

```typescript
const isLiveStripe = env.STRIPE_SECRET_KEY.startsWith('sk_live_')
const isProdEnv = env.NODE_ENV === 'production'
if (isLiveStripe !== isProdEnv) {
  console.error('❌ Stripe key / NODE_ENV mismatch')
  process.exit(1)
}
```

Empêche un déploiement où la prod tape Stripe test, ou inversement.

## Anti-patterns / interdictions

```
❌ Déploiement prod le vendredi après 17h
❌ Tag Docker `latest` en prod
❌ Déploiement prod sans passage validé en preprod
❌ `prisma migrate dev` en prod (toujours `migrate deploy`)
❌ Restore DB d'un env aval vers prod
❌ Credentials dans le compose-file de prod
❌ Force push sur main
❌ Sync prod → dev sans anonymisation PII
```

## Checklist post-déploiement

```
☐ /api/health répond 200
☐ Smoke test : login + créer une mission test + paiement test (en non-prod)
☐ Logs serveur sans erreur dans les 5 min qui suivent
☐ Métriques Sentry (taux d'erreur) stables vs avant
☐ Webhooks Stripe testés (Stripe CLI ou dashboard)
☐ Communication équipe (✅ déploiement OK / 🚨 rollback effectué)
```
