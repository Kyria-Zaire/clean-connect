# BMAD-light — règle transverse Clean Connect

**Source de vérité complète** : `docs/method/BMAD.md`
**Template PRD** : `docs/templates/PRD-template.md`
**Cahier des charges** : `docs/CAHIER-DES-CHARGES-v1.4.md`

---

## Posture obligatoire

> **Tout travail sur Clean Connect suit la méthode BMAD-light.**
> 4 phases : **Discover → Design → Build → Verify**.
> Chaque phase a une Definition of Done (DoD) figée et une validation humaine explicite.

Avant d'écrire la moindre ligne de code, tu dois pouvoir répondre à :
1. **Quel PRD pilote ce travail ?** (chemin `docs/prd/<slug>.md`)
2. **Dans quelle phase BMAD on est ?** (Discover / Design / Build / Verify)
3. **Quel persona pilote cette phase ?** (cf. matrice ci-dessous)

Si tu ne peux pas répondre → tu **arrêtes** et tu réclames le PRD avant de coder.

---

## Phases en une ligne

| Phase | Objectif | Output obligatoire | Pilote |
|---|---|---|---|
| **Discover** | Cadrer le besoin, scorer les risques | PRD rempli §1 à §3 + DoD §3.4 ✅ | `senior-dev` + humain |
| **Design** | Figer les contrats (DB, Zod, API, UI) | PRD rempli §4 + DoD §4.9 ✅ + ADR si besoin | `architecte-api` / `seniordev-frontend` / `ingenieur` |
| **Build** | Implémenter conforme aux contrats | PR mergeable + DoD §5.6 ✅ + tests verts | persona spécialisé du scope |
| **Verify** | Auditer sécu/RGPD/perf + QA | Rapport sécu + DoD §6.8 ✅ + sign-off humain | `reviewer-securite-code` + humain |

---

## Règles dures (non négociables)

1. **Pas de code sans PRD validé en Discover.**
2. **Pas de Build sans Design validé** (contrats Zod + Prisma + API figés).
3. **Pas de merge sans Verify** (rapport `reviewer-securite-code` = 0 Critical / 0 Important non traité).
4. **Toute déviation du Design pendant Build → retour en Design**, pas un fix sauvage.
5. **Tout raccourci pris pendant Build → `TODO(debt):` + ticket de suivi** dans §5.4 du PRD. Jamais silencieux.
6. **Hotfix prod = BMAD compressé, pas BMAD skippé.** La phase Verify reste obligatoire.

---

## Matrice persona × phase (résumé)

|                          | Discover | Design | Build | Verify |
|--------------------------|:-:|:-:|:-:|:-:|
| `senior-dev`             | pilote | actif | actif | actif |
| `architecte-api`         | — | pilote BE | actif BE | — |
| `seniordev-frontend`     | — | pilote FE | actif FE | — |
| `mobile`                 | — | mobile | mobile | — |
| `ingenieur`              | — | cross | infra | — |
| `securite` + `stripe` + `photos-rgpd` | si concerné | si concerné | si concerné | si concerné |
| `reviewer-securite-code` | — | pré-revue si risque ≥ 4 | — | **pilote audit** |
| `createur-workflow`      | — | — | si CI/Docker | si déploiement |

Détails complets dans `docs/method/BMAD.md` §6.

---

## Format de réponse attendu de l'IA

Quand un humain demande un travail sur Clean Connect, l'IA répond en suivant ce gabarit :

```
[BMAD] Phase identifiée : <Discover|Design|Build|Verify>
[BMAD] PRD : <chemin ou "à créer">
[BMAD] Persona pilote : <rule>
[BMAD] DoD à atteindre : <bullets>

<réponse technique>

[BMAD] Prochaine action attendue : <ce que l'humain doit valider>
```

Cette en-tête est **optionnelle** pour les questions hors-scope code (chat libre, brainstorming), **obligatoire** dès qu'on touche au code ou aux contrats.

---

## Anti-patterns IA (interdits)

- Coder sans demander le PRD ou le créer
- Modifier `schema.prisma` sans avoir validé en Design
- Ouvrir une PR sans lien vers le PRD
- Répondre "c'est bon ça marche" sans le rapport `reviewer-securite-code` en Verify
- Skipper la phase Verify pour un hotfix

---

*Règle BMAD-light v1.0 — voir `docs/method/BMAD.md` pour le détail complet*
