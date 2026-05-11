# ADR-XXX — <Titre court de la décision>

> **ADR** = *Architecture Decision Record*. Une décision = un fichier. Ne **jamais éditer** une ADR `Accepted` : créer une nouvelle ADR `Supersedes ADR-XXX` à la place.
>
> Conventions :
> - Nommage : `ADR-<n>-<slug-kebab-case>.md`, `<n>` = numéro incrémental (`001`, `002`, …)
> - Format ultra-léger volontairement : si une section ne s'applique pas → `N/A` + justification
> - Cible : lisible en 2 minutes par un nouvel arrivant

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-XXX` |
| **Titre** | `<Titre>` |
| **Statut** | `Proposed` \| `Accepted` \| `Superseded by ADR-YYY` \| `Deprecated` |
| **Date** | `YYYY-MM-DD` |
| **Auteur** | `<nom humain>` |
| **PRD lié** | `docs/prd/<slug>.md` ou `N/A` |
| **Phase BMAD** | `Discover` \| `Design` \| `Build` \| `Verify` |

---

## 1. Contexte

> Quel problème on cherche à résoudre ? Quelles contraintes pèsent dessus ? Quelles forces s'opposent ?
> 5-10 lignes max. Si plus long → le problème n'est pas assez clair, retour à Discover.

---

## 2. Décision

> Ce qu'on choisit, formulé à l'affirmatif et au présent.
> Exemple : « On utilise PostGIS sur la colonne `address.location` (type `GEOGRAPHY(Point, 4326)`) pour le matching prestataires. »

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| `<option A>` | `<raison concise>` |
| `<option B>` | `<raison concise>` |

> Si une seule option a été envisagée → soit la décision est triviale (pas besoin d'ADR), soit l'exploration est insuffisante.

---

## 4. Conséquences

### Positives
- ...

### Négatives / coûts assumés
- ...

### Neutres (à surveiller)
- ...

---

## 5. Suivi

- [ ] Mise à jour de `CLAUDE.md` si nécessaire
- [ ] Mise à jour de la rule concernée (`.cursor/rules/*.mdc` + `.claude/rules/*.md`)
- [ ] Code aligné dans la PR : `#<numéro>`
- [ ] Métriques d'impact instrumentées si applicable

---

## 6. Références

- Lien PRD : `docs/prd/<slug>.md`
- Liens externes (RFC, doc officielle, benchmark) : `<urls>`
- ADRs liées : `ADR-YYY`, `ADR-ZZZ`

---

*Template ADR Clean Connect v1.0 — méthode [BMAD-light](../method/BMAD.md)*
