/**
 * Erreur défense-en-profondeur Ticket 3.2 (ajustement CTO #3) — extraite du
 * handler `payment_intent.*` pour éviter un import circulaire au chargement
 * (`transfer-domain` / `refund-domain` ne doivent pas importer tout le module
 * `PaymentDomainHandler`).
 */
export class PaymentDomainLivemodeMismatchError extends Error {
  constructor(
    readonly stripeEventId: string,
    readonly eventLivemode: boolean,
    readonly appEnvIsProduction: boolean,
  ) {
    super(
      `Stripe event ${stripeEventId} livemode=${eventLivemode} ` +
        `mismatches APP_ENV production=${appEnvIsProduction}`,
    )
    this.name = 'PaymentDomainLivemodeMismatchError'
  }
}
