/**
 * PRD-003 Ticket 3.4 — utilitaire `addBusinessHoursParis`.
 *
 * Ajoute N heures **ouvrées Europe/Paris** à un `Date` :
 *  - week-end (samedi/dimanche en Europe/Paris) exclus.
 *  - jours fériés FR (2026 → 2028 inclus) exclus.
 *
 * Sémantique CTO Ticket 3.4 / Design AC-D.4 :
 *  - Une « heure ouvrée » = chaque heure d'un jour ouvré (24h/24, sans
 *    découpage horaire métier 9h-18h en MVP — cf. Design §3.4 Q5 : on
 *    veut juste retarder le job de ~2 jours ouvrés calendaires).
 *  - Donc `addBusinessHoursParis(now, 48)` ≈ `now + 2 jours ouvrés`.
 *
 * Complexité : O(hoursToAdd) — pour `48` heures, ~48-200 itérations max
 * (cas pire en cas de pont férié), exécuté **une seule fois** au
 * `complete` mission. Acceptable.
 *
 * Limites connues (debt) :
 *  - La liste `FRENCH_HOLIDAYS_FIXED` est statique et bornée 2026-2028.
 *    Toute exploitation au-delà nécessite un refresh annuel
 *    (`TODO(debt): business-hours-calendar-refresh`).
 *  - Les jours « pont » (ex. vendredi férié + samedi/dimanche) sont
 *    correctement gérés car chaque jour est testé indépendamment.
 *  - Les jours fériés régionaux Alsace-Moselle (Saint-Étienne, Vendredi
 *    Saint) ne sont **pas** appliqués (MVP national).
 */

import { formatInTimeZone } from 'date-fns-tz'

/**
 * Jours fériés FR fixes (date civile en Europe/Paris) — 2026 → 2028.
 *
 * Inclut :
 *  - Jour de l'an (1er janvier)
 *  - Fête du Travail (1er mai)
 *  - Victoire 1945 (8 mai)
 *  - Fête nationale (14 juillet)
 *  - Assomption (15 août)
 *  - Toussaint (1er novembre)
 *  - Armistice 1918 (11 novembre)
 *  - Noël (25 décembre)
 *  - Lundi de Pâques (variable — précalculé)
 *  - Ascension (variable — précalculé, Pâques + 39j)
 *  - Lundi de Pentecôte (variable — précalculé, Pâques + 50j)
 */
export const FRENCH_HOLIDAYS_FIXED: ReadonlySet<string> = new Set<string>([
  // 2026
  '2026-01-01', '2026-04-06', '2026-05-01', '2026-05-08', '2026-05-14',
  '2026-05-25', '2026-07-14', '2026-08-15', '2026-11-01', '2026-11-11',
  '2026-12-25',
  // 2027
  '2027-01-01', '2027-03-29', '2027-05-01', '2027-05-06', '2027-05-08',
  '2027-05-17', '2027-07-14', '2027-08-15', '2027-11-01', '2027-11-11',
  '2027-12-25',
  // 2028
  '2028-01-01', '2028-04-17', '2028-05-01', '2028-05-08', '2028-05-25',
  '2028-06-05', '2028-07-14', '2028-08-15', '2028-11-01', '2028-11-11',
  '2028-12-25',
])

const PARIS_TZ = 'Europe/Paris'
const ONE_HOUR_MS = 60 * 60 * 1_000

/** Vrai si la date (en Europe/Paris) tombe un samedi, dimanche ou un jour férié FR. */
export function isBusinessDayParis(date: Date): boolean {
  // `i` (ISO weekday 1=Mon..7=Sun) — date-fns-tz suit ce format.
  const isoWeekday = formatInTimeZone(date, PARIS_TZ, 'i')
  if (isoWeekday === '6' || isoWeekday === '7') return false
  const isoCalendarDate = formatInTimeZone(date, PARIS_TZ, 'yyyy-MM-dd')
  return !FRENCH_HOLIDAYS_FIXED.has(isoCalendarDate)
}

/**
 * Ajoute `hoursToAdd` heures ouvrées Europe/Paris à `start`.
 *
 * Algorithme robuste mais simple : on avance d'une heure à la fois, et
 * on ne décompte que les heures qui tombent un jour ouvré FR. La sortie
 * est en UTC (`Date` Node natif).
 */
export function addBusinessHoursParis(start: Date, hoursToAdd: number): Date {
  if (!Number.isFinite(hoursToAdd) || hoursToAdd <= 0) return new Date(start.getTime())
  let cursor = start.getTime()
  let remaining = Math.ceil(hoursToAdd)
  while (remaining > 0) {
    cursor += ONE_HOUR_MS
    if (isBusinessDayParis(new Date(cursor))) {
      remaining -= 1
    }
  }
  return new Date(cursor)
}
