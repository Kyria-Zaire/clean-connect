## Audit Sécurité — PRD-003 Ticket 3.6 (Verify final)

**Auditeur** : Reviewer Sécurité (posture `reviewer-securite-code`)  
**Cible** : Périmètre PRD-003 (paiements Stripe, webhooks, transfers/refunds, photos Cloudinary, RBAC, logs Pino) + alignement OpenAPI `docs/api/PRD-003-openapi.yaml`  
**Date** : 2026-05-12  
**Contexte** : PR #11 (Ticket 3.5) mergée sur `main` (`ede12fa`). Branche Verify : `verify/prd-003-ticket-3.6-final-audit`.

**Verdict** : ⚠️ **Conditions** — la base code **3.5** est saine sur les zones critiques déjà couvertes par les tests d’intégration ; la **DoD §6.5** du PRD (23 audits A–L + V1–V11 *tous* passants en intégration + smoke recette/preprod + perf gates) **n’est pas encore entièrement satisfaite**. Voir § « Gaps Verify » ci-dessous.

---

### Synthèse exécutive

| Sévérité | Compte | Synthèse |
|---|---:|---|
| Critique | 0 | Aucun bypass auth/webhook paiement identifié sur le périmètre audité. |
| Important | 1 | Couverture tests d’intégration **incomplète** vs grille CTO §6.1 (audits sans test Jest dédié listés § Gaps). |
| Suggestion | 2 | Job CI `verify-prd-003` dédié (duplicata filtre) ; alignement schémas OpenAPI (réponses refund admin vs DTO réel). |
| Conforme | 8+ | Signature Stripe avant traitement ; RBAC admin refunds/DLQ/transfers ; redactor Pino étendu ; idempotence webhook ingestion ; scénarios 3.5 (double payout/refund, transfer.reversed, reconcile). |

### Décision merge / clôture PRD-003

- **Merge de cette branche Verify** : ✅ possible une fois revue CTO (docs + tests uniquement, pas de feature Build).
- **Clôture PRD-003 / release-ready (DoD §6.5)** : ❌ **non** tant que les items « Important » § Gaps ne sont pas traités ou explicitement dé-scopés par écrit CTO + référent RGPD (smoke + perf gates inclus).

---

### Gaps Verify (Important — I1)

#### I1 — Grille §6.1 : audits sans test d’intégration Jest explicite

Le PRD impose que **chaque** audit A–L et V1–V11 soit couvert par un test d’intégration cité (chemin + ligne). État constaté après Ticket 3.6 (itération 2026-05-12) :

| ID | Audit / scénario | Couverture actuelle | Fichier(s) de référence |
|---|---|---|---|
| **A** | Idempotence webhook DB (`stripeEventId`) | ✅ | `apps/api/test/integration/payments-webhook.integration.spec.ts` (replay idempotent ~L187) |
| **B** | Idempotence mutations Stripe API + domain handler replay | ✅ | `payments-intent.integration.spec.ts` ; `payments-domain.integration.spec.ts` (~L371 replay succeeded) ; **`payments-verify-3-6.integration.spec.ts`** (5× `handler.handle`) |
| **C** | Race validate vs auto-release | ⚠️ **GAP** — pas de test d’intégration `POST /missions/:id/validate` concurrent trouvé dans `apps/api/test/integration/`. |
| **D** | Signature HMAC invalide | ✅ | `payments-webhook.integration.spec.ts` (~L152) |
| **E** | Livemode mismatch | ✅ | `payments-webhook.integration.spec.ts` (~L159) ; `payments-domain.integration.spec.ts` (~L405) |
| **F** | Quota photos (2 BEFORE / 4 AFTER → 409) | ⚠️ **PARTIEL** — quotas presign/confirm couverts partiellement ; scénario exact PRD §6.1.2 **F** à confirmer / ajouter. |
| **G** | Suppression photo pré-rétention → 403 | ⚠️ **GAP** — pas de test DELETE photo identifié en intégration. |
| **H** | Signed URL expire 5 min | ⚠️ **GAP** — pas de test d’intégration sur TTL (assertion temporelle ou mock d’horloge). |
| **I** | Webhook Cloudinary signature invalide | ⚠️ **GAP** — pas de suite `*cloudinary*.integration.spec.ts`. |
| **J** | DLQ après 5 retries | ✅ (replay + infra) | `payments-ticket-3-5.integration.spec.ts` (DLQ replay) ; comportement 5× retry côté processor à documenter si besoin. |
| **K** | Pino redactor (finance / PII) | ✅ **revue statique** | `apps/api/src/app.module.ts` (~L37–L87) — chemins `cardNumber`, `cvv`, `stripeAccountId`, `bankAccount`, `clientSecret`, `sessionToken`, etc. |
| **L** | `DELETE /users/me` purge photos | ⚠️ **GAP** — aucun test d’intégration `users/me` dans `apps/api/test/`. |
| **V1** | Replay 5× même payload HTTP | ✅ | `payments-webhook.integration.spec.ts` (~L187) |
| **V2** | Double capture `validate` simultané | ⚠️ **GAP** | — |
| **V3** | Double job auto-release | ⚠️ **GAP** (ou partiel unitaire seulement) | — |
| **V4** | Upload sans auth → 401 | ⚠️ **À confirmer** | Pas de test `presign` sans `Authorization` listé dans `photos.integration.spec.ts` (à ajouter). |
| **V5** | Cross-mission upload | ✅ | `photos.integration.spec.ts` (~L374 « cross-mission ») |
| **V6** | AFTER sans BEFORE | ⚠️ **GAP** | — |
| **V7** | Payout disabled → pas de transfer | ✅ | **`payments-verify-3-6.integration.spec.ts`** |
| **V8** | PI expiré / capture failed | ⚠️ **PARTIEL** | `payments-domain.integration.spec.ts` (~L285 `authorization_expired` côté canceled) — alignement exact avec scénario CTO à valider. |
| **V9** | Webhook spoofé | ✅ | `payments-webhook.integration.spec.ts` (~L152) |
| **V10** | Concurrent auto-release + safety-net | ⚠️ **GAP** | — |
| **V11** | Refund vs capture / replay transfer | ✅ **partiel** | `payments-verify-3-6.integration.spec.ts` (REFUNDED → pas de `transfers.create`) ; enchaînement **concurrent** temps réel admin vs job : **GAP**. |

