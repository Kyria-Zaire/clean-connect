/**
 * PRD-003 Ticket 3.1 — Provider Stripe SDK.
 *
 * Règles dures :
 * - `apiVersion` PINÉE via `env.STRIPE_API_VERSION` (ADR-011). Aucun `latest`.
 * - `maxNetworkRetries: 0` côté SDK — idempotence + retries gérés via BullMQ + DB
 *   (rule stripe, audit Verify V2).
 * - `appInfo` posé pour traçabilité Stripe Dashboard (`appInfo.name = clean-connect-api`).
 * - JAMAIS de log du secret (rule securite + Pino redactor).
 *
 * **Important** : `webhooks.constructEvent` n'effectue AUCUN appel réseau ; il ne
 * dépend que du secret HMAC + du raw body + du header signature. Le SDK Stripe
 * complet peut donc être instancié même en environnement déconnecté (tests) sans
 * effets de bord — on garde la vraie classe `Stripe` pour bénéficier de leur
 * implémentation HMAC officielle (recommandation Stripe, ne pas réinventer la roue).
 */

import { Injectable, Logger } from '@nestjs/common'
import Stripe from 'stripe'

import { loadEnv } from '../../../common/config/env'

/** Token DI pour `Stripe` — facilite mocks côté tests. */
export const STRIPE_CLIENT_TOKEN = 'STRIPE_CLIENT' as const

/**
 * Factory provider — construit le SDK Stripe une seule fois au boot du module.
 *
 * Décision : on ne fait PAS un wrapper mock même quand `FF_PAYMENTS_ENABLED=false`.
 * Raison : `webhooks.constructEvent` n'a aucun effet réseau (cf. doc Stripe).
 * Tout appel ayant un effet réseau (paymentIntents.create, transfers.create, etc.)
 * sera ajouté aux Tickets 3.2+ et passera par des services dédiés gated par le FF.
 */
@Injectable()
export class StripeClientFactory {
  private readonly logger = new Logger(StripeClientFactory.name)

  build(): Stripe {
    const env = loadEnv()

    // Cast contrôlé : la version pinnée est validée Zod côté `env.ts`
    // (regex `YYYY-MM-DD.codename`). Le type `LatestApiVersion` du SDK
    // change à chaque bump, mais Stripe accepte n'importe quelle version
    // valide ; on documente l'écart éventuel ici plutôt que de désactiver
    // strict mode.
    const apiVersion = env.STRIPE_API_VERSION as Stripe.LatestApiVersion

    const client = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion,
      typescript: true,
      // Anti-piège : on gère idempotence + retries via BullMQ + idempotency-key
      // côté serveur (rule stripe), pas via le SDK.
      maxNetworkRetries: 0,
      appInfo: {
        name: 'clean-connect-api',
        version: env.APP_VERSION,
        url: 'https://cleanconnect.fr',
      },
    })

    this.logger.log(
      `Stripe SDK initialisé — apiVersion=${apiVersion} app=${env.APP_VERSION} env=${env.APP_ENV}`,
    )

    return client
  }
}
