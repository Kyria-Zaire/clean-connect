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

  it('refuse toute transition depuis ACCEPTED (MVP)', () => {
    expect(canTransitionMissionStatus('ACCEPTED', 'IN_PROGRESS')).toBe(false)
  })
})
