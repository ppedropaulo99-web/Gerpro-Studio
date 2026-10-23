/**
 * Listeners globais da Apresentação Guiada. Tudo o que é registrado aqui é
 * removido pelo descarte devolvido, que pode ser chamado mais de uma vez.
 */

export type TourKeyAction = 'next' | 'prev' | 'close'

/** Esc encerra; setas avançam e voltam. Nenhuma outra tecla é capturada. */
export function tourKeyAction(key: string): TourKeyAction | null {
  if (key === 'Escape') return 'close'
  if (key === 'ArrowRight') return 'next'
  if (key === 'ArrowLeft') return 'prev'
  return null
}

export function attachTourListeners(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  handlers: { onKey: (action: TourKeyAction) => void; onReflow: () => void }
): () => void {
  const onKeyDown = (event: Event) => {
    const action = tourKeyAction((event as Event & { key?: string }).key ?? '')
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    handlers.onKey(action)
  }
  const onReflow = () => handlers.onReflow()
  const registered: Array<[string, (event: Event) => void, boolean]> = [
    ['keydown', onKeyDown, true],
    ['resize', onReflow, false],
    // Rolagem de qualquer contêiner (captura): o destaque acompanha.
    ['scroll', onReflow, true]
  ]
  // Opções como objeto: em alguns ambientes, `capture` booleano não é reconhecido na remoção.
  for (const [type, listener, capture] of registered) target.addEventListener(type, listener, { capture })
  let attached = true
  return () => {
    if (!attached) return
    attached = false
    for (const [type, listener, capture] of registered) target.removeEventListener(type, listener, { capture })
  }
}
