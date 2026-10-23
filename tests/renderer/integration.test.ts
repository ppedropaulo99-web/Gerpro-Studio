import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDataHandlers, invokeHandler } from '../../src/main/ipc-handlers'
import { createServices, type Services } from '../../src/main/services'
import { BUILTIN_TOOLS } from '../../src/main/tools/catalog'
import { ToolRegistry } from '../../src/main/tools/tool-registry'
import type { AgentRecord } from '../../src/shared/agents'
import type { Result } from '../../src/shared/errors'
import { IpcChannels } from '../../src/shared/ipc'
import { RUN_TRANSITIONS, type RunRecord } from '../../src/shared/runs'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'
import { agents as exampleAgents } from '../../src/renderer/src/data/agents'
import { runs as exampleRuns } from '../../src/renderer/src/data/runs'
import type { RunStatus } from '../../src/renderer/src/data/types'
import {
  agentFormErrors,
  draftFromForm,
  emptyAgentForm,
  formFromDefinition,
  formFromExample,
  requestedPermissionsFor,
  slugify,
  uniqueId
} from '../../src/renderer/src/lib/agent-form'
import { callApi } from '../../src/renderer/src/lib/api'
import { legacyRunState, runDurationSec, upsertRun } from '../../src/renderer/src/lib/runs'
import { formFromSettings, patchFromForm } from '../../src/renderer/src/lib/settings-form'
import { agentDraft, tempDir } from '../support/fixtures'

const catalog = new ToolRegistry(BUILTIN_TOOLS).list({})

/** Simula o que o Preload faz: chama o handler do canal com os argumentos recebidos. */
function bridge(services: Services) {
  const handlers = createDataHandlers(services)
  return <T>(channel: keyof typeof handlers, ...args: unknown[]) =>
    invokeHandler(channel, handlers[channel], args) as Promise<Result<T>>
}

async function boot(dir: string) {
  const services = await createServices(dir, { stepDelayMs: 1 })
  return { services, call: bridge(services) }
}

describe('mapeamento de estados de execução (dados de exemplo → contrato)', () => {
  it('cobre todos os estados antigos e só aponta para estados do contrato', () => {
    const legacy: RunStatus[] = ['running', 'succeeded', 'failed', 'queued', 'cancelled']
    assert.deepEqual(Object.keys(legacyRunState).sort(), [...legacy].sort())
    for (const state of Object.values(legacyRunState)) assert.ok(state in RUN_TRANSITIONS)
    assert.equal(legacyRunState.succeeded, 'completed')
    assert.equal(legacyRunState.queued, 'pending')
  })

  it('todos os dados de exemplo são mapeáveis', () => {
    assert.ok(exampleRuns.every((r) => legacyRunState[r.status] !== undefined))
  })
})

describe('lista de execuções no Renderer', () => {
  const run = (id: string, createdAt: string, state: RunRecord['state'] = 'pending'): RunRecord => ({
    id,
    agentId: 'a',
    origin: 'simulated',
    execution: null,
    state,
    createdAt,
    startedAt: null,
    finishedAt: null,
    progress: { percent: 0, step: null },
    messages: [],
    error: null,
    cancelRequested: false
  })

  it('atualiza pelo ID e mantém a mais recente primeiro', () => {
    let list = upsertRun([], run('run-1', '2026-10-23T10:00:00Z'))
    list = upsertRun(list, run('run-2', '2026-10-23T11:00:00Z'))
    list = upsertRun(list, run('run-1', '2026-10-23T10:00:00Z', 'running'))
    assert.deepEqual(list.map((r) => `${r.id}:${r.state}`), ['run-2:pending', 'run-1:running'])
  })

  it('duração só existe quando há início e fim', () => {
    assert.equal(runDurationSec({ startedAt: '2026-10-23T10:00:00Z', finishedAt: null }), null)
    assert.equal(runDurationSec({ startedAt: '2026-10-23T10:00:00Z', finishedAt: '2026-10-23T10:01:05Z' }), 65)
  })
})

