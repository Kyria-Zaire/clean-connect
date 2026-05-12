/**
 * Politique explicite de visibilité d'adresse mission (RGPD + PRD-002 Q6 CTO).
 * Toute exposition d'adresse dans les DTO HTTP doit passer par ces helpers.
 */

export interface FullMissionAddress {
  readonly street: string
  readonly city: string
  readonly zipCode: string
  readonly country: string
  readonly lat: number
  readonly lng: number
}

export interface MaskedMissionAddressForPrestataire {
  readonly city: string
  /** Ex. `75***` pour `75001` — réduit la ré-identification du quartier exact. */
  readonly partialZipCode: string
  /** Distance arrondie depuis la base du prestataire (km). */
  readonly approximateDistanceKm: number
}

/** Masque le code postal : 2 premiers chiffres + masque (FR métropole). */
export function formatPartialZipCode(zipCode: string): string {
  const trimmed = zipCode.trim()
  if (trimmed.length < 2) {
    return '**'
  }
  return `${trimmed.slice(0, 2)}***`
}

/** Prestataire : adresse complète uniquement une fois la mission acceptée et assignée à lui. */
export function canPrestataireViewFullMissionAddress(params: {
  readonly missionAssignedPrestataireId: string | null
  readonly viewerPrestataireId: string
}): boolean {
  return (
    params.missionAssignedPrestataireId !== null &&
    params.missionAssignedPrestataireId === params.viewerPrestataireId
  )
}

export function toPrestataireMissionAddressView(params: {
  readonly full: FullMissionAddress
  readonly approximateDistanceKm: number
  readonly showFull: boolean
}): FullMissionAddress | MaskedMissionAddressForPrestataire {
  if (params.showFull) {
    return params.full
  }
  return {
    city: params.full.city,
    partialZipCode: formatPartialZipCode(params.full.zipCode),
    approximateDistanceKm: params.approximateDistanceKm,
  }
}
