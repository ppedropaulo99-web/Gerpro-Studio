/**
 * Saudação do Início pelo horário local do computador. Faixas (hora local):
 * manhã das 5h às 11h59, tarde das 12h às 17h59 e noite das 18h às 4h59.
 */

export type DayPeriod = 'morning' | 'afternoon' | 'night'

/** Hora em que cada período começa. */
export const PERIOD_START_HOURS = { morning: 5, afternoon: 12, night: 18 } as const satisfies Record<DayPeriod, number>

const GREETINGS: Record<DayPeriod, string> = { morning: 'Bom dia', afternoon: 'Boa tarde', night: 'Boa noite' }

export function dayPeriod(date: Date): DayPeriod {
  const hour = date.getHours()
  if (hour >= PERIOD_START_HOURS.morning && hour < PERIOD_START_HOURS.afternoon) return 'morning'
  if (hour >= PERIOD_START_HOURS.afternoon && hour < PERIOD_START_HOURS.night) return 'afternoon'
  return 'night'
}

/** "Boa tarde, Ana!" com nome; "Boa tarde!" sem nome (vazio ou só espaços). */
export function greeting(date: Date, displayName?: string | null): string {
  const name = displayName?.trim()
  return name ? `${GREETINGS[dayPeriod(date)]}, ${name}!` : `${GREETINGS[dayPeriod(date)]}!`
}

/** Próximo instante em que o período muda (5h, 12h ou 18h locais, o que vier primeiro). */
export function nextPeriodChange(date: Date): Date {
  const at = (days: number, hour: number) => {
    const d = new Date(date)
    d.setDate(d.getDate() + days)
    d.setHours(hour, 0, 0, 0)
    return d
  }
  const hours = Object.values(PERIOD_START_HOURS)
  const today = hours.map((hour) => at(0, hour)).filter((d) => d.getTime() > date.getTime())
  // Depois das 18h, a próxima troca é às 5h do dia seguinte.
  return today.length > 0 ? today[0]! : at(1, PERIOD_START_HOURS.morning)
}
