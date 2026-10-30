import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { NavigationController } from '../../src/renderer/src/app/navigation-guard'
import type { RouteId } from '../../src/renderer/src/app/route-ids'
import { findAnchor, tourSelector } from '../../src/renderer/src/tour/anchors'
import { attachTourListeners, tourKeyAction } from '../../src/renderer/src/tour/listeners'
import { appArea, overlaps, panelRect, panelWidth, scrollDelta, spotlightRect, TOUR_PANEL, type Rect } from '../../src/renderer/src/tour/placement'
import { TOUR_CHAPTERS, TOUR_STEPS, validateTour, type TourChapter, type TourStep } from '../../src/renderer/src/tour/steps'
import { canStartTour, showRoute, TOUR_IDLE, tourProgress, tourReducer, type TourState } from '../../src/renderer/src/tour/tour-state'

const SRC = join(import.meta.dirname, '../../src/renderer/src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}
const ROUTES = [...read('app/route-ids.ts').matchAll(/'([a-z]+)'/g)].map((m) => m[1]!)

const step = (id: string, chapter: string, o: Partial<TourStep> = {}): TourStep => ({
  id,
  chapter,
  title: id,
  description: 'Descrição.',
  route: 'home',
  target: id,
  feature: 'implemented',
  ...o
})

describe('apresentação guiada: roteiro', () => {
  it('o roteiro é consistente', () => {
    assert.ok(ROUTES.length >= 8)
    assert.deepEqual(validateTour(TOUR_CHAPTERS, TOUR_STEPS, ROUTES), [])
  })

  it('todo alvo está marcado em um componente real', () => {
    const marked = new Set<string>()
    for (const file of files(SRC).filter((f) => f.endsWith('.tsx'))) {
      // `data-tour="x"`, `tour="x"` ou condicional (`data-tour={i === 0 ? 'x' : undefined}`).
      for (const m of readFileSync(file, 'utf8').matchAll(/\b(?:data-tour|tour)=(?:"|\{[^}]*?')([a-z0-9.-]+)['"]/g)) marked.add(m[1]!)
    }
    for (const s of TOUR_STEPS) assert.ok(marked.has(s.target), `${s.id}: alvo ${s.target} sem data-tour`)
  })

  it('cada etapa declara capítulo, tela, alvo e estado da funcionalidade, e nada mais', () => {
    for (const s of TOUR_STEPS) {
      assert.deepEqual(Object.keys(s).sort(), ['chapter', 'description', 'feature', 'id', 'route', 'target', 'title'])
      assert.ok(['implemented', 'demo', 'development', 'planned'].includes(s.feature))
    }
    // Todas as telas existentes são apresentadas.
    assert.deepEqual([...new Set(TOUR_STEPS.map((s) => s.route))].sort(), [...ROUTES].sort())
  })

  it('a validação aponta ids repetidos, capítulos e telas inexistentes e ordem errada', () => {
    const chapters: TourChapter[] = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' }
    ]
    const problems = validateTour(chapters, [step('x', 'b'), step('x', 'a'), step('y', 'z'), step('w', 'b', { route: 'nada' as RouteId })], ROUTES)
    assert.ok(problems.some((p) => p.includes('id repetido')))
    assert.ok(problems.some((p) => p.includes('fora da ordem')))
    assert.ok(problems.some((p) => p.includes('capítulo inexistente')))
    assert.ok(problems.some((p) => p.includes('tela inexistente')))
  })
})

