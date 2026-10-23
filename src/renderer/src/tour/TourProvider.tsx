import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { useNavigation } from '@renderer/app/navigation'
import { TOUR_CHAPTERS, TOUR_STEPS } from './steps'
import { canStartTour, showRoute, TOUR_IDLE, tourProgress, tourReducer, UNSAVED_MESSAGE, type TourAction, type TourState } from './tour-state'
import { TourOverlay } from './TourOverlay'

export const TOUR_LAUNCHER_ID = 'tour-launcher'

interface TourValue {
  active: boolean
  start: () => void
  /** Aviso ao lado do botão (ex.: alterações não salvas impediram o início). */
  notice: string | null
  dismissNotice: () => void
}

const TourContext = createContext<TourValue | null>(null)

const reduce = (state: TourState, action: TourAction) => tourReducer(state, action, TOUR_STEPS.length)

/**
 * Apresentação Guiada: percorre as telas reais, somente leitura. Enquanto
 * ativa, o app fica inerte (sem cliques, foco ou digitação) e só a navegação
 * entre telas acontece, pelo mesmo controlador que protege alterações não salvas.
 */
export function TourProvider({ children }: { children: ReactNode }) {
  const { controller } = useNavigation()
  const [state, dispatch] = useReducer(reduce, TOUR_IDLE)
  const [notice, setNotice] = useState<string | null>(null)
  const origin = useRef(state.origin)
  origin.current = state.origin

  const start = useCallback(() => {
    const check = canStartTour(controller)
    if (!check.ok) {
      setNotice(check.message)
      return
    }
    setNotice(null)
    dispatch({ type: 'start', origin: controller.getSnapshot().current })
  }, [controller])

  const close = useCallback(() => {
    const back = origin.current
    dispatch({ type: 'close' })
    if (back) showRoute(controller, back)
    // Devolve o foco ao botão que abriu a apresentação (o app deixa de ser inerte no próximo quadro).
    requestAnimationFrame(() => document.getElementById(TOUR_LAUNCHER_ID)?.focus())
  }, [controller])

  const next = useCallback(() => dispatch({ type: 'next' }), [])
  const prev = useCallback(() => dispatch({ type: 'prev' }), [])

  // Cada etapa abre a sua tela.
  useEffect(() => {
    if (!state.active) return
    const step = TOUR_STEPS[state.index]
    if (step && showRoute(controller, step.route) === 'blocked') {
      dispatch({ type: 'close' })
      setNotice(UNSAVED_MESSAGE)
    }
  }, [state.active, state.index, controller])

  // O aviso some sozinho.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 8000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const progress = state.active ? tourProgress(TOUR_CHAPTERS, TOUR_STEPS, state.index) : null
  const value = useMemo<TourValue>(() => ({ active: state.active, start, notice, dismissNotice: () => setNotice(null) }), [state.active, start, notice])

  return (
    <TourContext.Provider value={value}>
      {children}
      {progress && <TourOverlay progress={progress} onNext={next} onPrev={prev} onClose={close} />}
    </TourContext.Provider>
  )
}

export function useTour(): TourValue {
  const ctx = useContext(TourContext)
  if (!ctx) throw new Error('useTour precisa estar dentro de <TourProvider>')
  return ctx
}
