import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DemoHardwareDetector } from '../../src/main/hardware/detectors'
import { BUILTIN_TOOLS } from '../../src/main/tools/catalog'
import { ToolRegistry } from '../../src/main/tools/tool-registry'
import { DEMO_SCENARIOS, type HardwareProfile } from '../../src/shared/hardware'
import {
  estimateLocalCapability,
  recommendAgents,
  TASK_TYPES,
  type LocalCapabilityLevel,
  type Recommendation,
  type RecommendationFit
} from '../../src/shared/recommendations'
import { exampleAgentProfiles } from '../../src/renderer/src/data/agent-requirements'
import { agents as exampleAgents } from '../../src/renderer/src/data/agents'
import { models } from '../../src/renderer/src/data/models'
import { buildCandidates, capabilityConclusion, recommendationConclusion } from '../../src/renderer/src/lib/advisor'
import { localCapability, recommendationFit } from '../../src/renderer/src/lib/status'

const HARDWARE_UI = join(import.meta.dirname, '../../src/renderer/src/components/hardware')
const read = (name: string) => readFileSync(join(HARDWARE_UI, name), 'utf8')

/** Juízos sobre o equipamento ou incompatibilidade apresentada como confirmada. */
const DEPRECIATIVE = /insuficient|modest|fraco|ruim|ultrapassad|inadequad|obsolet|incompatível|não comporta|impede|requer recursos/i

const tools = new ToolRegistry(BUILTIN_TOOLS).list({})

async function demoProfiles(): Promise<HardwareProfile[]> {
  const scenarios = DEMO_SCENARIOS.filter((s) => s !== 'error')
  return Promise.all(scenarios.map((s) => new DemoHardwareDetector(s).detect(new AbortController().signal)))
}

/** Todas as recomendações possíveis com os perfis de demonstração, em todas as tarefas e sem perfil. */
async function allRecommendations(): Promise<Recommendation[]> {
  const candidates = buildCandidates([], exampleAgents, models, exampleAgentProfiles)
  const profiles: Array<HardwareProfile | null> = [null, ...(await demoProfiles())]
  return profiles.flatMap((hardware) =>
    (['any', ...TASK_TYPES] as const).flatMap((task) =>
      recommendAgents(candidates, {
        hardware,
        hardwareNote: hardware ? undefined : 'Nenhuma análise de hardware realizada ainda.',
        task,
        tools,
        engineAvailable: false
      })
    )
  )
}

describe('Hardware Advisor: linguagem', () => {
  it('nenhum estado de estimativa usa o tom de erro', () => {
    for (const meta of [...Object.values(recommendationFit), ...Object.values(localCapability)]) {
      assert.notEqual(meta.tone, 'danger', meta.label)
    }
    assert.equal(recommendationFit['needs-resources'].tone, 'warning')
    assert.equal(localCapability.insufficient.tone, 'warning')
  })

  it('rótulos identificam estimativas e o que não foi verificado', () => {
    const fits: RecommendationFit[] = ['recommended-local', 'limited', 'needs-resources']
    for (const fit of fits) assert.match(recommendationFit[fit].label, /estimativa/i)
    assert.equal(recommendationFit.unknown.label, 'Não verificado')
    assert.equal(localCapability.unknown.label, 'Não verificado')
  })

  it('rótulos, motivos e conclusões não julgam o equipamento', async () => {
    const texts = [...Object.values(recommendationFit).map((m) => m.label), ...Object.values(localCapability).map((m) => m.label)]
    for (const profile of await demoProfiles()) {
      const estimate = estimateLocalCapability(profile)
      const conclusion = capabilityConclusion(estimate)
      texts.push(estimate.summary, conclusion.headline, conclusion.action, ...estimate.reasons.map((r) => r.message))
    }
    for (const rec of await allRecommendations()) {
      const conclusion = recommendationConclusion(rec)
      texts.push(conclusion.headline, conclusion.action, ...rec.reasons.map((r) => r.message))
    }
    for (const text of texts) assert.doesNotMatch(text, DEPRECIATIVE, text)
  })

  it('os textos fixos das telas do Advisor também não julgam o equipamento', () => {
    for (const file of ['HardwarePanel.tsx', 'AgentRecommendations.tsx', 'ReasonList.tsx']) {
      // Só o texto exibido: literais de string e conteúdo JSX (ignora identificadores como `modest`).
      const shown = [...read(file).matchAll(/'([^'\n]*)'|>([^<>{}\n]+)</g)].map((m) => m[1] ?? m[2] ?? '')
      for (const text of shown) assert.doesNotMatch(text, DEPRECIATIVE, `${file}: ${text}`)
    }
  })

  it('o que impede a recomendação é apresentado como estimativa, sem aparência de erro', async () => {
    const blockers = (await allRecommendations()).flatMap((r) => r.reasons.filter((x) => x.kind === 'blocker'))
    assert.ok(blockers.length > 0)
    for (const b of blockers) assert.match(b.message, /^Estimativa:/, b.message)
    assert.doesNotMatch(read('ReasonList.tsx'), /text-danger|XCircle/)
  })
})