describe('apresentação guiada: navegação e contador', () => {
  const total = TOUR_STEPS.length
  const run = (actions: Parameters<typeof tourReducer>[1][], from: TourState = TOUR_IDLE, n = total) => actions.reduce((s, a) => tourReducer(s, a, n), from)

  it('avança, volta e respeita os limites', () => {
    const started = run([{ type: 'start', origin: 'agents' }])
    assert.deepEqual(started, { active: true, index: 0, origin: 'agents' })
    assert.equal(run([{ type: 'prev' }], started).index, 0)
    assert.equal(run([{ type: 'next' }, { type: 'next' }, { type: 'prev' }], started).index, 1)
    const atEnd = run([{ type: 'goto', index: 999 }], started)
    assert.equal(atEnd.index, total - 1)
    assert.equal(run([{ type: 'next' }], atEnd), atEnd)
  })

  it('sem apresentação ativa, nada avança; encerrar volta ao estado inicial', () => {
    assert.equal(run([{ type: 'next' }]), TOUR_IDLE)
    assert.equal(run([{ type: 'start', origin: 'home' }, { type: 'next' }, { type: 'close' }]), TOUR_IDLE)
    assert.equal(run([{ type: 'start', origin: 'home' }], TOUR_IDLE, 0), TOUR_IDLE)
  })

  it('o contador é calculado do roteiro', () => {
    const first = tourProgress(TOUR_CHAPTERS, TOUR_STEPS, 0)!
    assert.equal(first.total, TOUR_STEPS.length)
    assert.equal(first.chapterCount, TOUR_CHAPTERS.length)
    assert.ok(first.isFirst && !first.isLast)
    const last = tourProgress(TOUR_CHAPTERS, TOUR_STEPS, TOUR_STEPS.length - 1)!
    assert.ok(last.isLast)
    assert.equal(last.percent, 100)
    assert.equal(tourProgress(TOUR_CHAPTERS, TOUR_STEPS, TOUR_STEPS.length), null)
  })

  it('outro roteiro, outros totais; capítulo sem etapas não conta', () => {
    const chapters: TourChapter[] = [
      { id: 'a', title: 'A' },
      { id: 'vazio', title: 'Vazio' },
      { id: 'b', title: 'B' }
    ]
    const steps = [step('a1', 'a'), step('a2', 'a'), step('b1', 'b')]
    const p = tourProgress(chapters, steps, 2)!
    assert.equal(p.total, 3)
    assert.equal(p.chapterCount, 2)
    assert.equal(p.chapterPosition, 2)
    assert.deepEqual([p.stepInChapter, p.chapterSteps], [1, 1])
    assert.deepEqual([tourProgress(chapters, steps, 1)!.stepInChapter, tourProgress(chapters, steps, 1)!.chapterSteps], [2, 2])
  })

  it('setas navegam e Esc encerra; outras teclas são ignoradas', () => {
    assert.equal(tourKeyAction('Escape'), 'close')
    assert.equal(tourKeyAction('ArrowRight'), 'next')
    assert.equal(tourKeyAction('ArrowLeft'), 'prev')
    assert.equal(tourKeyAction('Enter'), null)
    assert.equal(tourKeyAction('a'), null)
  })
})

describe('apresentação guiada: proteção de dados', () => {
  it('não começa com alterações não salvas', () => {
    const nav = new NavigationController<RouteId>('settings')
    const guard = nav.register('nas configurações')
    nav.setDirty(guard, true)
    const check = canStartTour(nav)
    assert.equal(check.ok, false)
    nav.setDirty(guard, false)
    assert.equal(canStartTour(nav).ok, true)
  })

  it('troca de tela pela navegação do app; se for retida, nada é descartado', () => {
    const nav = new NavigationController<RouteId>('home')
    assert.equal(showRoute(nav, 'agents'), 'ok')
    assert.equal(nav.getSnapshot().current, 'agents')
    const guard = nav.register('no agente em edição')
    nav.setDirty(guard, true)
    assert.equal(showRoute(nav, 'settings'), 'blocked')
    // Confirmação cancelada e alteração preservada: continua na mesma tela, ainda pendente.
    assert.deepEqual(nav.getSnapshot(), { current: 'agents', pending: null, blockedBy: null })
    assert.equal(nav.hasUnsavedChanges(), true)
  })

  it('o código da apresentação não chama o Main, a rede nem o armazenamento', () => {
    const tourFiles = files(join(SRC, 'tour'))
    assert.ok(tourFiles.length >= 7)
    for (const file of tourFiles) {
      const text = readFileSync(file, 'utf8')
      assert.doesNotMatch(text, /window\.gerpro|callApi|fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|ipcRenderer/, file)
    }
  })

  it('o app fica inerte e bloqueado enquanto a apresentação está aberta', () => {
    const shell = read('components/layout/AppShell.tsx')
    assert.match(shell, /inert=\{tour\.active\}/)
    assert.match(shell, /tour\.active && 'shell--touring'/)
    assert.match(read('tour/TourOverlay.tsx'), /className="tour__blocker"/)
  })
})

describe('apresentação guiada: componentes ausentes', () => {
  const el = (rect: Rect) => ({ getBoundingClientRect: () => rect })
  const root = (map: Record<string, ReturnType<typeof el>>) => ({ querySelector: (sel: string) => map[sel] ?? null })

  it('encontra pelo atributo; ausente ou sem área = null', () => {
    const visible = el({ top: 10, left: 10, width: 100, height: 40 })
    assert.equal(findAnchor(root({ [tourSelector('a')]: visible }), 'a'), visible)
    assert.equal(findAnchor(root({}), 'a'), null)
    assert.equal(findAnchor(root({ [tourSelector('a')]: el({ top: 0, left: 0, width: 0, height: 0 }) }), 'a'), null)
    assert.equal(tourSelector('home.stats'), '[data-tour="home.stats"]')
  })

  it('a etapa sem componente continua navegável', () => {
    assert.match(read('tour/TourOverlay.tsx'), /não está visível agora/)
    assert.match(read('tour/TourOverlay.tsx'), /className="tour__dim"/)
  })
})

