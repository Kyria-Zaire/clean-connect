import { Injectable, type ExecutionContext } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'

/**
 * Wrapper du `ThrottlerGuard` standard qui peut être totalement bypassé via la
 * variable `DISABLE_THROTTLE=true`. Sécurité : `env.ts` interdit cette variable
 * en `NODE_ENV=production` (crash boot). Réservé aux tests d'intégration métier
 * où le rate-limit produit des faux-positifs (PRD-001 Ticket 1.6 Verify).
 *
 * NB : lecture directe de `process.env` plutôt que `loadEnv()` parce que ce
 * dernier cache la valeur au premier appel ; les tests d'intégration ont besoin
 * de toggler dynamiquement (auth-flow bypass vs auth-rate-limit actif) au sein
 * d'un même run Jest. La validation Zod prod garde le crash-boot en filet.
 */
@Injectable()
export class ConditionalThrottlerGuard extends ThrottlerGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (process.env['DISABLE_THROTTLE'] === 'true') {
      return true
    }
    return super.canActivate(context)
  }
}
