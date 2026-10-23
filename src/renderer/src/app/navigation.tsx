import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { RouteId } from './routes'

interface NavigationValue {
  current: RouteId
  navigate: (to: RouteId) => void
}

const NavigationContext = createContext<NavigationValue | null>(null)

export function NavigationProvider({ initial = 'home', children }: { initial?: RouteId; children: ReactNode }) {
  const [current, setCurrent] = useState<RouteId>(initial)
  const value = useMemo(() => ({ current, navigate: setCurrent }), [current])
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}

export function useNavigation(): NavigationValue {
  const ctx = useContext(NavigationContext)
  if (!ctx) throw new Error('useNavigation precisa estar dentro de <NavigationProvider>')
  return ctx
}
