# ADR-012 — Email provider : Resend (+ mock en dev)

> **ADR** = *Architecture Decision Record*.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-012` |
| **Titre** | Email transactionnel Clean Connect — Resend (vs SendGrid / Postmark) + mock dev |
| **Statut** | `Accepted` |
| **Date** | `2026-05-12` |
| **Auteur** | CTO Clean Connect + `architecte-api` + `senior-dev` |
| **PRD lié** | `docs/prd/PRD-003-photos-paiements.md` |
| **Phase BMAD** | `Design` |

---

## 1. Contexte

PRD-003 décision CTO Q9 + Q10 (Discover sign-off 2026-05-12) :
- **Notifications email transactionnelles MVP** : rappels auto-release T+24h/T+36h/T+47h ouvrées, reçus paiement (en complément du reçu Stripe natif), confirmations de mission, alertes admin sur DLQ.
- Volume attendu MVP : ~500 emails/jour à 5 000 emails/jour sous 6 mois.
- Templates : 5-10 templates transactionnels (mission validée, mission rappel, mission auto-released, paiement échoué, …).

**Providers candidats** :
- **Resend** ([resend.com](https://resend.com)) : DX moderne (React Email), API simple, audit logs, tarif compétitif jusqu'à 100 K mails/mois.
- **Postmark** : leader historique transactionnel, fiabilité maximale, mais DX templates moins moderne (Mustache-based).
- **SendGrid** : leader marché, gourmand côté config, retours mitigés sur la délivrabilité depuis le rachat Twilio.
- **AWS SES** : moins cher mais nécessite warm-up domaine + configuration complexe (gestion bounces). DX médiocre.

---

## 2. Décision

### 2.1 Provider retenu : **Resend**

Raisons :
- **DX excellente** : React Email natif (`@react-email/components` + `react-email render`). Templates écrits en TSX, type-safe, preview navigateur en dev.
- **Setup rapide** : ajout d'un domaine + DNS (DKIM, SPF, DMARC) en < 30 min. Délivrabilité bonne dès J+1.
- **Tarif** : 100 emails/jour gratuit, 50 $/mois pour 50 K emails, prévisible.
- **Audit logs** : dashboard intégré, retention 30 jours, statuts (delivered, bounced, complained).
- **Webhook events** : `email.delivered`, `email.bounced`, `email.complained`, etc. — utilisables pour suppression liste.
- **SDK officiel Node** : `resend` npm package, types TS first-class.

### 2.2 Architecture module `notifications/email`

```typescript
// apps/api/src/modules/notifications/email/email.client.ts
import { Resend } from 'resend'
import { env } from '../../common/config/env'

export const resend = env.NODE_ENV === 'development'
  ? createMockResend()
  : new Resend(env.RESEND_API_KEY)
