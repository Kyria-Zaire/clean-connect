/**
 * Sous-ensemble de mots de passe trop communs (normalisés en minuscules).
 * Ticket 1.3 (Build) : étendre vers la liste OWASP Top 10k si besoin (fichier
 * JSON généré ou import statique), sans gonfler indéfiniment ce module en Design.
 */

export const AUTH_PASSWORD_BLOCKLIST = new Set<string>([
  'password',
  'password123',
  'password1',
  '123456789',
  '1234567890',
  '12345678',
  '1234567',
  '123456',
  'qwerty',
  'qwerty123',
  'azerty',
  'letmein',
  'welcome',
  'welcome123',
  'admin',
  'admin123',
  'root',
  'toor',
  'passw0rd',
  'p@ssw0rd',
  'monkey',
  'dragon',
  'master',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'iloveyou',
  'trustno1',
  'whatever',
  'abc123',
  'abcd1234',
  'cleanconnect',
  'cleanconnect123',
])
