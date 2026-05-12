# ADR-011 — Stripe API pinning : `STRIPE_API_VERSION = 2025-02-24.acacia`

> **ADR** = *Architecture Decision Record*.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-011` |
| **Titre** | Pinning de la version Stripe API — `2025-02-24.acacia` (config-driven, jamais `latest`) |
| **Statut** | `Accepted` |
| **Date** | `2026-05-12` |
| **Auteur** | CTO Clean Connect + `architecte-api` + `stripe` |
| **PRD lié** | `docs/prd/PRD-003-photos-paiements.md` |
| **Phase BMAD** | `Design` |
| **Pré-revue sécurité** | `docs/security-reviews/2026-05-12-prd-003-design-prereview.md` |

---

## 1. Contexte

Stripe publie une nouvelle version d'API tous les ~6 mois (versions nommées en kebab-case + suffixe, ex: `2024-04-10.acacia`, `2024-09-30.acacia`, `2025-02-24.acacia`). Chaque version peut introduire :
- Breaking changes structurels (champs renommés, retirés, types modifiés).
- Nouveaux comportements webhook (events ajoutés, payloads enrichis).
- Comportements d'API mutés (retours d'erreur, codes, sémantique).

**Risque** :
- `apiVersion = 'latest'` côté SDK = la version d'API peut basculer **sans préavis** côté backend lors d'un nouveau bump Stripe → bugs silencieux, webhooks malformés vs nos types, payloads divergents entre serveurs.
- Aucun moyen de tester en preprod avant qu'une nouvelle version ne s'applique en prod.
- Audit fiscal / comptable difficile : pas de trace de la version d'API qui a produit le webhook.

**Décision CTO Q12** : version Stripe API **figée** + variable d'environnement `STRIPE_API_VERSION` + bump traçé via ADR.

---

## 2. Décision

### 2.1 Version pinnée — `2025-02-24.acacia`

- Version d'API actuelle Sprint 3 MVP : **`2025-02-24.acacia`** (dernière stable au 2026-05-12).
- Validation env vars boot (Zod) : `STRIPE_API_VERSION` obligatoire, format strict regex `^\d{4}-\d{2}-\d{2}\.[a-z]+$`. Crash au démarrage si invalide.

### 2.2 Initialisation SDK

```typescript
// apps/api/src/common/stripe/stripe.client.ts
import Stripe from 'stripe'
import { env } from '../config/env'

export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: env.STRIPE_API_VERSION as Stripe.LatestApiVersion, // cast strict pour typing — la valeur runtime est validée Zod
  typescript: true,
  maxNetworkRetries: 0, // on gère nous-mêmes l'idempotence + retry via BullMQ
  appInfo: {
    name: 'clean-connect-api',
    version: env.APP_VERSION,
    url: 'https://cleanconnect.fr',
  },
})
```

**Règle dure** : aucun appel `new Stripe(...)` sans `apiVersion` venant de `env.STRIPE_API_VERSION`. Audit grep CI sur `apiVersion: 'latest'` → fail build.

### 2.3 Webhook — version d'API tracée

Le payload webhook Stripe contient `api_version` (top-level). On vérifie au handler :

```typescript
function assertWebhookApiVersion(event: Stripe.Event) {
  if (event.api_version !== env.STRIPE_API_VERSION) {
    logger.warn(
      { eventId: event.id, eventApiVersion: event.api_version, expected: env.STRIPE_API_VERSION },
      'webhook.api_version.mismatch',
    )
    // MVP : on ne rejette PAS (Stripe peut envoyer des events legacy lors d'une bascule).
    // En revanche, on alerte ops + on persiste `apiVersion` côté StripeWebhookEvent pour audit.
  }
}
```

`StripeWebhookEvent.payload` JSON contient `api_version` → traçable rétroactivement.

### 2.4 Endpoint dashboard Stripe — pinning identique

Le webhook endpoint configuré côté dashboard Stripe (`https://api.cleanconnect.fr/v1/webhooks/stripe`) doit avoir **la même version d'API** que celle pinnée dans le code. Sinon les payloads peuvent diverger (un endpoint en `2024-04-10.acacia` reçoit des champs différents d'un endpoint en `2025-02-24.acacia`).

