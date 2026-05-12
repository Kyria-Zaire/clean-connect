import {
  assertMissionTransition,
  canTransitionMissionStatus,
  MissionInvalidStatusTransitionError,
} from './mission-state.machine'

describe('mission-state.machine (PRD-002)', () => {
  it('autorise DRAFT → PUBLISHED', () => {
    expect(canTransitionMissionStatus('DRAFT', 'PUBLISHED')).toBe(true)
    expect(() => assertMissionTransition('DRAFT', 'PUBLISHED')).not.toThrow()
  })

  it('refuse DRAFT → ACCEPTED', () => {
    expect(canTransitionMissionStatus('DRAFT', 'ACCEPTED')).toBe(false)
    expect(() => assertMissionTransition('DRAFT', 'ACCEPTED')).toThrow(MissionInvalidStatusTransitionError)
  })

  it('autorise PROPOSED → ACCEPTED', () => {
    expect(canTransitionMissionStatus('PROPOSED', 'ACCEPTED')).toBe(true)
  })

  it('autorise PUBLISHED → ACCEPTED (marketplace first-accept-wins)', () => {
    expect(canTransitionMissionStatus('PUBLISHED', 'ACCEPTED')).toBe(true)
    expect(() => assertMissionTransition('PUBLISHED', 'ACCEPTED')).not.toThrow()
  })

  it('autorise PUBLISHED → EXPIRED', () => {
    expect(canTransitionMissionStatus('PUBLISHED', 'EXPIRED')).toBe(true)
  })

  // PRD-003 Ticket 3.4 — transitions liées à la complétion mission.
  it('autorise ACCEPTED → CLIENT_VALIDATION_PENDING (PRD-003 Ticket 3.4)', () => {
    expect(canTransitionMissionStatus('ACCEPTED', 'CLIENT_VALIDATION_PENDING')).toBe(true)
    expect(() => assertMissionTransition('ACCEPTED', 'CLIENT_VALIDATION_PENDING')).not.toThrow()
  })

  it('autorise CLIENT_VALIDATION_PENDING → COMPLETED (webhook capture)', () => {
    expect(canTransitionMissionStatus('CLIENT_VALIDATION_PENDING', 'COMPLETED')).toBe(true)
  })

  it('autorise CLIENT_VALIDATION_PENDING → DISPUTE_OPEN (report problem)', () => {
    expect(canTransitionMissionStatus('CLIENT_VALIDATION_PENDING', 'DISPUTE_OPEN')).toBe(true)
  })

  it('refuse COMPLETED → DISPUTE_OPEN (fenêtre 7j PRD-005, hors Ticket 3.4)', () => {
    expect(canTransitionMissionStatus('COMPLETED', 'DISPUTE_OPEN')).toBe(false)
  })

  it('refuse ACCEPTED → COMPLETED (capture obligatoire)', () => {
    expect(canTransitionMissionStatus('ACCEPTED', 'COMPLETED')).toBe(false)
  })

  it('refuse DISPUTE_OPEN → COMPLETED (terminal MVP, PRD-005)', () => {
    expect(canTransitionMissionStatus('DISPUTE_OPEN', 'COMPLETED')).toBe(false)
  })
})
