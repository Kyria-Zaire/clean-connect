# ADR-006 — Géocodage BAN + repli coordonnées natives mobile (PRD-002)

> **ADR** = *Architecture Decision Record*.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-006` |
| **Titre** | Géocodage adresse : Base Adresse Nationale (BAN) côté API, repli localisation native mobile |
| **Statut** | `Accepted` |
| **Date** | `2026-05-12` |
| **Auteur** | CTO Clean Connect + `architecte-api` |
| **PRD lié** | `docs/prd/PRD-002-missions-geolocalisation.md` |
| **Phase BMAD** | `Design` |
| **Pré-revue sécurité** | `docs/security-reviews/2026-05-12-prd-002-missions-design-prereview.md` |

---

## 1. Contexte

- Chaque mission référence une ligne `addresses` avec `location geography(Point,4326)` (cf. ADR-003) pour le **matching PostGIS**.
- Il faut une source **fiable** pour transformer rue + CP + ville → coordonnées, sans dépendre d’une clé Google en MVP.
- Le mobile peut obtenir des coordonnées **GPS natives** (permission utilisateur) en secours si l’API BAN échoue.

---

## 2. Décision

1. **Provider principal** : **API BAN** (`api-adresse.data.gouv.fr`) pour la géolocalisation côté serveur lors de la création / mise à jour d’adresse métier.
2. **Pattern d’intégration** : skill `integrate-external-service` — **timeout court**, **retry borné**, **logs structurés sans PII** (pas d’adresse complète en clair dans les logs — utiliser hash ou tronqué).
3. **Repli mobile** : si le client envoie `address.location` déjà renseigné avec une précision acceptable (Zod `geoPointSchema`), l’API **valide** (FR, cohérence CP/ville soft) et **persiste** sans rappel BAN obligatoire ; sinon tentative BAN.
4. **Géolocalisation métier** : toute distance / filtre « dans le rayon » utilise **exclusivement PostGIS** (`ST_DWithin`, `ST_Distance` en `geography`) — pas de Haversine applicatif pour les décisions métier (uniquement affichage « distance approx » masquée si besoin, cf. politique d’adresse).
5. **Erreurs** : échec BAN + absence coords client → **`422 GEOCODING_FAILED`**.

---

## 3. Conséquences

- **Positif** : pas de facturation clé API ; excellente couverture France ; alignement souveraineté données.
- **Négatif** : dépendance service public — monitoring disponibilité obligatoire en Build.
- **RGPD** : ne pas journaliser l’adresse complète ; tracer `geocoding.provider=ban|client_gps` et codes HTTP.

---

## 4. Alternatives non retenues

| Alternative | Raison du rejet |
|---|---|
| Nominatim seul | Quotas / politique d’usage ; BAN plus adapté au format français MVP. |
| Google Geocoding | Coût + clé secrète à gérer dès le MVP. |
| Géocodage uniquement mobile | Risque d’incohérence serveur (matching) si pas revalidé côté API. |

---

*ADR-006 v1.0 — PRD-002 Missions & Géolocalisation*
