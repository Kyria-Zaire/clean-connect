# ADR-002 — Tous les montants en centimes (Int)

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-002` |
| **Titre** | Stockage et manipulation de tous les montants monétaires en **centimes** (entiers) |
| **Statut** | `Accepted` |
| **Date** | 2026-05-11 |
| **Auteur** | CTO Clean Connect (validation), Senior Dev (push back technique) |
| **PRD lié** | `N/A` (convention transverse) |
| **Phase BMAD** | `Design` |

---

## 1. Contexte

Clean Connect manipule de l'argent à plusieurs niveaux :

- Prix d'une mission proposée par le client
- Montant total facturé (TVA incluse)
- Commission Clean Connect : **18 % HT**
- Montant transféré au prestataire (séquestre Stripe)
- Refunds, ajustements en cas de litige

L'API Stripe utilise des **entiers représentant la plus petite unité de la devise** (centimes pour EUR). Toute valeur transmise à Stripe est un `Int` (ex : `amount: 19900` = 199,00 €).

Le risque de bugs financiers est élevé si la représentation interne diverge de Stripe :
- Erreurs d'arrondi (commission 18 % de 199,99 € ?)
- Floating point binary (`0.1 + 0.2 = 0.30000000000000004`)
- Double conversion (Decimal Prisma → number JS → centimes Stripe → number JS → Decimal Prisma)

---

## 2. Décision

**Tous les montants monétaires sont stockés et manipulés en centimes (`Int`) end-to-end.**

### Convention de nommage

Le suffixe `Cents` est **obligatoire** sur toute variable, colonne, propriété ou DTO contenant un montant :

```prisma
model Mission {
  amountCents       Int      // ✅ 19900 = 199,00 €
  commissionCents   Int      // ✅
  payoutCents       Int      // ✅ amountCents - commissionCents
}
```

```typescript
export const createMissionSchema = z.object({
  amountCents: z.number().int().positive().max(50_000_00), // ≤ 50 000 €
})

interface PaymentSummary {
  totalCents: number
  commissionCents: number
}
```

### Conversion vers Stripe : aucune
```typescript
// ✅ DIRECT — pas de conversion
const paymentIntent = await stripe.paymentIntents.create({
  amount: mission.amountCents,
  currency: 'eur',
})
```

### Conversion vers UI : centralisée
Un helper unique dans `@cc/shared-types` (ou `@cc/design-tokens` selon ce qui s'avère le plus pratique) :
```typescript
export function formatEUR(cents: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
  }).format(cents / 100)
}
// formatEUR(19900) → "199,00 €"
```

Aucun composant UI ne fait `amount / 100` directement. Toujours passer par le helper.

### Commission : calcul en entiers
```typescript
// ✅ Commission 18 % HT
const COMMISSION_BPS = 1800 // basis points (1 BPS = 0.01 %)
function commissionCents(amountCents: number): number {
  return Math.floor((amountCents * COMMISSION_BPS) / 10_000)
}
// commissionCents(19900) → 3582 = 35,82 €
```

Utilisation de **basis points** (1 BPS = 0,01 %) pour permettre une commission ajustable sans toucher au type. Le `Math.floor` garantit qu'on ne facture jamais plus que ce que Stripe accepte.

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| **`Float` / `Decimal(10,2)` en DB** | Floating point → bugs d'arrondi catastrophiques en finance. Decimal Prisma est mieux mais introduit conversions et perte de cohérence avec Stripe (qui exige Int). |
| **Library `dinero.js` ou `currency.js`** | Surcouche utile sur Float, mais reste une dette quand Stripe attend des Int. Et impose une dépendance supplémentaire pour un problème déjà résolu nativement par `Int`. |
| **`BigInt` JS** | Sur-dimensionné : un montant Clean Connect ne dépassera jamais Number.MAX_SAFE_INTEGER (9 quadrillions). Complexifie les conversions et la sérialisation JSON. |

---

## 4. Conséquences

### Positives
- **Aucune divergence** entre DB et Stripe : un `amountCents` est passé tel quel
- **Calculs exacts** sur les commissions (entiers)
- **Standard industrie** : aligné Stripe, Square, Adyen, etc.
- **Convention claire** : suffixe `Cents` rend toute variable monétaire identifiable au premier coup d'œil
- Un futur passage **multi-devises** est facilité (toujours en plus petite unité de la devise)

### Négatives / coûts assumés
- **Helpers de formatage obligatoires** côté UI (mais centralisés, un seul point de vérité)
- **Discipline d'équipe** : tout dev (humain ou IA) doit utiliser le suffixe `Cents`
- **Aucun coût technique réel** — c'est juste une convention nominale

### Neutres (à surveiller)
- TVA et arrondis fiscaux : à valider avec l'expert comptable (généralement `Math.round` au centime)
- Affichage : le helper `formatEUR` doit gérer FR / EN selon locale future

---

## 5. Suivi

- [x] Inclus dans le schéma Prisma initial — fait Sprint 0.2
- [x] Documenté dans la rule `stripe` — déjà présent
- [ ] Helper `formatEUR` créé dans `@cc/shared-types/money` — à faire dans le premier PRD touchant l'UI
- [ ] Test unitaire `commissionCents` avec edge cases (0, 1, 199999, valeurs négatives → throw) — à inclure dans le premier PRD `payments`

---

## 6. Références

- Stripe — gérer les montants : https://docs.stripe.com/currencies#zero-decimal
- Stack Overflow référence : https://stackoverflow.com/questions/2010102/how-to-store-money-currency-in-a-database
- ADRs liées : ADR-001 (Expo hybride), ADR-003 (PostGIS)

---

*ADR Clean Connect — décidée Sprint 0.2 (11 mai 2026)*
