/**
 * Estado e navegação da Apresentação Guiada, sem React nem DOM.
 *
 * A apresentação é somente leitura: só troca de tela pela navegação do app
 * (que respeita alterações não salvas) e nunca chama o processo Main.
 */

import type { RouteId } from '@renderer/app/route-ids'
import type { TourChapter, TourStep } from './steps'

export interface TourState {
  active: boolean
  index: number
  /** Tela de onde a apresentação começou; o app volta a ela no fim. */
  origin: RouteId | null
}

export const TOUR_IDLE: TourState = { active: false, index: 0, origin: null }

export type TourAction = { type: 'start'; origin: RouteId } | { type: 'next' } | { type: 'prev' } | { type: 'goto'; index: number } | { type: 'close' }

/** Transições; `total` = número de etapas do roteiro. */
export function tourReducer(state: TourState, action: TourAction, total: number): TourState {
  switch (action.type) {
    case 'start':
      return total > 0 ? { active: true, index: 0, origin: action.origin } : state
    case 'close':
      return TOUR_IDLE
    default:
      if (!state.active) return state
  }
  const last = total - 1
  const index =
    action.type === 'next' ? Math.min(state.index + 1, last) : action.type === 'prev' ? Math.max(state.index - 1, 0) : Math.max(0, Math.min(action.index, last))
  return index === state.index ? state : { ...state, index }
}

export interface TourProgress {
  step: TourStep
  /** 1 a `total`. */
  position: number
  total: number
  chapter: TourChapter
  chapterPosition: number
  chapterCount: number
  stepInChapter: number
  chapterSteps: number
  isFirst: boolean
  isLast: boolean
  percent: number
}

/** Contadores calculados do próprio roteiro: nada é fixo. */
export function tourProgress(chapters: readonly TourChapter[], steps: readonly TourStep[], index: number): TourProgress | null {
  const step = steps[index]
  if (!step) return null
  const usedChapters = chapters.filter((c) => steps.some((s) => s.chapter === c.id))
  const chapterIndex = usedChapters.findIndex((c) => c.id === step.chapter)
  const inChapter = steps.filter((s) => s.chapter === step.chapter)
  const total = steps.length
  return {
    step,
    position: index + 1,
    total,
    chapter: usedChapters[chapterIndex]!,
    chapterPosition: chapterIndex + 1,
    chapterCount: usedChapters.length,
    stepInChapter: inChapter.indexOf(step) + 1,
    chapterSteps: inChapter.length,
    isFirst: index === 0,
    isLast: index === total - 1,
    percent: Math.round(((index + 1) / total) * 100)
  }
}

// ---------------------------------------------------------------------------
// Navegação entre telas e proteção de alterações não salvas
// ---------------------------------------------------------------------------

/** O necessário do `NavigationController` (permite testar sem React). */
export interface TourNavigator {
  getSnapshot(): { current: RouteId; pending: RouteId | null }
  request(to: RouteId): 'navigated' | 'blocked' | 'unchanged'
  keepEditing(): void
  hasUnsavedChanges(): boolean
}

export type TourStartCheck = { ok: true } | { ok: false; reason: 'unsaved-changes'; message: string }

export const UNSAVED_MESSAGE = 'Há alterações não salvas. Salve ou descarte as alterações antes de iniciar a apresentação.'

/** A apresentação não começa sobre alterações não salvas: nada é descartado por ela. */
export function canStartTour(nav: Pick<TourNavigator, 'hasUnsavedChanges'>): TourStartCheck {
  return nav.hasUnsavedChanges() ? { ok: false, reason: 'unsaved-changes', message: UNSAVED_MESSAGE } : { ok: true }
}

/**
 * Leva o app à tela da etapa pela navegação normal. Se ela for retida por
 * alterações não salvas, a confirmação é cancelada (nada é descartado) e o
 * resultado é `blocked`, para a apresentação encerrar.
 */
export function showRoute(nav: TourNavigator, route: RouteId): 'ok' | 'blocked' {
  const outcome = nav.request(route)
  if (outcome !== 'blocked') return 'ok'
  nav.keepEditing()
  return 'blocked'
}
