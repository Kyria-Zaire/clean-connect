# ADR-005 — Matching marketplace « premier accepté gagne » (PRD-002)

> **ADR** = *Architecture Decision Record*.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-005` |
| **Titre** | Matching marketplace : diffusion aux prestataires éligibles + premier accepté gagne (sans round-robin MVP) |
| **Statut** | `Accepted` |
| **Date** | `2026-05-12` |
| **Auteur** | CTO Clean Connect + `architecte-api` |
| **PRD lié** | `docs/prd/PRD-002-missions-geolocalisation.md` |
| **Phase BMAD** | `Design` |
| **Pré-revue sécurité** | `docs/security-reviews/2026-05-12-prd-002-missions-design-prereview.md` |

---

## 1. Contexte

- Après publication, la mission doit être **visible** par tous les prestataires **éligibles géographiquement** (PostGIS `ST_DWithin` sur `addresses.location` du prestataire vs mission, rayon `users.service_radius_km`).
- Le MVP **n’implémente pas** de sélection manuelle du prestataire par le client ni de round-robin séquentiel.
- Le risque **concurrence** (deux prestataires acceptent en même temps) est identifié au cahier des charges (§12).

---

## 2. Décision

1. **Modèle « marketplace »** : à l’issue du job `mission.matching`, insérer une ligne `mission_proposals` par prestataire éligible (limite **50** résultats, tri distance croissante).
2. **Transition** : `PUBLISHED` → `PROPOSED` une fois au moins une proposition créée ; si **0** prestataire, la mission peut passer directement à `EXPIRED` après le timeout liste (cf. ADR logique métier Build).
3. **Acceptation** : `POST /missions/:id/accept` — **premier** `UPDATE` transactionnel gagnant avec condition `status = 'PROPOSED' AND prestataire_id IS NULL AND EXISTS (proposal for caller)` ; les autres reçoivent **`409`**.
4. **Pas de lock Redis** en MVP : **lock optimiste base de données** uniquement (décision CTO Discover).
5. **Timeout liste** : **15 minutes** après `published_at` — job BullMQ delayed `mission.listing_expired` → `EXPIRED` si toujours `PROPOSED` sans `prestataire_id`.

---

## 3. Conséquences

- **Positif** : implémentation simple, UX « Uber-like », pas d’état distribué Redis à maintenir.
- **Négatif** : « course » côté prestataires ; charge spike sur `accept` — mitigé par transaction courte + index sur `missions(id, status)`.
- **Dette / V2** : round-robin, réservation « soft hold » 30 minutes, scoring multi-critères (notes) — hors MVP.

---

## 4. Alternatives non retenues

| Alternative | Raison du rejet |
|---|---|
| Round-robin sur le plus proche d’abord | Complexité produit + UX moins claire ; reporté V2. |
| Choix manuel du prestataire par le client | Hors scope Discover validé (marketplace first-accept). |
| Verrou Redis `SETNX` | Coût opérationnel + pas nécessaire si la transaction SQL suffit (CTO). |

---

*ADR-005 v1.0 — PRD-002 Missions & Géolocalisation*