describe('formulário de agente', () => {
  it('gera IDs válidos e livres a partir do nome', () => {
    assert.equal(slugify('  Análise de Código & Revisão!  '), 'analise-de-codigo-revisao')
    assert.equal(uniqueId('agente', new Set(['agente', 'agente-2'])), 'agente-3')
    assert.equal(uniqueId('', new Set()), 'agente')
  })

  it('permissões solicitadas derivam das ferramentas, sem repetição', () => {
    assert.deepEqual(requestedPermissionsFor(['filesystem', 'document-reader', 'web-search'], catalog), [
      'network',
      'filesystem:read',
      'filesystem:write'
    ])
    assert.deepEqual(requestedPermissionsFor(['calculator'], catalog), [])
  })

  it('formulário vazio em rascunho é aceito; pronto exige modelo e instruções', () => {
    const base = { ...emptyAgentForm(), id: 'meu-agente', name: 'Meu agente' }
    assert.equal(draftFromForm(base, catalog).ok, true)
    const ready = draftFromForm({ ...base, state: 'ready' }, catalog)
    assert.equal(ready.ok, false)
    assert.ok(!ready.ok && ready.errors.modelId && ready.errors.instructions)
  })

  it('números inválidos apontam para o campo certo', () => {
    const result = draftFromForm({ ...emptyAgentForm(), id: 'x1', name: 'X', temperature: '5', topP: '', maxOutputTokens: '1,5' }, catalog)
    assert.ok(!result.ok)
    assert.deepEqual(Object.keys(result.errors).sort(), ['maxOutputTokens', 'temperature', 'topP'])
  })

  it('ida e volta: definição → formulário → rascunho preserva os dados', () => {
    // Inclui o que o formulário não edita: finalidade, provedor e demais parâmetros do perfil.
    const draft = agentDraft({
      tools: ['web-search'],
      requestedPermissions: ['network'],
      taskTypes: ['research'],
      defaultModel: { providerId: 'provedor-local', modelId: 'aurora-8b-instruct' },
      defaultProfile: { ...agentDraft().defaultProfile, temperature: 0.2, topP: 0.9, maxOutputTokens: 512, seed: 7, contextLength: 8192 }
    })
    const back = draftFromForm(formFromDefinition(draft), catalog)
    assert.deepEqual(back, { ok: true, draft })
  })

  it('duplicar exemplo cria rascunho com ID livre e só ferramentas do catálogo', () => {
    const example = exampleAgents[0]!
    const form = formFromExample(example, new Set([example.id]), catalog)
    assert.equal(form.id, `${example.id}-2`)
    assert.equal(form.state, 'draft')
    assert.equal(draftFromForm(form, catalog).ok, true)
    const withGhost = formFromExample({ ...example, tools: ['calculator', 'nao-existe'] }, new Set(), catalog)
    assert.deepEqual(withGhost.tools, ['calculator'])
  })

  it('todos os exemplos podem virar rascunhos válidos', () => {
    for (const example of exampleAgents) {
      assert.equal(draftFromForm(formFromExample(example, new Set(), catalog), catalog).ok, true, example.id)
    }
  })

  it('erros do Main são mapeados para campos', () => {
    assert.deepEqual(agentFormErrors([{ path: '$.defaultModel', message: 'obrigatório' }, { path: '$.outro', message: 'x' }]), {
      modelId: 'obrigatório',
      form: '$.outro: x'
    })
  })
})

describe('formulário de configurações', () => {
  it('sem mudanças não gera alteração', () => {
    const result = patchFromForm(DEFAULT_SETTINGS, formFromSettings(DEFAULT_SETTINGS))
    assert.deepEqual(result, { ok: true, patch: {}, changed: false })
  })

  it('envia só o que mudou; pasta vazia vira padrão (null)', () => {
    const saved: AppSettings = { ...DEFAULT_SETTINGS, models: { directory: 'D:\\modelos', maxRamGb: 16 } }
    const result = patchFromForm(saved, { ...formFromSettings(saved), density: 'compact', modelsDirectory: '  ', maxRamGb: '32' })
    assert.deepEqual(result, { ok: true, patch: { general: { density: 'compact' }, models: { directory: null, maxRamGb: 32 } }, changed: true })
  })

  it('valor inválido aponta para o campo', () => {
    for (const maxRamGb of ['', '0', '2.5', 'abc']) {
      const result = patchFromForm(DEFAULT_SETTINGS, { ...formFromSettings(DEFAULT_SETTINGS), maxRamGb })
      assert.ok(!result.ok && result.errors.maxRamGb, maxRamGb)
    }
  })
})

describe('ponte com o Main', () => {
  it('falha da ponte vira erro estruturado', async () => {
    const result = await callApi(() => Promise.reject(new Error('Preload ausente')))
    assert.deepEqual(result, {
      ok: false,
      error: { code: 'internal', message: 'Não foi possível comunicar com o processo principal.', retryable: true }
    })
  })
})

