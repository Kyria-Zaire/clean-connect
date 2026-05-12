import { assertNoAddressLeak } from './mission-event.types'

describe('assertNoAddressLeak', () => {
  it('passe sur des payloads sans adresse', () => {
    expect(() =>
      assertNoAddressLeak({ missionId: 'abc', count: 3, status: 'PUBLISHED' }),
    ).not.toThrow()
  })

  it('rejette street en racine', () => {
    expect(() => assertNoAddressLeak({ street: '12 rue X' })).toThrow(/street/)
  })

  it('rejette location imbriquée', () => {
    expect(() =>
      assertNoAddressLeak({ payload: { address: { location: { lat: 48, lng: 2 } } } }),
    ).toThrow(/location/)
  })

  it('rejette lat/lng en racine', () => {
    expect(() => assertNoAddressLeak({ lat: 48 })).toThrow(/lat/)
    expect(() => assertNoAddressLeak({ lng: 2 })).toThrow(/lng/)
  })

  it('rejette longitude dans un tableau', () => {
    expect(() =>
      assertNoAddressLeak({ list: [{ ok: true }, { longitude: 2.35 }] }),
    ).toThrow(/longitude/)
  })

  it('accepte des coordonnées approximatives nommées sans clé interdite', () => {
    expect(() =>
      assertNoAddressLeak({ approximateDistanceKm: 4.2, prestataireId: 'u1' }),
    ).not.toThrow()
  })
})
