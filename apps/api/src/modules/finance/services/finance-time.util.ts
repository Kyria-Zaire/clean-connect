/**
 * PRD-004 Ticket 4.5 Build itération 2 — Helpers temporels Europe/Paris.
 *
 * Important : on calcule la fenêtre J-1 calée sur Europe/Paris (rule
 * date-fns-tz dans le projet). Les bornes sont stockées en UTC côté DB
 * (Prisma DateTime). On utilise `Intl.DateTimeFormat` pour offset déterministe
 * (DST automatique) sans dépendance supplémentaire.
 */

const PARIS_TZ = 'Europe/Paris'

/**
 * Renvoie la fenêtre [from, to[ correspondant à J-1 en Europe/Paris (00:00 → 24:00),
 * exprimée en `Date` UTC pour Prisma. Si `now` = 2026-05-13 04:15 Europe/Paris,
 * on retourne :
 *   from = 2026-05-12 00:00 Europe/Paris = 2026-05-11 22:00 UTC
 *   to   = 2026-05-13 00:00 Europe/Paris = 2026-05-12 22:00 UTC
 */
export function computeJ1Window(now: Date): { from: Date; to: Date } {
  const parisToday = parisStartOfDay(now)
  const parisYesterday = new Date(parisToday.getTime() - 24 * 60 * 60_000)
  return { from: parisYesterday, to: parisToday }
}

/**
 * Renvoie le `Date` UTC correspondant à 00:00 Europe/Paris pour la date de `ref`.
 * Utilise un calcul d'offset basé sur `Intl.DateTimeFormat` (DST-safe).
 */
function parisStartOfDay(ref: Date): Date {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: PARIS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(ref)

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type)
    if (!p) throw new Error(`Intl part missing: ${type}`)
    return Number(p.value)
  }

  const y = get('year')
  const m = get('month')
  const d = get('day')

  // 00:00 Europe/Paris exprimé en UTC : on passe par un Date "wallclock" puis on
  // recalcule l'offset en regardant la différence entre wallclock et la projection.
  const wallclockMidnightUtc = Date.UTC(y, m - 1, d, 0, 0, 0)
  const projectedHour = get('hour')
  const projectedMinute = get('minute')
  const projectedSecond = get('second')
  const projectedMs = ref.getTime()
  const wallclockProjectedUtc = Date.UTC(y, m - 1, d, projectedHour, projectedMinute, projectedSecond)
  const offsetMs = wallclockProjectedUtc - projectedMs
  return new Date(wallclockMidnightUtc - offsetMs)
}
