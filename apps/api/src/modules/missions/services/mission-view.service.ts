/**
 * MissionViewService — sérialise un `Mission` Prisma en `MissionView` Zod
 * (`@cc/shared-types`) en appliquant la **policy d'adresse** (ADR-005 + Q6).
 *
 * Règles :
 *   - CLIENT propriétaire    → toujours adresse complète
 *   - ADMIN                  → toujours adresse complète
 *   - PRESTATAIRE assigné    → adresse complète si mission ACCEPTED+
 *   - PRESTATAIRE proposé    → adresse masquée (`MaskedMissionAddress`)
 *   - autres                 → adresse masquée (sécurité par défaut)
 *
 * Le service ne décide PAS du droit de lecture : c'est `MissionsService` qui
 * vérifie l'autorisation avant d'appeler la sérialisation.
 */

import type { MissionView } from '@cc/shared-types'
import { Injectable } from '@nestjs/common'
import type { Mission } from '@prisma/client'

import {
  canPrestataireViewFullMissionAddress,
  formatPartialZipCode,
} from '../domain/mission-address.policy'
import { MissionsRepository } from '../missions.repository'

interface ViewerContext {
  userId: string
  role: 'CLIENT' | 'PRESTATAIRE' | 'ADMIN'
}

@Injectable()
export class MissionViewService {
  constructor(private readonly repo: MissionsRepository) {}

  async toView(mission: Mission, viewer: ViewerContext): Promise<MissionView> {
    const address = await this.repo.loadAddressWithCoords(mission.addressId)
    if (!address) {
      throw new Error(`MissionViewService: address ${mission.addressId} introuvable`)
    }

    const fullAllowed = this.isFullAddressAllowed(mission, viewer)

    return {
      id: mission.id,
      missionNumber: mission.missionNumber,
      status: mission.status,
      serviceType: mission.serviceType,
      clientId: mission.clientId,
      prestataireId: mission.prestataireId,
      address: fullAllowed
        ? {
            kind: 'FULL',
            street: address.street,
            city: address.city,
            zipCode: address.zipCode,
            country: address.country,
            location: { lat: address.lat, lng: address.lng },
          }
        : {
            kind: 'MASKED',
            city: address.city,
            partialZipCode: formatPartialZipCode(address.zipCode),
            // Distance approximative non calculée ici (nécessite localisation prestataire) :
            // 0 = "non communiquée pré-acceptation" — UI affiche "à proximité".
            approximateDistanceKm: 0,
          },
      startAt: mission.startAt.toISOString(),
      endAt: mission.endAt.toISOString(),
      timeZone: mission.timeZone,
      isAsap: mission.isAsap,
      estimatedPriceCents: mission.estimatedPriceCents,
      publishedAt: mission.publishedAt ? mission.publishedAt.toISOString() : null,
      listingExpiresAt: mission.listingExpiresAt ? mission.listingExpiresAt.toISOString() : null,
      createdAt: mission.createdAt.toISOString(),
      updatedAt: mission.updatedAt.toISOString(),
    }
  }

  private isFullAddressAllowed(mission: Mission, viewer: ViewerContext): boolean {
    if (viewer.role === 'ADMIN') return true
    if (viewer.role === 'CLIENT' && viewer.userId === mission.clientId) return true
    if (viewer.role === 'PRESTATAIRE') {
      return canPrestataireViewFullMissionAddress({
        missionAssignedPrestataireId: mission.prestataireId,
        viewerPrestataireId: viewer.userId,
      })
    }
    return false
  }
}