describe('integração ponta a ponta (Renderer → IPC → serviços → disco)', () => {
  it('configurações persistem após reiniciar', async () => {
    const dir = await tempDir()
    const first = await boot(dir)
    const loaded = await first.call<AppSettings>(IpcChannels.settingsGet)
    assert.ok(loaded.ok)
    const pending = patchFromForm(loaded.data, { ...formFromSettings(loaded.data), language: 'es', maxRamGb: '64' })
    assert.ok(pending.ok && pending.changed)
    assert.equal((await first.call(IpcChannels.settingsUpdate, pending.patch)).ok, true)
    first.services.runs.dispose()

    const second = await boot(dir)
    const reloaded = await second.call<AppSettings>(IpcChannels.settingsGet)
    assert.ok(reloaded.ok)
    assert.equal(reloaded.data.general.language, 'es')
    assert.equal(reloaded.data.privacy.telemetry, false)
    assert.equal(reloaded.data.models.maxRamGb, 64)
    second.services.runs.dispose()
  })

  it('criar, editar, arquivar e excluir agentes; indisponível sem motor; persiste após reiniciar', async () => {
    const dir = await tempDir()
    const app = await boot(dir)
    const form = { ...emptyAgentForm(), id: 'revisor', name: 'Revisor', modelId: 'koda-coder-6b', instructions: 'Revise.', state: 'ready' as const, tools: ['filesystem'] }
    const draft = draftFromForm(form, catalog)
    assert.ok(draft.ok)

    const created = await app.call<AgentRecord>(IpcChannels.agentsCreate, draft.draft)
    assert.ok(created.ok)
    assert.equal(created.data.availability.status, 'unavailable')
    assert.ok(created.data.availability.issues.some((i) => i.code === 'engine-unavailable'))

    const duplicate = await app.call(IpcChannels.agentsCreate, draft.draft)
    assert.equal(!duplicate.ok && duplicate.error.code, 'conflict')

    const edited = draftFromForm({ ...formFromDefinition(created.data.definition), name: 'Revisor de PRs' }, catalog)
    assert.ok(edited.ok)
    const updated = await app.call<AgentRecord>(IpcChannels.agentsUpdate, edited.draft)
    assert.ok(updated.ok)
    assert.equal(updated.data.definition.createdAt, created.data.definition.createdAt)

    const archived = await app.call<AgentRecord>(IpcChannels.agentsUpdate, { ...edited.draft, state: 'archived' })
    assert.ok(archived.ok && archived.data.availability.status === 'archived')
    const blocked = await app.call(IpcChannels.runsStartDemo, { agentId: 'revisor', scenario: 'success' })
    assert.equal(!blocked.ok && blocked.error.code, 'invalid-state', 'agente arquivado não executa nem em simulação')
    app.services.runs.dispose()

    const restarted = await boot(dir)
    const list = await restarted.call<AgentRecord[]>(IpcChannels.agentsList)
    assert.ok(list.ok)
    assert.deepEqual(list.data.map((a) => [a.definition.name, a.definition.state]), [['Revisor de PRs', 'archived']])
    assert.equal((await restarted.call(IpcChannels.agentsDelete, 'revisor')).ok, true)
    const empty = await restarted.call<AgentRecord[]>(IpcChannels.agentsList)
    assert.ok(empty.ok && empty.data.length === 0)
    restarted.services.runs.dispose()
  })

  it('execução simulada: eventos chegam em ordem, sempre marcados como simulados e só em memória', async () => {
    const dir = await tempDir()
    const app = await boot(dir)
    await app.call(IpcChannels.agentsCreate, agentDraft())

    let list: RunRecord[] = []
    const done = new Promise<void>((resolve) => {
      app.services.runs.onUpdate((run) => {
        list = upsertRun(list, run)
        if (run.state === 'completed') resolve()
      })
    })
    const started = await app.call<RunRecord>(IpcChannels.runsStartDemo, { agentId: 'assistente-geral', scenario: 'success' })
    assert.ok(started.ok && started.data.origin === 'simulated')
    await done

    assert.equal(list.length, 1)
    assert.equal(list[0]!.state, 'completed')
    assert.equal(list[0]!.origin, 'simulated')
    const fromMain = await app.call<RunRecord[]>(IpcChannels.runsList)
    assert.ok(fromMain.ok)
    assert.deepEqual(fromMain.data, list)
    app.services.runs.dispose()

    const restarted = await boot(dir)
    const afterRestart = await restarted.call<RunRecord[]>(IpcChannels.runsList)
    assert.ok(afterRestart.ok && afterRestart.data.length === 0, 'execuções simuladas não são persistidas')
    restarted.services.runs.dispose()
  })
})
