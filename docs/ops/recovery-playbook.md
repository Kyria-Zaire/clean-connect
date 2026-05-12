# Recovery Playbook — Clean Connect Ops

> Ce runbook couvre les incidents les plus probables liés aux paiements,
> aux webhooks Stripe et aux jobs BullMQ critiques.
> Couvre PRD-004 Ticket 4.2 (Retry & Recovery BullMQ). Mis à jour 2026-05-13.

## Légende sévérité alertes

| Sévérité | Sens | Délai réaction attendu | Channel |
|---|---|---|---|
| **P0** | Impact direct prestataire/client (paiement bloqué, données perdues) | < 30 min, 24/7 | Discord `#ops-critical` |
| **P1** | Risque dérive ops, pas d'impact immédiat utilisateur | < 4 h, ouvré | Discord `#ops-alerts` |
| **P2** | Anomalie à surveiller | jour ouvré suivant | Discord `#ops-info` (batch) |
| **P3** | Info, logs uniquement | n/a | Pino structured logs |

---

## 1. Transfer Stripe bloqué après 5 retries automatiques (alerte P0 `bullmq_failed_jobs`)

**Signal :** alerte Discord `[P0][bullmq_failed_jobs] Transfer FAILED terminal (transient_max_attempts)` — un prestataire n'a pas reçu son paiement après 5 retries (5 min → 24 h cumulés).

