/**
 * Hachage bcrypt des mots de passe — coût 10 (décision CTO Design PRD-001).
 * Aucun mot de passe en clair ne doit transiter en dehors de ce service.
 */

import { Injectable } from '@nestjs/common'
import * as bcrypt from 'bcrypt'

const BCRYPT_COST = 10

@Injectable()
export class PasswordService {
  hash(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_COST)
  }

  verify(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash)
  }
}
