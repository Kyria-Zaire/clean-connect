# ADR-015 — BullMQ monitoring & DLQ observability

> **ADR** = *Architecture Decision Record*. Une décision = un fichier.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-015` |
| **Titre** | BullMQ monitoring : BullBoard auth-protégé + métriques Prometheus + visibilité DLQ + replay observabilité |
| **Statut** | `Proposed` (Design Ticket 4.1) |
| **Date** | 2026-05-12 |
| **Auteur** | `architecte-api` + `ingenieur` (observability) |
| **PRD lié** | `docs/prd/PRD-004-hardening-ops-compliance.md` Ticket 4.1 |
| **Phase BMAD** | `Design` |

---

## 1. Contexte

PRD-003 a livré 2 queues BullMQ critiques : `stripe-webhook-queue` (ingestion async webhooks) et `auto-release-queue` (jobs delayed T+48h ouvrées). PRD-004 Ticket 4.2 va en ajouter (retry transfer + safety-net cron).

Aujourd'hui, **aucun outil ne montre l'état de ces queues**. Pour répondre à « est-ce qu'un job est bloqué ? », un dev doit :
1. SSH sur le VPS, `docker exec` dans le container `api`,
2. `node -e "const Q=require('bullmq').Queue; ..."` à la main,
3. lire la DB pour reconstituer le statut.

Inacceptable en production. PRD-004 OQ-3 a tranché **BullBoard en parallèle d'un admin tooling custom** (4.3). Cette ADR fige :
1. comment BullBoard est exposé (en restant **sécurisé**),
2. quelles métriques Prometheus on émet par queue,
3. comment la DLQ devient **observable** sans devenir une **surface attaquable**.

---

## 2. Décision

### 2.1 BullBoard : self-host derrière `JwtAccessGuard(ADMIN)`

**Outil** : [`@bull-board/express`](https://github.com/felixmosh/bull-board) + adapter `@bull-board/api/bullMQAdapter`.

**Montage** dans NestJS (Build Ticket 4.1) :

```typescript
// Pseudo-code — Design only
// apps/api/src/modules/observability/bullboard.controller.ts
@Controller('admin/queues')
@UseGuards(JwtAccessGuard, RolesGuard)
@Roles('ADMIN')
export class BullBoardController {
  // monte le router Express bull-board sur /api/v1/admin/queues
}
```

**Garde-fous obligatoires** :
- `JwtAccessGuard` + `RolesGuard` + `@Roles('ADMIN')` — **jamais accessible** sans token admin valide.
- **Rate limiter spécifique** (`@nestjs/throttler`) : 60 req/min/user (lecture intensive admin acceptable, mais bornée).
- **CORS** : `BullBoard` exposé sur le sous-domaine admin (`admin.cleanconnect.fr`), pas sur le sous-domaine API public.
- **Aucune action mutative exposée via BullBoard UI** : `add`, `remove`, `retry`, `promote` sont **désactivés** (BullBoard accepte un flag `readOnlyMode: true`). Toute action ops (replay, retry) passe par l'admin custom (Ticket 4.3) avec audit trail.
- **PII filter** : les `data` des jobs ne doivent **jamais** contenir de PII (cf. ADR-016 §3) — BullBoard expose le `data` brut.

> **Refus explicite** : `@bull-board/h3` ou `@bull-board/fastify` (on est sur Express/Nest). Pas d'autre fork.

### 2.2 Métriques Prometheus par queue

Exposées via `GET /api/internal/metrics` (cf. ADR-014 §2.3).

**Nommage** : convention OpenMetrics `cleanconnect_bullmq_<metric>{queue=<name>,<labels>}`.

| Métrique | Type | Labels | Source | Use case |
|---|---|---|---|---|
| `cleanconnect_bullmq_jobs_total` | Counter | `queue`, `status` (`completed`, `failed`, `stalled`) | hook `queue.on('completed' \| 'failed' \| 'stalled')` | volume jobs / queue / statut |
| `cleanconnect_bullmq_job_duration_seconds` | Histogram | `queue`, `name` (jobName) | `processedOn - timestamp` | distribution durée jobs |
| `cleanconnect_bullmq_queue_depth` | Gauge | `queue`, `state` (`waiting`, `active`, `delayed`, `failed`, `paused`) | `queue.getJobCounts()` toutes les 15 s | détection accumulation |
| `cleanconnect_bullmq_retries_total` | Counter | `queue`, `name`, `attempt` | hook `worker.on('failed')` → `job.attemptsMade` | détection poison jobs |
| `cleanconnect_bullmq_dlq_size` | Gauge | `source` (`STRIPE` pour `WebhookDeadLetter`, plus tard d'autres) | `prisma.webhookDeadLetter.count({ resolvedAt: null })` toutes les 60 s | alerte DLQ size > seuil |
| `cleanconnect_bullmq_stalled_total` | Counter | `queue` | hook `worker.on('stalled')` | détection worker crashé |
| `cleanconnect_bullmq_processing_lag_seconds` | Histogram | `queue` | `Date.now() - job.timestamp` à la prise du job | détection retard ingestion |

**Plus tard (Ticket 4.5)** :
- `cleanconnect_finance_transfer_success_rate` (Gauge, calculé) — alimenté par requête SQL aggrégée toutes les 5 min.
- `cleanconnect_finance_stuck_transfers` (Gauge) — `Transfer.PENDING & createdAt < now-2h` count.

### 2.3 DLQ observability — sans exposer de PII

La table `WebhookDeadLetter` contient `payloadHash` (SHA-256), `errorMessage`, `attempts`, `lastAttemptAt`, `externalEventId`. Pas de payload brut, pas de PII. **Bonne base.**

Mais l'**erreur** elle-même (`errorMessage`) peut leaker des secrets (ex. `Cannot read property 'cardNumber' of...`). À filtrer en Build par une fonction `sanitizeErrorForDLQ(err)` qui :
- whiteliste les types d'erreur connus (`StripeSignatureVerificationError`, `WebhookLivemodeMismatchError`, etc.) → message d'erreur figé,
- pour les autres : message générique `Unhandled processor error: <ErrorClassName>` + détail dans Sentry (avec contexte complet redacté par `beforeSend` — cf. ADR-016 §4).

**Visibilité ops** (cf. Ticket 4.3) :
- Page `/admin/dead-letters` listing avec filtres (`source`, `resolvedAt=null`, période).
- Drawer détail : `externalEventId`, `type`, `payloadHash` (tronqué affichage `b1f3...`), `attempts`, `lastAttemptAt`, `errorMessage` (sanitisé).
- Lien vers le span Sentry correspondant via `traceId` injecté dans `WebhookDeadLetter.metadata` (champ JSON à ajouter en Build Ticket 4.2 — pour l'instant pas de migration, juste documenté).

### 2.4 Replay observability (corrélation déterministe)

Quand un admin déclenche `POST /v1/admin/webhooks/stripe-dead-letters/:id/replay` :

1. **Audit événement** : `MissionEvent` `ADMIN_DLQ_REPLAY` (ou table `AdminAction` selon arbitrage Ticket 4.3) avec `actor_user_id`, `target_dlq_id`, `target_stripe_event_id`.
2. **Span Sentry parent** créé sur la requête HTTP avec tag `admin_action=dlq_replay`.
3. **Job enqueue** porte le `traceId` du span parent dans `data.traceId` → le worker en consommant ouvre un span enfant. Le replay est ainsi visible dans la même trace que l'action admin.
4. **Métrique** : `cleanconnect_bullmq_dlq_replay_total{source,result=success|failed}`.

### 2.5 Stalled jobs : politique standardisée

BullMQ tag `stalled` un job dont le **lock** a expiré sans heartbeat (worker crashé, OOM, etc.).

**Configuration par défaut** (à figer dans chaque queue) :
- `lockDuration: 30_000` (30 s) — délai max avant qu'un job soit considéré stalled.
- `lockRenewTime: 15_000` (15 s) — heartbeat worker pour renouveler le lock.
- `stalledInterval: 30_000` — fréquence de check stalled jobs.
- `maxStalledCount: 1` (override par défaut BullMQ de 1) — un stalled = re-tenté **une fois**, le 2e stalled → DLQ direct.

**Conséquence métier** : un job stalled est re-tenté **une fois maximum** par le mécanisme stalled. Au-delà, il bascule en DLQ via la politique de retry exponentiel (max attempts) — pas de boucle infinie.

### 2.6 Endpoints additionnels (lecture interne, hors BullBoard)

| Route | Auth | Usage | Réponse |
|---|---|---|---|
| `GET /api/internal/queues` | Bearer `OBSERVABILITY_TOKEN` | Snapshot ops sans UI (script, alerte Slack) | `{ queues: [{ name, counts: { waiting, active, delayed, failed }, paused }] }` |
| `GET /api/v1/admin/queues/health` | `JwtAccessGuard(ADMIN)` | Sain / dégradé selon seuils | `{ status: 'ok'\|'degraded', queues: {...} }` |

> Pas d'endpoint **mutatif** sur les queues côté API publique. Toute mutation = via l'admin custom (Ticket 4.3) avec audit trail.

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| **Pas de BullBoard, tout via admin custom** | Réécrire un UI BullMQ from scratch coûte 1 semaine. BullBoard est mature, gratuit, readOnly suffit pour 95 % des besoins ops. |
| **Hangfire / autre stack queue** | Refus — BullMQ déjà en prod (PRD-003 PR #11). Pas de migration de queue dans PRD-004. |
| **Métriques Bull via plugin SaaS** (ex. Taskforce.sh) | Vendor SaaS supplémentaire, coût récurrent, pas d'intégration Prometheus native. |
| **BullBoard sur sous-domaine public séparé** (`queues.cleanconnect.fr`) | Surface attaquable réseau supplémentaire + cookie auth séparé. Préférer le montage sur le même domaine admin derrière le même JWT. |
| **Auth basique HTTP (`htpasswd`) sur BullBoard** | Moins sécurisé qu'un JWT court (15 min). Pas de logout. Mauvaise DX. Refusé. |
| **Exposer `/metrics` sans auth** | Inacceptable — leak structure interne. Bearer interne obligatoire. |

---

## 4. Conséquences

### Positives

- **MTTD queue-related < 2 min** : Grafana D2 affiche queue depth en temps réel + alerte si > seuil.
- **Diagnostic ops self-service** : BullBoard ADMIN-only permet de voir tout job + ses attempts sans `docker exec`.
- **DLQ replay traçable** : audit + span Sentry = post-mortem facile.
- **Pas d'exposition de PII** : `WebhookDeadLetter` ne contient déjà aucune PII, `data` BullMQ filtré côté producteur (cf. ADR-016).
- **Pas de surface mutative externe** : actions queue passent par admin custom (Ticket 4.3).

### Négatives / coûts assumés

- **2 packages npm** ajoutés (`@bull-board/express`, `@bull-board/api`) — peer dep BullMQ 5+ vérifiée.
- **Bandeau de risque** : si la rotation JWT admin échoue, BullBoard devient accessible jusqu'à expiration du token (15 min max).
- **Overhead Prometheus scraping** négligeable (~1-2 ms par scrape) avec 7 métriques.

### Neutres (à surveiller)

- **BullBoard maintenance** : projet OSS communautaire — vérifier maintenance trimestrielle.
- **Format métriques** : si Prometheus → Mimir/Cortex futur, format OpenMetrics est compatible.

---

## 5. Suivi

- [ ] PR Build : module `observability/bullboard.controller.ts` + `bullmq-metrics.service.ts`
- [ ] PR Build : `sanitizeErrorForDLQ` (lib pure testable)
- [ ] PR Build : extension `WebhookDeadLetter.metadata Json?` (migration additive si retenue) — ou stockage dans Sentry uniquement
- [ ] Tests intégration Build : DLQ replay → vérifier métriques + audit + span
- [ ] Dashboard Grafana D2 versionné (`docs/ops/grafana/dashboards/D2-bullmq-queues.json`)
- [ ] Mise à jour `CLAUDE.md` : section ops + lien ADR-015

---

## 6. Références

- BullBoard : https://github.com/felixmosh/bull-board
- BullMQ stalled jobs : https://docs.bullmq.io/guide/jobs/stalled
- prom-client BullMQ exporter patterns : https://github.com/siimon/prom-client
- PRD-004 Ticket 4.1 §4 (Design technique)
- ADRs liées : ADR-014 (Observability stack), ADR-016 (Logging), ADR-017 (Alerting)

---

*ADR-015 v1.0 — méthode [BMAD-light](../method/BMAD.md). À passer `Accepted` après sign-off CTO Design.*
