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

  // --- Audit Verify CTO §D — payload hygiene étendu : PII + secrets -----------
  describe('Verify §D — PII & secrets interdits', () => {
    it.each([
      ['email racine', { email: 'a@b.fr' }],
      ['emailAddress imbriqué', { actor: { emailAddress: 'a@b.fr' } }],
      ['phone racine', { phone: '+33612345678' }],
      ['phoneNumber dans un tableau', { contacts: [{ phoneNumber: '+33612345678' }] }],
      ['mobile imbriqué', { user: { mobile: '+33612345678' } }],
      ['telephone', { telephone: '0102030405' }],
      ['password', { password: 'plaintext' }],
      ['passwordHash', { passwordHash: '$2b$10$...' }],
      ['token', { token: 'abc.def.ghi' }],
      ['accessToken', { meta: { accessToken: 'eyJhbGciOi...' } }],
      ['refreshToken', { refreshToken: 'opaque-uuid' }],
      ['tokenHash', { tokenHash: 'sha256...' }],
      ['jwt', { jwt: 'eyJ...' }],
      ['authorization', { authorization: 'Bearer xyz' }],
      ['apiKey', { external: { apiKey: 'sk_test_xxx' } }],
      ['secret', { secret: 'shhh' }],
    ] as const)('rejette %s', (_label, payload) => {
      expect(() => assertNoAddressLeak(payload)).toThrow()
    })

    it('accepte un payload audit légitime mission_events (durée + motif + ids)', () => {
      expect(() =>
        assertNoAddressLeak({
          listingTtlMs: 900_000,
          reason: 'client_changed_mind',
          missionId: 'mission-uuid',
          prestataireId: 'user-uuid',
          eligibleCount: 3,
        }),
      ).not.toThrow()
    })
  })
})
