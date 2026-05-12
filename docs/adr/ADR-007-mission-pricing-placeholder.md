# ADR-007 — Tarification mission : placeholder `estimatedPriceCents` (PRD-002)

> **ADR** = *Architecture Decision Record*.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-007` |
| **Titre** | Prix mission hors périmètre PRD-002 — champ `estimatedPriceCents` optionnel uniquement |
| **Statut** | `Accepted` |
| **Date** | `2026-05-12` |
| **Auteur** | CTO Clean Connect + `architecte-api` |
| **PRD lié** | `docs/prd/PRD-002-missions-geolocalisation.md` |
| **Phase BMAD** | `Design` |
| **Pré-revue sécurité** | `docs/security-reviews/2026-05-12-prd-002-missions-design-prereview.md` |

---

## 1. Contexte

- Le **PRD-003 Paiements / Stripe** doit s’appuyer sur un montant contractuel stable.
- Le **Discover PRD-002** tranche : **pas de tarification fonctionnelle** dans le périmètre Missions MVP — seulement un **placeholder** pour UX / études.

---

## 2. Décision

1. Champ Prisma `missions.estimated_price_cents` : **`Int?`**, strictement **positif** s’il est renseigné (contrainte SQL + Zod).
2. **Aucune** contrainte métier « commission + payout = amount » sur la mission en PRD-002 (les champs `amount_cents` / `commission_cents` / `payout_cents` Sprint 0.2 sont **retirés** du modèle — cf. migration Design).
3. La tarification réelle (barème, frais plateforme, PaymentIntent) sera **redéfinie et implémentée dans PRD-003** ; ADR-002 (montants en centimes) reste la règle comptable pour les montants **de paiement**.

---

## 3. Conséquences

- **Positif** : découplage net PRD-002 / PRD-003 ; pas de faux flux financier dans le MVP géo.
- **Négatif** : migration destructive des anciennes colonnes montant — acceptable **pré-prod** uniquement (cf. migration SQL).

---

## 4. Alternatives non retenues

| Alternative | Raison du rejet |
|---|---|
| Conserver `amount_cents` obligatoire en PRD-002 | Crée une dette produit (prix sans paiement) et bloque les arbitrages PRD-003. |
| Devis prestataire dans PRD-002 | Hors scope Discover validé. |

---

*ADR-007 v1.0 — PRD-002 Missions & Géolocalisation*
