## Audit Sécurité — Design PRD-001 Auth JWT (pré-revue avant Build)

**Auditeur** : Reviewer Sécurité (agent + alignement méthode `reviewer-securite-code`)  
**Cible** : `docs/prd/PRD-001-auth-jwt.md`, `docs/adr/ADR-004-auth-tokens-strategy.md`, `packages/shared-types/src/zod/auth.ts`, `apps/api/prisma/schema.prisma` (modèle `RefreshToken` + champs `User`), `apps/api/src/common/config/env.ts`  
**Date** : 2026-05-12  
**Verdict** : **Conditions avant Build** (pas de finding **Critique** bloquant le Design ; le **Build** doit traiter les conditions listées)

**Tag CTO** : validation humaine attendue sur ce document en ~15 min ou équivalent ; les points **Condition** sont les garde-fous à vérifier en revue humaine.

---

### Critique (0 finding)

*Aucun point classé Critique sur le périmètre Design documenté (contrats, schéma DB, stratégie tokens).*

---

### Important (conditions avant merge du Ticket 1.3 Build)

#### I1 — Garde-fou secrets JWT distincts

**Constat** : ADR-004 impose `JWT_ACCESS_SECRET !== JWT_REFRESH_SECRET` ; `env.ts` valide longueur mais **n’interdit pas encore** l’égalité des deux chaînes.

**Mitigation (Build)** : `superRefine` dans `loadEnv()` — crash au boot si égaux.

#### I2 — DTO Nest + pipe Zod sur toutes les routes auth

**Constat** : Les schémas Zod existent dans `@cc/shared-types` ; **aucune route HTTP** ne doit traiter `req.body` brut.

**Mitigation (Build)** : `createZodDto` + `ZodValidationPipe` global ou par route ; pas de contournement.

#### I3 — Rate limits alignés PRD

**Constat** : `signup` **3 req/min/IP** et `login` **10/min** cumul IP **et** email (PRD AC-2.5, Q6).

**Mitigation (Build)** : `@Throttle` dédiés ou clé composite Throttler ; tests d’intégration sur `429`.

#### I4 — Logs et PII

**Constat** : Tokens et mots de passe ne doivent **jamais** apparaître dans Pino.

**Mitigation (Build)** : redactor existant + tests « body de réponse / logs mockés » ; pas de `console.log`.

#### I5 — Transaction refresh

**Constat** : AC-4.5 impose atomicité rotation.

**Mitigation (Build)** : `prisma.$transaction` pour révoquer l’ancien + créer le nouveau + cascade dans le même flux transactionnel quand applicable.

---

### Suggestion (suivi ticket, non bloquant Design)

#### S1 — Blocklist mots de passe

Le fichier `auth-weak-blocklist.ts` est un sous-ensemble ; le PRD mentionne top 10k en évolution — prévoir ticket **TODO(debt)** ou charge utile Build pour liste étendue / import.

#### S2 — Limite nombre de sessions actives

Multi-device autorisé sans plafond MVP — surveiller métrique « nombre de refresh actifs par user » (abus).

---

### Conforme (à conserver en Build)

- Refresh **opaque** + **`token_hash` unique** + `revoked_at` / `expires_at` + FK `onDelete: Cascade`.
- **Révocation cascade** sur reuse de token révoqué (PRD AC-4.3).
- **Logout idempotent** `204` (AC-5.2).
- **Anti-énumération login** `401 INVALID_CREDENTIALS` (AC-2.2).
- **ADMIN** interdit au signup public (AC-1.5).
- Payload JWT **minimal** sans Stripe ni email (AC-6.5, Q9).

---

### Décision de passage Design → Build

| Gate | Statut |
|---|---|
| PRD §4 Design complété | ✅ (soumis avec cette livraison) |
| ADR-004 | ✅ `Accepted` |
| Pré-revue reviewer | ✅ **Conditions** — Build interdit sans traiter I1–I5 |
| Validation humaine CTO Design §4.9 | **En attente** |

---

*Pré-revue Design — PRD-001 — Clean Connect.*
