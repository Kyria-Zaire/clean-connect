/**
 * PRD-004 Ticket 4.5 Build itération 2 — Contrat `InvariantDescriptor`.
 *
 * Source de vérité : PRD-004 §4.15.16 + ADR-018 §3 + conseil CTO Build :
 *  > "Chaque invariant : autonome, testable, documenté, observable, retourne
 *  >  mismatchCode + severity + explanation + remediationHint."
 *
 * Mécanique :
 *  - Chaque fichier `invariants/fin-i-XXX-*.ts` exporte UN `InvariantDescriptor`.
 *  - Tous les descriptors sont enregistrés dans `invariants/registry.ts`.
 *  - `FinanceReconcileService` / `FinanceStuckFundsService` /
 *    `FinanceInvariantsService` consomment le registry et appliquent uniquement
 *    les invariants pertinents pour leur scope (`scope: 'reconcile' | 'stuck' | 'daily'`).
 *
 * Règle dure : un invariant ne fait QUE détecter. Il ne mute jamais Stripe ni la
 * DB. Toute écriture passe par `FinanceReconcileService.persistResults(...)`.
 */

import type {
  FinanceMismatchType,
  FinanceResourceKind,
  Payment,
  Refund,
  Transfer,
} from '@prisma/client'
import type Stripe from 'stripe'

import type { FinanceInvariantCode , FinanceSeverity } from '../finance.constants'


/**
 * Scope opérationnel d'un invariant. Un même invariant ne peut appartenir
 * qu'à un seul scope (déterministe).
 *  - `reconcile` : appliqué pendant le scheduler reconcile (07:30 EU/Paris).
 *  - `stuck`     : appliqué pendant le scheduler stuck-funds (toutes les heures).
 *  - `daily`     : appliqué pendant le scheduler daily-report / invariants J-1.
 */
export type InvariantScope = 'reconcile' | 'stuck' | 'daily'

/** Données DB nécessaires à un invariant `reconcile` sur un Payment. */
export interface PaymentInvariantInput {
  payment: Payment
  transfer: Transfer | null
  refunds: readonly Refund[]
  stripe: {
    paymentIntent: Stripe.PaymentIntent | null
    transfer: Stripe.Transfer | null
    refunds: readonly Stripe.Refund[]
  }
}

/** Données nécessaires aux invariants `stuck` (par ressource — Payment OU Transfer). */
export type StuckInvariantInput =
  | {
      kind: 'PAYMENT'
      payment: Payment
      transfer: Transfer | null
      refunds: readonly Refund[]
      missionStatus: string | null
    }
  | {
      kind: 'TRANSFER'
      transfer: Transfer
      payment: Payment | null
      missionStatus: string | null
    }

/** Données nécessaires à l'invariant journalier (`FIN-J-001`). */
export interface DailyInvariantInput {
  reportDate: Date
  capturedSumCents: number
  transferSentSumCents: number
  refundedSumCents: number
  applicationFeeSumCents: number
}

/** Contexte commun (pour le `now()` injectable côté tests + tolérance). */
export interface InvariantClock {
  now(): Date
}

/**
 * Résultat normalisé d'une exécution d'invariant. Tous les champs sont
 * strictement bornés (pas de PII, pas de stripeId complet).
 */
export interface InvariantBreak {
  /** Code déterministe versionné (`FIN-I-001`, `FIN-J-001`, ...). */
  mismatchCode: FinanceInvariantCode
  /** Type Prometheus historique (cf. `FinanceMetricsTracker.recordMismatch`). */
  mismatchType: FinanceMismatchType
  /** Ressource concernée (UUID DB tel quel — déjà dans la whitelist). */
  resourceKind: FinanceResourceKind
  resourceId: string
  severity: FinanceSeverity
  /** Explication factuelle, sans PII. Affichée dans `/admin/finance/mismatches/:id`. */
  explanation: string
  /** Conseil ops pour la remédiation. Pas d'instruction destructive automatique. */
  remediationHint: string
  /** Delta cents si pertinent (mismatch montant). */
  amountDeltaCents?: number
  /** Snapshot DB pré-sanitisé (whitelist appliquée par l'invariant). */
  dbSnapshot: Record<string, unknown>
  /** Snapshot Stripe pré-sanitisé. `null` si l'invariant n'utilise pas Stripe. */
  stripeSnapshot?: Record<string, unknown> | null
}

/**
 * Descriptor d'un invariant. Un seul export par fichier.
 * Le `apply` fonction est PURE (pas de DB ni de réseau).
 *
 * `clock` est optionnel : la plupart des invariants reconcile/daily n'en ont
 * pas besoin (purement structurels). Les invariants stuck (FIN-I-009/010/011)
 * l'utilisent pour calculer l'âge des ressources de manière injectable
 * (déterministe en tests).
 */
export interface InvariantDescriptor<TInput> {
  readonly code: FinanceInvariantCode
  readonly scope: InvariantScope
  readonly description: string
  readonly defaultSeverity: FinanceSeverity
  /** Renvoie `null` si l'invariant tient ; `InvariantBreak` si rompu. */
  apply(input: TInput, clock?: InvariantClock): InvariantBreak | null
}

/** Type union des descriptors selon le scope (utilisé par le registry). */
export type ReconcileInvariant = InvariantDescriptor<PaymentInvariantInput>
export type StuckInvariant = InvariantDescriptor<StuckInvariantInput>
export type DailyInvariant = InvariantDescriptor<DailyInvariantInput>
