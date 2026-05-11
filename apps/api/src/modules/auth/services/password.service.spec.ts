import { PasswordService } from './password.service'

describe('PasswordService', () => {
  const service = new PasswordService()

  it('hashe un mot de passe sans le retourner en clair', async () => {
    const hash = await service.hash('Sup3rSecret_passw0rd!')
    expect(hash).not.toEqual('Sup3rSecret_passw0rd!')
    expect(hash.startsWith('$2')).toBe(true)
  })

  it('verifie un mot de passe valide', async () => {
    const hash = await service.hash('Sup3rSecret_passw0rd!')
    await expect(service.verify('Sup3rSecret_passw0rd!', hash)).resolves.toBe(true)
  })

  it('rejette un mot de passe invalide', async () => {
    const hash = await service.hash('Sup3rSecret_passw0rd!')
    await expect(service.verify('wrong-password', hash)).resolves.toBe(false)
  })
})
