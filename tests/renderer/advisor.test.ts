import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DemoHardwareDetector } from '../../src/main/hardware/detectors'
import { BUILTIN_TOOLS } from '../../src/main/tools/catalog'
import { ToolRegistry } from '../../src/main/tools/tool-registry'
import type { AgentRecord } from '../../src/shared/agents'
import { NO_CONSENT, type HardwareAdvisorState } from '../../src/shared/hardware'
import { recommendAgents } from '../../src/shared/recommendations'
import { exampleAgentProfiles } from '../../src/renderer/src/data/agent-requirements'
import { agents as exampleAgents } from '../../src/renderer/src/data/agents'
import { models } from '../../src/renderer/src/data/models'
import { advisorHardware, buildCandidates, diagnosticRows } from '../../src/renderer/src/lib/advisor'
import { agentDraft } from '../support/fixtures'

const tools = new ToolRegistry(BUILTIN_TOOLS).list({})
const record = (o: Parameters<typeof agentDraft>[0] = {}): AgentRecord => ({
  definition: { ...agentDraft(o), createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' },
  availability: { status: 'unavailable', issues: [] }
})
const state = (o: Partial<HardwareAdvisorState>): HardwareAdvisorState => ({
  consent: NO_CONSENT,
  status: 'not-authorized',
  analysis: null,
  hasStoredData: false,
  detectors: { real: { available: false, reason: 'x' }, demo: { available: true, reason: null } },
  staleAfterDays: 30,
  ...o
})

describe('Advisor na interface', () => {
  it('candidatos: agentes salvos (exceto arquivados) e todos os exemplos', () => {
    const saved = [record({ id: 'meu', model: { engineId: null, modelId: 'fora-da-biblioteca' } }), record({ id: 'velho', state: 'archived' })]
    const candidates = buildCandidates(saved, exampleAgents, models, exampleAgentProfiles)
    assert.equal(candidates.length, 1 + exampleAgents.length)
    const mine = candidates.find((c) => c.origin === 'saved')!
    assert.equal(mine.model, null)
    assert.equal(mine.taskTypes, null)
    assert.ok(candidates.filter((c) => c.origin === 'example').every((c) => c.model && c.taskTypes))
    assert.equal(candidates.find((c) => c.agentId === 'analista-dados')!.requirements?.source, 'declared')
  })

  it('sem autorização: tudo "desconhecido" e nada executável', () => {
    const { profile, note } = advisorHardware(state({}))
    assert.equal(profile, null)
    const recs = recommendAgents(buildCandidates([], exampleAgents, models, exampleAgentProfiles), {
      hardware: profile,
      hardwareNote: note,
      task: 'any',
      tools,
      engineAvailable: false
    })
    assert.ok(recs.every((r) => r.fit === 'unknown' && !r.executableNow))
    assert.ok(recs.every((r) => r.reasons.some((x) => x.message === note)))
  })

  it('com perfis demonstrativos: as quatro categorias aparecem e nenhuma é executável', async () => {
    const saved = [record({ id: 'meu', model: { engineId: null, modelId: 'fora-da-biblioteca' } })]
    const fitsFor = async (scenario: 'workstation' | 'modest') => {
      const profile = await new DemoHardwareDetector(scenario).detect(new AbortController().signal)
      const hw = advisorHardware(
        state({
          consent: { ...NO_CONSENT, localAnalysis: { status: 'granted', decidedAt: profile.provenance.collectedAt, scope: 'demo-only' } },
          status: 'completed',
          analysis: { mode: 'demo', attemptedAt: profile.provenance.collectedAt, outcome: { kind: 'completed', profile } }
        })
      )
      assert.equal(hw.profile?.provenance.source, 'demo')
      const recs = recommendAgents(buildCandidates(saved, exampleAgents, models, exampleAgentProfiles), {
        hardware: hw.profile,
        task: 'any',
        tools,
        engineAvailable: false
      })
      assert.ok(recs.every((r) => !r.executableNow))
      return new Set(recs.map((r) => r.fit))
    }
    const workstation = await fitsFor('workstation')
    const modest = await fitsFor('modest')
    assert.ok(!workstation.has('needs-resources'), 'a estação comporta todos os exemplos')
    assert.ok(modest.has('needs-resources'), 'o perfil de 8 GB sem GPU tem agentes não recomendados')
    assert.deepEqual(new Set([...workstation, ...modest]), new Set(['recommended-local', 'limited', 'needs-resources', 'unknown']))
  })

  it('diagnóstico: campos desconhecidos aparecem como tal', async () => {
    const partial = await new DemoHardwareDetector('partial').detect(new AbortController().signal)
    const rows = diagnosticRows(partial)
    assert.deepEqual(rows.filter((r) => !r.known).map((r) => r.label), ['GPU e VRAM', 'Armazenamento', 'Aceleração'])
    const modest = diagnosticRows(await new DemoHardwareDetector('modest').detect(new AbortController().signal))
    assert.equal(modest.find((r) => r.label === 'GPU e VRAM')!.value, 'Nenhuma GPU dedicada')
  })
})
