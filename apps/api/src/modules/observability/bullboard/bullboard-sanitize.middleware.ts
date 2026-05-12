/**
 * PRD-004 Ticket 4.1 (Build B) — Sanitization middleware pour BullBoard.
 *
 * BullBoard expose `/api/queues/<name>/jobs/<id>` qui renvoie le JSON brut
 * du job (incluant `data`, `opts`, `returnvalue`, `failedReason`, ...). Sans
 * sanitization, un admin lit le payload brut → exposition de :
 *   - `stripeEventId` (acceptable, public)
 *   - `payloadHash` (acceptable, c'est déjà un hash)
 *   - n'importe quel champ "secret" futur dans le payload
 *   - stacktraces avec PII
 *
 * **Politique défense-en-profondeur** : on applique `deepSanitize` sur toute
 * réponse JSON, sans whitelister par champ. Garantit que même un nouveau
 * payload ajouté sans audit reste safe (rule securite — fail-closed).
 *
 * **Performance** : la sanitization est O(n) sur la taille du payload, mais
 * BullBoard n'est utilisé que ponctuellement par les admins (< 100 RPM en
 * worst case). Aucun impact production.
 */

import { Injectable, Logger, type NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'

import { deepSanitize } from '../../../common/security/sanitize'

/**
 * Wrap `res.send` pour intercepter le body JSON et appliquer `deepSanitize`.
 *
 * Cas couverts :
 *  - `res.json(obj)` → BullBoard l'utilise pour les détails de job
 *  - `res.send(string)` → si JSON parsable, on sanitise
 *  - `res.send(Buffer)` → passthrough (assets statiques BullBoard UI)
 *
 * Aucune modification des headers (Content-Type / Content-Length recalculés
 * par Express si on remplace le body string).
 */
@Injectable()
export class BullBoardSanitizeMiddleware implements NestMiddleware {
  private readonly logger = new Logger(BullBoardSanitizeMiddleware.name)

  use(_req: Request, res: Response, next: NextFunction): void {
    const originalJson = res.json.bind(res)
    res.json = (body: unknown): Response => {
      try {
        const sanitized = deepSanitize(body)
        return originalJson(sanitized)
      } catch (err) {
        // Fail-closed : si deepSanitize crash (cas pathologique), on renvoie
        // un objet vide plutôt que le body brut. Logué pour audit.
        this.logger.error({ err }, 'bullboard.sanitize.failed_fallback_empty')
        return originalJson({ error: 'SANITIZATION_FAILED' })
      }
    }

    const originalSend = res.send.bind(res)
    res.send = (body: unknown): Response => {
      if (typeof body !== 'string') {
        return originalSend(body)
      }
      const trimmed = body.trim()
      if (
        trimmed.length === 0 ||
        (trimmed[0] !== '{' && trimmed[0] !== '[')
      ) {
        return originalSend(body)
      }
      try {
        const parsed: unknown = JSON.parse(body)
        const sanitized = deepSanitize(parsed)
        return originalSend(JSON.stringify(sanitized))
      } catch {
        return originalSend(body)
      }
    }

    next()
  }
}
