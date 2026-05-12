# ADR-016 — Logging production & stratégie de rédaction PII

> **ADR** = *Architecture Decision Record*. Une décision = un fichier.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-016` |
| **Titre** | Logging production : Pino structuré JSON, redactor PII figé, corrélation IDs, rétention 30 j |
| **Statut** | `Proposed` (Design Ticket 4.1) |
| **Date** | 2026-05-12 |
| **Auteur** | `architecte-api` + `securite` + `photos-rgpd` |
| **PRD lié** | `docs/prd/PRD-004-hardening-ops-compliance.md` Ticket 4.1 |
| **Phase BMAD** | `Design` |

---

## 1. Contexte

Clean Connect utilise déjà `nestjs-pino` (cf. PRD-001 + extensions PRD-002 et PRD-003). Le `redactor` est défini dans `apps/api/src/app.module.ts` (audit Verify PRD-003 §6.1 K — vert).

**Mais** :

1. Aucune **politique formelle** n'est documentée — la liste de paths redactés grossit à chaque PRD sans cadre clair.
2. Aucune **politique de rétention** des logs n'est figée (combien de jours on garde les logs ? où ?).
3. Aucune **corrélation logs ↔ traces** n'est explicite (`requestId` existe mais `traceId` n'est pas encore propagé — viendra avec ADR-014).
4. Le **masquage Stripe / webhooks** n'est pas exhaustif : tous les nouveaux champs (`stripeAccountId`, `clientSecret`, `cardNumber`, etc.) sont ajoutés au cas par cas.
5. **RGPD** : aucune doc ne décrit ce qui se passe quand un user demande l'effacement vis-à-vis des logs (les logs gardent des `userId` UUID identifiables).

Cette ADR formalise.

---

## 2. Décision

### 2.1 Pino production figé

| Aspect | Choix | Justif |
|---|---|---|
| **Format** | JSON Lines (`pino`) | parseable par tous les log aggregators (Loki, Datadog, CloudWatch, etc.) |
| **Niveau prod** | `info` | équilibre signal/bruit ; `debug` jamais en prod |
| **Niveau dev / recette** | `debug` | dev voit tout |
| **Pretty print** | **désactivé** en prod, activé via `pino-pretty` en dev (déjà fait) | Pas de cycles CPU prod sur le formatting |
| **Sortie** | `stdout` Docker | conteneur Docker capture, agrégateur en aval (cf. §2.5) |
| **Timestamp** | `Date.now()` (epoch ms) — `pino` default | tri lexicographique correct |
| **Hostname/PID** | inclus (`process.env.HOSTNAME`, `process.pid`) | retrouver le container/pod source |

### 2.2 Politique de redaction — liste figée par classe

> **Règle fondamentale** : on redacte par **classe de donnée**, pas par champ ad-hoc.

#### Classe A — Secrets et tokens (CRITIQUE — interdiction absolue de log)

| Pattern | Action |
|---|---|
| `req.headers.authorization` | `[REDACTED]` |
| `req.headers.cookie`, `res.headers["set-cookie"]` | `[REDACTED]` |
| `req.headers["stripe-signature"]` | `[REDACTED]` |
| `req.headers["idempotency-key"]` | `[REDACTED]` (techniquement pas un secret, mais peut faciliter le rejeu) |
| `*.password`, `*.passwordHash` | `[REDACTED]` |
| `*.accessToken`, `*.refreshToken`, `*.tokenHash`, `*.tokenDigest` | `[REDACTED]` |
| `*.sessionToken` | `[REDACTED]` |
| `*.api_key`, `*.api_secret` (Cloudinary), `*.signature` (Cloudinary signed upload) | `[REDACTED]` |
| `*.clientSecret`, `*.client_secret` (Stripe PaymentIntent) | `[REDACTED]` |
| `*.stripeSecretKey`, `*.STRIPE_SECRET_KEY` (paranoia, ne devrait pas être en payload) | `[REDACTED]` |

#### Classe B — Données financières (CRITIQUE — interdiction de log)

| Pattern | Action |
|---|---|
| `*.cardNumber`, `*.card.number` | `[REDACTED]` |
| `*.cvv`, `*.card.cvc` | `[REDACTED]` |
| `*.bankAccount`, `*.bankAccount.*` | `[REDACTED]` |
| `*.payment_method`, `*.paymentMethod` | `[REDACTED]` |
| `*.stripeAccountId`, `*.stripeCustomerId` | `[REDACTED]` (identifiants Stripe = PII) |
| `*.payout`, `*.payout.*` | `[REDACTED]` |

#### Classe C — PII direct (IMPORTANT — redacte par défaut, exceptions explicites)

| Pattern | Action |
|---|---|
| `*.email`, `*.emailAddress` | `[REDACTED]` (l'email d'un user est PII) |
| `*.firstName`, `*.lastName`, `*.fullName` | `[REDACTED]` |
| `*.phone`, `*.phoneNumber`, `*.mobile` | `[REDACTED]` |
| `*.address.street`, `*.street` | `[REDACTED]` |
| `*.address.location`, `*.location.lat`, `*.location.lng`, `*.gpsLat`, `*.gpsLng`, `*.gps.lat`, `*.gps.lng` | `[REDACTED]` |
| `*.dateOfBirth`, `*.birthDate` | `[REDACTED]` |
| `*.captureClientUuid` | `[REDACTED]` (peut être recoupé à une photo identifiable) |

#### Classe D — Identifiants techniques (NEUTRE — gardé en clair pour debug)

| Pattern | Action |
|---|---|
| `userId`, `missionId`, `paymentId`, `transferId`, `refundId`, `photoId` (UUID v4 internes) | **gardé** (utiles au debug, pas exploitable hors-DB) |
| `requestId`, `traceId`, `spanId`, `jobId` | **gardé** (corrélation obligatoire) |
| `stripeEventId` (`evt_xxx`), `stripePaymentIntentId` (`pi_xxx`), `stripeTransferId` (`tr_xxx`), `stripeRefundId` (`re_xxx`) | **gardé** (corrélation Stripe Dashboard) |

> **Exception Classe C → Classe D** : un admin légitime peut être amené à lire un payload non-redacté pour instruire un litige. Ce **ne se fait pas** depuis les logs — ça se fait depuis l'admin tooling avec audit trail (Ticket 4.3 PRD-004). Les logs eux-mêmes ne contiennent **jamais** de PII en clair.

### 2.3 Configuration Pino consolidée (Design only, à appliquer en Build)

```typescript
// Pseudo — extrait de apps/api/src/app.module.ts (futur)
LoggerModule.forRoot({
  pinoHttp: {
    level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
    autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
    redact: {
      paths: [
        // Classe A — Secrets
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["stripe-signature"]',
        'req.headers["idempotency-key"]',
        'res.headers["set-cookie"]',
        '*.password', '*.passwordHash',
        '*.accessToken', '*.refreshToken', '*.tokenHash', '*.tokenDigest',
        '*.sessionToken',
        '*.api_key', '*.api_secret',
        '*.signature',
        '*.clientSecret', '*.client_secret',
        '*.cloudinaryParams.signature', '*.cloudinaryParams.api_key',

        // Classe B — Finance
        '*.cardNumber', '*.card.number',
        '*.cvv',
        '*.bankAccount',
        '*.payment_method', '*.paymentMethod',
        '*.stripeAccountId', '*.stripeCustomerId',

        // Classe C — PII
        '*.email',
        '*.firstName', '*.lastName',
        '*.phone', '*.phoneNumber', '*.mobile',
        '*.address.street', '*.street',
        '*.address.location', '*.location.lat', '*.location.lng',
        '*.gpsLat', '*.gpsLng', '*.gps.lat', '*.gps.lng',
        '*.captureClientUuid',
      ],
      censor: '[REDACTED]',
    },
    customProps: (req) => ({
      requestId: req.id, // déjà géré par nestjs-pino
      traceId: trace.getSpanContext()?.traceId, // OTel propagator (ADR-014)
      spanId: trace.getSpanContext()?.spanId,
      env: process.env.APP_ENV,
    }),
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url, remoteAddress: '[REDACTED_IP]' }),
      // IP redactée par défaut — RGPD considère l'IP comme PII en France.
      // Exception : si on a besoin de l'IP pour security audit, on la garde mais on l'hashe (sha256(ip + salt)).
    },
  },
})
```

### 2.4 Corrélation IDs dans chaque log

Chaque ligne de log doit porter au minimum :

| Champ | Source | Obligatoire ? |
|---|---|---|
| `requestId` | `nestjs-pino` middleware | Oui (HTTP) |
| `traceId` | OTel current span (ADR-014) | Oui si span actif |
| `spanId` | OTel current span | Optionnel |
| `jobId` | BullMQ `job.id` ou idempotency-key déterministe | Oui (worker) |
| `userId` | `CurrentUser` décorator | Oui si auth (sinon `null`) |
| `env` | `APP_ENV` | Oui |
| `service` | `'api' | 'worker'` | Oui |

**Bonne pratique** (à imposer en Build via lint custom ou code review) : tout `logger.info / error / warn` doit prendre `{ traceId, requestId, userId, ...context }` en premier argument, puis le message en second.

### 2.5 Pipeline d'agrégation (vue d'ensemble — Design only, exécution Build)

```
NestJS Pino → stdout
            ↓
        Docker logs
            ↓
   [agent de collecte VPS]    ← Vector ou Promtail (à arbitrer Build)
            ↓
         Loki (self-host)     ← agrégateur log queryable
            ↓
       Grafana Explore        ← UI lecture (admin only via ADR-014 §2.6)
