## Audit Sécurité — PRD-003 Ticket 3.6-bis (Verify final)

**Auditeur** : Reviewer Sécurité (`reviewer-securite-code`)
**Cible** : Périmètre PRD-003 — paiements Stripe Connect Express (auth + escrow + transfers + refunds + DLQ + reconcile), photos Cloudinary, RBAC, logs Pino, OpenAPI.
**Date** : 2026-05-12
**Branche** : `verify/prd-003-ticket-3.6-bis-final-audits`
**Itération précédente** : Ticket 3.6 (PR #12, mergée `cfc3af5`) — verdict ⚠️ Conditions / 1 Important documenté.

**Verdict** : ✅ **Merge autorisé pour cette itération Verify.**
**Statut release-ready PRD-003** : ⚠️ **conditionnel** — code et tests intégration verts ; **étapes hors-code restantes** (smoke recette/preprod §6.2, perf §6.3, sign-off RGPD) à exécuter par l'équipe humaine avant clôture officielle (cf. §« Release Checklist »).

---

### Synthèse exécutive

| Sévérité | Compte | Synthèse |
|---|---:|---|
| 🔴 Critique | **0** | Aucun bypass auth, aucune fuite secret, aucun double payout / refund possible. |
| 🟠 Important | **0** | I1 (couverture grille §6.1 incomplète) **résolu** par cette itération. Audits hors-scope code 3.5 reclassés en dette PRD-004 documentée. |
| 🟡 Suggestion | 3 | Job CI `verify-prd-003` nommé ; alignement schémas réponses refund/replay (déjà partiellement traité) ; ré-écrire `assertEnvConsistency` pour préfixe `sk_*` (hors-scope). |
| 🟢 Conforme | 11+ | Signature Stripe pré-handler ; idempotence webhook + capture + transfer + refund + DLQ replay ; RBAC admin scellé ; redactor Pino étendu ; quotas photos enforcés ; TTL signed URL ≤ 5 min ; isolement env (livemode mismatch rejeté) ; tests races / concurrence verts. |

---

### Grille §6.1 — couverture finale (12 audits techniques + 11 scénarios CTO)

> Tous les tests cités sont en intégration (`apps/api/test/integration/*.spec.ts`) et tournent en CI sur `quality + integration + docker build`.

#### 6.1.1 — Audits techniques A–L

| ID | Audit | Statut | Référence |
|---|---|:---:|---|
| **A** | Idempotence webhook DB (`stripeEventId`) | ✅ | `payments-webhook.integration.spec.ts` (replay idempotent) |
| **B** | Idempotence mutations Stripe + domain handler | ✅ | `payments-intent.integration.spec.ts` (intent replay) ; `payments-domain.integration.spec.ts` (succeeded replay) ; `payments-verify-3-6.integration.spec.ts` (5× `handler.handle`) |
| **C** | Race validate vs auto-release | ✅ | **`payments-verify-3-6-bis-concurrency.integration.spec.ts`** — V2/C double POST `/validate` |
| **D** | Signature HMAC invalide | ✅ | `payments-webhook.integration.spec.ts` (HMAC invalide → 400) |
| **E** | Livemode mismatch (event.livemode vs APP_ENV) | ✅ | `payments-webhook.integration.spec.ts` ; `payments-domain.integration.spec.ts` |
| **F** | Quotas photos exacts (2/3 BEFORE, 4/5 AFTER) | ✅ | **`photos-verify-3-6-bis-quotas-rbac.integration.spec.ts`** — 4 cas (2/5 → 409 BEFORE ; 3/4 → 409 AFTER ; 3/5 → 200) |
| **G** | Suppression photo manuelle pré-rétention | 🟧 | **Dette PRD-004 RGPD** — pas d'endpoint `DELETE /photos/:id` en 3.5 (purge gérée par cron rétention 30 j post mission, pas par action manuelle). Documenté §« Dette ». |
| **H** | Signed URL Cloudinary TTL ≤ 5 min | ✅ | **`photos-verify-3-6-bis-quotas-rbac.integration.spec.ts`** — `expiresAt − now ≤ 300 s` |
| **I** | Webhook Cloudinary signature invalide | 🟧 | **Dette PRD-004** — pas de webhook entrant Cloudinary en 3.5 (Cloudinary est appelé en sortie ; `getResource` validé côté `/confirm`). Documenté. |
| **J** | DLQ après 5 retries + alerte admin | ✅ | `payments-ticket-3-5.integration.spec.ts` (DLQ replay admin-only + jobId déterministe) |
| **K** | Pino redactor (PII finance / Stripe / Cloudinary) | ✅ **revue statique** | `apps/api/src/app.module.ts` L37–L87 — `cardNumber`, `cvv`, `stripeAccountId`, `bankAccount`, `clientSecret`, `sessionToken`, `signature`, `api_secret`, `captureClientUuid`, `gpsLat/Lng`, `email`, `street`, `password*`, `*Token` |
| **L** | `DELETE /users/me` purge photos | 🟧 | **Dette PRD-004 RGPD** — endpoint utilisateur self-service hors-scope PRD-003 (PRD-001 expose `/auth/me` lecture uniquement). Documenté. |

#### 6.1.2 — Scénarios V1–V11

| ID | Scénario | Statut | Référence |
|---|---|:---:|---|
| **V1** | Replay 5× même `stripe_event_id` HTTP | ✅ | `payments-webhook.integration.spec.ts` (idempotent 202) |
| **V2** | Double POST `/validate` simultané → 1 capture | ✅ | **`payments-verify-3-6-bis-concurrency.integration.spec.ts`** — au plus 1 capture Stripe, idempotency-key `capture-mission-<id>` |
| **V3** | Double `scheduleTx` auto-release | ✅ | **`payments-verify-3-6-bis-concurrency.integration.spec.ts`** — 2 `scheduleTx` concurrents → 1 ligne DB ; `enqueueDelayedJob` 2× même bullJobId → 1 job BullMQ |
| **V4** | `POST /presign` sans JWT → 401 | ✅ | **`photos-verify-3-6-bis-quotas-rbac.integration.spec.ts`** (idem `/confirm`) |
| **V5** | Cross-mission upload | ✅ | `photos.integration.spec.ts` (cross-mission 409) |
| **V6** | AFTER sans BEFORE → 409 | ✅ | **`photos-verify-3-6-bis-quotas-rbac.integration.spec.ts`** (`INSUFFICIENT_BEFORE`) |
| **V7** | `providerPayoutStatus` PAYOUTS_DISABLED post-capture | ✅ | `payments-verify-3-6.integration.spec.ts` — capture OK, **0** `transfers.create` |
| **V8** | PaymentIntent expiré (`authorization_expired`) | ✅ | `payments-domain.integration.spec.ts` (canceled-automatic + audit failure code) |
| **V9** | Webhook spoofé (signature random) | ✅ | `payments-webhook.integration.spec.ts` (HMAC invalide → 400) |
| **V10** | Concurrent auto-release vs capture déjà effective | ✅ | **`payments-verify-3-6-bis-concurrency.integration.spec.ts`** — `requestCapture(SYSTEM/AUTO_RELEASE)` sur Payment `CAPTURED` → 0 appel Stripe |
| **V11** | Refund vs auto-release / replay capture | ✅ | `payments-verify-3-6.integration.spec.ts` (Payment `REFUNDED` → 0 outbound transfer) ; **`payments-verify-3-6-bis-concurrency.integration.spec.ts`** (Payment `REFUND_PENDING` → 0 capture) |

**Conclusion grille §6.1** : 12/12 audits techniques + 11/11 scénarios CTO sont **couverts** par tests d'intégration ou revue statique sourcée, à l'exception de **G/I/L** qui sont **hors-scope code PRD-003** (re-classés en dette PRD-004 ci-dessous, **décision écrite CTO requise** pour la clôture officielle).

---

### Dette explicite — décision CTO requise pour clôture PRD-003

| Sujet | Origine | Pourquoi reporté | Décision attendue |
|---|---|---|---|
| **G** — `DELETE /photos/:id` admin/owner | §6.1.1 (audit absent du code 3.x) | Aucun endpoint manuel de suppression en 3.5 ; la purge est portée par cron rétention 30 j post fin mission. | Accepter la dette PRD-004 ou exiger l'ajout d'une route avant clôture (faible risque mais hors-scope Verify). |
| **I** — Webhook Cloudinary signature | §6.1.1 | Pas de webhook **entrant** Cloudinary intégré (Cloudinary est consommé en sortie via `getResource`). | Accepter ou exiger ajout PRD-004. |
| **L** — `DELETE /users/me` + purge photos | §6.1.1 | Pas d'endpoint self-service RGPD en 3.x ; l'admin peut désactiver/anonymiser via console. | Accepter pour clôture PRD-003 ; ouvrir PRD-RGPD. |
| **Retry queue auto BullMQ transfers** | 3.5 §7.3 | Retiré pour casser un cycle DI Nest sans risque finance (retry admin manuel via `POST /admin/transfers/:id/retry`). | Reporté en PRD-004 (documenté). |
| **Orphan cleanup `PhotoUploadSession`** | 3.5 §7.3 | Volume résiduel borné (TTL session 5 min, donc max ~1/h × #sessions actives). | Reporté en PRD-004. |
| **CodeRabbit cleanup** (exceptions typées, repository pattern, logs refund symétriques) | 3.5 review | Non bloquant sécu ; améliorations DX. | À traiter au fil de l'eau si patch rapide. |

---

### Section A — Findings 🔴 Critique (0)

*Aucun.*

---

### Section B — Findings 🟠 Important (0)

*Aucun (I1 résolu cette itération).*

---

### Section C — 🟡 Suggestions (non bloquantes)

1. **CI** : nommer explicitement l'étape Integration en `verify-prd-003-integration` pour la traçabilité du PRD §6.1.3 (sinon : pas d'action). Coût : 1 ligne YAML.
2. **OpenAPI** : pour `POST /v1/admin/payments/:paymentId/refund` la réponse `202` est aujourd'hui `AcceptedAsyncBody` générique alors que le serveur renvoie `{ accepted, refundId, stripeRefundId }`. Désaligner doc-only sans risque ; déjà partiellement traité pour DLQ replay.
3. **Codes erreur** : harmoniser dans `mission-completion.errors.ts` le payload `reason` (parfois `INSUFFICIENT_BEFORE (before=0, after=5)` parfois plus court). Cosmétique.

---

### Section D — 🟢 Conformités vérifiées (extraits sourcés)

- **Auth + RBAC** : tous les controllers métier (`payments`, `admin-*`, `missions`, `mission-completion`, `photos`) sous `JwtAccessGuard` + `RolesGuard` + `@Roles(...)`. Le seul `@Public()` du périmètre est `POST /v1/webhooks/stripe` (auth par signature HMAC). Sources :
  - `payments.controller.ts:50-79` (`@Roles(CLIENT)`)
  - `admin-payments.controller.ts:28-47` (`@Roles(ADMIN)`)
  - `admin-transfers.controller.ts:31-61` (`@Roles(ADMIN)`)
  - `admin-refunds-dlq.controller.ts:18-57` (`@Roles(ADMIN)`)
  - `photos.controller.ts:45-69` (`@Roles(PRESTATAIRE, ADMIN)`)
  - `mission-completion.controller.ts:48-104` (`@Roles(PRESTATAIRE)` complete, `@Roles(CLIENT)` validate/report)
- **Signature Stripe avant désérialisation** : `payments-webhook.service.ts:99-110` (`constructEvent` sur `rawBody`) ; redactor Pino bloque `stripe-signature` dans les logs.
- **Idempotency-Key Stripe** : `payments.service.ts:330-354` (`buildCaptureIdempotencyKey`) ; `outbound-transfer.service.ts:190` (`buildTransferStripeIdempotencyKey`) ; `refunds.service.ts` (idempotence côté DB via unique `payment_id`).
- **No PII Stripe metadata** : confirmé `payments-ticket-3-5.integration.spec.ts:368` (test « Transfer SENT metadata UUIDs only »).
- **Rate limiting** : ThrottlerModule global ; webhook Stripe bypass justifié (`@SkipThrottle()` `payments-webhook.controller.ts:51` — auth par HMAC + replay légitime burst).
- **Validation Zod globale** : `ZodValidationPipe` au boot (`main.ts`) ; tous les controllers métier consomment des DTOs typés.
- **TTL signed URL Cloudinary** : `PHOTO_UPLOAD_SESSION_TTL_SECONDS=300` ; vérifié intégration H.
- **Quotas photos** : `PHOTO_MIN_BEFORE=3`, `PHOTO_MIN_AFTER=5` ; vérifié intégration F (4 cas).
- **DLQ Stripe** : admin-only (V3 ✅) + jobId déterministe `stripe-webhook-replay-<dlqId>-<ts>` ; replay testé.
- **Reconcile cron** : `TransferReconcileScheduler` détecte les transfers `PENDING > 2h` et appelle `stripe.transfers.retrieve` ; testé `payments-ticket-3-5.integration.spec.ts`.

---

### Section E — §6.2 Smoke test paiement (recette + preprod) — checklist humaine

> À exécuter par l'équipe ops sur les environnements réels avec compte Stripe **test** (`sk_test_*`). Cocher dans cette section puis joindre captures Stripe Dashboard.

#### E.1 — Recette (`rec.cleanconnect.fr`)
- [ ] Carte `4242 4242 4242 4242` (Visa OK) : PaymentIntent → `payment_intent.amount_capturable_updated` → mission `PUBLISHED` → fin mission → `payment_intent.succeeded` → `Payment.CAPTURED` + Mission `COMPLETED`.
- [ ] Carte `4000 0000 0000 3220` (3DS challenge) : flow PaymentSheet mobile complet, capture OK après 3DS.
- [ ] Carte `4000 0000 0000 9995` (refus) : mission reste en `PENDING_PAYMENT`, audit `PAYMENT_FAILED`, retry possible avec nouvelle `Idempotency-Key`.
- [ ] Onboarding Stripe Express test (prestataire) : `account.updated` reçu → `stripeTransfersEnabled=true` → mission acceptable.
- [ ] Auto-release T+48h ouvrées simulé (backdate `scheduledFor` en DB) : `Transfer.SENT` créé idempotent (idempotency-key déterministe).
- [ ] Refund admin intégral : `POST /v1/admin/payments/:id/refund` → 202 + webhook `charge.refunded` → `Payment.REFUNDED`.
- [ ] Refund admin partiel : `amountCents < amountCapturedCents` → 422 `PAYMENT_PARTIAL_REFUND_NOT_SUPPORTED`.
- [ ] DLQ replay : forcer un webhook 5× failed → entrée `WebhookDeadLetter` créée → admin replay → re-process OK.

#### E.2 — Préproduction (`preprod.cleanconnect.fr`)
Mêmes cases que E.1 sur la base DB préprod.

#### E.3 — Critère pass
0 anomalie sur les 8 scénarios par environnement. Toute anomalie = retour Build, pas merge.

---

### Section F — §6.3 Performance gates — checklist humaine

> À mesurer avec un load tester (`k6` / `bombardier`) après smoke vert. Objectifs PRD §6.3.

- [ ] `POST /v1/webhooks/stripe` p95 < **200 ms** sur 1000 events (mesuré recette).
- [ ] `POST /v1/missions/:id/photos/presign` p95 < **100 ms** sur 200 reqs (mesuré recette).
- [ ] Matching `findEligiblePrestataires` (PostGIS + filtre `stripeTransfersEnabled`) : pas de régression p95 vs PRD-002 (joindre `EXPLAIN ANALYZE`).

#### Critère pass
Tous les gates respectés. Si dépassement < 20 %, accepté avec ticket de suivi. > 20 % = bloquant.

---

### Section G — RGPD — checklist humaine (sign-off référent RGPD)

- [ ] **Rétention financière** (Code de commerce) : 10 ans sur tables `Payment`, `Transfer`, `Refund` documentée ; pas de purge avant cette limite. ⇒ Validation référent juridique requise.
- [ ] **Rétention photos** : 30 j post fin mission (ADR-010) → cron purge actif. Confirmation que le job tourne en recette (admin console).
- [ ] **PII en logs** : revue Pino redactor (paths `apps/api/src/app.module.ts:37-87`) ; aucun `email`, `passwordHash`, `cardNumber`, `cvv`, `stripeAccountId`, `clientSecret`, `sessionToken`, `gpsLat/Lng`, `street` détecté en `grep` sur sample 100 logs production-like.
- [ ] **Droit à l'effacement** : voie d'accès aujourd'hui = demande email + action admin ; documenté dans politique de confidentialité. **PRD-004** ouvre `DELETE /users/me` self-service.
- [ ] **Sous-traitants** : Stripe (paiement), Cloudinary (stockage photos), Postmark/SendGrid (email) — DPA signés.
- [ ] **Sign-off référent RGPD** : nom + date + signature ci-dessous.

```
Référent RGPD :  _____________________________
Date :           _____________________________
Décision :       [ ] approuvé    [ ] approuvé avec réserves    [ ] refusé
Notes :          _____________________________
```

---

### Section H — Release Checklist PRD-003

#### Code & tests
- [x] `quality` CI verte (unit 214 / lint 0 warn / typecheck OK).
- [x] `integration` CI verte (12 suites / 105 tests, dont 12 nouveaux Verify 3.6 + 3.6-bis).
- [x] `docker build` CI verte (Ticket 3.5 PR #11 confirmation).
- [x] Aucune `TODO(debt)` non documentée hors §7.3 PRD.

#### Documentation
- [x] OpenAPI `1.0.8-prd003-ticket-3.6-verify-openapi-align` aligné sur routes Nest.
- [x] PRD §6.5 lié au rapport ; §7.3 dette à jour.
- [x] Rapport `reviewer-securite-code` joint (ce fichier).

#### Ops (à valider humain hors PR)
- [ ] Smoke §6.2 vert sur **recette** ET **preprod**.
- [ ] Perf §6.3 dans les gates.
- [ ] Sign-off **CTO** sur cette PR.
- [ ] Sign-off **référent RGPD** (Section G).
- [ ] Plan rollback validé : flags `FF_PAYMENTS_ENABLED`, `FF_PAYOUTS_ENABLED`, `FF_PHOTOS_ENABLED` coupent les chaînes ; rollback DB = `prisma migrate resolve` sur les 9 migrations PRD-003.
- [ ] Dashboard admin : DLQ, transfers PENDING > 2h, auto-release jobs en erreur — accessible en prod.
- [ ] Changelog rédigé pour la release.

#### Décision dette
- [ ] Position CTO écrite sur G / I / L (accepter dette PRD-004 ou exiger correctifs).

#### Critère release-ready
**Toutes** les cases ci-dessus cochées (la check `[ ]` restante hors code = action humaine). Le code est, lui, prêt à merger.

---

### Décision merge & étapes suivantes

#### Décision merge (cette PR)
✅ **Merge autorisé** — code et tests verts ; 0 Critical / 0 Important ; grille §6.1 couverte intégration (3 audits classés dette PRD-004 documentés et soumis à décision CTO).

#### Étapes avant clôture officielle PRD-003 (humain)
1. CTO statue par écrit sur G / I / L (dette PRD-004 ou correctifs bloquants).
2. Ops exécute Section E (smoke) + Section F (perf).
3. Référent RGPD signe Section G.
4. CTO signe Section H.
5. Tag release `v3.0.0-prd003` + déploiement preprod → prod.

---

*Fin du rapport — itération Ticket 3.6-bis (2026-05-12, Verify final).*
