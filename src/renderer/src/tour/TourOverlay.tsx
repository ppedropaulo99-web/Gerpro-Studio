import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, EyeOff, X } from 'lucide-react'
import { Button, Notice, ProgressBar, StatusBadge } from '@renderer/components/ui'
import type { Tone } from '@renderer/components/ui/tone'
import { findAnchor, SCROLL_CONTAINER } from './anchors'
import { attachTourListeners } from './listeners'
import { appArea, intersect, scrollDelta, spotlightRect, type Rect } from './placement'
import { TOUR_FEATURE_LABELS, type TourFeatureState } from './steps'
import type { TourProgress } from './tour-state'

/** Tentativas de localizar o componente enquanto a tela carrega os dados. */
const LOCATE_INTERVAL_MS = 100
const LOCATE_ATTEMPTS = 25

const FEATURE_TONE: Record<TourFeatureState, Tone> = { implemented: 'success', demo: 'warning', planned: 'neutral' }

type Spot = { rect: Rect; clipped: boolean }

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })

/** Área visível do componente: a da tela (se estiver numa área com rolagem) dentro da área do app. */
function visibleArea(el: HTMLElement): Rect {
  const area = appArea(viewport())
  const container = el.closest<HTMLElement>(SCROLL_CONTAINER)
  return container ? intersect(container.getBoundingClientRect(), area) : area
}

interface Props {
  progress: TourProgress
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

export function TourOverlay({ progress, onNext, onPrev, onClose }: Props) {
  const { step } = progress
  const [spot, setSpot] = useState<Spot | null>(null)
  const [status, setStatus] = useState<'locating' | 'found' | 'missing'>('locating')
  const measure = useRef<() => void>(() => undefined)
  const panel = useRef<HTMLElement>(null)

  // Teclado e reposicionamento; removidos ao encerrar.
  useEffect(
    () =>
      attachTourListeners(window, {
        onKey: (action) => (action === 'close' ? onClose() : action === 'next' ? onNext() : onPrev()),
        onReflow: () => measure.current()
      }),
    [onClose, onNext, onPrev]
  )

  // Foco no painel ao abrir; o app atrás dele fica inerte.
  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('.tour__next')?.focus()
  }, [])

  // Localiza o componente da etapa, rola até ele e acompanha mudanças de tamanho.
  useEffect(() => {
    let el: HTMLElement | null = null
    let tries = 0
    let timer = 0
    let observer: ResizeObserver | null = null
    setStatus('locating')
    setSpot(null)

    const update = () => {
      if (!el?.isConnected) {
        setSpot(null)
        return
      }
      setSpot(spotlightRect(el.getBoundingClientRect(), visibleArea(el)))
    }
    measure.current = update

    const locate = () => {
      el = findAnchor<HTMLElement>(document, step.target)
      if (el) {
        const container = el.closest<HTMLElement>(SCROLL_CONTAINER)
        if (container) container.scrollTop += scrollDelta(el.getBoundingClientRect(), container.getBoundingClientRect())
        observer = new ResizeObserver(update)
        observer.observe(el)
        setStatus('found')
        update()
        return
      }
      if (++tries >= LOCATE_ATTEMPTS) setStatus('missing')
      else timer = window.setTimeout(locate, LOCATE_INTERVAL_MS)
    }
    // Primeira busca depois da troca de tela.
    timer = window.setTimeout(locate, 0)

    return () => {
      window.clearTimeout(timer)
      observer?.disconnect()
      measure.current = () => undefined
    }
  }, [step.target, step.id])

  const missing = status === 'missing' || (status === 'found' && !spot)

  return createPortal(
    <div className="tour" data-testid="tour">
      {/* Bloqueia o app: a apresentação é somente leitura. */}
      {/* `preventDefault` no clique mantém o foco no painel. */}
      <div className="tour__blocker" aria-hidden onMouseDown={(e) => e.preventDefault()} />
      {spot ? (
        <div className="tour__spotlight" aria-hidden style={{ top: spot.rect.top, left: spot.rect.left, width: spot.rect.width, height: spot.rect.height }} />
      ) : (
        <div className="tour__dim" aria-hidden />
      )}

      <aside ref={panel} className="tour__panel" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-description">
        <header className="tour__head">
          <span className="tour__eyebrow">
            Capítulo {progress.chapterPosition} de {progress.chapterCount} · {progress.chapter.title}
          </span>
          <Button variant="ghost" size="sm" iconOnly aria-label="Encerrar apresentação" title="Encerrar apresentação (Esc)" icon={<X size={16} />} onClick={onClose} />
        </header>

        <div className="tour__body">
          <h2 id="tour-title" className="tour__title">
            {step.title}
          </h2>
          <div className="row">
            <StatusBadge tone={FEATURE_TONE[step.feature]}>{TOUR_FEATURE_LABELS[step.feature]}</StatusBadge>
          </div>
          <p id="tour-description" className="tour__description">
            {step.description}
          </p>
          {missing && (
            <Notice tone="neutral" icon={<EyeOff size={16} />}>
              Este componente não está visível agora (por exemplo, sem dados para exibir). A explicação continua válida.
            </Notice>
          )}
          {spot?.clipped && <p className="subtle">O componente continua além da área visível.</p>}
        </div>

        <footer className="tour__foot">
          <div className="tour__progress">
            <span className="subtle">
              Etapa {progress.position} de {progress.total}
            </span>
            <ProgressBar value={progress.percent} label={`Etapa ${progress.position} de ${progress.total}`} />
          </div>
          <div className="tour__controls">
            <Button variant="secondary" icon={<ChevronLeft size={15} />} disabled={progress.isFirst} onClick={onPrev}>
              Anterior
            </Button>
            {progress.isLast ? (
              <Button className="tour__next" variant="primary" onClick={onClose}>
                Concluir
              </Button>
            ) : (
              <Button className="tour__next" variant="primary" onClick={onNext}>
                Próximo <ChevronRight size={15} />
              </Button>
            )}
          </div>
          <span className="tour__hint subtle">Esc encerra · ← → navegam</span>
        </footer>
      </aside>
    </div>,
    document.body
  )
}
