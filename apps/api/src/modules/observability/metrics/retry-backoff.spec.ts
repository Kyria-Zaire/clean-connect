import { applyJitter, RETRY_JITTER_RATIO, RETRY_MIN_DELAY_MS } from './retry-backoff'

describe('applyJitter', () => {
  it('returns delayMs untouched when random() = 0.5 (no offset)', () => {
    const result = applyJitter({ delayMs: 60_000, random: () => 0.5 })
    expect(result).toBe(60_000)
  })

  it('returns minimum value when random() = 0 (full negative offset)', () => {
    const result = applyJitter({ delayMs: 60_000, random: () => 0 })
    expect(result).toBe(Math.round(60_000 * (1 - RETRY_JITTER_RATIO)))
    expect(result).toBe(54_000)
  })

  it('returns near-maximum value when random() approaches 1', () => {
    const result = applyJitter({ delayMs: 60_000, random: () => 0.999_999 })
    expect(result).toBeGreaterThanOrEqual(Math.round(60_000 * (1 + RETRY_JITTER_RATIO) - 1))
    expect(result).toBeLessThanOrEqual(Math.round(60_000 * (1 + RETRY_JITTER_RATIO)))
  })

  it('respects RETRY_MIN_DELAY_MS floor even for tiny inputs', () => {
    const result = applyJitter({ delayMs: 100, random: () => 0 })
    expect(result).toBe(RETRY_MIN_DELAY_MS)
  })

  it('respects RETRY_MIN_DELAY_MS floor for zero input', () => {
    const result = applyJitter({ delayMs: 0, random: () => 0.5 })
    expect(result).toBe(RETRY_MIN_DELAY_MS)
  })

  it('mean over many samples approaches delayMs (±2%)', () => {
    const delayMs = 60_000
    const samples = 1_000
    let sum = 0
    for (let i = 0; i < samples; i += 1) {
      sum += applyJitter({ delayMs })
    }
    const mean = sum / samples
    // Tolerance loose : 2 % de la cible (suffit pour vérifier la symétrie).
    expect(mean).toBeGreaterThan(delayMs * 0.98)
    expect(mean).toBeLessThan(delayMs * 1.02)
  })

  it('never returns above delayMs * (1 + ratio) over many samples', () => {
    const delayMs = 60_000
    const maxAllowed = Math.round(delayMs * (1 + RETRY_JITTER_RATIO))
    for (let i = 0; i < 200; i += 1) {
      const v = applyJitter({ delayMs })
      expect(v).toBeLessThanOrEqual(maxAllowed)
    }
  })

  it('uses Math.random by default when no random function provided', () => {
    const v1 = applyJitter({ delayMs: 60_000 })
    const v2 = applyJitter({ delayMs: 60_000 })
    expect(v1).toBeGreaterThanOrEqual(54_000)
    expect(v1).toBeLessThanOrEqual(66_000)
    expect(v2).toBeGreaterThanOrEqual(54_000)
    expect(v2).toBeLessThanOrEqual(66_000)
  })
})