```

**Note** : Loki vs SaaS (Datadog Logs, Better Stack) à reconfirmer en Build sur critères coût/maintenance. La décision **ne bloque pas** Ticket 4.1 — Pino+stdout fonctionne déjà ; l'agrégation centralisée peut arriver en 4.1b.

**Décision provisoire** : démarrer **sans agrégateur central** (Pino stdout + `docker logs` suffisent au début) ; ajouter Loki en Build 4.1 si volumétrie le justifie. Cela évite de surdimensionner et permet de mesurer le volume réel avant de payer.

### 2.6 Rétention logs — politique RGPD

| Type de log | Durée de rétention | Justification |
|---|---|---|
| **Logs applicatifs** (info, warn) | **30 jours** | dépannage + détection incidents post-mortem |
| **Logs erreurs** (error, fatal) | **90 jours** | analyse incidents J-90 + détection patterns récurrents |
| **Logs accès HTTP** (`autoLogging`) | **30 jours** | corrélation requestId, anti-fraude |
| **Logs sécurité** (auth, RBAC denied, webhook signature invalid) | **180 jours** | conformité audit sécurité + revue annuelle |
| **Logs financiers** (capture, transfer, refund émis — audit trail) | **N/A** (pas stockés dans les logs) — vérité = DB + Stripe | Code de commerce 10 ans → table `MissionEvent` ou audit DB dédié |
| **Logs avec PII redactée** | identique au type ci-dessus — `[REDACTED]` n'est plus PII | RGPD admet la redaction comme moyen d'anonymisation effective |

> **Critique** : la rétention est appliquée **par le système d'agrégation** (Loki retention config, ou ttl SaaS). Si on reste sur Docker stdout sans agrégation, Docker logrotate doit être configuré (`max-size: 50m, max-file: 7` typiquement).

### 2.7 RGPD — effacement utilisateur dans les logs

Quand un user déclenche `DELETE /v1/users/me` (Ticket 4.4 PRD-004) :

- **Aucune action sur les logs existants** — `userId` UUID n'est pas une PII directe (pas d'email, pas de nom). C'est un identifiant interne qui devient orphelin après la suppression du `User` côté DB.
- **Justification CNIL** : l'UUID seul ne permet pas de réidentifier la personne sans accès à la table `User` (qui sera anonymisée ou supprimée). Donc le log conserve sa valeur d'audit sans violer le droit à l'effacement.
- **Logs futurs** : aucune log de la personne supprimée n'est plus généré.
- **Si la CNIL exige plus** : on peut implémenter un script de purge ciblé (cron Ticket 4.4) qui re-écrit les logs Loki avec `userId=<deleted>` — non-MVP, décidé si besoin.

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| **Pino → Sentry breadcrumbs** | Sentry n'est pas un log aggregator — coût explose si on lui envoie tous les logs. On reste discipliné : Sentry = erreurs/transactions, Loki = logs. |
| **Winston à la place de Pino** | Pino déjà en place + plus performant + écosystème NestJS (`nestjs-pino`). Pas de raison de changer. |
| **CloudWatch / Stackdriver** | Vendor cloud-specific. On reste agnostic. |
| **Hashing systématique des userId dans les logs** | Casse le diagnostic ops (impossible de joindre log à DB). userId UUID est acceptable. |
| **Redaction at log-aggregator (post-ingestion)** | Trop tardif — si le log JSON contient déjà la PII, elle a transité en clair sur le réseau VPS → aggregator. **Redaction at source obligatoire**. |
| **Pas de logs RBAC denied / webhook signature invalid** | Sécurité : on doit savoir si quelqu'un essaie d'attaquer. Logs sécurité conservés 180 j. |

---

## 4. Conséquences

### Positives

- **PII zero-tolerance** : toute classe A/B/C masquée, audit reproductible.
- **RGPD-compatible** : redaction effective + rétention bornée + UUID non-réidentifiable.
- **Corrélation triviale** : `requestId` (HTTP) + `traceId` (cross-service) + `jobId` (worker) dans **chaque** log.
- **Évolutivité** : si Loki devient insuffisant, swap aggregator sans toucher au code applicatif.
- **Dette consommée** : `debt-pino-redactor-extension` (PRD-003 Verify §6.1 K) figée durablement.

### Négatives / coûts assumés

- **Effort de discipline** : chaque PR doit passer la liste redactor en revue (toute nouvelle classe de payload → ajout au redactor).
- **Volume log prod** : ~5-20 GB/mois estimé à 1 000 missions/jour. Loki self-host gère sans souci. Datadog coûterait ~50-100 €/mois pour ce volume.
- **Test du redactor** : à ajouter en CI (unit test : payload réel avec PII → après log, JSON ne contient pas la PII).

### Neutres (à surveiller)

- **Loki vs SaaS** : décision à confirmer post-prod J+30 (mesurer volume réel).
- **Logs sécurité 180 j** : à challenger avec DPO si conservation excessive (compromis sécurité ↔ minimisation).

---

## 5. Suivi

- [ ] PR Build : `apps/api/src/app.module.ts` redactor consolidé (déjà partiellement fait, à compléter avec Classe A/B/C exhaustive)
- [ ] PR Build : `apps/api/src/common/interceptors/log-correlation.interceptor.ts` (injecte `traceId` dans logger context)
- [ ] PR Build : test CI `apps/api/test/unit/pino-redactor.spec.ts` — payloads PII de chaque classe → vérifie `[REDACTED]` dans le JSON émis
- [ ] PR Build : `docker-compose.prod.yml` — configuration logrotate Docker (avant Loki)
- [ ] Rule Cursor `logs-redaction.mdc` à créer (au moment du Build, avec lien ADR-016)
- [ ] Mise à jour `CLAUDE.md` § sécurité — règle 10 (PII logs) avec lien ADR-016

---

## 6. Références

- nestjs-pino : https://github.com/iamolegga/nestjs-pino
- Pino redact : https://github.com/pinojs/pino/blob/master/docs/redaction.md
- CNIL — pseudonymisation par identifiant technique : https://www.cnil.fr/fr/recherche-scientifique-hors-sante/pseudonymisation
- ADR-014 (Observability), ADR-015 (BullMQ obs), ADR-017 (Alerting)

---

*ADR-016 v1.0 — méthode [BMAD-light](../method/BMAD.md). À passer `Accepted` après sign-off CTO Design.*
