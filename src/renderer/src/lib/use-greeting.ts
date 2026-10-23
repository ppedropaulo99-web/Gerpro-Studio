import { useEffect, useState } from 'react'
import { dayPeriod, greeting, nextPeriodChange } from './greeting'

/**
 * Saudação que acompanha a troca de período com o app aberto: um único
 * temporizador até a próxima troca. Ao voltar o foco à janela (por exemplo,
 * depois de o computador dormir), o período é conferido de novo.
 */
export function useGreeting(displayName: string | undefined): string {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const delay = Math.max(1000, nextPeriodChange(now).getTime() - Date.now() + 1000)
    const timer = window.setTimeout(() => setNow(new Date()), delay)
    const recheck = () => {
      const current = new Date()
      if (dayPeriod(current) !== dayPeriod(now)) setNow(current)
    }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [now])

  return greeting(now, displayName)
}
