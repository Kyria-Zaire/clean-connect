# PRD-004 — Hardening, Ops & Compliance

> **PRD** = *Product Requirements Document*
> Sprint **4** — durcissement production post-MVP. Aucune feature visible client.
> Méthode : [BMAD-light](../method/BMAD.md). **Phase actuelle : Discover (DISCOVER_DRAFT)**.
> Réf. cahier : [`docs/CAHIER-DES-CHARGES-v1.4.md`](../CAHIER-DES-CHARGES-v1.4.md) §6 (Ops & exploitation) + §8 (RGPD).

---

## 0. Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `PRD-004` |
| **Slug** | `hardening-ops-compliance` |
| **Titre** | Hardening, Ops & Compliance |
| **Version PRD** | `0.1` |
| **Statut** | `DISCOVER_DRAFT` |
| **Owner produit** | _à désigner CTO_ |
| **Owner technique** | _à désigner CTO_ |
| **Persona pilote (Discover)** | `senior-dev` |
| **Persona pilote (Design — à confirmer)** | `ingenieur` (infra/observabilité) + `architecte-api` (admin tooling/retry) + `photos-rgpd` (compliance) + `stripe` (monitoring financier) |
| **Créé le** | 2026-05-12 |
| **Mis à jour le** | 2026-05-12 |
| **Cible de release** | `v3.1.0-prd004` (1 ou 2 paliers — cf. OQ-9) |
| **T-shirt size** | `XL` (5 tickets — cf. §3.6 pour découpe potentielle en `PRD-004A / 004B`) |
| **Lien Cahier v1.4** | §6 Exploitation & monitoring, §8 RGPD |

---

## 1. Contexte & problème

### 1.1 Pourquoi PRD-004 maintenant ?

Clean Connect est **fonctionnellement complet** (PRD-001 Auth + PRD-002 Missions + PRD-003 Photos & Paiements `v3.0.0-prd003` release-candidate). Trois constats au sortir du Sprint 3 :

1. **Aveuglement opérationnel.** Aucun outil de monitoring n'est branché. Les logs Pino partent dans `stdout` Docker. Pas de Sentry, pas de tracing, pas de dashboard p95/p99. Si un webhook Stripe tombe en silence, on l'apprend par un appel client.
2. **Recovery manuel uniquement.** Les retries automatiques BullMQ existent pour le webhook ingestion mais pas pour les transferts. Aucun cron de safety-net pour les "stuck jobs". L'arbitrage CTO PR #11 a explicitement reporté `TRANSFER_RETRY_QUEUE` BullMQ et `orphan cleanup` à PRD-004.
3. **Surface admin réduite.** Les controllers admin existent (`/admin/payments`, `/admin/transfers/:id/retry`, `/admin/webhooks/stripe-dead-letters`) mais aucune UI ne les consomme. L'admin opère via `curl` + Stripe Dashboard + Cloudinary Dashboard — ingérable au-delà de quelques dizaines de missions/jour.
4. **Dettes RGPD acceptées en PR #13.** G (`DELETE /photos/:id` self-service), I (webhook entrant Cloudinary), L (`DELETE /users/me` self-service) ont été explicitement reportées à PRD-004 par le CTO. Le MVP est conforme via la voie email + action admin, mais ce n'est pas tenable à long terme.
5. **Risque financier non-instrumenté.** Aucun job ne compare quotidiennement les états Stripe vs DB. Une divergence (`Transfer.SENT` côté Stripe mais `PENDING` côté DB, ou inverse) ne sera détectée que par hasard.

**Objectif PRD-004** : passer Clean Connect de "fonctionnel" à "exploitable en production avec assurance" — observable, monitoré, recoverable, conforme RGPD, supportable par une équipe ops.

### 1.2 Pourquoi PRD-004 est prioritaire **avant** PRD-005 (Disputes) et au-delà

| Argument | Détail |
|---|---|
| **Risque non-couvert immédiat** | PRD-003 est en prod sans monitoring : impossibilité de détecter une dérive transfer/refund/capture avant qu'un utilisateur ne se plaigne. |
| **Disputes (PRD-005) repose sur observabilité** | Un litige se résout en lisant la **timeline d'audit** d'une mission. Sans dashboard admin (4.3) et tracing (4.1), instruire un dispute revient à `psql` + Stripe Dashboard. |
| **RGPD non-MVP-suffisant à 3 mois** | La CNIL accepte la voie email pour l'effacement, mais une plateforme grandissante doit fournir un self-service. Mieux vaut le faire maintenant que sous contrainte CNIL. |
| **Coût croissant avec le temps** | Plus la volumétrie augmente (paiements, photos, missions), plus l'introduction d'observabilité a posteriori est coûteuse (logs déjà perdus, métriques sans baseline). |
| **Réversibilité faible** | Sentry/OTel sont des **investissements transverses** — branchés une fois, ils profitent à toutes les features ultérieures. Faire PRD-005 d'abord = re-instrumenter PRD-005 après. |

**Verdict** : PRD-004 doit se finir avant que la volumétrie post-MVP n'amplifie les dégâts d'un incident silencieux.

### 1.3 Personas concernés

- [x] **Admin ops** — pilote la console admin, instruit les disputes, replay les DLQ, surveille la santé Stripe. **Persona principal.**
- [x] **Support N1** (peut être confondu avec Admin ops au MVP) — répond aux tickets client/prestataire, consulte la timeline d'audit d'une mission.
- [x] **CTO / dev on-call** — reçoit les alertes Sentry / Slack, instruit les incidents, lit les traces OTel.
- [x] **Prestataire impacté par payout** — bénéficiaire passif de la fiabilité retry transfer (4.2).
- [x] **Client impacté par litige/remboursement** — bénéficiaire passif de la rapidité de résolution dispute (4.3) et de la conformité RGPD (4.4).
- [x] **Système** (cron, BullMQ worker, OTel collector, Sentry) — bénéficiaire passif d'une politique de retry/recovery stable.

### 1.4 Métriques de succès

> Toutes les baselines sont à mesurer une fois 4.1 livré (sans observabilité, pas de baseline).

| Métrique | Baseline actuelle | Cible | Comment mesurer |
|---|---|---|---|
| **Webhook ack p95** | inconnue | < 200 ms | Sentry transaction `POST /v1/webhooks/stripe` |
| **Webhook ack p99** | inconnue | < 500 ms | idem |
| **Transfer failure rate** | inconnue | < 0,5 % sur 7 j glissants | dashboard finance (4.5) — `Transfer.FAILED / Transfer.SENT` |
| **Refund success rate** | inconnue | > 99 % sur 30 j | dashboard finance — `Refund.SUCCEEDED / Refund.attempted` |
| **DLQ count (steady state)** | inconnue | < 5 entrées non résolues à tout moment | endpoint `/admin/webhooks/stripe-dead-letters?resolvedAt=null` |
| **Stuck transfers (`PENDING > 2h`)** | inconnue | 0 à tout moment | reconcile cron — alerte si > 0 pendant > 15 min |
| **API error rate global** | inconnue | < 0,5 % requêtes 5xx | Sentry / OTel |
| **API p95 endpoints critiques** | inconnue | `/payments/intent` < 800 ms, `/presign` < 400 ms, `/complete` < 1 s, `/validate` < 1 s | Sentry transactions |
| **API p99 endpoints critiques** | inconnue | < 2× p95 | idem |
| **Cloudinary orphan count** | inconnue | < 10 assets orphelins à tout moment | cron audit (4.4) |
| **Mean time to detect (MTTD)** incident | jours | < 5 min via alertes Sentry/Slack | dispatch alerte → ack on-call |
| **Mean time to resolve (MTTR)** incident | inconnue | < 60 min sur P0 | post-mortem |
| **Stripe/DB reconciliation drift** | inconnue | 0 mismatch quotidien | daily finance report (4.5) |
| **Time-to-replay DLQ entry** (action admin) | inconnue (admin via curl) | < 30 s via UI admin (4.3) | UX QA |

### 1.5 Out of scope (non-goals — **explicite**)

> Ces items sont **refusés** pour PRD-004. Toute dérive doit être rejetée en revue PR.

