import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { NavigationController, type NavigationOutcome } from './navigation-guard'
import type { RouteId } from './routes'

interface NavigationValue {
  current: RouteId
  /** Navega, ou pede confirmação se houver alterações não salvas. */
  navigate: (to: RouteId) => NavigationOutcome
  /** Destino retido aguardando "Continuar editando" ou "Descartar alterações". */
  pending: RouteId | null
  blockedBy: string | null
  keepEditing: () => void
  confirmDiscard: () => void
  controller: NavigationController<RouteId>
}

const NavigationContext = createContext<NavigationValue | null>(null)

export function NavigationProvider({ initial = 'home', children }: { initial?: RouteId; children: ReactNode }) {
  const [controller] = useState(() => new NavigationController<RouteId>(initial))
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const value = useMemo<NavigationValue>(
    () => ({
      ...snapshot,
      navigate: (to) => controller.request(to),
      keepEditing: () => controller.keepEditing(),
      confirmDiscard: () => void controller.confirmDiscard(),
      controller
    }),
    [snapshot, controller]
  )
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}

export function useNavigation(): NavigationValue {
  const ctx = useContext(NavigationContext)
  if (!ctx) throw new Error('useNavigation precisa estar dentro de <NavigationProvider>')
  return ctx
}

/**
 * Protege alterações não salvas de um formulário. Enquanto `dirty` for
 * verdadeiro, sair da tela pela navegação do app pede confirmação.
 * `label` completa a frase "Há alterações não salvas…" (ex.: "no agente em edição").
 */
export function useUnsavedChangesGuard(dirty: boolean, label: string): void {
  const { controller } = useNavigation()
  const [id, setId] = useState<number | null>(null)

  useEffect(() => {
    const guardId = controller.register(label)
    setId(guardId)
    return () => controller.unregister(guardId)
  }, [controller, label])

  useEffect(() => {
    if (id !== null) controller.setDirty(id, dirty)
  }, [controller, id, dirty])
}
