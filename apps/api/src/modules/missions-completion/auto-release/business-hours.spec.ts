import { addBusinessHoursParis, isBusinessDayParis } from './business-hours'

/**
 * Tous les `Date` ISO ci-dessous sont écrits avec offset `+02:00` (heure d'été
 * Europe/Paris) ou `+01:00` (heure d'hiver) pour garantir une lecture sans
 * ambiguïté de la timezone Paris.
 */

describe('isBusinessDayParis', () => {
  it('lundi ordinaire (2026-06-22) → true', () => {
    expect(isBusinessDayParis(new Date('2026-06-22T10:00:00+02:00'))).toBe(true)
  })

  it('samedi (2026-06-20) → false', () => {
    expect(isBusinessDayParis(new Date('2026-06-20T10:00:00+02:00'))).toBe(false)
  })

  it('dimanche (2026-06-21) → false', () => {
    expect(isBusinessDayParis(new Date('2026-06-21T10:00:00+02:00'))).toBe(false)
  })

  it('1er janvier 2026 (jour férié) → false', () => {
    expect(isBusinessDayParis(new Date('2026-01-01T10:00:00+01:00'))).toBe(false)
  })

  it('15 août 2026 (Assomption, samedi mais férié → toujours false)', () => {
    expect(isBusinessDayParis(new Date('2026-08-15T10:00:00+02:00'))).toBe(false)
  })

  it('14 juillet 2027 (mercredi férié) → false', () => {
    expect(isBusinessDayParis(new Date('2027-07-14T10:00:00+02:00'))).toBe(false)
  })
})

describe('addBusinessHoursParis', () => {
  it('cas trivial 0h → renvoie le même instant', () => {
    const start = new Date('2026-06-22T08:00:00+02:00')
    const out = addBusinessHoursParis(start, 0)
    expect(out.toISOString()).toBe(start.toISOString())
  })

  it('lundi 10h + 48h ouvrées → mercredi 10h (jamais férié dans cette semaine)', () => {
    // Semaine du 22 au 28 juin 2026 — aucun jour férié.
    const start = new Date('2026-06-22T10:00:00+02:00')
    const out = addBusinessHoursParis(start, 48)
    // 48 heures ouvrées consécutives sur lun-mar-mer → mercredi 24/06 à 10:00 Paris.
    expect(out.toISOString()).toBe(new Date('2026-06-24T10:00:00+02:00').toISOString())
  })

  it("vendredi 10h + 48h ouvrées → mardi 10h (saut du week-end)", () => {
    // 26 juin = vendredi (semaine du 22-28 juin 2026, pas de férié).
    const start = new Date('2026-06-26T10:00:00+02:00')
    const out = addBusinessHoursParis(start, 48)
    expect(out.toISOString()).toBe(new Date('2026-06-30T10:00:00+02:00').toISOString())
  })

  it("jeudi 10h + 48h ouvrées (jeudi → mardi via pont férié vendredi 1er mai 2026)", () => {
    // 30 avril 2026 = jeudi. 1er mai 2026 = vendredi férié (Fête du Travail).
    // L'algorithme compte heure par heure dans les jours ouvrés (sémantique
    // homogène avec les tests « lundi+48h=mercredi » et « vendredi+48h=mardi ») :
    //   jeudi 10h → 24h        = 14h ouvrées (restant : 34h)
    //   vendredi 1er mai férié = skip 24h
    //   samedi/dimanche        = skip 48h
    //   lundi 4 mai 0h → 24h   = 24h ouvrées (restant : 10h)
    //   mardi 5 mai 0h → 10h   = 10h ouvrées (restant : 0)
    // → mardi 5 mai 10h Paris.
    const start = new Date('2026-04-30T10:00:00+02:00')
    const out = addBusinessHoursParis(start, 48)
    expect(out.toISOString()).toBe(new Date('2026-05-05T10:00:00+02:00').toISOString())
  })

  it("valeur négative ou NaN → renvoie le même instant (garde-fou)", () => {
    const start = new Date('2026-06-22T08:00:00+02:00')
    expect(addBusinessHoursParis(start, -10).toISOString()).toBe(start.toISOString())
    expect(addBusinessHoursParis(start, Number.NaN).toISOString()).toBe(start.toISOString())
  })
})
