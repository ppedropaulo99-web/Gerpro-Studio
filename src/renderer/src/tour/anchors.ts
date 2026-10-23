/**
 * Identificação dos componentes apresentados.
 *
 * Os componentes reais recebem `data-tour="<id>"` no JSX; a apresentação os
 * encontra só por esse atributo, sem depender de classes ou da estrutura.
 */

import type { Rect } from './placement'

export const TOUR_ATTRIBUTE = 'data-tour'

export const tourSelector = (id: string) => `[${TOUR_ATTRIBUTE}="${id}"]`

/** Subconjunto de `Element` usado aqui (permite testar sem DOM). */
export interface AnchorElement {
  getBoundingClientRect(): Rect
}

/** O componente, se existir e estiver visível (com área). Senão, `null`: a etapa segue sem destaque. */
export function findAnchor<E extends AnchorElement>(root: { querySelector(selector: string): E | null }, id: string): E | null {
  const el = root.querySelector(tourSelector(id))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? el : null
}

/** Contêiner com rolagem onde o componente está (a área principal das telas), se houver. */
export const SCROLL_CONTAINER = '.main'
