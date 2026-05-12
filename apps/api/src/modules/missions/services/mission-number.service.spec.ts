import { MissionNumberService } from './mission-number.service'

describe('MissionNumberService', () => {
  const svc = new MissionNumberService()

  it('respecte le format CC-YYYY-XXXXXXXX', () => {
    const n = svc.generate()
    expect(n).toMatch(/^CC-\d{4}-[0-9A-Z]{8}$/u)
  })

  it('inclut l\'année courante', () => {
    const n = svc.generate()
    const year = new Date().getUTCFullYear()
    expect(n).toContain(`CC-${year}-`)
  })

  it('produit des numéros distincts (1000 tirages)', () => {
    const set = new Set<string>()
    for (let i = 0; i < 1000; i += 1) set.add(svc.generate())
    expect(set.size).toBe(1000)
  })
})