```

```typescript
// apps/api/src/modules/notifications/email/email.service.ts
@Injectable()
export class EmailService {
  async send(template: EmailTemplate, vars: Record<string, unknown>) {
    const html = await renderTemplate(template, vars) // React Email render
    const { id, error } = await resend.emails.send({
      from: env.EMAIL_FROM, // 'noreply@cleanconnect.fr'
      to: vars.recipientEmail as string,
      subject: vars.subject as string,
      html,
      headers: { 'X-Clean-Connect-Template': template },
    })
    if (error) {
      logger.error({ template, error }, 'email.send.failed')
      throw new EmailSendError(template, error)
    }
    logger.info({ template, emailId: id }, 'email.send.success')
    return id
  }
}
```

### 2.3 Mock Resend en dev

En `NODE_ENV=development`, on remplace le client Resend par un mock local qui :
1. Render le template HTML.
2. Sauvegarde le HTML dans `apps/api/tmp/emails/{timestamp}-{template}.html`.
3. Log l'envoi via Pino (`email.dev.captured`).
4. Renvoie un `{ id: 'dev-mock-' + uuid }`.

```typescript
function createMockResend(): { emails: { send: (params: any) => Promise<{ id: string; error: null }> } } {
  return {
    emails: {
      send: async (params) => {
        const id = `dev-mock-${randomUUID()}`
        const filename = `${Date.now()}-${params.headers?.['X-Clean-Connect-Template'] ?? 'unknown'}.html`
        const filepath = path.join(process.cwd(), 'tmp', 'emails', filename)
        await fs.mkdir(path.dirname(filepath), { recursive: true })
        await fs.writeFile(filepath, params.html, 'utf-8')
        logger.info({ id, filepath, template: params.headers?.['X-Clean-Connect-Template'] }, 'email.dev.captured')
        return { id, error: null }
      },
    },
  }
}
```

**Justification mock** :
- Pas de quota Resend gaspillé en dev / CI.
- Aperçu HTML facile via le navigateur (chemin `tmp/emails/...`).
- Tests d'intégration peuvent valider le rendu sans appel réseau.

### 2.4 Templates React Email

Structure :

```
apps/api/src/modules/notifications/email/templates/
├── _layout.tsx                # Header + footer commun
├── mission-validated.tsx
├── mission-auto-release-reminder-24h.tsx
├── mission-auto-release-reminder-36h.tsx
├── mission-auto-release-reminder-47h.tsx
├── mission-auto-released.tsx
├── payment-failed.tsx
├── admin-dlq-alert.tsx
└── render.ts                  # `renderTemplate(name, vars)` → string HTML
```

Chaque template :
- Hérite de `_layout.tsx` (header logo Clean Connect, footer mentions légales).
- Props typées : `{ recipientName, missionId, missionTitle, ... }`.
- Preview script local : `pnpm --filter @cc/api email:preview`.

### 2.5 Webhooks Resend (optionnel MVP)

`POST /v1/webhooks/resend` (à implémenter en Build optionnel post-MVP) :
- Listen events `email.bounced`, `email.complained` → flag `User.emailUndeliverable = true`.
- Signature webhook Resend (HMAC SHA-256) vérifiée avant traitement.

**Pas obligatoire MVP** : Resend dashboard donne déjà visibilité, on peut différer le webhook à PRD-004 (notifications complètes).

### 2.6 Variables d'environnement

| Variable | Validation Zod | Exemple |
|---|---|---|
| `RESEND_API_KEY` | `z.string().startsWith('re_').min(20)` en prod, optionnel en dev | `re_xxxxxxxxxxxxxxx` |
| `EMAIL_FROM` | `z.string().email()` | `noreply@cleanconnect.fr` |
| `EMAIL_FROM_NAME` | `z.string().min(1).max(80)` | `Clean Connect` |
| `EMAIL_REPLY_TO` | `z.string().email()` | `support@cleanconnect.fr` |

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| **Postmark** | Excellente fiabilité mais DX templates Mustache-based, moins agréable que React Email. Plus cher (~80 $/mois équivalent). Reste éligible si Resend ne tient pas la charge (révision PRD-004). |
| **SendGrid** | Config UI complexe, retours mitigés délivrabilité depuis rachat Twilio, alertes sécu fréquentes (clés exposées sur GitHub). |
| **AWS SES** | Warm-up domaine fastidieux, dashboard SES médiocre, gestion bounces / complaints custom. Hors scope MVP. |
| **SMTP générique (Mailgun / Postfix self-hosted)** | Délivrabilité aléatoire sans warm-up + IP reputation à gérer. Hors scope MVP. |

---

## 4. Conséquences

### Positives

- **DX rapide** : templates en TSX, preview local, type-safe.
- **Setup MVP** : opérationnel en quelques heures.
- **Coût prévisible** : tier gratuit + 50 $/mois pour 50 K mails.
- **Délivrabilité** : Resend a un bon track record (DKIM/SPF/DMARC config simple).

### Négatives / coûts assumés

- **Vendor lock-in léger** : l'abstraction `EmailService.send()` permet de switcher vers Postmark/SES si besoin. Templates React Email restent portables (juste le client SDK à changer).
- **Pas de SLA garanti MVP** : Resend est jeune (créé 2023). Reste éligible Postmark plan B si problème délivrabilité.

### Neutres (à surveiller)

- **Volume** : monitoring `email.send.count` + Resend dashboard. Alerte si > 80 % du quota tier.
- **Bounces / complaints** : à intégrer en PRD-004 via webhook Resend.

---

## 5. Suivi

- [x] PRD §3.4 Q10 + ADRs §4.
- [x] Décision documentée pour règle Cursor future `notifications.mdc` (à créer en Build).
- [ ] **Build** : module `notifications/email` + templates React Email + mock dev + env Zod.
- [ ] **Build** : tests d'intégration capture mock email + vérif HTML contient `missionId`.
- [ ] **Verify** : smoke test recette envoie un email réel à `support+test@cleanconnect.fr`.

---

## 6. Références

- PRD : [`docs/prd/PRD-003-photos-paiements.md`](../prd/PRD-003-photos-paiements.md) §3.4 Q9/Q10.
- Resend docs : [resend.com/docs](https://resend.com/docs), [@react-email/components](https://react.email/docs).
- ADRs liées : [ADR-013 Notifications push + email MVP](ADR-013-notifications-push-email-mvp.md).

---

*ADR-012 v1.0 — PRD-003 Photos & Paiements — Sprint 3 Design.*