**Cause probable :**
- Stripe indisponible long term (incident plateforme — vérifier https://status.stripe.com).
- Compte Connect Express prestataire en `restricted` ou `disabled` (capabilities tombées).
- Solde plateforme insuffisant.

**Diagnostic en 5 min :**
1. Récupérer le `transferIdShort` dans l'alerte → BullBoard `/api/internal/queues` filtrer `transfer-retry` → trouver le job correspondant.
2. Dans Grafana dashboard `cc-stripe-webhooks` → panel `Stripe API failures by status` filtré sur l'heure de l'alerte.
3. Si erreur récurrente `account_closed` / `account_restricted` → re-vérifier le statut Stripe Connect du prestataire (`/admin/users/:id`).
4. Si plateforme Stripe down → patientez, le scheduler safety-net repartira automatiquement au prochain enqueue admin.

**Action de récupération :**
```bash
# 1. Vérifier l'état réel côté Stripe (le transfer a-t-il peut-être abouti malgré l'erreur ?)
curl -X GET "https://api.stripe.com/v1/transfers?destination=acct_xxx&created[gte]=$(date -d '24 hours ago' +%s)" \
  -u "$STRIPE_SECRET_KEY:"

# 2. Si un transfer existe côté Stripe avec le bon montant → forcer la réconciliation côté DB
# POST /v1/admin/transfers/:id/reconcile (utilise OutboundTransferService.reconcileTransferRow)

# 3. Sinon → relancer un retry manuel admin (réinitialise retryCount, garde idempotency key stable)
# POST /v1/admin/transfers/:id/retry
```

**Prévention :**
- Surveiller le panel `Stripe API failures by status` Grafana — un spike soutenu déclenche l'alerte `stripe_api_failure_spike` (P1) bien avant l'épuisement individuel.
- Vérifier hebdomadairement les capabilities Stripe Connect des prestataires actifs (`/admin/users?providerPayoutStatus=NOT_READY`).

---

## 2. Transfer terminé sur erreur permanente (alerte P1 `stuck_transfer`)

**Signal :** alerte Discord `[P1][stuck_transfer] Transfer FAILED terminal (permanent_error)` — Stripe a renvoyé une erreur non-retryable.

**Erreurs Stripe permanentes connues** (cf. `stripe-transfer-error.ts`) :
- `account_closed` — compte Connect Express fermé par le prestataire.
- `transfer_already_paid` — un transfer existe déjà côté Stripe avec la même idempotency key (race ou succès tardif côté Stripe).
- `invalid_request_error` (avec code spécifique) — payload incorrect.

**Cas particulier `transfer_already_paid` au-delà de 24 h :** Stripe expire l'idempotency_key après ~24 h. Sur un retry très tardif (auto-release safety-net + cron), Stripe peut renvoyer cette erreur **alors qu'aucun transfer n'a réellement été créé**. Vérifier avec :
```bash
curl -X GET "https://api.stripe.com/v1/transfers?destination=acct_xxx&transfer_group=<missionNumber>" \
  -u "$STRIPE_SECRET_KEY:"
```
Si aucun transfer → recréer manuellement (admin) avec une **nouvelle** idempotency key (ex. `transfer-mission-<id>-fix-YYYYMMDD`).

**Action :**
1. Lire le code d'erreur dans l'alerte (`stripeCode` field).
2. Si `account_closed` → contacter le prestataire (nouveau onboarding Connect Express ou paiement par virement bancaire hors Stripe).
3. Si `transfer_already_paid` confirmé côté Stripe → forcer la réconciliation (`reconcileTransferRow`) pour passer le DB row en `SENT`.

---

## 3. Auto-release stalled (alerte P1 `auto_release_stalled`)

**Signal :** alerte Discord `[P1][auto_release_stalled] safety-net re-enqueued N jobs` avec `N > 10`.

**Cause probable :**
- BullMQ worker crashé ou désynchronisé (lockedAt orphelin).
- Redis a redémarré sans persistence AOF (perte des delayed jobs).
- Charge de complétion massive (peu probable au MVP).

**Diagnostic :**
1. BullBoard `/api/internal/queues` → file `escrow-auto-release` → vérifier la répartition `waiting / active / delayed / failed`.
2. Grafana `cc-bullmq` → panel `Queue state cumulative` → repérer le drop / spike.
3. Logs API : `kubectl logs -l app=cc-api --tail=200 | grep auto.release.safety`.

**Action :**
- Vérifier que les workers BullMQ tournent (`docker ps` ou `kubectl get pods`).
- Si Redis a redémarré → vérifier `redis-cli INFO persistence` (AOF activé : `aof_enabled:1`).
- Le scheduler safety-net horaire va régulièrement re-enqueue jusqu'à résorption ; vérifier sur 2-3 ticks que `N` redescend < 10.
- Si `N` reste > 10 sur 3 ticks consécutifs → escalader CTO (incident infra Redis ou worker).

---

## 4. Webhook poison job → DLQ + alerte P0 `bullmq_failed_jobs`

**Signal :** alerte Discord `[P0][bullmq_failed_jobs] Webhook stripe-webhook FAILED` + alerte P1 `dlq_growth` quelques secondes plus tard.

**Cause probable :**
- Bug applicatif sur un nouveau type d'event Stripe.
- Données malformées (incident côté Stripe — très rare).
- Migration DB en cours qui bloque le handler.

**Diagnostic :**
1. Récupérer le `stripeEventIdPrefix` dans l'alerte (12 chars tronqués).
2. `/admin/dead-letters` → filtrer par préfixe → lire `errorMessage` + `payloadHash`.
3. Sentry → chercher l'erreur sur la fenêtre temporelle.

**Action :**
1. Reproduire en local avec l'event Stripe (récupéré via `stripe events resend evt_xxx --webhook-endpoint we_xxx` côté Stripe CLI).
2. Patcher le handler → déployer.
3. Replayer la DLQ via UI admin (déjà admin-only) — l'idempotence `StripeWebhookEvent` empêche les doubles traitements.

**Non-action acceptable :**
- Si l'event est non-critique (ex. `customer.updated` sans impact métier) → marquer la DLQ comme `resolved` sans replay.

---

## 5. DLQ growth soutenue (alerte P1 `dlq_growth`)

**Signal :** alertes P1 `dlq_growth` répétées (cooldown 5 min → indique > 1 DLQ enqueue / 5 min).

**Action :**
1. Grafana `cc-bullmq` → panel `DLQ events/min by action` → identifier la queue source.
2. Si Stripe webhooks → suivre playbook #4.
3. Si autre queue → suivre les logs API `kubectl logs -l app=cc-api --tail=500 | grep dlq.recordEnqueued`.

---

## 6. PhotoUploadSession orphan accumulation (anomalie passive)

**Signal :** pas d'alerte automatique au MVP (sera ajoutée Ticket 4.4 RGPD). Détectable via Grafana panel custom ou via requête DB.

**Vérification :**
```sql
SELECT COUNT(*) FROM "PhotoUploadSession"
WHERE "expiresAt" < NOW() - INTERVAL '1 hour'
  AND NOT EXISTS (SELECT 1 FROM "Photo" WHERE "Photo"."uploadSessionId" = "PhotoUploadSession"."id");
```

**Action :**
- Le cron `PhotoUploadSessionCleanupScheduler` tourne quotidiennement à 04:15 Europe/Paris. Si la valeur croît malgré le cron → vérifier les logs `kubectl logs -l app=cc-api | grep photo.session.cleanup`.
- Pour un cleanup d'urgence : appeler manuellement `PhotosRepository.deleteExpiredUnconsumedSessions({ olderThan: new Date(Date.now() - 1h), limit: 500 })` via script `pnpm --filter @cc/api run script:photo-cleanup` (à créer si besoin).

**Note Cloudinary :** Ticket 4.2 ne nettoie **PAS** Cloudinary — Tickets 4.4 RGPD.

---

## 7. Replay DLQ admin (procédure standard)

**Quand :** après fix d'un bug qui causait des DLQ entries — voir aussi #4.

**Procédure :**
1. `/admin/dead-letters` → filtrer par `status: UNRESOLVED`.
2. Lire le détail (payload + errorMessage + attempts).
3. Clic "Replay" → appelle `POST /v1/admin/webhooks/stripe-dead-letters/:id/replay`.
4. **Idempotence garantie côté `StripeWebhookEvent.stripe_event_id` unique** — pas de risque de double traitement même si le replay réussit après que l'event ait été reprocessé par un autre canal.
5. Si replay succeeds → la DLQ passe en `RESOLVED`. Sinon → retour ici, recommencer.

---

## 8. Indicateurs à surveiller en routine (dashboards Grafana)

| Dashboard | Panel | Seuil d'attention |
|---|---|---|
| `cc-api-health` | HTTP 5xx rate | > 0.1 % sur 5 min |
| `cc-stripe-webhooks` | Stripe API failures by status | spike 4xx/5xx > 3 / min |
| `cc-bullmq` | DLQ size stat (gauge) | > 10 jobs |
| `cc-bullmq` | Jobs failed by queue (rate) | > 0.5 / s sur 5 min |
| **(nouveau Ticket 4.2)** | `bullmq_retry_exhausted_total` rate | toute occurrence non-nulle → ouvrir un ticket d'investigation |

---

## 9. Escalade

| Cas | Escalade |
|---|---|
| P0 non résolu en 30 min | Slack `@CTO` + `@on-call` |
| P1 récurrent (> 3 sur 24 h, même `kind`) | Ouvrir ticket Linear `ops-incident-*` + revue avec CTO |
| Anomalie DB / Redis / Stripe (infra) | Notifier le provider concerné + CTO |
| Suspicion fraude / abuse | CTO + DPO en CC, freeze le compte client/prestataire concerné via `/admin/users/:id` |

---

*Mainteneur : équipe Ops Clean Connect — questions @ ops@cleanconnect.fr*
