/**
 * Geometria da Apresentação Guiada, pura (sem DOM).
 *
 * Prioridade: o componente destacado fica inteiro à vista. O painel
 * explicativo ocupa uma COLUNA RESERVADA à direita (o app encolhe para dar
 * lugar a ela), então nunca cobre o destaque.
 */

export interface Rect {
  top: number
  left: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/** Largura do painel por largura de janela. */
export const TOUR_PANEL = { wide: 360, narrow: 300, breakpoint: 1280 } as const
/** Folga entre o componente e a borda do destaque. */
export const SPOTLIGHT_PADDING = 6
/** Margem mínima entre o destaque e a borda da área visível ao rolar. */
export const SCROLL_MARGIN = 16

export function panelWidth(viewport: Size): number {
  return viewport.width >= TOUR_PANEL.breakpoint ? TOUR_PANEL.wide : TOUR_PANEL.narrow
}

/** Área do app (tudo menos a coluna do painel). */
export function appArea(viewport: Size): Rect {
  return { top: 0, left: 0, width: Math.max(0, viewport.width - panelWidth(viewport)), height: viewport.height }
}

/** Painel: coluna da direita, abaixo da barra de título (onde ficam os botões da janela). */
export function panelRect(viewport: Size, titlebarHeight: number): Rect {
  const width = panelWidth(viewport)
  return { top: titlebarHeight, left: viewport.width - width, width, height: Math.max(0, viewport.height - titlebarHeight) }
}

/**
 * Quanto rolar o contêiner para mostrar o alvo:
 * - já visível com margem → 0 (sem saltos);
 * - cabe na área → centraliza;
 * - maior que a área → alinha o topo.
 */
export function scrollDelta(target: Rect, container: Rect, margin = SCROLL_MARGIN): number {
  const top = container.top + margin
  const bottom = container.top + container.height - margin
  if (target.top >= top && target.top + target.height <= bottom) return 0
  if (target.height <= bottom - top) return Math.round(target.top + target.height / 2 - (container.top + container.height / 2))
  return Math.round(target.top - top)
}

/** Destaque: o alvo com folga, recortado à área visível. `clipped` = o alvo não cabe inteiro. */
export function spotlightRect(target: Rect, visible: Rect, padding = SPOTLIGHT_PADDING): { rect: Rect; clipped: boolean } {
  const want = { top: target.top - padding, left: target.left - padding, bottom: target.top + target.height + padding, right: target.left + target.width + padding }
  const top = Math.max(want.top, visible.top)
  const left = Math.max(want.left, visible.left)
  const bottom = Math.min(want.bottom, visible.top + visible.height)
  const right = Math.min(want.right, visible.left + visible.width)
  const clipped =
    target.top < visible.top ||
    target.left < visible.left ||
    target.top + target.height > visible.top + visible.height ||
    target.left + target.width > visible.left + visible.width
  return { rect: { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }, clipped }
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height
}

export function intersect(a: Rect, b: Rect): Rect {
  const top = Math.max(a.top, b.top)
  const left = Math.max(a.left, b.left)
  return {
    top,
    left,
    width: Math.max(0, Math.min(a.left + a.width, b.left + b.width) - left),
    height: Math.max(0, Math.min(a.top + a.height, b.top + b.height) - top)
  }
}