describe('Hardware Advisor: conclusão e ação sugerida', () => {
  it('toda capacidade estimada tem conclusão e sugestão', () => {
    const levels: LocalCapabilityLevel[] = ['high', 'medium', 'low', 'insufficient', 'unknown']
    for (const level of levels) {
      const c = capabilityConclusion({ level, maxModelSizeGb: level === 'unknown' ? null : 3.2, summary: '', reasons: [] })
      assert.ok(c.headline.length > 10 && c.action.length > 10, level)
    }
    assert.equal(
      capabilityConclusion({ level: 'medium', maxModelSizeGb: 7.6, summary: '', reasons: [] }).action,
      'Prefira agentes com modelos de até ~7,6 GB.'
    )
    assert.match(capabilityConclusion({ level: 'low', maxModelSizeGb: 3.6, summary: '', reasons: [] }).action, /^Prefira agentes com modelos leves, de até ~3,6 GB;/)
    assert.match(capabilityConclusion({ level: 'low', maxModelSizeGb: null, summary: '', reasons: [] }).action, /^Prefira agentes com modelos leves;/)
  })

  it('toda recomendação tem conclusão e sugestão coerentes com a adequação', async () => {
    const seen = new Set<RecommendationFit>()
    for (const rec of await allRecommendations()) {
      seen.add(rec.fit)
      const c = recommendationConclusion(rec)
      assert.ok(c.headline && c.action, rec.agentId)
      if (rec.fit === 'needs-resources') assert.match(c.headline, /não recomendado.*estimativa/i)
      if (rec.fit === 'unknown') assert.equal(c.headline, 'Compatibilidade não verificada.')
    }
    assert.deepEqual(seen, new Set(['recommended-local', 'limited', 'needs-resources', 'unknown']))
  })

  it('sem perfil, a sugestão é fazer a análise', () => {
    const [rec] = recommendAgents(buildCandidates([], exampleAgents, models, exampleAgentProfiles), {
      hardware: null,
      hardwareNote: 'Análise de hardware não autorizada: compatibilidade desconhecida.',
      task: 'any',
      tools,
      engineAvailable: false
    })
    assert.match(recommendationConclusion(rec!).action, /análise/)
  })
})

describe('Hardware Advisor: apresentação', () => {
  it('detalhes técnicos ficam recolhidos por padrão', () => {
    for (const file of ['HardwarePanel.tsx', 'AgentRecommendations.tsx']) {
      const source = read(file)
      // Sem `open`: fechado até o usuário pedir.
      assert.match(source, /<details className="disclosure">\s*<summary>Ver detalhes técnicos<\/summary>/, file)
    }
    const panel = read('HardwarePanel.tsx')
    const summary = panel.indexOf('Ver detalhes técnicos')
    for (const detail of ['className="specs"', 'Confiabilidade', '<ReasonList']) {
      assert.ok(panel.lastIndexOf(detail) > summary, `${detail} dentro dos detalhes técnicos`)
    }
    const recs = read('AgentRecommendations.tsx')
    assert.ok(recs.indexOf('<ReasonList') > recs.indexOf('Ver detalhes técnicos'))
  })

  it('dados simulados, exemplos e estimativas continuam identificados', () => {
    const panel = read('HardwarePanel.tsx')
    assert.match(panel, /Dados fictícios: demonstração/)
    assert.match(panel, /<Tag>Estimativa<\/Tag>/)
    assert.match(panel, /Cenário demonstrativo \(fictício\)/)
    const recs = read('AgentRecommendations.tsx')
    assert.match(recs, /<FeatureBadge state="simulated">/)
    assert.match(recs, /perfil de hardware fictício/)
    assert.match(recs, /'Exemplo'/)
  })
})
