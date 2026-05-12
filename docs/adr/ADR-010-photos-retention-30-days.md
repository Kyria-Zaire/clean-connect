# ADR-010 — Photos : rétention 30 jours + purge cron + `PhotoDeletionLog` + suppression réelle Cloudinary

> **ADR** = *Architecture Decision Record*.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-010` |
| **Titre** | Politique de rétention photos AVANT/APRÈS — 30 jours post-mission + purge cron + audit `PhotoDeletionLog` + suppression réelle Cloudinary |
| **Statut** | `Accepted` |
| **Date** | `2026-05-12` |
| **Auteur** | CTO Clean Connect + `photos-rgpd` + `architecte-api` |
| **PRD lié** | `docs/prd/PRD-003-photos-paiements.md` |
| **Phase BMAD** | `Design` |
| **Pré-revue sécurité** | `docs/security-reviews/2026-05-12-prd-003-design-prereview.md` |
| **Supersede** | Mention "12 mois" dans `.cursor/rules/photos-rgpd.mdc` legacy (mise à jour effectuée). |

---

## 1. Contexte

PRD-003 introduit un système de preuves photos AVANT/APRÈS. Ces photos sont une **donnée personnelle RGPD** au sens du règlement (intérieur de domicile = lieu de vie). Décision CTO Q2/D3 (Discover sign-off 2026-05-12) :

- Rétention par défaut : **30 jours post `mission.completedAt`**.
- Exceptions : litige actif (`DISPUTE_OPEN`), fraude (`flagSuspicious=true` + escalation admin), obligation légale (`LEGAL_HOLD`).
- Cron quotidien de purge à 03h00 Europe/Paris.
- **Suppression réelle Cloudinary** (pas seulement tombstone DB).
- **Audit `PhotoDeletionLog`** systématique (qui, quand, pourquoi, succès/échec).

Cette politique remplace la mention "12 mois après fin de mission" du fichier `.cursor/rules/photos-rgpd.mdc` (rule legacy). La règle est mise à jour en conséquence.

---

## 2. Décision

### 2.1 Durée de rétention

| Cas | Rétention | Trigger |
|---|---|---|
| Mission `COMPLETED` standard | **30 jours post `completedAt`** | Cron `photos.purge` quotidien 03h Europe/Paris. |
| Mission `DISPUTE_OPEN` actif | **Sans limite** tant que dispute ouverte | Cron skip si `mission.disputeOpenedAt IS NOT NULL AND disputeResolvedAt IS NULL`. |
| Dispute résolu | 30 jours post `disputeResolvedAt` | Cron applique délai à partir de la résolution. |
| `flagSuspicious=true` (fraude soft) | 90 jours (audit interne) | `PhotoDeletionLog.reason = 'FRAUD_INVESTIGATION'`. |
| `LEGAL_HOLD` (obligation judiciaire) | **Sans limite** | Drapeau admin manuel. Cron skip. `PhotoDeletionLog.reason = 'LEGAL_HOLD'` à la levée. |
| Compte utilisateur supprimé (RGPD `DELETE /users/me`) | 30 jours post `user.deletedAt` (anonymisation immédiate) | Cron `user.purge` (PRD-001 + extension). |

**`defaultRetentionDays = 30`** : valeur exposée via env var `PHOTO_RETENTION_DAYS` (validée Zod 1..3650 au boot). Permet ajustement preprod/recette.

### 2.2 Cron `photos.purge` — déroulé déterministe

**Fréquence** : `0 3 * * *` (03h Europe/Paris quotidien).
**Worker** : BullMQ `photos-purge.processor.ts`. **Idempotence** : `batchId = sha256('photos-purge-' + yyyyMMdd)`.

```typescript
@Cron('0 3 * * *', { timeZone: 'Europe/Paris' })
async purgeExpiredPhotos() {
  const cutoff = subDays(new Date(), env.PHOTO_RETENTION_DAYS) // 30 j par défaut
  const batchId = `photos-purge-${format(new Date(), 'yyyyMMdd')}`

  // 1. SELECT photos eligibles (paginées 500)
  const photos = await this.prisma.photo.findMany({
    where: {
      deletedAt: null,
      cloudinaryPublicId: { not: null },
      mission: {
        completedAt: { lt: cutoff },
        disputeOpenedAt: null, // skip si dispute actif
        OR: [{ legalHoldAt: null }],
      },
    },
    take: 500,
  })

  // 2. Pour chaque photo : delete Cloudinary + tombstone DB + PhotoDeletionLog
  for (const photo of photos) {
    try {
      await cloudinary.uploader.destroy(photo.cloudinaryPublicId!, { type: 'private', invalidate: true })
    } catch (err: any) {
      // 404 Cloudinary (asset déjà supprimé) : on poursuit, on log
      if (err?.http_code !== 404) {
        await this.recordDeletionLog(photo, batchId, false, err.message)
        continue
      }
    }

    await this.prisma.$transaction([
      this.prisma.photo.update({
        where: { id: photo.id },
        data: {
          deletedAt: new Date(),
          // tombstone : on **garde** la ligne pour audit (cloudinaryPublicId mis à null pour cohérence)
          cloudinaryPublicId: null,
        },
      }),
      this.prisma.photoDeletionLog.create({
        data: {
          photoId: photo.id,
          missionId: photo.missionId,
          reason: 'RETENTION_POLICY',
          performedBy: 'SYSTEM',
          batchId,
          metadata: { previousPublicId: photo.cloudinaryPublicId },
        },
      }),
    ])
  }

  logger.info({ batchId, count: photos.length }, 'photos.purge.completed')
}
```

### 2.3 Suppression réelle Cloudinary (revue CTO)

- `cloudinary.uploader.destroy(publicId, { type: 'private', invalidate: true })` : suppression **physique** de l'asset + invalidation CDN.
- **Tolérance 404** : si l'asset Cloudinary n'existe déjà plus (déjà supprimé manuellement ou par batch précédent partiellement échoué), on poursuit + log explicite.
- **Échec non-404** (timeout, 5xx Cloudinary) : `PhotoDeletionLog { success: false, errorMessage }`. Retry au prochain run du cron. Pas de tombstone DB tant que la suppression Cloudinary n'a pas réussi.

### 2.4 `PhotoDeletionLog` — audit obligatoire

Modèle Prisma (déjà présent dans le schéma) :

```prisma
model PhotoDeletionLog {
  id          String              @id @default(uuid())
  photoId     String
  photo       Photo               @relation(...)
  missionId   String
  mission     Mission             @relation(...)
  reason      PhotoDeletionReason   // RETENTION_POLICY | LEGAL_HOLD | FRAUD_INVESTIGATION | ADMIN_ACTION
  performedBy PhotoDeletionActor    // SYSTEM | ADMIN (jamais CLIENT ni PRESTATAIRE)
  batchId     String?               // sha256 du batch (idempotence) — VARCHAR(64)
  metadata    Json?                 // { previousPublicId, errorMessage?, ... }
  createdAt   DateTime              @default(now())
}
```

- **Chaque tentative** (succès **ou** échec) est tracée. Une photo peut avoir N `PhotoDeletionLog` (1 par retry).
- `batchId` permet l'**idempotence inter-runs** (relancer le même batch deux fois ne crée pas deux logs identiques).

### 2.5 Anti suppression manuelle (D12 + revue CTO)

- **Aucune route HTTP** ne permet à un CLIENT ou PRESTATAIRE de supprimer une photo. Tentative → `403 PHOTO_DELETE_FORBIDDEN_RETENTION`.
- **ADMIN seulement** peut déclencher une suppression hors-cycle via `POST /v1/admin/photos/{id}/delete` (route admin, x-rbac ADMIN, audit `performedBy: 'ADMIN'`, `reason: 'ADMIN_ACTION'`).
- Le cron purge est marqué `performedBy: 'SYSTEM'`.

### 2.6 Mise à jour rule `.cursor/rules/photos-rgpd.mdc`

La mention "12 mois" est **remplacée** par "30 jours par défaut, configurable via `PHOTO_RETENTION_DAYS`". Description, header `description`, et section `## RGPD — Rétention` mis à jour. Voir cette ADR comme source de vérité ; la rule reflète.

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| **Rétention 12 mois** (rule legacy) | Excessive RGPD — pas justifié au regard du besoin métier (litige < 60 j typique). Risque RGPD si fuite. |
| **Rétention 7 jours** | Trop court — un client peut contester / réclamer dans les 14 j post-mission (cf. PRD-005 dispute window). Manque de preuve. |
| **Tombstone DB sans suppression Cloudinary** (rule legacy version) | RGPD : la donnée reste en clair sur Cloudinary. Inacceptable. Suppression physique obligatoire. |
| **Suppression DB hard (`DELETE FROM photos`)** | Perte de l'audit (qui a uploadé, quand, taille, checksums). Conservation tombstone obligatoire. |
| **Cron toutes les heures** | Charge inutile sur Cloudinary API. 1× / jour à 03h Europe/Paris suffit (peu de trafic, batch idempotent). |

