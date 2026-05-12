# Pré-revue sécurité — Design PRD-004 Ticket 4.1 (Observabilité & Ops)

| Champ | Valeur |
|---|---|
| **Date** | 2026-05-12 |
| **Reviewer** | `securite` + `reviewer-securite-code` (méthode pré-revue Design — risques Discover ≥ 4 : Sécurité 4/5, RGPD 5/5, Financier 4/5) |
| **PRD** | [`docs/prd/PRD-004-hardening-ops-compliance.md`](../prd/PRD-004-hardening-ops-compliance.md) (Ticket 4.1) |
| **Périmètre** | ADR-014 (Observability) + ADR-015 (BullMQ monitoring) + ADR-016 (Logging) + ADR-017 (Alerting) + PRD-004 §4.1 → §4.10 |
| **Statut** | **Pré-revue Design OK — Build interdit sans sign-off CTO Design final.** |

---

## Synthèse

| Sévérité | Compte | Commentaire |
|---|---:|---|
| 🔴 Critical | **0** | — |
| 🟠 Important | **0** (5 **Conditions Build** documentées §3) | — |
| 🟡 Suggestion | **5** | Voir §4 |
| 🟢 Conforme | **18** | Voir §2 |

**Verdict** : aucun blocage **Critical** / **Important** sur le périmètre Design (ADRs + contrats + RBAC + redaction). Les 5 conditions §3 sont des garde-fous **obligatoires** à appliquer en Build — déjà tracés dans la liste TODO Build du PRD §4.10. Build peut démarrer après sign-off CTO Design final.

---

## 1. Méthodologie

**Cibles auditées** :
- `docs/adr/ADR-014-observability-architecture.md` — frontière 3 piliers, sampling, corrélation IDs.
- `docs/adr/ADR-015-bullmq-monitoring-dlq.md` — BullBoard auth + métriques Bull + DLQ visibility.
- `docs/adr/ADR-016-logging-redaction-strategy.md` — Pino prod + redactor Classe A/B/C + rétention + RGPD.
- `docs/adr/ADR-017-alerting-strategy.md` — Discord + email + sévérité P0-P3 + escalade + silence.
- `docs/prd/PRD-004-hardening-ops-compliance.md` — §4.1 → §4.10 (architecture, flux, endpoints, contrats, RBAC, dashboards, modules Nest, TODO Build).

**Grille d'audit** : checklist `reviewer-securite-code.mdc` + CLAUDE.md §sécurité + cahier v1.4 §6 (Exploitation & monitoring) + §8 (RGPD) + rules `securite.mdc`, `backend.mdc`.

**Tests effectués** (statiques — pas de code à exécuter) :
- ✅ Vérification cohérence ADR ↔ PRD ↔ rules.
- ✅ Vérification que chaque endpoint exposé porte explicitement un `RBAC` ou Bearer interne.
- ✅ Croisement liste redactor (Classe A/B/C ADR-016 §2.2) avec champs sensibles connus de PRD-001 / PRD-002 / PRD-003 (auth, missions, paiements, photos, webhooks, Cloudinary).
- ✅ Vérification absence d'exposition payload brut webhook / DLQ.
- ✅ Vérification que les exemples de logs / alertes / dashboards ne contiennent pas de PII fictive dangereuse (pas de templates copy-paste leakant un email réel).

---

## 2. Checklist conforme (18 items)

### 2.1 Architecture & isolement (ADR-014)

1. **Frontière 3 piliers stricte** : Sentry = erreurs/APM ; OTel = traces ; Prometheus = métriques. Pas de duplication ni de double comptage qui pourrait masquer une dérive.
2. **Sampling prod 10 % + override critiques 100 %** : protège la facture Sentry tout en garantissant la traçabilité financière (`/payments/intent`, `/webhooks/stripe`, `/missions/:id/validate`, `/missions/:id/complete`, `/admin/payments/:id/refund`).
3. **`/api/internal/metrics` Bearer interne** + **firewall réseau Docker** (`9090` accessible uniquement depuis IP container Grafana). Aucune exposition publique des métriques internes.
4. **`/api/internal/queues` Bearer interne** : même règle.
5. **Sentry région UE Frankfurt** : conforme RGPD (data residency EU). DPA Sentry à signer/référencer côté DPO (cf. §3 Condition Build 1).
6. **Pas d'envoi de logs à Sentry** : Sentry n'est pas un log aggregator, on évite l'explosion de coûts et la duplication des données PII.

