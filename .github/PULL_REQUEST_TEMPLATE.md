<!--
Clean Connect — Template Pull Request
Méthode BMAD-light : docs/method/BMAD.md
-->

## Lien PRD

**PRD piloté** : `docs/prd/PRD-XXX-<slug>.md`
**Phase BMAD à l'ouverture de cette PR** : `Build` ou `Verify`

> Si tu ne peux pas lier un PRD, **stop** : retour en Discover.
> Exception : `chore/` pur infra/outillage sans impact fonctionnel.

---

## Résumé

<!-- 3-5 lignes max. Le "pourquoi" prime sur le "comment". -->

## Changements clés

- [ ] ...
- [ ] ...

## Definition of Done — Build (cf. BMAD §5)

- [ ] CI verte (typecheck + lint + tests + build Docker)
- [ ] Coverage ≥ 80 % sur services Payment/Escrow/Auth · ≥ 60 % ailleurs
- [ ] Zéro `any`, `console.log`, secret en clair, `JSON.parse(llmResponse)` sans Zod
- [ ] Logger structuré utilisé partout, redactor PII actif
- [ ] OpenAPI à jour si nouvelle route API
- [ ] Tous les critères d'acceptance du PRD ✅
- [ ] PR self-reviewed avec checklist
- [ ] TODO(debt) introduits sont listés dans le PRD §5.4 avec ticket de suivi

## Verify (si applicable)

- [ ] Rapport sécu `reviewer-securite-code` joint (`docs/security-reviews/...`)
- [ ] 0 Critical / 0 Important non traité
- [ ] Manual QA OK sur recette
- [ ] Smoke test paiement OK si applicable (cartes Stripe test)
- [ ] Plan de rollback validé

## Captures (mobile / admin si UI)

<!-- Glisser-déposer les captures avant/après -->

## Risques & impact

- **Sécurité** : ...
- **RGPD** : ...
- **Performance** : ...
- **Rollout** : feature flag ? migration data ? ordre de déploiement ?

## Checklist reviewer

- [ ] Le code respecte la rule pertinente (`.cursor/rules/...` ou `.claude/rules/...`)
- [ ] Pas de déviation du Design figé dans le PRD
- [ ] Pas de SQL brut sans justification commentée (cf. ADR-003 pour PostGIS)
- [ ] Pas de montant manipulé hors centimes (cf. ADR-002)
