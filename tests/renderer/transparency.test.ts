import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DemoHardwareDetector } from '../../src/main/hardware/detectors'
import { BUILTIN_TOOLS } from '../../src/main/tools/catalog'
import { ToolRegistry } from '../../src/main/tools/tool-registry'
import type { AgentRecord } from '../../src/shared/agents'
import type { ModelStatus } from '../../src/shared/engine'
import { recommendAgents } from '../../src/shared/recommendations'
import type { RunRecord, RunState } from '../../src/shared/runs'
import { exampleAgentProfiles } from '../../src/renderer/src/data/agent-requirements'
import { agents as exampleAgents } from '../../src/renderer/src/data/agents'
import { models } from '../../src/renderer/src/data/models'
import { buildCandidates } from '../../src/renderer/src/lib/advisor'
import { formatGb } from '../../src/renderer/src/lib/format'
import { homeStats, isSameLocalDay } from '../../src/renderer/src/lib/home'
import { displayedModelStatus, featureStatus } from '../../src/renderer/src/lib/status'
import { agentDraft } from '../support/fixtures'

const MODEL_STATUSES: ModelStatus[] = ['available', 'downloading', 'loaded', 'error']
const PAGES = join(import.meta.dirname, '../../src/renderer/src/pages')
const page = (name: string) => readFileSync(join(PAGES, name), 'utf8')

const record = (o: Parameters<typeof agentDraft>[0] = {}): AgentRecord => ({
  definition: { ...agentDraft(o), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  availability: { status: 'unavailable', issues: [] }
})

const run = (createdAt: Date, state: RunState = 'completed'): RunRecord => ({
  id: `run-${createdAt.getTime()}-${state}`,
  agentId: 'a',
  origin: 'simulated',
  execution: null,
  state,
  createdAt: createdAt.toISOString(),
  startedAt: null,
  finishedAt: null,
  progress: { percent: null, step: null },
  messages: [],
  error: null,
  cancelRequested: false,
  revision: 0,
  output: '',
  metrics: null
})

describe('vocabulário de estado funcional', () => {
  it('quatro estados com rótulos fixos em português', () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(featureStatus).map(([k, v]) => [k, v.label])),
      { real: 'Real', simulated: 'Simulado', planned: 'Planejado', example: 'Exemplo' }
    )
  })

  it('só o estado real usa o tom de sucesso; os demais têm tons distintos', () => {
    const tones = Object.values(featureStatus).map((s) => s.tone)
    assert.equal(new Set(tones).size, tones.length)
    assert.ok(Object.entries(featureStatus).every(([k, v]) => (v.tone === 'success') === (k === 'real')))
    assert.ok(Object.values(featureStatus).every((s) => s.description.length > 0))
  })
})

describe('modelos de exemplo', () => {
  it('nunca exibem estado operacional (Carregado, download, erro)', () => {
    for (const status of MODEL_STATUSES) assert.equal(displayedModelStatus('example', status), null)
  })

  it('modelos de um provedor real mantêm o estado informado', () => {
    assert.equal(displayedModelStatus('local-provider', 'loaded')?.label, 'Carregado')
    assert.equal(displayedModelStatus('local-provider', 'downloading')?.pulse, true)
  })

  it('tamanhos em formato brasileiro', () => {
    assert.equal(formatGb(4.9), '4,9 GB')
    assert.equal(formatGb(12), '12 GB')
  })
})

describe('indicadores do Início', () => {
  it('conta só agentes gravados não arquivados e os prontos entre eles', () => {
    const stats = homeStats([record({ id: 'a' }), record({ id: 'b', state: 'draft' }), record({ id: 'c', state: 'archived' })], [], new Date())
    assert.equal(stats.savedAgents, 2)
    assert.equal(stats.readyAgents, 1)
  })

  it('"hoje" acompanha a data atual, não uma data fixa', () => {
    const day1 = new Date(2026, 9, 23, 10)
    const day2 = new Date(2026, 9, 24, 10)
    const runs = [run(new Date(2026, 9, 23, 0, 5)), run(new Date(2026, 9, 23, 23, 50)), run(new Date(2026, 9, 24, 8), 'running')]
    assert.equal(homeStats([], runs, day1).simulationsToday, 2)
    assert.equal(homeStats([], runs, day2).simulationsToday, 1)
    assert.equal(homeStats([], runs, day2).activeSimulations, 1)
    assert.equal(isSameLocalDay(new Date(2025, 9, 23, 10).toISOString(), day1), false)
  })

  it('sem dados gravados, tudo zero (nada fictício entra na conta)', () => {
    assert.deepEqual(homeStats([], [], new Date()), { savedAgents: 0, readyAgents: 0, simulationsToday: 0, realRunsToday: 0, activeSimulations: 0 })
  })
})

describe('recomendações com a biblioteca de exemplo', () => {
  const tools = new ToolRegistry(BUILTIN_TOOLS).list({})

  it('modelos de exemplo nunca aparecem como instalados nem tornam o agente executável, mesmo com motor', async () => {
    const hardware = await new DemoHardwareDetector('workstation').detect(new AbortController().signal)
    const candidates = buildCandidates([], exampleAgents, models, exampleAgentProfiles)
    assert.ok(candidates.every((c) => c.model?.source === 'example'))
    const recs = recommendAgents(candidates, { hardware, task: 'any', tools, engineAvailable: true })
    assert.ok(recs.every((r) => !r.executableNow))
    const messages = recs.flatMap((r) => r.reasons.map((x) => x.message))
    assert.ok(messages.every((m) => !m.includes('disponível localmente')))
    assert.ok(messages.some((m) => m.includes('biblioteca de exemplo')))
  })
})

describe('telas: nada fictício apresentado como operacional', () => {
  it('telas que usam dados fictícios identificam a origem', () => {
    for (const file of readdirSync(PAGES).filter((f) => f.endsWith('.tsx'))) {
      const src = page(file)
      if (src.includes("from '@renderer/data/")) {
        assert.match(src, /<Feature(Badge|Notice) state="example"/, `${file} usa dados de exemplo sem identificá-los`)
      }
    }
  })

  it('Início não usa dados fictícios nem data fixa', () => {
    const src = page('HomePage.tsx')
    assert.doesNotMatch(src, /@renderer\/data\//)
    assert.doesNotMatch(src, /\d{4}-\d{2}-\d{2}/)
  })

  it('Ferramentas lê o catálogo do Main e não tem interruptores inertes', () => {
    const src = page('ToolsPage.tsx')
    assert.match(src, /window\.gerpro\.tools\.list\(\)/)
    assert.doesNotMatch(src, /<Switch\b/)
  })

  it('Desenvolvedor não permite alterar porta nem expor na rede', () => {
    const src = page('DeveloperPage.tsx')
    assert.doesNotMatch(src, /0\.0\.0\.0/)
    assert.doesNotMatch(src, /setPort|setLan/)
  })

  it('Modelos e Gerpro AI sem ações mortas ou seletor operacional', () => {
    assert.doesNotMatch(page('ModelsPage.tsx'), /<Menu\b|Carregar modelo/)
    assert.match(page('ChatPage.tsx'), /<Select[\s\S]*?disabled[\s\S]*?\/>/)
  })
})