### 2.2 BullMQ monitoring (ADR-015)

7. **BullBoard derrière `JwtAccessGuard + RolesGuard(ADMIN)`** + **`readOnlyMode: true`** : aucune mutation possible depuis BullBoard (anti tampering ops).
8. **Rate limiter** spécifique 60 req/min/user sur BullBoard : protège contre l'usage anormal d'un compte admin compromis.
9. **Aucune PII dans `WebhookDeadLetter`** : déjà acquis PR #11 (`payloadHash` SHA-256 + `errorMessage` sans payload brut + `attempts` + `lastAttemptAt`).
10. **`sanitizeErrorForDLQ`** : whitelist erreurs connues + générique pour les autres (anti-leak via stack trace dans `errorMessage`).
11. **Replay DLQ traçable** : `MissionEvent` (ou `AdminAction`) + span Sentry parent + métrique `cleanconnect_bullmq_dlq_replay_total{result}` — auditabilité complète.

### 2.3 Logging & RGPD (ADR-016)

12. **Redactor PII Classe A (secrets)** : `authorization`, `cookie`, `stripe-signature`, `idempotency-key`, `password*`, `*Token*`, `*sessionToken*`, `api_key`, `api_secret`, `signature`, `clientSecret`, `cloudinaryParams.*`. **18 chemins figés**.
13. **Redactor PII Classe B (finance)** : `cardNumber`, `card.number`, `cvv`, `bankAccount`, `payment_method`, `stripeAccountId`, `stripeCustomerId`. **7 chemins**.
14. **Redactor PII Classe C (direct PII)** : `email`, `firstName/lastName/fullName`, `phone*`, `mobile`, `address.street`, `street`, `address.location`, `location.lat/lng`, `gps*`, `captureClientUuid`. **14 chemins**.
15. **IP cliente redactée par défaut** dans le serializer `req` (RGPD considère l'IP comme PII en France).
16. **`userId` UUID conservé** = pseudonyme conforme CNIL (pas réidentifiable sans la table `User`). Justification documentée ADR-016 §2.7.

### 2.4 Alerting (ADR-017)

17. **Templates message Discord** : jamais de payload brut. `title` + `detail` + lien Sentry + lien Grafana. Passage par `sanitizeForAlert` qui rejette emails / IBANs / cartes / clés Stripe / JWT-like.
18. **Silence window bornée + auditable** : pas de silence permanent (TTL Redis), `MissionEvent` `ADMIN_ALERT_SILENCE` (ou `AdminAction`) avec `actor_user_id`, `actor_email`, `actor_ip`, `reason`, `duration`.

---

## 3. Conditions Build (obligatoires — non-bloquantes Design)

> Ces 5 conditions ne bloquent pas le Design (les contrats sont OK) mais doivent être **implémentées et testées** en Build, sous peine de blocage Verify.

### Condition Build 1 — DPA Sentry et registre RGPD

**Quoi** : signer le DPA Sentry (Data Processing Agreement) + ajouter Sentry au **registre des traitements** RGPD côté DPO. Vérifier la **clause sous-traitant** + la région UE Frankfurt.
**Pourquoi** : Sentry traite des données techniques pouvant être indirectement liées à des utilisateurs (`traceId`, `requestId`, `userId` UUID, payload erreur après filtrage). Un manquement = sanction CNIL.
**Vérif Verify** : DPO confirme par écrit (rapport Verify §RGPD).

### Condition Build 2 — Test unitaire redactor PII exhaustif

**Quoi** : `apps/api/test/unit/pino-redactor.spec.ts` doit tester **chacune** des 3 classes A/B/C avec un payload réel par classe → vérifier le JSON émis ne contient pas la PII.
**Pourquoi** : redactor mal configuré = leak PII silencieux. Un test CI = détection avant prod.
**Cas de test minimum** :
- Classe A : signup payload → `password`, `*Token*` doivent être `[REDACTED]`.
- Classe B : Stripe payment intent → `clientSecret`, `cardNumber` (fictif) doivent être `[REDACTED]`.
- Classe C : profil user → `email`, `phone`, `firstName` doivent être `[REDACTED]`.

### Condition Build 3 — Sentry `beforeSend` filter

**Quoi** : configurer `Sentry.init({ beforeSend(event, hint) { ... } })` pour :
1. Strip `event.request.headers` (sauf whitelist) — anti-leak `cookie`, `authorization`, `stripe-signature`.
2. Strip `event.request.data` si > 1 KB ou si contient PII Classe A/B/C (réutiliser la même `sanitizeForAlert` que ADR-017).
3. Stripper les breadcrumbs contenant `card.number`, `cvv`, `clientSecret`, `api_secret`, `password`, etc.

**Pourquoi** : par défaut, Sentry envoie le payload de la requête → leak garanti si pas filtré.
**Vérif Verify** : test d'intégration provoque une erreur volontaire dans `/payments/intent` → vérifier que l'event Sentry capturé (via SDK mock ou Sentry SDK in-test) ne contient ni `cardNumber` ni `clientSecret`.

### Condition Build 4 — Auth Grafana production

**Quoi** : déployer Grafana derrière reverse proxy Nginx + `auth_request /auth/admin/verify` qui appelle l'API NestJS pour vérifier le JWT admin. **Jamais** d'auth basique htpasswd. **Jamais** d'utilisateur Grafana local.
**Pourquoi** : Grafana expose toutes les métriques internes (queue depth, transferts, alertes, etc.) — sécurité = même niveau que `/admin/*`.
**Vérif Verify** : test E2E manuel — Grafana sans token → 401, avec token CLIENT → 401, avec token ADMIN → 200.

### Condition Build 5 — Tests OTel propagation cross-process

**Quoi** : test d'intégration `observability-traceid-propagation.integration.spec.ts` qui :
1. déclenche un webhook Stripe valide,
2. vérifie que le job BullMQ enqueue contient `data.traceId`,
3. attend le worker,
4. vérifie que les logs Pino du worker portent le **même** `traceId` que la requête HTTP.

**Pourquoi** : la corrélation cross-process est la valeur ajoutée principale d'OTel. Si elle casse silencieusement, on dépense des $ Sentry sans bénéfice diagnostic.
**Vérif Verify** : ce test doit être vert en CI.

---

## 4. Suggestions (5)

> Non bloquantes — à reconfirmer en Build / Verify.

### Suggestion 1 — Better Stack uptime monitoring externe

Ajouter [Better Stack](https://betterstack.com/) (ou UptimeRobot) pour le monitoring **externe** de `/healthz` (toutes les 30 s) + status page publique. Coût ~10 €/mois.
**Justif** : Sentry / Prometheus sont **internes**. Si l'app est totalement down, ils ne peuvent rien signaler. Un check externe garantit la détection même en cas de SPOF Docker host.
**Décision** : à arbitrer ouverture Build ou plus tard. Pas bloquant 4.1.

### Suggestion 2 — Sentry Performance budget

Configurer un **budget Sentry** mensuel (`events`, `transactions`, `profiles`) avec alerte à 80 % du quota → Discord P2.
**Justif** : si une erreur loop génère 1 M events en une nuit, on consomme tout le quota mensuel. Alerte précoce = upgrade plan vs throttling brutal.

### Suggestion 3 — Test de charge `bullmq-metrics` instrumentation

En Build, faire un test de charge (`autocannon` ou similaire) : 1 000 req/s sur `/healthz` (route non instrumentée) vs 1 000 req/s sur `/payments/intent` (route instrumentée OTel + Sentry + Prometheus). Mesurer overhead %.
**Cible** : overhead < 10 % de latence p95. Si > 10 % → reconsidérer sampling ou désactivation auto-instrumentations Prisma.

### Suggestion 4 — Discord webhook URL rotation policy

Documenter dans `docs/ops/secrets-rotation.md` (à créer Ticket 4.4 ou plus tard) une politique de rotation **trimestrielle** du `DISCORD_WEBHOOK_URL` (au cas où le secret leak via screenshot Discord ou logs).
**Justif** : Discord webhook URL = secret partiel (permet de poster, pas de lire). Mais une rotation périodique = bonne hygiène.

### Suggestion 5 — Migration `WebhookDeadLetter` → enrichir avec `traceId`

À planifier en Build : ajouter une colonne `traceId String?` à `WebhookDeadLetter` (migration additive non-bloquante). Permet de lier DLQ ↔ span Sentry directement, sans devoir requêter Sentry par `externalEventId`.
**Cible** : Build Ticket 4.2 (qui touchera de toute façon `WebhookDeadLetter`).

---

## 5. Risk matrix Design (rappel)

| Domaine | Score | Statut | Mitigation principale |
|---|:-:|:-:|---|
| Sécurité | 4/5 | ✅ mitigé | RBAC strict + Bearer interne + firewall réseau + redactor Pino exhaustif |
| RGPD | 5/5 | ✅ mitigé (Condition Build 1 obligatoire) | DPA Sentry + redactor Classe C + IP redactée + rétention bornée |
| Financier | 4/5 | ✅ mitigé | `sanitizeForAlert` (alerts) + `sanitizeErrorForDLQ` (DLQ) + Sentry `beforeSend` (Condition Build 3) |
| Vendor lock-in Sentry | 3/5 | ✅ mitigé | OTel exporter swappable (Sentry → Tempo) + DPA UE |
| Surface attaquable | 4/5 | ✅ mitigé | `/internal/*` Bearer + Docker firewall + Grafana auth_request via API |
| Alert fatigue | 3/5 | ✅ mitigé | Sévérité P0-P3 stricte + tuning J+7 + silence window |
| Saturation logs | 3/5 | ✅ mitigé | `autoLogging.ignore` + rétention + logrotate |
| Coût | 2/5 | ✅ acceptable | ~30 €/mois total au lancement |

---

## 6. Recommandations transverses

### 6.1 Sécurité opérationnelle des secrets

- `SENTRY_DSN`, `OBSERVABILITY_TOKEN`, `DISCORD_WEBHOOK_URL` doivent être dans le **secret manager** (pas dans `.env` git-tracké).
- `OBSERVABILITY_TOKEN` = secret rotatable (mensuel).
- `SENTRY_DSN` = pas un secret strict (visible côté client) mais à protéger côté backend de toute façon.
- Validation Zod au boot : crash si manque en prod (cf. CLAUDE.md règle 1).

### 6.2 Documentation des secrets

À créer (post-Build) : `docs/ops/secrets-inventory.md` listant tous les secrets nécessaires + rotation + propriétaire. Hors-scope 4.1, mais à prévoir Ticket 4.3 / 4.4.

### 6.3 Pas d'envoi cross-env de la télémétrie

Vérifier en Build : la conf Sentry/Prometheus utilise **strictement** la variable `APP_ENV` côté tag — un event d'erreur recette ne doit jamais arriver dans le project Sentry production.

---

## 7. Verdict final pré-revue Design

✅ **Design Ticket 4.1 — validé** sous réserve :
- application des **5 conditions Build** (§3) — toutes documentées dans la liste TODO Build PRD §4.10
- sign-off CTO final Design Ticket 4.1 (DoD PRD §4.11 dernière case)

Le Design peut être mergé. Le Build ne peut démarrer qu'après sign-off CTO.

---

*Pré-revue sécurité Design PRD-004 Ticket 4.1 v1.0 — 2026-05-12 — méthode [BMAD-light](../method/BMAD.md). Rapport Verify final à produire après Build (cf. méthode Verify PRD-003 PR #13 comme référence — 23 audits + grille §6.1 complète).*