**Procédure de configuration** :
1. Stripe Dashboard → Developers → Webhooks → endpoint Clean Connect.
2. Édit endpoint → "API version" → choisir `2025-02-24.acacia` (= valeur de `STRIPE_API_VERSION`).
3. Vérifier qu'on a un endpoint **par environnement** (test/live) pinné à la même version.

### 2.5 Procédure de bump version

1. Lecture du [Stripe API Changelog](https://docs.stripe.com/upgrades) — identifier breaking changes.
2. Ouvrir un PRD ou ADR-bump (ex: `ADR-XXX-stripe-api-bump-YYYY-MM-DD.acacia`) avec :
   - Diff impacts sur Clean Connect (champs utilisés, webhooks écoutés).
   - Plan de test : recette → preprod → prod.
3. Mettre à jour `STRIPE_API_VERSION` dans `.env.example`, secrets manager preprod/prod.
4. Mettre à jour la version sur les webhooks Stripe Dashboard (test puis live).
5. Bumper `apps/api/package.json` SDK Stripe si nécessaire (`stripe` npm package — types alignés).
6. Run tests d'intégration complets en recette.
7. Smoke test paiement preprod (3 cartes test).
8. Déploiement prod + monitoring 48 h.

**Aucun bump silencieux**. Toute modification de la version Stripe = nouvelle ADR avec sign-off CTO.

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| `apiVersion: 'latest'` (Stripe SDK default) | Version mute sans préavis quand Stripe publie. Risque de breaking change silencieux en prod. Refusé. |
| Pin **dans le code source** (`const STRIPE_API_VERSION = '2025-02-24.acacia'`) | Pas de visibilité ops, nécessite redéploiement code pour bump. Préférence pour variable d'env (audit, observabilité, ops). |
| Pin **sans validation Zod** | Risque de typo / valeur invalide silencieuse → 500 runtime. Validation boot obligatoire. |
| **Multi-version simultanée** (gérer ancien + nouveau format webhook en parallèle) | Hors scope MVP. Complexité injustifiée. Une version à la fois, bumps traçés. |

---

## 4. Conséquences

### Positives

- **Pas de bug silencieux** : la version d'API ne bouge que sur ADR explicite.
- **Audit** : tout webhook traçable par `apiVersion` (DB + logs Pino).
- **DX** : typing TypeScript Stripe aligné via `Stripe.LatestApiVersion` (cast strict, validé Zod runtime).
- **Cohérence test/live** : la même version est utilisée dans tous les environnements.

### Négatives / coûts assumés

- **Maintenance** : nécessité de bumper périodiquement (Stripe peut deprecate des versions anciennes). MVP : pas de bump avant 6 mois post-lancement.
- **Cast `as Stripe.LatestApiVersion`** : si on pin une version qui n'est pas la `LatestApiVersion` du SDK actuel, on doit caster. Solution : aligner le bump SDK Stripe (`stripe@latest`) avec le bump version API au moment de l'ADR.

### Neutres (à surveiller)

- **Stripe deprecation** : Stripe garantit ~2 ans de support des versions. À surveiller via dashboard notifications.

---

## 5. Suivi

- [x] PRD §2.2 AC-B.12 + §3.4 D7 / Q12.
- [x] Mise à jour `.cursor/rules/stripe.mdc` (mention `STRIPE_API_VERSION`).
- [ ] **Build** : env Zod `STRIPE_API_VERSION` (regex + crash boot si invalide), initialisation `stripe.client.ts`.
- [ ] **Build** : warning Pino `webhook.api_version.mismatch` si event `api_version !== env.STRIPE_API_VERSION`.
- [ ] **Build** : grep CI `apiVersion: 'latest'` → fail build.
- [ ] **Build** : `StripeWebhookEvent.payload` JSON inclut `api_version` (déjà natif Stripe).
- [ ] **Verify** : smoke test recette + preprod avec cartes 4242 / 3220 / 9995 sur la version pinnée.

---

## 6. Références

- PRD : [`docs/prd/PRD-003-photos-paiements.md`](../prd/PRD-003-photos-paiements.md) §3.4 Q12.
- Stripe docs : [API versioning](https://docs.stripe.com/api/versioning), [Upgrades](https://docs.stripe.com/upgrades).
- ADRs liées : [ADR-008 Escrow Connect](ADR-008-escrow-manual-capture-delayed-transfer.md).

---

*ADR-011 v1.0 — PRD-003 Photos & Paiements — Sprint 3 Design.*