describe('apresentação guiada: posicionamento', () => {
  const VIEWPORTS = [
    { width: 1440, height: 900 },
    { width: 960, height: 600 }
  ]

  it('a coluna do painel coincide com o CSS', () => {
    const css = read('styles/tokens.css')
    assert.match(css, new RegExp(`--tour-panel-width: ${TOUR_PANEL.narrow}px`))
    assert.match(css, new RegExp(`min-width: ${TOUR_PANEL.breakpoint}px\\)[^}]*--tour-panel-width: ${TOUR_PANEL.wide}px`))
    assert.equal(panelWidth({ width: 1440, height: 900 }), TOUR_PANEL.wide)
    assert.equal(panelWidth({ width: 960, height: 600 }), TOUR_PANEL.narrow)
  })

  it('o destaque nunca fica sob o painel', () => {
    for (const vp of VIEWPORTS) {
      const area = appArea(vp)
      const panel = panelRect(vp, 40)
      for (const target of [
        { top: 50, left: 0, width: area.width, height: 200 },
        { top: 100, left: area.width - 50, width: 400, height: 80 },
        { top: -100, left: 200, width: 300, height: 2000 }
      ]) {
        const { rect } = spotlightRect(target, area)
        assert.equal(overlaps(rect, panel), false, JSON.stringify({ vp, target }))
      }
    }
  })

  it('recorta à área visível e informa quando o alvo não cabe', () => {
    const area = { top: 40, left: 0, width: 600, height: 500 }
    assert.deepEqual(spotlightRect({ top: 100, left: 100, width: 200, height: 100 }, area, 6), {
      rect: { top: 94, left: 94, width: 212, height: 112 },
      clipped: false
    })
    const tall = spotlightRect({ top: 60, left: 20, width: 200, height: 900 }, area, 6)
    assert.equal(tall.clipped, true)
    assert.equal(tall.rect.top + tall.rect.height, 540)
  })

  it('rola só o necessário: nada se já visível, centraliza se cabe, alinha o topo se não cabe', () => {
    const container = { top: 40, left: 0, width: 800, height: 560 }
    assert.equal(scrollDelta({ top: 100, left: 0, width: 10, height: 100 }, container), 0)
    // Abaixo da área: centro do alvo vai ao centro do contêiner.
    assert.equal(scrollDelta({ top: 900, left: 0, width: 10, height: 100 }, container), 950 - 320)
    // Maior que a área: topo do alvo a 16 px do topo do contêiner.
    assert.equal(scrollDelta({ top: 900, left: 0, width: 10, height: 1000 }, container), 900 - 56)
  })
})

describe('apresentação guiada: limpeza de efeitos', () => {
  function counting() {
    const target = new EventTarget()
    let active = 0
    const add = target.addEventListener.bind(target)
    const remove = target.removeEventListener.bind(target)
    return {
      target: {
        addEventListener: ((...args: Parameters<EventTarget['addEventListener']>) => {
          active++
          add(...args)
        }) as EventTarget['addEventListener'],
        removeEventListener: ((...args: Parameters<EventTarget['removeEventListener']>) => {
          active--
          remove(...args)
        }) as EventTarget['removeEventListener'],
        dispatchEvent: (e: Event) => target.dispatchEvent(e)
      },
      active: () => active
    }
  }
  const key = (k: string) => Object.assign(new Event('keydown', { cancelable: true }), { key: k })

  it('registra teclado, redimensionamento e rolagem; o descarte remove tudo', () => {
    const t = counting()
    const keys: string[] = []
    let reflows = 0
    const dispose = attachTourListeners(t.target, { onKey: (a) => keys.push(a), onReflow: () => reflows++ })
    assert.equal(t.active(), 3)
    t.target.dispatchEvent(key('Escape'))
    t.target.dispatchEvent(key('ArrowRight'))
    t.target.dispatchEvent(key('x'))
    t.target.dispatchEvent(new Event('resize'))
    t.target.dispatchEvent(new Event('scroll'))
    assert.deepEqual(keys, ['close', 'next'])
    assert.equal(reflows, 2)

    dispose()
    assert.equal(t.active(), 0)
    t.target.dispatchEvent(key('Escape'))
    t.target.dispatchEvent(new Event('resize'))
    assert.deepEqual(keys, ['close', 'next'])
    assert.equal(reflows, 2)
    // Descartar de novo não remove nada a mais.
    dispose()
    assert.equal(t.active(), 0)
  })

  it('teclas da apresentação não chegam ao app', () => {
    const t = counting()
    const dispose = attachTourListeners(t.target, { onKey: () => undefined, onReflow: () => undefined })
    const esc = key('Escape')
    t.target.dispatchEvent(esc)
    assert.equal(esc.defaultPrevented, true)
    const other = key('Tab')
    t.target.dispatchEvent(other)
    assert.equal(other.defaultPrevented, false)
    dispose()
  })

  it('a sobreposição só existe enquanto a apresentação está ativa e desfaz os efeitos ao desmontar', () => {
    assert.match(read('tour/TourProvider.tsx'), /\{progress && <TourOverlay/)
    const overlay = read('tour/TourOverlay.tsx')
    assert.match(overlay, /observer\?\.disconnect\(\)/)
    assert.match(overlay, /window\.clearTimeout\(timer\)/)
    assert.match(overlay, /attachTourListeners\(window/)
  })
})