- ❌ **Chat in-app** (client ↔ prestataire ou client ↔ support) — ouvre un PRD séparé si besoin produit.
- ❌ **Nouvelles features client visibles** (rating mission, programme fidélité, parrainage, etc.).
- ❌ **Remboursement partiel (`partial refund`)** — refusé MVP en PRD-003 (RefundsService = full only). Reste hors-scope PRD-004.
- ❌ **Multi-currency** — EUR only, hors-scope PRD-004.
- ❌ **Refonte UI mobile** — pas de changement de DA, pas de nouveaux écrans utilisateur.
- ❌ **IA pricing / matching** — pas d'algorithme prédictif, pas de scoring.
- ❌ **Refactor architectural** (passage micro-services, changement d'ORM, etc.) — Clean Connect reste monorepo NestJS + Prisma.
- ❌ **Multi-tenant** — single-tenant cleanconnect.fr exclusif.
- ❌ **Internationalisation (i18n)** — FR uniquement.
- ❌ **Webhook entrant Cloudinary `notification_url` HMAC** (dette **I** PRD-003) — **inclus** dans Ticket 4.4 (cf. §2.4).
- ❌ **Dispute resolution metier** (workflow client/prestataire, médiation) — c'est **PRD-005**. PRD-004 fournit uniquement l'**outillage admin** pour instruire les disputes (4.3).

---

## 2. User stories & critères d'acceptance par ticket

> Chaque ticket = un boundary livrable (1-2 PRs). Critères d'acceptance **macro** ici — affinés en Design.

### 2.1 Ticket 4.1 — Observabilité & Ops

> **Objectif** : voir avant de réparer. Sentry + OpenTelemetry + dashboards perf + BullMQ monitoring + alerting DLQ.

**Stories**

#### US-4.1.1 — Crash + erreurs serveur captés en temps réel

**En tant que** CTO / dev on-call
**Je veux** être notifié sous 5 min d'une erreur 5xx ou d'un crash worker BullMQ
**Pour** corriger avant que les utilisateurs ne se plaignent

**AC macro** :
- AC-4.1.1.1 — Toute exception non gérée (5xx, processor crash, scheduler crash) est captée par Sentry avec contexte (user id, request id, route, idempotency-key).
- AC-4.1.1.2 — Aucune PII (cf. liste redactor Pino) ne se retrouve dans Sentry — `beforeSend` filtre/anonymise.
- AC-4.1.1.3 — Une alerte (channel à confirmer OQ-6) part dès qu'une release a > N erreurs / minute (seuil à figer OQ-8).

#### US-4.1.2 — Traces distribuées sur les flows critiques

**En tant que** dev / ops
**Je veux** voir la timeline complète d'une requête : controller → service → Prisma → Stripe → BullMQ enqueue
**Pour** diagnostiquer une latence anormale ou un échec en chaîne

**AC macro** :
- AC-4.1.2.1 — Flow `payment_intent.succeeded` (webhook → handler → outbound transfer) tracé bout-en-bout avec span Prisma + span Stripe.
- AC-4.1.2.2 — Flow `POST /missions/:id/photos/presign` tracé avec span Cloudinary signing.
- AC-4.1.2.3 — Flow `POST /missions/:id/validate` tracé avec span auto-release cancel + capture.

#### US-4.1.3 — Dashboards perf + santé services

**En tant que** ops
**Je veux** un dashboard temps réel : p95/p99 endpoints, taux erreur, throughput, état BullMQ, healthz DB+Redis
**Pour** détecter une dégradation avant qu'elle devienne incident

**AC macro** :
- AC-4.1.3.1 — Dashboard public-interne (Sentry Performance ou Grafana — OQ-2) lisible par les ops, mis à jour < 1 min.
- AC-4.1.3.2 — Tag environnement (`dev / recette / preprod / prod`) propagé à toutes les traces — pas de mélange entre envs.

#### US-4.1.4 — Alerting DLQ webhook

**En tant que** ops
**Je veux** être alerté quand une entrée arrive dans `WebhookDeadLetter`
**Pour** investiguer avant qu'une chaîne de paiement ne casse

**AC macro** :
- AC-4.1.4.1 — Toute nouvelle `WebhookDeadLetter` déclenche une alerte (canal OQ-6) avec lien direct vers le dashboard admin (4.3).
- AC-4.1.4.2 — Seuil de garde-fou (OQ-8) : > 5 DLQ non-résolues simultanément → alerte P1.

---

### 2.2 Ticket 4.2 — Retry & Recovery BullMQ

> **Objectif** : automatiser ce qui aujourd'hui demande une action admin manuelle. Couvre les dettes `debt-prd004-transfer-retry-queue` et `debt-prd004-orphan-cleanup` reclassées de PRD-003.

**Stories**

#### US-4.2.1 — Retry automatique des transferts Stripe en échec

**En tant que** prestataire
**Je veux** que mon paiement arrive même si Stripe a renvoyé une erreur transiente
**Pour** ne pas dépendre d'une action admin manuelle

**AC macro** :
- AC-4.2.1.1 — Un `Transfer.FAILED` avec code transient (`insufficient_capabilities`, `rate_limit`, network 5xx Stripe) est re-tenté automatiquement (politique à figer en Design — exponentiel 5 min, 30 min, 2 h, 12 h, 24 h max).
- AC-4.2.1.2 — Un `Transfer.FAILED` avec code permanent (`account_closed`, `transfer_already_paid`) n'est **pas** re-tenté, alerte admin uniquement.
- AC-4.2.1.3 — Le retry transfer reste **idempotent** côté Stripe (idempotency-key déterministe `transfer-mission-<id>`).
- AC-4.2.1.4 — Le compteur d'attempts est borné (≤ N), au-delà l'entrée bascule en DLQ admin avec raison.

#### US-4.2.2 — Recovery des jobs stuck

**En tant que** ops
**Je veux** qu'un job BullMQ qui crashe pendant son traitement soit remis en file après un délai
**Pour** ne pas avoir à intervenir manuellement à chaque worker qui meurt

**AC macro** :
- AC-4.2.2.1 — Tout job `active` depuis > N min sans hearbeat est considéré stuck et réenqueué (paramètre Bull `lockDuration` + cron safety-net).
- AC-4.2.2.2 — Le retry stuck reste idempotent (les handlers `PaymentDomainHandler`, `TransferDomainHandler`, `RefundDomainHandler`, `AutoReleaseExecutor` court-circuitent déjà sur état déjà appliqué — audit V10 PR #13).

#### US-4.2.3 — Poison job isolation

**En tant que** ops
**Je veux** qu'un job qui plante systématiquement à chaque retry soit isolé en DLQ après N tentatives
**Pour** ne pas bloquer la file ni épuiser les workers

**AC macro** :
- AC-4.2.3.1 — Politique de retry par queue : exponentiel, max N tentatives (déjà 5 pour `stripe-webhook-queue`, à figer pour `auto-release-queue` et future `transfer-retry-queue`).
- AC-4.2.3.2 — Au-delà du max, le job va dans DLQ (table dédiée — réutiliser `WebhookDeadLetter` ou créer `JobDeadLetter` ? à arbitrer en Design).

#### US-4.2.4 — Safety-net cron pour invariants critiques

**En tant que** ops
**Je veux** un cron horaire qui vérifie qu'aucun `AutoReleaseJob.SCHEDULED` n'a manqué son délai T+48 h
**Pour** garantir l'auto-release même si BullMQ a hoqueté

**AC macro** :
- AC-4.2.4.1 — Cron horaire : tout `AutoReleaseJob.SCHEDULED` avec `scheduledFor < now - 30 min` ET `Mission.status = CLIENT_VALIDATION_PENDING` ET `Payment.status = REQUIRES_CAPTURE` → re-enqueue ou exécution synchrone.
- AC-4.2.4.2 — Idempotent : si le job a déjà été exécuté (`status = EXECUTED`), no-op.

#### US-4.2.5 — Recovery playbooks documentés

**En tant que** dev on-call
**Je veux** une procédure pas-à-pas pour les 5 incidents les plus probables
**Pour** ne pas improviser à 3 h du matin

**AC macro** :
- AC-4.2.5.1 — Playbooks rédigés dans `docs/ops/` : webhook DLQ ne replay pas, transfer stuck, mission stuck `CLIENT_VALIDATION_PENDING` au-delà T+48h, Cloudinary upload échoue en masse, base de données saturée.

---

### 2.3 Ticket 4.3 — Admin Tooling réel (UI)

> **Objectif** : exposer côté UI ce qui existe déjà côté API (`/admin/payments`, `/admin/transfers`, `/admin/webhooks/stripe-dead-letters`, etc.). Couvre la dette CodeRabbit DX et préfigure l'instrumentation PRD-005 (disputes).

**Stories**

#### US-4.3.1 — Dashboard admin opérationnel

**En tant que** admin ops
**Je veux** une page d'accueil admin qui me montre l'état global (paiements à instruire, DLQ non résolue, transferts en échec, missions en litige)
**Pour** prioriser mes actions du jour en < 30 s

**AC macro** :
- AC-4.3.1.1 — Page `/admin` (apps/admin Vite+React) avec 4 widgets : DLQ count / Transfer failed count / Disputes open / Stuck missions.
- AC-4.3.1.2 — Chaque widget linke vers sa page détaillée.
- AC-4.3.1.3 — RBAC `ADMIN` strict — accès refusé pour `CLIENT` / `PRESTATAIRE`.

#### US-4.3.2 — Transfers monitor + retry UI

**En tant que** admin ops
**Je veux** lister tous les transfers (filtres : statut, période, prestataire), voir leur historique d'attempts, déclencher un retry manuel
**Pour** débloquer un prestataire en quelques clics

**AC macro** :
- AC-4.3.2.1 — Page `/admin/transfers` avec filtre + pagination + bouton retry par ligne (appelle `POST /v1/admin/transfers/:id/retry`).
- AC-4.3.2.2 — Action de retry **traçable** : `MissionEvent` `TRANSFER_RETRY_REQUESTED` avec `actor_user_id = admin.id`.

#### US-4.3.3 — Refunds monitor

**En tant que** admin ops
**Je veux** lister les refunds (en cours, succeeded, failed), déclencher un nouveau refund avec confirmation 2-clics
**Pour** instruire les remboursements rapidement et sans `curl`

**AC macro** :
- AC-4.3.3.1 — Page `/admin/refunds` avec liste + bouton "rembourser" par paiement (réutilise `POST /v1/admin/payments/:paymentId/refund`).
- AC-4.3.3.2 — Modal confirmation **2-étapes** (saisir motif + confirmer montant) — empêche les clics accidentels sur de l'argent réel.

#### US-4.3.4 — DLQ list + replay UI

**En tant que** admin ops
**Je veux** voir la liste des `WebhookDeadLetter` non résolues, lire le payload + l'erreur, replay en un clic
**Pour** ne plus passer par `curl`

**AC macro** :
- AC-4.3.4.1 — Page `/admin/dead-letters` avec filtre source (STRIPE / autre futur) + statut (résolue/non résolue).
- AC-4.3.4.2 — Drawer détail par DLQ : `stripeEventId`, `type`, `payloadHash`, `errorMessage`, `attempts`, `lastAttemptAt`.
- AC-4.3.4.3 — Bouton replay → `POST /v1/admin/webhooks/stripe-dead-letters/:id/replay` (déjà admin-only via `RolesGuard`).

#### US-4.3.5 — Disputes monitor (préfiguration PRD-005)

**En tant que** admin ops
**Je veux** lister les missions `DISPUTE_OPEN`, voir le contexte (transferts reverse, photos, timeline)
**Pour** instruire le litige

**AC macro** :
- AC-4.3.5.1 — Page `/admin/disputes` listant les missions en `DISPUTE_OPEN`.
- AC-4.3.5.2 — Drawer détail : timeline d'audit (`MissionEvent`) chronologique + accès photos (variant `ORIGINAL` réservé admin) + état Payment/Transfer/Refund.
- AC-4.3.5.3 — **Pas d'action de résolution** côté UI dans PRD-004 (workflow = PRD-005). Read-only + lien refund.

#### US-4.3.6 — Audit timeline mission

**En tant que** admin ops
**Je veux** voir l'historique complet d'une mission (tous les `MissionEvent` : CREATED, PUBLISHED, ACCEPTED, CAPTURED, COMPLETED, AUTO_RELEASE_*, TRANSFER_*, REFUND_*, DISPUTE_*)
**Pour** comprendre où ça a coincé

**AC macro** :
- AC-4.3.6.1 — Composant `<MissionTimeline missionId="..." />` réutilisable côté admin (dispute, payment detail, transfer detail).
- AC-4.3.6.2 — Sérialisation `MissionEvent.payload` audit-safe (déjà `assertEventPayloadHygiene` PR #4 PRD-002 — pas de PII ni de secrets).

#### US-4.3.7 — Toute action admin tracée

**En tant que** auditeur (CTO, DPO, CNIL en cas de contrôle)
**Je veux** une trace écrite de chaque action admin (refund déclenché, transfer retry, DLQ replay)
**Pour** assurer la non-répudiation

**AC macro** :
- AC-4.3.7.1 — Chaque action admin produit un `MissionEvent` (ou table dédiée `AdminAction` ? à arbitrer en Design) avec `actor_user_id`, `actor_email`, `actor_ip`, `action`, `target_id`, `payload`.
- AC-4.3.7.2 — Logs Pino structurés avec niveau `info` + tag `admin_action=true` filtrables.

---

### 2.4 Ticket 4.4 — RGPD avancé

> **Objectif** : éteindre les dettes G/I/L PRD-003, finaliser purge cron + Cloudinary deletion guarantees + consent logs.

**Stories**

#### US-4.4.1 — `DELETE /users/me` self-service (dette **L**)

**En tant que** client / prestataire
**Je veux** supprimer mon compte sans envoyer d'email au support
**Pour** exercer mon droit à l'effacement (RGPD art. 17)

**AC macro** :
- AC-4.4.1.1 — Endpoint `DELETE /v1/users/me` (CLIENT / PRESTATAIRE) — soft delete 30 j puis purge cron, **sauf** obligation légale (Stripe data → conservation 10 ans Code de commerce).
- AC-4.4.1.2 — Approche hard delete vs anonymisation à arbitrer (OQ-4).
- AC-4.4.1.3 — Conservation par défaut RGPD ne s'applique **pas** aux logs financiers : `Payment`, `Transfer`, `Refund` restent identifiables Stripe (`stripeCustomerId` côté Stripe), seul l'`User` local est anonymisé.
- AC-4.4.1.4 — Si missions en cours : refus 409 `USER_HAS_ACTIVE_MISSIONS` avec liste — bloque la suppression tant qu'il reste un Payment `REQUIRES_CAPTURE` ou Transfer `PENDING`.

#### US-4.4.2 — Export données utilisateur

**En tant que** client / prestataire
**Je veux** télécharger toutes mes données (profil, missions, paiements, photos)
**Pour** exercer mon droit à la portabilité (RGPD art. 20)

**AC macro** :
- AC-4.4.2.1 — Endpoint `GET /v1/users/me/export` retournant un lien temporaire signé.
- AC-4.4.2.2 — Format à confirmer (OQ-5) : JSON seul (rapide) ou ZIP (JSON + photos originales).
- AC-4.4.2.3 — Idempotence + rate limit strict (max 1 export / utilisateur / 24h pour éviter l'abus).

#### US-4.4.3 — Suppression photo admin (dette **G**)

**En tant que** admin ops
**Je veux** pouvoir supprimer une photo manuellement (anti-fraude, contenu illégal, contestation)
**Pour** ne pas attendre la purge cron 30 j

**AC macro** :
- AC-4.4.3.1 — Endpoint `DELETE /v1/admin/photos/:id` (ADMIN only).
- AC-4.4.3.2 — Suppression DB + Cloudinary (cf. 4.4.5 — deletion guarantees).
- AC-4.4.3.3 — Trace `PhotoDeletionLog` déjà créée en PRD-003 mig `20260512214500_prd003_photo_deletion_log`.
- AC-4.4.3.4 — Une mission en `DISPUTE_OPEN` bloque la suppression (le litige a besoin de la preuve) — sauf override CTO avec motif écrit.

#### US-4.4.4 — Consent logs

**En tant que** DPO
**Je veux** une trace horodatée du consentement aux CGU / CGV / politique de confidentialité à l'inscription
**Pour** prouver le consentement éclairé en cas de contrôle CNIL

**AC macro** :
- AC-4.4.4.1 — Table `UserConsent` (à valider en Design) : `userId`, `consentType`, `version`, `acceptedAt`, `ip`, `userAgent`.
- AC-4.4.4.2 — Signup accepte uniquement après cocher CGU + CGV — logged.

#### US-4.4.5 — Cloudinary deletion guarantees

**En tant que** DPO
**Je veux** être certain qu'une photo supprimée DB l'est aussi côté Cloudinary
**Pour** éviter un asset orphelin (= violation RGPD à terme)

**AC macro** :
- AC-4.4.5.1 — Tout `DELETE /admin/photos/:id` enqueue un job BullMQ `cloudinary-delete` avec retry exponentiel + DLQ.
- AC-4.4.5.2 — Cron audit hebdomadaire : pour chaque `Photo` sans `deletedAt`, on liste Cloudinary `prod/missions/<id>/` et on flag les orphelins.
- AC-4.4.5.3 — Idem pour `PhotoUploadSession.expiresAt < now - 1h` non `confirmed` → cleanup Cloudinary + DB.

#### US-4.4.6 — Webhook entrant Cloudinary (dette **I**)

**En tant que** système
**Je veux** être notifié quand un upload Cloudinary signed termine côté Cloudinary
**Pour** détecter les uploads abandonnés et compléter la traçabilité

**AC macro** :
- AC-4.4.6.1 — Endpoint `POST /v1/webhooks/cloudinary` (Public + HMAC signature Cloudinary).
- AC-4.4.6.2 — Idempotence via `notification_id` Cloudinary (déjà fourni dans le payload).
- AC-4.4.6.3 — Effet : confirme côté DB la session de upload, ou flag asset orphelin si pas trouvé en DB.

#### US-4.4.7 — Retention audit (cron mensuel)

**En tant que** DPO
**Je veux** un rapport mensuel automatique : combien de photos > 12 mois, combien de comptes soft-deleted > 30 j non purgés, combien de logs financiers > 10 ans
**Pour** déclencher la purge et démontrer la conformité

**AC macro** :
- AC-4.4.7.1 — Cron mensuel produit `docs/ops/rgpd-retention-YYYY-MM.md` ou envoi email DPO (OQ-7).
- AC-4.4.7.2 — Action de purge déclenchée manuellement (pas automatique) — protection contre purge accidentelle.

---

### 2.5 Ticket 4.5 — Monitoring financier

> **Objectif** : garantir l'invariant `DB.Payment / Transfer / Refund == Stripe.Payment / Transfer / Refund` quotidiennement. Détecte les dérives **avant** qu'elles deviennent un trou comptable.

**Stories**

#### US-4.5.1 — Stripe/DB reconciliation dashboard

**En tant que** CTO / finance
**Je veux** voir chaque jour la liste des incohérences entre Stripe et notre DB
**Pour** corriger avant que ça impacte un client

**AC macro** :
- AC-4.5.1.1 — Cron quotidien (heure creuse, ex 4h Europe/Paris) listant tout `Payment / Transfer / Refund` créé depuis J-7 et comparant statut DB vs Stripe via API `retrieve`.
- AC-4.5.1.2 — Page admin `/admin/finance/reconciliation` listant les divergences (DB status vs Stripe status) — manuel resolve admin.
- AC-4.5.1.3 — Alerte si > 0 divergence après une exécution.

#### US-4.5.2 — Stuck funds detector

**En tant que** CTO
**Je veux** une alerte dès qu'un `Payment.REQUIRES_CAPTURE` reste > 6 j (autorisation Visa/MC expire ~7 j)
**Pour** capturer avant que Stripe annule l'autorisation

**AC macro** :
- AC-4.5.2.1 — Cron horaire — alerte P1 si `Payment.REQUIRES_CAPTURE` & `createdAt < now - 6 j`.
- AC-4.5.2.2 — Cron horaire — alerte P1 si `Transfer.PENDING & createdAt < now - 2h` (déjà partiellement couvert par `TransferReconcileScheduler` PR #11, à étendre + alerter).

#### US-4.5.3 — Payout anomalies detector

**En tant que** finance
**Je veux** être alerté si un prestataire reçoit un payout > 2× son volume mensuel moyen
**Pour** détecter une fraude ou une erreur de calcul

**AC macro** :
- AC-4.5.3.1 — Cron quotidien sur table `Transfer` — flag les `Transfer.amount > 2 × avg(prestataire.transfer.amount.last30d)`.
- AC-4.5.3.2 — Liste admin pour review.

#### US-4.5.4 — Daily finance report

**En tant que** CTO / finance
**Je veux** un mail quotidien avec les KPIs finance de la veille (paiements capturés, transferts émis, refunds, commissions plateforme)
**Pour** garder la main sur la santé financière

**AC macro** :
- AC-4.5.4.1 — Cron 6h Europe/Paris — agrège la veille — envoie au CTO + finance.
- AC-4.5.4.2 — Format à confirmer (OQ-7) : email seul, dashboard seul, ou les deux.

#### US-4.5.5 — Mismatch detector (capture / transfer / refund consistency)

**En tant que** dev
**Je veux** une assertion automatique en CI test (intégration) : pour un Payment, on doit avoir `Payment.amount == Transfer.amount + commission` et `Payment.refunded == Refund.amount`
**Pour** détecter une dérive de modèle avant prod

**AC macro** :
- AC-4.5.5.1 — Test intégration `finance-consistency.integration.spec.ts` couvrant les 6 cas standards (capture, capture+transfer, capture+refund, transfer.reversed, refund partial impossible MVP, multi-refund impossible MVP).
- AC-4.5.5.2 — Cron quotidien production : même invariant appliqué sur l'échantillon des dernières 24h — alerte si fail.

#### US-4.5.6 — Capture/transfer/refund consistency checks (production)

**En tant que** finance
**Je veux** que les invariants comptables soient vérifiés quotidiennement en production
**Pour** détecter une fuite d'argent avant qu'elle dépasse 1 €

**AC macro** :
- AC-4.5.6.1 — Job quotidien : `SUM(Payment.capturedAmount) - SUM(Transfer.amount) - SUM(Refund.amount) - SUM(Commission.amount) == 0` sur la fenêtre J-1.
- AC-4.5.6.2 — Toute divergence > 0,01 € → alerte P1 + entrée DLQ finance dédiée.

---

## 3. Phase DISCOVER

### 3.1 Risk assessment (1 = faible, 5 = critique)

| Domaine | Score | Justification | Action si ≥ 4 |
|---|:-:|---|---|
| **Sécurité** | **4** | Sentry + OTel risquent de logger des PII si `beforeSend` n'est pas configuré. Admin tooling expose des routes très sensibles (refund, replay DLQ). RBAC `ADMIN` doit rester scellé. | Pré-revue `reviewer-securite-code` en Design sur 4.1 (Sentry redactor) + 4.3 (admin tooling) + 4.4 (RGPD). |
| **RGPD** | **5** | `DELETE /users/me` + export utilisateur + suppression photo + consent logs touchent au cœur du droit à l'effacement et à la portabilité. Une erreur = sanction CNIL. | Lecture par référent RGPD + ADR dédié pour le choix hard delete vs anonymisation (OQ-4). |
| **Financier** | **4** | Le retry transfer automatique (4.2) + reconciliation cron (4.5) manipulent des sommes réelles. Une boucle de retry mal bornée = double payout ; un fix DB sans coordination = mismatch comptable. | Application stricte rule `stripe` + tests intégration race conditions (cf. PRD-003 Verify méthode). |
| **UX (régression)** | **2** | PRD-004 ne touche pas aux écrans mobile client/prestataire. Risque limité aux régressions admin (interne). | Tests E2E admin happy path (4.3) en Build. |
| **Performance** | **3** | OTel + Sentry ajoutent du overhead. Si mal réglé (sampling) → bruit + coût. Reconciliation cron peut être lourd si > 10k Payments. | Plan de charge en Design + sampling Sentry strict (1-10 %) en prod. |
| **Disponibilité (dépendance externe)** | **3** | Sentry SaaS + Cloudinary + Stripe : si Sentry est down, l'API doit continuer à fonctionner (fail-open). | Plan B : `Sentry.captureException` ne doit jamais bloquer la requête (timeout court, fail-silent). |
| **Dette ops** | **4** | Si PRD-004 n'est pas livré, chaque PRD futur (PRD-005 Disputes en tête) sera infaisable proprement faute d'observabilité et d'admin tooling. | Prioriser 4.1 + 4.3 en premier pour débloquer le reste du backlog. |
| **Coût** | **2** | Sentry team plan + OTel collector + Cloudinary alerts ajoutent ~50-200 €/mois. Acceptable. | Comparatif Sentry/Highlight/Logtail/Datadog en annexe §8 si OQ-1 = "Sentry + OTel". |

### 3.2 Modules touchés (lite — à raffiner en Design)

- [x] `apps/api/src/main.ts` — initialisation Sentry + OTel SDK
- [x] `apps/api/src/common/filters/all-exceptions.filter.ts` — wrap Sentry.captureException
- [x] `apps/api/src/common/interceptors/` — interceptor tracing OTel
- [x] `apps/api/src/modules/payments/` — `OutboundTransferService` (retry policy 4.2), `RefundsService` (UI admin 4.3), `TransferReconcileScheduler` (extension 4.5)
- [x] `apps/api/src/modules/missions-completion/auto-release/` — safety-net cron 4.2.4
- [x] `apps/api/src/modules/users/` — `DELETE /users/me` + export (4.4)
- [x] `apps/api/src/modules/photos/` — `DELETE /admin/photos/:id` + webhook Cloudinary (4.4)
- [x] `apps/api/src/modules/admin/` — nouveau module agrégateur admin (finance, reconciliation, audit)
- [x] `apps/api/prisma/schema.prisma` — peut introduire `AdminAction`, `UserConsent`, `JobDeadLetter` (à arbitrer en Design)
- [x] `apps/admin/` — refonte structure pages (4.3) : `/admin`, `/admin/transfers`, `/admin/refunds`, `/admin/dead-letters`, `/admin/disputes`, `/admin/finance/reconciliation`
- [ ] `apps/mobile/` — **aucun changement runtime** (4.4.1 `DELETE /users/me` consommable par l'app mais pas obligatoire en MVP — voir OQ)
- [x] `packages/shared-types` — schémas Zod admin actions, user export, consent
- [x] `.github/workflows/` — éventuellement ajouter un job `lint-otel-config` ou `lint-sentry-redactor`
- [x] `docs/ops/` — playbooks recovery (4.2.5) + rapport RGPD mensuel (4.4.7)

### 3.3 Open Questions CTO (à résoudre AVANT Design)

> Aucune question non résolue ne peut bloquer le passage en Design. Le CTO arbitre, on documente la décision dans le PRD avec date + nom.

| # | Question | Owner | Statut | Réponse |
|---|---|---|---|---|
| **OQ-1** | **Stack observabilité** : Sentry seul (erreurs + perf) OU Sentry + OpenTelemetry (errors + tracing distribué + métriques) ? Sentry intègre déjà des traces, OTel offre plus de souplesse export (Grafana Tempo, Honeycomb, ...). | CTO | `OPEN` | _Reco senior-dev : **Sentry seul** au démarrage (1 outil, dashboard inclus, redactor maîtrisé) ; ajouter OTel uniquement si Sentry s'avère limitant en self-host._ |
| **OQ-2** | **Métriques infra** : Prometheus + Grafana **maintenant** (auto-hébergés, coût VPS) OU **plus tard** (PRD-004B / PRD-006) ? Sentry Performance peut suffire MVP. | CTO | `OPEN` | _Reco : **plus tard**. Sentry Performance couvre p95/p99 endpoints + transactions. Prometheus seulement si on dépasse le quota Sentry ou besoin de métriques custom (queue depth, par exemple)._ |
| **OQ-3** | **Admin tooling UI** : BullBoard (open-source, ready-to-deploy, expose les queues BullMQ) OU dashboard admin custom (React+Vite, déjà en place pour `apps/admin`) ? | CTO | `OPEN` | _Reco : **dashboard admin custom** pour les actions métier (refund, transfer retry, DLQ replay, disputes) + **BullBoard en parallèle** (lecture queue uniquement, derrière auth admin) pour le diagnostic technique. Cohabitation = best of both._ |
| **OQ-4** | **`DELETE /users/me`** : hard delete (suppression réelle de la ligne `User` après période de grâce 30 j) OU anonymisation (`User.email = '<deleted>'`, `User.firstName/lastName = ''`, etc.) ? | CTO + DPO | `OPEN` | _Reco : **anonymisation** — `User.deletedAt + User.email = 'deleted-<uuid>@cleanconnect.local'`. Permet de conserver les liens vers `Payment / Transfer / Refund / MissionEvent` historiques (obligation Code de commerce 10 ans) sans plus afficher de PII. Hard delete impossible tant qu'il y a un Payment lié._ |
| **OQ-5** | **Export RGPD** : JSON seul (compact, rapide, < 100 ko) OU ZIP (JSON + photos `ORIGINAL` Cloudinary) ? Le ZIP avec photos peut peser plusieurs Go pour un prestataire actif. | CTO + DPO | `OPEN` | _Reco : **JSON seul en synchrone** + lien signé temporaire vers chaque photo (l'utilisateur télécharge à la demande). Évite les ZIP géants en mémoire backend._ |
| **OQ-6** | **Canal d'alerting** : email seul (au sens "alerte SMTP"), Slack/Discord webhook, ou les deux ? Email = persistant, Slack = temps réel équipe. | CTO | `OPEN` | _Reco : **Slack/Discord en P0/P1** (temps réel) + **email en récap quotidien** (4.5.4). Pas d'email d'alerte temps réel (lassitude, on les ignore)._ |
| **OQ-7** | **Finance report quotidien** : envoi email seul, page admin dashboard seule, ou les deux ? | CTO + finance | `OPEN` | _Reco : **dashboard admin** (source de vérité, drill-down possible) + **email récap journalier au CTO + finance** (push minimal — 5 KPIs principaux + lien vers dashboard pour le détail)._ |
| **OQ-8** | **Seuils d'alerte** précis pour : (a) stuck transfer (par défaut > 2h DB = alerte ?), (b) DLQ count (> 5 = alerte P1 ?), (c) API error rate (> 1 % sur 5 min = alerte ?). | CTO | `OPEN` | _Reco : seuils initiaux **conservateurs** (stuck > 2h, DLQ > 5, error rate > 1 % sur 5 min) à ajuster après J+7 d'observation prod (éviter les alertes-fatigue)._ |
| **OQ-9** | **Découpage du PRD-004** : un seul PRD-004 (5 tickets séquentiels) OU séparer en **PRD-004A Ops** (4.1 + 4.2 + 4.5) et **PRD-004B Admin & RGPD** (4.3 + 4.4) ? Le 004A déverrouille les ops, le 004B est plus produit. | CTO | `OPEN` | _Reco : **un seul PRD-004** avec 5 tickets — l'ordre d'exécution donne déjà la priorité (cf. §3.6). Séparer en deux PRDs multiplie l'admin BMAD pour un découpage déjà clair en tickets._ |

### 3.4 Définition de Done — Discover

- [x] PRD instancié avec ID `PRD-004`, slug `hardening-ops-compliance`, statut `DISCOVER_DRAFT`
- [x] Lien explicite vers le cahier v1.4 (§6 + §8)
- [x] **5 tickets** définis (4.1 → 4.5) avec stories + AC macro
- [x] Personas listés (admin ops, support, CTO/dev, prestataire, client, système)
- [x] Risk assessment renseigné (8 domaines scorés)
- [x] Métriques de succès quantifiables (15 métriques)
- [x] Out of scope listé (10 items explicites)
- [x] Open questions listées (9 OQ ouvertes pour le CTO)
- [x] Dépendances PRD-003 explicitées (cf. §3.5)
- [x] Recommandation ordre d'exécution (cf. §3.6)
- [x] **Aucune ligne de code runtime ajoutée** ✅ (PR doc-only)
- [x] T-shirt size estimé : `XL` (sous-arbitrable en `M + L` si OQ-9 = split)
- [ ] **Validation humaine** (CTO Owner produit) : nom + date — **bloque le passage en Design**

> ✍️ À valider en Discover par `<CTO>` le `YYYY-MM-DD`. Statut passera à `DISCOVER_DONE` puis `DESIGN_DRAFT` à l'ouverture du Design.

### 3.5 Dépendances avec PRD-003 (dettes reportées)

| Item | Origine PRD-003 | Repris dans PRD-004 |
|---|---|---|
| `debt-prd004-transfer-retry-queue` (auto BullMQ retry transfer) | PR #11 — `TODO(debt)` `payments.module.ts` | **Ticket 4.2** US-4.2.1 |
| `debt-prd004-orphan-cleanup` (`PhotoUploadSession` orphelins) | PR #11 — accepté CTO 3.5 → 3.6 | **Ticket 4.4** US-4.4.5 |
| Dette **G** — `DELETE /photos/:id` self-service / admin manual | PR #13 — Verify §6.1.1 | **Ticket 4.4** US-4.4.3 |
| Dette **I** — Webhook entrant Cloudinary | PR #13 — Verify §6.1.1 | **Ticket 4.4** US-4.4.6 |
| Dette **L** — `DELETE /users/me` self-service RGPD | PR #13 — Verify §6.1.1 | **Ticket 4.4** US-4.4.1 |
| `debt-coderabbit-typing` (exceptions typées, repo pattern, logs refund) | Verify 3.6 | **Ticket 4.3** (au fil des PRs admin) + suivi indépendant DX |
| Suggestion S2 — Stripe Dashboard live testé en prod | PR #13 audit §6.2 | **Ticket 4.5** US-4.5.4 (daily finance report = re-vérifie côté Stripe) |

### 3.6 Recommandation ordre d'exécution

**Ordre proposé** (à valider OQ-9 et arbitrage CTO) :

1. **Ticket 4.1 Observabilité** — **bloquant** pour tout le reste. Sans Sentry/OTel/tracing, on ne mesure pas les effets de 4.2/4.5 et on découvre les régressions par hasard.
2. **Ticket 4.2 Retry & Recovery** — **prioritaire ops**. Couvre la dette `transfer-retry-queue` + safety-net auto-release. Évite un incident de paiement bloqué pendant 24h.
3. **Ticket 4.5 Monitoring financier** — **prioritaire finance**. Détecte les dérives Stripe/DB **avant** qu'elles deviennent un trou comptable. Nécessite 4.1 pour les alertes.
4. **Ticket 4.4 RGPD avancé** — **prioritaire conformité**. Éteint les dettes G/I/L. Volume utilisateur faible en post-MVP rend l'urgence relative, mais le sujet ne peut pas s'enliser.
5. **Ticket 4.3 Admin Tooling UI** — **dernier**. Les controllers admin existent déjà ; l'UI est une commodité tant qu'on opère < 100 missions/jour. **Mais** ce ticket débloque PRD-005 Disputes (qui consomme la timeline admin et le disputes monitor).

**Justification** : observabilité (4.1) → fiabilité (4.2) → finance (4.5) → conformité (4.4) → confort ops (4.3). On commence par voir, puis on automatise, puis on contrôle, puis on conforme, puis on confortifie.

**Variante CTO si OQ-9 = split** :
- **PRD-004A "Ops Foundation"** = 4.1 + 4.2 + 4.5 (tag `v3.1.0-prd004a`)
- **PRD-004B "Admin & Compliance"** = 4.3 + 4.4 (tag `v3.2.0-prd004b`)

Le split a l'avantage de permettre une livraison plus rapide d'Ops Foundation, mais coûte 2× l'overhead BMAD (2 PRDs, 2 Verify, 2 release runbooks). Non recommandé sauf si la pression ops est plus forte que prévu.

### 3.7 Hypothèses & contraintes

- **H1** — Sentry est utilisable légalement (DPA signé) et conforme RGPD avec leur région UE.
- **H2** — Cloudinary supporte les webhooks sortants `notification_url` avec HMAC ([doc Cloudinary upload notifications](https://cloudinary.com/documentation/notifications)).
- **H3** — La volumétrie post-MVP reste compatible avec un seul VPS (pas besoin de scaling horizontal).
- **H4** — Aucun prestataire connecté Stripe en mode "Custom" (PRD-003 Connect Express only) → la reconciliation cron utilise seulement `transfers.retrieve` et `payment_intents.retrieve`.
- **H5** — Les disputes Stripe (chargeback Visa/MC) sortent du scope de PRD-004 (PRD-005). PRD-004 traite uniquement les disputes **internes** (`Mission.status = DISPUTE_OPEN`).

### 3.8 Glossaire (vocabulaire PRD-004)

- **Observabilité** : capacité à comprendre l'état interne d'un système à partir de ses outputs (logs, métriques, traces).
- **MTTD** : Mean Time To Detect — temps moyen pour qu'une anomalie soit détectée (vs survenue).
- **MTTR** : Mean Time To Resolve — temps moyen entre détection et résolution.
- **DLQ** : Dead Letter Queue — file des messages/jobs qui ont échoué tous leurs retries.
- **Poison job** : job qui plante systématiquement quel que soit le retry — doit être isolé pour ne pas saturer le worker.
- **Stuck job** : job `active` en BullMQ qui ne progresse plus (lock perdu, worker crashé) — distinct du poison job.
- **OTel** : OpenTelemetry — standard ouvert (CNCF) pour traces/métriques/logs.
- **Reconciliation** : processus de comparaison entre deux sources de vérité (Stripe vs DB) pour détecter les divergences.
- **Safety-net cron** : cron de "filet de sécurité" qui re-déclenche un job qui aurait dû s'exécuter mais ne s'est pas exécuté.
- **Anonymisation** vs **suppression** : anonymisation rend les données non-identifiantes mais préserve l'intégrité référentielle ; suppression efface l'enregistrement.

---

## 4. Phase DESIGN

> Le Design est démarré **ticket par ticket** pour minimiser le scope d'une PR de design et faciliter la revue.
> Sign-off CTO Discover obtenu (arbitrages OQ-1 à OQ-9 — captés dans les ADRs ci-dessous).

### 4.0 Sommaire Design

| Ticket | Statut | ADRs | Livrable |
|---|:-:|---|---|
| **4.1 Observabilité & Ops** | 🟡 Design en cours (cette itération) | [ADR-014](../adr/ADR-014-observability-architecture.md), [ADR-015](../adr/ADR-015-bullmq-monitoring-dlq.md), [ADR-016](../adr/ADR-016-logging-redaction-strategy.md), [ADR-017](../adr/ADR-017-alerting-strategy.md) | §4.1 → §4.7 ci-dessous + [pré-revue sécu](../security-reviews/2026-05-12-prd-004-observability-design-prereview.md) |
| 4.2 Retry & Recovery BullMQ | ⏳ pending | — | bloqué par 4.1 (instrumentation queue) |
| 4.3 Admin Tooling UI | ⏳ pending | — | bloqué par 4.1 (tracing admin actions) |
| 4.4 RGPD avancé | ⏳ pending | — | indépendant 4.1, peut démarrer en parallèle |
| 4.5 Monitoring financier | ⏳ pending | — | bloqué par 4.1 (métriques + alertes) |

---

### 4.1 Architecture observabilité (vue d'ensemble)

```
                      ┌────────────────────────────────────────────────────────┐
                      │             apps/api (NestJS — single process)         │
                      │                                                        │
   HTTP request   ───▶│  Pino HTTP middleware (requestId)                      │
                      │     │                                                  │
                      │     ▼                                                  │
                      │  AsyncLocalStorage <─ OTel SDK (traceId, spanId)       │
                      │     │                                                  │
                      │     ├─▶ Controller → Service → Prisma (span)           │
                      │     ├─▶ Stripe SDK (span)                              │
                      │     └─▶ BullMQ Producer (data.{requestId,traceId})     │
                      │                                                        │
                      │  ┌────────────────────────┐                            │
                      │  │ BullMQ Worker (Process)│  (data → context restore)  │
                      │  │   span enfant OTel     │                            │
                      │  └────────────────────────┘                            │
                      │                                                        │
                      │  ┌──────────────────────────────────────────┐          │
                      │  │ AlertingService (BullMQ alerts-queue)    │          │
                      │  └──────────────────────────────────────────┘          │
                      └────────────────────────────────────────────────────────┘
                          │           │                  │          │
                Sentry ───┘           │                  │          └─── Discord webhook
                (errors+APM)    OTel exporter            │              + Resend (email)
                                 (OTLP/HTTP              ▼
                                  → Sentry)        prom-client
                                                  /api/internal/metrics
                                                        │
                                                        ▼
                                                   Prometheus (scrape 15 s)
                                                        │
                                                        ▼
                                                   Grafana (D1/D2/D3)
                                                  (admin only via JWT)
```

**Frontière fonctionnelle figée** (ADR-014 §2.1) :

- **Sentry** = exceptions + transactions HTTP (p50/p95/p99).
- **OpenTelemetry** = spans cross-service détaillés (Prisma, Stripe, BullMQ).
- **Prometheus + Grafana** = métriques techniques + queues + business.
- **Pino + stdout Docker** = logs structurés (rétention 30 j applicatifs / 90 j erreurs / 180 j sécurité — ADR-016 §2.6).

### 4.2 Flux traces / métriques / logs

#### 4.2.1 Trace d'une requête `POST /v1/missions/:id/validate` (exemple)

```
[span:HTTP POST /v1/missions/:id/validate]                                    traceId=t1, spanId=s1
  ├─[span:MissionCompletionService.validate]                                   spanId=s2
  │   ├─[span:prisma.mission.findUnique]                                       spanId=s3
  │   ├─[span:prisma.mission.update CLIENT_VALIDATION_PENDING→COMPLETED]       spanId=s4
  │   ├─[span:AutoReleaseService.cancelByMission]                              spanId=s5
  │   │   └─[span:bullmq.removeJob auto-release-<missionId>]                   spanId=s6
  │   └─[span:PaymentsService.requestCapture(actor=CLIENT)]                    spanId=s7
  │       └─[span:stripe.paymentIntents.capture]                               spanId=s8
  │           └── (HTTP Stripe — 250 ms)
```

Cette trace est visible dans **Sentry Performance** → on identifie immédiatement la latence sur le `stripe.paymentIntents.capture` (le span le plus long).

#### 4.2.2 Trace d'un webhook Stripe (cross-process — traceId continu)

```
[span:HTTP POST /v1/webhooks/stripe]                                          traceId=t2, spanId=s10
  ├─[span:PaymentsWebhookService.ingest]                                       spanId=s11
  │   ├─[span:assertEnvConsistency]
  │   ├─[span:prisma.stripeWebhookEvent.create]                                spanId=s12
  │   └─[span:bullmq.add stripe-webhook-queue jobId=stripe-webhook-<evtId>]    spanId=s13
  │
  └─[ack 202 — Stripe content]

... 200 ms plus tard, worker pick up ...

[span:bullmq.process stripe-webhook-queue]                          traceId=t2 (continued !), spanId=s14
  ├─[span:PaymentDomainHandler.handle payment_intent.succeeded]                spanId=s15
  │   ├─[span:prisma.payment.update CAPTURED]                                  spanId=s16
  │   ├─[span:AutoReleaseService.cancelByMission]                              spanId=s17
  │   └─[span:OutboundTransferService.ensureOutboundTransferAfterCapture]      spanId=s18
  │       └─[span:stripe.transfers.create idemKey=transfer-mission-<id>]       spanId=s19
```

**Crucial** : `traceId=t2` est **identique** entre la requête HTTP webhook et le traitement worker BullMQ, grâce à `data.traceId` injecté côté producer (ADR-014 §2.4). Le webhook se suit bout-en-bout dans Sentry.

#### 4.2.3 Matrice flux × signaux

| Flux | Métriques Prometheus | Spans OTel | Logs Pino |
|---|---|---|---|
| `POST /payments/intent` | `http_request_duration_seconds` + `cleanconnect_payment_intent_created_total` | HTTP + Prisma + Stripe | `info payment_intent.created` (sans `clientSecret`) |
| `POST /webhooks/stripe` | `http_request_duration_seconds` + `cleanconnect_webhook_ingested_total{type}` | HTTP + Prisma + BullMQ producer | `info webhook.ingested` |
| Worker `stripe-webhook-queue` | `cleanconnect_bullmq_job_duration_seconds{queue}` + handler counter | worker + handler + Stripe + Prisma | `info webhook.processed` |
| `Transfer.SENT` | `cleanconnect_transfer_succeeded_total` (Ticket 4.5) | span Stripe | `info transfer.sent` |
| `WebhookDeadLetter` créé | Gauge `cleanconnect_bullmq_dlq_size{source}` ↑ | (état, pas de span dédié) | `error webhook.dead_letter` + **ALERT P1** |

### 4.3 Endpoints health / readiness / metrics

| Route | Auth | Réponse exemple | Quoi vérifier |
|---|---|---|---|
| `GET /healthz` | Public | `{ "status":"ok", "uptime":12345, "version":"v3.0.0-prd003", "env":"prod" }` | process up + version |
| `GET /readyz` | Public | `{ "status":"ok", "services":{ "database":"ok", "redis":"ok", "stripe":"ok" } }` | DB + Redis + Stripe reachable |
| `GET /api/internal/metrics` | Bearer `OBSERVABILITY_TOKEN` | OpenMetrics text format | scrape Prometheus |
| `GET /api/internal/queues` | Bearer `OBSERVABILITY_TOKEN` | `{ "queues":[...] }` | snapshot ops BullMQ |
| `GET /api/v1/admin/queues/*` (BullBoard) | `JwtAccessGuard(ADMIN)` | UI HTML BullBoard read-only | inspection admin |
| `GET /api/v1/admin/queues/health` | `JwtAccessGuard(ADMIN)` | `{ "status":"ok"\|"degraded", "queues":{...} }` | dashboard widget |
| `POST /api/v1/admin/observability/silence` | `JwtAccessGuard(ADMIN)` | `{ "silencedUntil":"..." }` | maintenance window |

> **Critique** (ADR-014 §2.3) : `/api/internal/*` jamais public — Bearer interne + firewall réseau Docker (port `9090` Prometheus ouvert uniquement sur l'IP du conteneur Grafana).

### 4.4 Conventions de nommage métriques (`cleanconnect_*`)

#### 4.4.1 Format général

```
cleanconnect_<domain>_<entity>_<measure>_<unit>{labels}
```

- `domain` : `http`, `bullmq`, `payment`, `transfer`, `refund`, `photo`, `cloudinary`, `webhook`, `finance`.
- `entity` : entité métier ou technique.
- `measure` : `total`, `duration`, `size`, `success_rate`, `failures`, `pending`, etc.
- `unit` : `_seconds` (durée), `_bytes` (taille), `_total` (counter), pas d'unité pour gauge raw.

#### 4.4.2 Métriques figées Ticket 4.1 (19 métriques)

| Métrique | Type | Labels | Description |
|---|---|---|---|
| `cleanconnect_http_request_duration_seconds` | Histogram | `route`, `method`, `status_code` | latence HTTP par route |
| `cleanconnect_http_requests_total` | Counter | `route`, `method`, `status_code` | volume HTTP |
| `cleanconnect_bullmq_jobs_total` | Counter | `queue`, `status` | jobs Bull par statut |
| `cleanconnect_bullmq_job_duration_seconds` | Histogram | `queue`, `name` | durée jobs |
| `cleanconnect_bullmq_queue_depth` | Gauge | `queue`, `state` | profondeur queue par état |
| `cleanconnect_bullmq_retries_total` | Counter | `queue`, `name`, `attempt` | retries |
| `cleanconnect_bullmq_dlq_size` | Gauge | `source` | taille DLQ |
| `cleanconnect_bullmq_stalled_total` | Counter | `queue` | jobs stalled |
| `cleanconnect_bullmq_processing_lag_seconds` | Histogram | `queue` | lag enqueue → pickup |
| `cleanconnect_webhook_ingested_total` | Counter | `type` | webhooks reçus |
| `cleanconnect_webhook_signature_invalid_total` | Counter | (none) | signature HMAC invalide |
| `cleanconnect_webhook_livemode_mismatch_total` | Counter | (none) | livemode mismatch rejeté |
| `cleanconnect_webhook_processing_duration_seconds` | Histogram | `type` | latence end-to-end (ingest → handler done) |
| `cleanconnect_payment_intent_created_total` | Counter | (none) | volume PaymentIntent (4.5 enrichira) |
| `cleanconnect_payment_capture_duration_seconds` | Histogram | (none) | latence capture Stripe |
| `cleanconnect_cloudinary_signed_url_total` | Counter | (none) | volume presign |
| `cleanconnect_cloudinary_confirm_duration_seconds` | Histogram | (none) | latence confirm |
| `cleanconnect_alerts_emitted_total` | Counter | `severity` (`p0`-`p3`), `kind` | alertes émises |
| `cleanconnect_alerts_silenced_total` | Counter | (none) | alertes étouffées par silence window |

> Ticket 4.5 enrichira (`cleanconnect_finance_*`, `cleanconnect_transfer_success_rate`, `cleanconnect_finance_mismatch_amount`, etc.).

### 4.5 Contrats observabilité

#### 4.5.1 Event schema émis par `AlertingService`

```typescript
// Schéma logique — figé en Design, Zod schema en Build
type AlertEvent = {
  severity: 'P0' | 'P1' | 'P2' | 'P3'
  kind:
    | 'api_5xx_burst'
    | 'webhook_dead_letter_new'
    | 'transfer_failed_rate_high'
    | 'auto_release_stalled'
    | 'queue_depth_high'
    | 'finance_mismatch'             // Ticket 4.5
    | 'payment_authorization_expiring'  // Ticket 4.5
    | 'payout_anomaly'                  // Ticket 4.5
    | 'daily_finance_report'            // Ticket 4.5
    | 'weekly_retention_audit'          // Ticket 4.4
    | 'release_deployed'
    | 'admin_alert_silence_started'
    | 'admin_alert_silence_ended'
  title: string                       // 1 ligne, < 80 caractères
  detail: string                      // 1 ligne supplémentaire, < 200 caractères
  traceId?: string                    // optionnel — span Sentry à lier
  sentryUrl?: string                  // optionnel
  grafanaUrl?: string                 // optionnel
  env: 'development' | 'recette' | 'preprod' | 'production'
  emittedAt: string                   // ISO 8601
  metadata?: Record<string, string | number | boolean>  // jamais de PII
}
```

**Garde-fou** : tous les champs `title`, `detail`, `metadata` passent par `sanitizeForAlert(value)` qui rejette toute chaîne contenant un email (`/.+@.+/`), un IBAN-like, un numéro de carte (Luhn check), une clé Stripe (`sk_*`, `pk_*`), un JWT-like.

#### 4.5.2 DLQ payload visibility — lecture admin

```typescript
type WebhookDeadLetterView = {
  id: string                          // UUID DLQ
  source: 'STRIPE' | 'CLOUDINARY'     // CLOUDINARY ajouté en Ticket 4.4 (dette I)
  externalEventId: string             // `evt_xxx` (Stripe) ou `notif_xxx` (Cloudinary)
  type: string                        // `payment_intent.succeeded`, etc.
  payloadHashTruncated: string        // 8 premiers caractères du SHA-256
  errorMessageSanitized: string       // err.message passé par `sanitizeErrorForDLQ`
  errorClassName: string              // `StripeSignatureVerificationError`, etc.
  attempts: number
  lastAttemptAt: string
  resolvedAt: string | null
  traceId: string | null              // span Sentry de la dernière tentative
}
```

> **Refus** : exposer le **payload brut**. Si un admin a besoin du payload pour instruire, il interroge Stripe (`stripe.events.retrieve(externalEventId)`) — vérité = Stripe, pas notre DB.

#### 4.5.3 RBAC monitoring — matrice qui peut voir quoi

| Endpoint | CLIENT | PRESTATAIRE | ADMIN | Système (Bearer interne) |
|---|:-:|:-:|:-:|:-:|
| `GET /healthz` | ✅ | ✅ | ✅ | ✅ |
| `GET /readyz` | ✅ | ✅ | ✅ | ✅ |
| `GET /api/internal/metrics` | ❌ | ❌ | ❌ | ✅ |
| `GET /api/internal/queues` | ❌ | ❌ | ❌ | ✅ |
| `GET /admin/queues/*` BullBoard | ❌ | ❌ | ✅ | ❌ |
| `GET /admin/queues/health` | ❌ | ❌ | ✅ | ❌ |
| `POST /admin/observability/silence` | ❌ | ❌ | ✅ | ❌ |
| `GET /admin/webhooks/stripe-dead-letters` | ❌ | ❌ | ✅ | ❌ |
| `POST /admin/webhooks/stripe-dead-letters/:id/replay` | ❌ | ❌ | ✅ (audit) | ❌ |

**Sentry / Grafana** : hors-app.
- Sentry : auth Sentry native (email + 2FA obligatoire pour l'organisation Clean Connect).
- Grafana : `admin.cleanconnect.fr/grafana` derrière reverse proxy Nginx + `auth_request` délégué à `/auth/admin/verify` du backend (Build Ticket 4.1).

### 4.6 Dashboards Grafana figés (3)

#### D1 — API Health

| Panel | Source | Métrique |
|---|---|---|
| Uptime % | Better Stack externe (Build) | `up` over time |
| Request rate (req/s) | Prometheus | `rate(cleanconnect_http_requests_total[1m])` |
| Error rate (5xx %) | Prometheus | `rate(cleanconnect_http_requests_total{status_code=~"5.."}[5m]) / rate(...)` |
| p50/p95/p99 par route critique | Prometheus | `histogram_quantile(0.95, cleanconnect_http_request_duration_seconds_bucket)` |
| Top 5 endpoints lents | Prometheus | top_k 5 |
| Sentry transactions (lien) | Sentry embed | iframe |

#### D2 — BullMQ Queues

| Panel | Source | Métrique |
|---|---|---|
| Queue depth par queue / état | Prometheus | `cleanconnect_bullmq_queue_depth` |
| Jobs/min par queue | Prometheus | `rate(cleanconnect_bullmq_jobs_total[1m])` |
| Failed jobs (last 1 h) | Prometheus | `increase(cleanconnect_bullmq_jobs_total{status="failed"}[1h])` |
| DLQ size par source | Prometheus | `cleanconnect_bullmq_dlq_size` |
| Job duration histogram | Prometheus | `cleanconnect_bullmq_job_duration_seconds` |
| Stalled jobs counter | Prometheus | `cleanconnect_bullmq_stalled_total` |

#### D3 — Business Funnel (préparé 4.1, alimenté 4.5)

| Panel | Source | Métrique |
|---|---|---|
| Missions créées / publiées / acceptées / complétées | Postgres exporter | count par status |
| PaymentIntent → Capture → Transfer success funnel | Prometheus (Ticket 4.5) | ratios |
| Cloudinary signed upload volume | Prometheus | `cleanconnect_cloudinary_signed_url_total` |
| Refund volume + reasons | Prometheus (Ticket 4.5) | breakdown |
| Daily finance KPIs | Prometheus + Postgres exporter | TBD Ticket 4.5 |

**Versionnage** : tous les dashboards JSON exports → `docs/ops/grafana/dashboards/D1-api-health.json`, etc. → Build PR.

### 4.7 Modules Nest à créer (Build — pas runtime ici)

> Réservation de noms et boundary fonctionnels. **Aucun code écrit en Design**.

| Module | Responsabilité | Dépendances Nest |
|---|---|---|
| `observability/observability.module.ts` | racine — init Sentry + OTel + Pino correlation + Prometheus middleware | racine `AppModule` |
| `observability/sentry/sentry.module.ts` | wrappers Sentry (init, breadcrumb, captureException) | `@sentry/node` |
| `observability/otel/otel.module.ts` | init OTel SDK + propagator W3C + auto-instrumentations | `@opentelemetry/sdk-node` |
| `observability/metrics/metrics.module.ts` | `prom-client` Registry + `/metrics` endpoint + middleware HTTP | `prom-client` |
| `observability/metrics/bullmq-metrics.service.ts` | hook tous les events Bull → counters/histograms | `@nestjs/bullmq` |
| `observability/health/health.controller.ts` | `/healthz` + `/readyz` (refactor existant) | `@nestjs/terminus` |
| `observability/bullboard/bullboard.controller.ts` | mount Bull Board derrière JwtAccessGuard | `@bull-board/express` + `@bull-board/api` |
| `observability/alerting/alerting.module.ts` | service + processor + Discord client + Resend email | BullMQ `alerts-queue` |
| `observability/alerting/alerting.service.ts` | API publique `emit(event)` | — |
| `observability/alerting/alerts.processor.ts` | consumer BullMQ + dispatch Discord/email | — |
| `observability/alerting/discord-webhook.client.ts` | HTTP client (undici) + Zod payload | — |
| `admin/observability/silence.controller.ts` | `POST /admin/observability/silence` | JWT + Roles |

**Volumétrie estimée Build** : ~12 fichiers source + ~6 fichiers tests + 4 fichiers config Docker/Grafana. **0** migration Prisma (silence stocké Redis avec TTL natif).

### 4.8 Risk assessment Ticket 4.1 (Design)

| Risque | Score | Mitigation |
|---|:-:|---|
| **Coût monitoring** (Sentry SaaS + Prometheus self-host) | 2/5 | Sentry team plan ~26 €/mois + auto-host gratuit. Surveillé via `cleanconnect_alerts_emitted_total{kind='sentry_quota_warning'}`. Réévaluer à J+30. |
| **Fuite PII** dans Sentry / Prometheus / Grafana | 4/5 | (a) `beforeSend` Sentry filtre PII (Classe A/B/C ADR-016) ; (b) Prometheus n'expose que des nombres ; (c) `/metrics` Bearer interne + firewall ; (d) Discord templates sans payload brut + `sanitizeForAlert`. |
| **Saturation logs** (volume incontrôlé) | 3/5 | `autoLogging.ignore` sur `/healthz` `/readyz` ; rétention bornée (ADR-016 §2.6) ; Docker logrotate. |
| **Alert fatigue** | 3/5 | Sévérité stricte (`@here` réservé P0) ; tuning seuils J+7 (ADR-017 §2.3) ; silence window. |
| **Vendor dependency Sentry** | 3/5 | OTel exporter swappable (Sentry → Tempo) ; redondance Sentry email natif + Discord ; DPA UE Frankfurt RGPD. |
| **Surface attaquable `/metrics` `/admin/queues`** | 4/5 | Bearer interne firewall réseau Docker ; JwtAccessGuard + RolesGuard sur admin ; aucun mutatif via BullBoard (`readOnlyMode: true`). |
| **Régression perf (overhead OTel + Sentry)** | 3/5 | Sampling 10 % prod ; `tracesSampler` 100 % pour les routes critiques ; bench avant/après en Build. |
| **Mauvaise corrélation traceId** | 3/5 | Tests intégration : un webhook → vérifier `traceId` continu HTTP → worker (Build Ticket 4.1 obligatoire). |

### 4.9 Pré-revue sécurité

[`docs/security-reviews/2026-05-12-prd-004-observability-design-prereview.md`](../security-reviews/2026-05-12-prd-004-observability-design-prereview.md) — **0 Critical / 0 Important / 5 Suggestions** (cf. fichier dédié).

### 4.10 TODO Build (à dérouler après sign-off CTO Design)

> Liste figée — ne pas étoffer en Build sans repasser par Design.

1. Ajouter dépendances : `@sentry/node`, `@sentry/profiling-node`, `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@sentry/opentelemetry`, `prom-client`, `@bull-board/express`, `@bull-board/api`. Vérifier compatibilité Node 20 + ESM.
2. Étendre `env.ts` Zod : `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT` (optionnel — par défaut Sentry), `PROM_METRICS_TOKEN`, `OBSERVABILITY_TOKEN`, `DISCORD_WEBHOOK_URL`, `OPS_ALERT_EMAIL`. Crash boot si manque en prod.
3. Initialiser Sentry **avant** Nest bootstrap dans `apps/api/src/main.ts` (Sentry SDK contract).
4. Initialiser OTel SDK **avant** Nest bootstrap aussi (auto-instrumentation HTTP impossible sinon).
5. Implémenter `ObservabilityModule` + sous-modules selon §4.7.
6. Hooker tous les events BullMQ existants (`stripe-webhook-queue`, `auto-release-queue`) sur le `bullmq-metrics.service`.
7. Implémenter `AlertingService.emit()` + processor + Discord client + Resend email.
8. Implémenter `POST /admin/observability/silence` + storage Redis.
9. Implémenter middleware HTTP Prometheus + endpoint `/api/internal/metrics` (Bearer).
10. Implémenter `BullBoardController` montant le router Express derrière `JwtAccessGuard` + `RolesGuard(ADMIN)` + `readOnlyMode: true`.
11. Étendre redactor Pino Classe A/B/C (ADR-016 §2.2) + test unitaire `pino-redactor.spec.ts`.
12. Configurer `tracesSampler` custom (routes critiques 100 %, reste 10 %).
13. Tests intégration : webhook Stripe → vérifier que `traceId` est continu HTTP → worker.
14. Tests intégration : `POST /admin/queues/health` → vérifier RBAC + format.
15. Tests intégration : émettre une alerte → vérifier qu'elle arrive sur Discord (avec mock webhook) + sanitisée.
16. CI : ajouter `pnpm --filter @cc/api typecheck` + `pnpm --filter @cc/api test`.
17. Dashboards Grafana versionnés `docs/ops/grafana/dashboards/D1.json`, `D2.json`, `D3.json` (export JSON).
18. `docker-compose.prod.yml` : ajouter services `prometheus` + `grafana` + scrape config.
19. Mise à jour `CLAUDE.md` § Observabilité + lien ADR-014/015/016/017.
20. PR Build = **1 grosse PR** ou **séquence de 3 PRs** (Sentry+OTel, Prometheus+BullBoard, Alerting) — à arbitrer en ouverture Build.

### 4.11 Definition of Done — Design Ticket 4.1

- [x] **ADR-014** Architecture observabilité (Sentry + OTel + Prometheus/Grafana) — `Proposed` → `Accepted` au sign-off CTO
- [x] **ADR-015** BullMQ monitoring & DLQ observability — `Proposed`
- [x] **ADR-016** Logging & redaction strategy — `Proposed`
- [x] **ADR-017** Alerting strategy — `Proposed`
- [x] Architecture observabilité (§4.1) — diagramme + frontière 3 piliers
- [x] Flux traces/métriques/logs (§4.2) — 2 traces de référence + matrice flux
- [x] Endpoints health/readiness/metrics (§4.3) — RBAC + format
- [x] Conventions nommage métriques (§4.4) — préfixe `cleanconnect_*` + 19 métriques figées
- [x] Contrats observabilité (§4.5) — `AlertEvent` schema + DLQ view + RBAC matrix
- [x] Dashboards Grafana (§4.6) — D1 API Health + D2 BullMQ + D3 Business Funnel (préparé)
- [x] Modules Nest réservés (§4.7) — boundary + dépendances pour Build
- [x] Risk assessment Design (§4.8) — 8 risques scorés + mitigations
- [x] Pré-revue sécurité (§4.9) — 0 Critical / 0 Important / 5 Suggestions
- [x] TODO Build (§4.10) — 20 items figés
- [x] **Aucune ligne de code runtime ajoutée** ✅ (PR doc-only)
- [ ] **Sign-off CTO Design Ticket 4.1** ← bloque l'ouverture du Build Ticket 4.1

> ✍️ À valider par `<CTO>` le `YYYY-MM-DD`. ADRs passent à `Accepted` au sign-off.

---

## 5. Phase BUILD

`N/A` — bloquée tant que le Design n'est pas validé.

---

## 6. Phase VERIFY

`N/A` — bloquée tant que le Build n'est pas validé.

---

## 7. Post-release

`N/A` — bloquée tant que le Verify n'est pas validé.

---

## 8. Annexes

### 8.1 Recherches / benchmarks à conduire en Design

- Comparatif **Sentry Performance vs OpenTelemetry + collector** sur le coût d'hébergement + DX (OQ-1).
- Comparatif **BullBoard vs admin UI custom** sur la surface attaquable (auth, RBAC, exposition queue raw) (OQ-3).
- Étude **anonymisation vs hard delete** en cohabitation avec rétention Stripe 10 ans (OQ-4) — DPO + juriste.
- Test charge **reconciliation cron** sur 10k Payments — temps total + impact API Stripe (`payment_intents.retrieve` rate limit) (US-4.5.1).
- Recherche **Cloudinary deletion guarantees** — comportement réseau `Cloudinary.api.delete_resources` quand pas idempotent côté Cloudinary (US-4.4.5).

### 8.2 Refusés / alternatives non retenues

| Alternative | Pourquoi non retenue |
|---|---|
| **Datadog APM** | Coût > 2-3× Sentry pour une équipe small. Non justifié au MVP. |
| **Self-host complet (Sentry self-host + Loki + Tempo + Grafana)** | Coût opérationnel d'hébergement / maintenance > bénéfice à ce stade. Réévaluer si la facture Sentry SaaS dépasse 200 €/mois. |
| **Webhook Stripe** comme seul mécanisme d'alerte (sans Sentry) | Webhook Stripe = succès/échec côté Stripe ; n'apporte aucune info sur les exceptions internes / crashs worker / latences. |
| **Reconciliation cron en temps réel (event-driven)** | Trop coûteux en API calls Stripe. Daily cron suffit pour détecter une dérive avant 24h. |
| **`DELETE /users/me` hard delete sans grâce** | Risque d'erreur utilisateur (clic accidentel) + perte des références financières → choix anonymisation + soft delete 30 j (OQ-4). |
| **ZIP avec toutes les photos en synchrone** (export RGPD) | Multi-Go en mémoire backend = crash. Async + S3 signed URLs serait OK mais surdimensionné. JSON seul + liens signés suffit (OQ-5). |
| **PagerDuty / Opsgenie** | Coût élevé sur petite équipe. Slack/Discord webhook + email récap = couverture suffisante MVP (OQ-6). |
| **Refonte du module `apps/admin` de zéro** | Le scaffolding Vite+React+TanStack existe (PRD-001 a posé `apps/admin`). On itère, on ne refait pas. |
| **Multi-tenant / B2B Clean Connect** | Hors-scope MVP. Pas de prospects identifiés. À reconsidérer si demande commerciale. |
| **Audit log dédié dans une table `AdminAction`** | Possible alternative à `MissionEvent` étendu (US-4.3.7). À arbitrer en Design — `MissionEvent` peut suffire si on ajoute les types `ADMIN_*`. |

### 8.3 Cible de tag

- Si OQ-9 = un seul PRD → **`v3.1.0-prd004`**
- Si OQ-9 = split → **`v3.1.0-prd004a`** (Ops Foundation) puis **`v3.2.0-prd004b`** (Admin & Compliance)

---

## 9. Checklist BMAD globale

- [x] **Discover** : PRD instancié, 5 tickets cadrés, risques scorés, métriques quantifiables, OQ ouvertes, dépendances PRD-003 listées, ordre d'exécution proposé, statut `DISCOVER_DRAFT`
- [ ] **Validation humaine Discover** (CTO) : nom + date — bloque le passage en Design
- [ ] **Design** : 5 livrables (Prisma diff, Zod schemas, OpenAPI delta, state machines retry/reconciliation, ADRs) — bloqué tant que Discover non validé CTO
- [ ] **Build** : code + tests + migrations (bloqué tant que Design non validé)
- [ ] **Verify** : audits sécu + RGPD + finance + smoke + sign-off CTO + référent RGPD (bloqué tant que Build non validé)
- [ ] PRD archivé, statut `DONE`, version finale taguée

---

*PRD-004 v0.1 — Discover draft — 2026-05-12 — méthode [BMAD-light](../method/BMAD.md) — cahier [v1.4](../CAHIER-DES-CHARGES-v1.4.md). **Aucune ligne de code runtime introduite par cette ouverture de PRD.** Validation CTO requise avant ouverture du Design.*
