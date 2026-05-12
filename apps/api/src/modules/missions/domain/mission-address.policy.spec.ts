import {
  canPrestataireViewFullMissionAddress,
  formatPartialZipCode,
  toPrestataireMissionAddressView,
} from './mission-address.policy'

describe('mission-address.policy (PRD-002)', () => {
  it('formatPartialZipCode masque le suffixe', () => {
    expect(formatPartialZipCode('75001')).toBe('75***')
    expect(formatPartialZipCode('130')).toBe('13***')
  })

  it('canPrestataireViewFullMissionAddress exige assignation', () => {
    expect(
      canPrestataireViewFullMissionAddress({
        missionAssignedPrestataireId: 'a',
        viewerPrestataireId: 'a',
      }),
    ).toBe(true)
    expect(
      canPrestataireViewFullMissionAddress({
        missionAssignedPrestataireId: null,
        viewerPrestataireId: 'a',
      }),
    ).toBe(false)
    expect(
      canPrestataireViewFullMissionAddress({
        missionAssignedPrestataireId: 'b',
        viewerPrestataireId: 'a',
      }),
    ).toBe(false)
  })

  it('toPrestataireMissionAddressView retourne masqué ou complet', () => {
    const full = {
      street: '10 rue X',
      city: 'Paris',
      zipCode: '75001',
      country: 'FR',
      lat: 48.85,
      lng: 2.35,
    }
    const masked = toPrestataireMissionAddressView({
      full,
      approximateDistanceKm: 3,
      showFull: false,
    })
    expect('partialZipCode' in masked).toBe(true)
    if ('partialZipCode' in masked) {
      expect(masked.partialZipCode).toBe('75***')
      expect(masked.city).toBe('Paris')
    }
    const plain = toPrestataireMissionAddressView({
      full,
      approximateDistanceKm: 3,
      showFull: true,
    })
    expect('street' in plain ? plain.street : '').toBe('10 rue X')
  })
})
