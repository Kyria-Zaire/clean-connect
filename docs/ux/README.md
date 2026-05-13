# UX — documentation produit (Clean Connect)

> **Statut** : préparation **Design 005A** (PRD-005 §12.2 / §12.3 — aucun code `apps/mobile` ni `apps/admin`).
> **PRD** : [PRD-005 — Product Experience](../prd/PRD-005-product-experience.md)

## Index

| Document | Contenu |
|---|---|
| [state-glossary.md](state-glossary.md) | Glossaire back → front (enums Prisma, libellés par rôle, gravité UX) |
| [mission-lifecycle-map.md](mission-lifecycle-map.md) | State machine mission + paiement + transfer + auto-release + RACI |
| [client-user-flows.md](client-user-flows.md) | Flows métier CLIENT (texte) |
| [provider-user-flows.md](provider-user-flows.md) | Flows métier PRESTATAIRE (texte) |
| [admin-operational-flows.md](admin-operational-flows.md) | Flows opérationnels ADMIN (texte) |
| [error-and-edge-cases.md](error-and-edge-cases.md) | Erreurs HTTP, offline, edge cases, mapping codes métier |

**Source de vérité backend** : `apps/api/prisma/schema.prisma`, `apps/api/src/modules/**/*.errors.ts`, `mission-state.machine.ts`.