---

## 4. Conséquences

### Positives

- **Conformité RGPD** : suppression effective sous 30 j post-mission. Audit traçable (`PhotoDeletionLog`).
- **Coût Cloudinary maîtrisé** : purge active, pas d'accumulation d'assets.
- **Litige protégé** : skip cron si `disputeOpenedAt`, conservation tant que litige actif.
- **Reprise automatique** : retry au prochain cron en cas d'échec Cloudinary (timeout, 5xx).

### Négatives / coûts assumés

- **Dépendance Cloudinary** : si l'API Cloudinary est down pendant > 24 h, la purge est différée. Acceptable (pas de risque RGPD critique sur quelques jours, alerting ops).
- **Cron monolithique** : une seule fenêtre 03h Europe/Paris. Si beaucoup de photos à purger (back-fill initial post-MVP), latence cron > 1 h possible. Mitigation : pagination 500 + reprise au prochain run.

### Neutres (à surveiller)

- **Métriques** : `photos.purge.deleted_count`, `photos.purge.failed_count`, `photos.purge.duration_ms`. Alerte si `failed_count > 50` sur un run.

---

## 5. Suivi

- [x] PRD §2.3 AC-C.10 + AC-C.9 (anti suppression manuelle) + §3.4 D3 + Q2.
- [x] Schéma Prisma `Photo.deletedAt` + `PhotoDeletionLog` + enums `PhotoDeletionReason` / `PhotoDeletionActor`.
- [x] OpenAPI : pas de route DELETE publique (uniquement admin POST `/v1/admin/photos/{id}/delete` — à ajouter en Build).
- [x] Mise à jour `.cursor/rules/photos-rgpd.mdc` (12 mois → 30 jours).
- [ ] **Build** : `PhotosPurgeProcessor` + cron `0 3 * * *` + tolérance 404 + `PhotoDeletionLog` + métriques Pino.
- [ ] **Verify** : test L (RGPD `DELETE /users/me` purge photos à T+30 j) + test cron skip dispute + test tolérance 404.
- [ ] Env var : `PHOTO_RETENTION_DAYS` validée Zod (1..3650, défaut 30).

---

## 6. Références

- PRD : [`docs/prd/PRD-003-photos-paiements.md`](../prd/PRD-003-photos-paiements.md) §2.3 + §3.4 D3.
- Cahier des charges v1.4 : §6.5 (RGPD).
- RGPD : [Article 5.1.e](https://www.cnil.fr/fr/reglement-europeen-protection-donnees/chapitre1#Article5) (limitation conservation).
- Cloudinary docs : [Destroy asset](https://cloudinary.com/documentation/admin_api#delete_resources), [CDN invalidation](https://cloudinary.com/documentation/managing_assets#invalidating_cached_media).
- ADRs liées : [ADR-009 Cloudinary signed upload](ADR-009-cloudinary-signed-upload-dual-variant.md).

---

*ADR-010 v1.0 — PRD-003 Photos & Paiements — Sprint 3 Design.*