**Mitigation** : itération Verify suivante = ajouter les fichiers `*.integration.spec.ts` manquants **sans** nouvelle feature métier (stubs + orchestration HTTP + assertions DB), puis mettre à jour ce rapport (table complète avec numéros de ligne).

---

### 🟠 Important (hors I1)

*Aucun finding de sécurité applicative supplémentaire au périmètre audité.*

---

### 🟡 Suggestion

1. **CI** : le PRD §6.1.3 mentionne un job `verify-prd-003` — aujourd’hui `pnpm --filter @cc/api run test:integration` couvre déjà toute la suite (`.github/workflows/ci.yml`). Décider : renommer l’étape, ou dupliquer avec filtre `--testPathPattern` PRD-003 uniquement (risque : diverger de la suite complète).

2. **OpenAPI** : `POST /v1/admin/payments/{paymentId}/refund` — aligner le schéma de réponse `202` sur le corps réel (`{ accepted, refundId, stripeRefundId }` vs `AcceptedAsyncBody` générique) lors d’une itération doc-only.

---

### 🟢 Conforme (extraits vérifiables)

- **Webhook Stripe** : `constructEvent` sur raw body ; skip throttle documenté (`payments-webhook.controller.ts`).
- **RBAC** : `admin-payments`, `admin-transfers`, `admin-refunds-dlq` sous `JwtAccessGuard` + `@Roles(ADMIN)` ; routes métier client/prestataire correctement scindées.
- **No double payout / refund (3.5)** : `payments-ticket-3-5.integration.spec.ts`.
- **Transfer.reversed → litige** : même fichier.
- **Reconcile cron PENDING > 2h** : même fichier.
- **Qualité gate local** (2026-05-12) : `pnpm --filter @cc/api test` (214 tests) ; `pnpm --filter @cc/api test:integration` (93 tests, +3 Verify) ; `pnpm -r run lint` (0 warnings) ; `pnpm --filter @cc/api typecheck` OK.

---

### Dette documentée (non traitée en 3.6 sauf décision CTO)

| Sujet | Référence |
|---|---|
| Retry queue BullMQ auto pour transfers | `PaymentsModule` — TODO(debt) + `docs/prd/PRD-003-photos-paiements.md` §7.3 |
| Orphan cleanup sessions / photos | §7.3 PRD |
| Réserves CodeRabbit (typing, repository, logs) | §7.3 PRD — patchs optionnels faible risque |

---

### Prochaines étapes (humain)

1. Valider le merge de la branche `verify/prd-003-ticket-3.6-final-audit` (docs + tests + OpenAPI).
2. Trancher : **compléter la grille §6.1** (I1) en une ou plusieurs PR Verify, **ou** réviser le PRD pour réduire le périmètre des audits « intégration obligatoire » (décision CTO + trace ADR).
3. Exécuter **§6.2** (smoke cartes) + **§6.3** (perf) en recette/preprod ; joindre les preuves au rapport final.
4. Sign-off **CTO + référent RGPD** après 0 Critical / 0 Important.

---

*Fin du rapport — itération Ticket 3.6 (2026-05-12).*
