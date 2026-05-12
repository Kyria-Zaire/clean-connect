import type { ConfigService } from '@nestjs/config'

import { GeocoderService } from './geocoder.service'

const config = {
  get: (key: string) => {
    if (key === 'BAN_BASE_URL') return 'https://example-ban.test'
    if (key === 'BAN_TIMEOUT_MS') return 1_000
    throw new Error(`unexpected ${key}`)
  },
} as unknown as ConfigService

describe('GeocoderService', () => {
  let service: GeocoderService

  beforeEach(() => {
    service = new GeocoderService(config as unknown as ConfigService<never, true>)
    jest.restoreAllMocks()
  })

  it('court-circuite BAN si coords mobiles déjà fournies', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
    const out = await service.geocode({
      street: '12 rue test',
      city: 'Paris',
      zipCode: '75011',
      knownLocation: { lat: 48.86, lng: 2.37 },
    })
    expect(out).toEqual({ lat: 48.86, lng: 2.37, source: 'CLIENT_GPS' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('parse une réponse BAN nominale (1 feature)', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          features: [{ geometry: { coordinates: [2.37, 48.86] } }],
        }),
        { status: 200 },
      ),
    )
    const out = await service.geocode({ street: '12 rue X', city: 'Paris', zipCode: '75011' })
    expect(out).toEqual({ lat: 48.86, lng: 2.37, source: 'BAN' })
  })

  it('throw après 3 échecs HTTP successifs', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }))
    await expect(
      service.geocode({ street: 'x', city: 'Paris', zipCode: '75011' }),
    ).rejects.toThrow(/BAN unreachable/)
  })

  it('throw si BAN ne renvoie aucun feature', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ features: [] }), { status: 200 }))
    await expect(
      service.geocode({ street: 'x', city: 'Paris', zipCode: '75011' }),
    ).rejects.toThrow(/BAN unreachable/)
  })
})
