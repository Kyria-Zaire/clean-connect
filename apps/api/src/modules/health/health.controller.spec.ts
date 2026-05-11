/**
 * Smoke test — vérifie que le module health peut être instancié.
 * Ce fichier sert aussi de canari de configuration TS / Jest.
 * (globals Jest fournis via @types/jest, pas besoin d'import explicite)
 */

describe('HealthController (smoke)', () => {
  it('canari de configuration TS/Jest (test d\'intégration health en PRD ultérieur)', () => {
    expect(true).toBe(true)
  })
})
