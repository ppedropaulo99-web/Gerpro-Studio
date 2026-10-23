import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AppError } from '../../src/main/errors'
import { DEMO_STEPS, DemoRunManager } from '../../src/main/runs/demo-run-manager'
import type { RunRecord } from '../../src/shared/runs'
import { fakeClock, ManualScheduler } from '../support/fixtures'

function setup(maxRecords?: number) {
  const scheduler = new ManualScheduler()
  let n = 0
  const manager = new DemoRunManager({
    canRun: (id) => (id === 'agente' ? { ok: true } : { ok: false, reason: 'não existe' }),
    scheduler,
    now: fakeClock(),
    newId: () => `run-${++n}`,
    maxRecords
  })
  const events: RunRecord[] = []
  manager.onUpdate((run) => events.push(run))
  return { scheduler, manager, events }
}

const isCode = (code: string) => (e: unknown) => e instanceof AppError && e.code === code

describe('gerenciador demonstrativo de execuções', () => {
  it('cenário de sucesso: pending → running → completed, sempre simulado', () => {
    const { scheduler, manager, events } = setup()
    const run = manager.start({ agentId: 'agente', scenario: 'success' })
    assert.equal(run.state, 'pending')
    assert.equal(run.origin, 'simulated')

    scheduler.flush()
    const done = manager.get(run.id)!
    assert.equal(done.state, 'completed')
    assert.equal(done.progress.percent, 100)
    assert.ok(done.startedAt && done.finishedAt && done.startedAt < done.finishedAt)
    assert.equal(done.error, null)

    const states = [...new Set(events.map((e) => e.state))]
    assert.deepEqual(states, ['pending', 'running', 'completed'])
    assert.ok(events.every((e) => e.origin === 'simulated'))
    const percents = events.map((e) => e.progress.percent ?? 0)
    assert.deepEqual(percents, [...percents].sort((a, b) => a - b), 'progresso nunca regride')
    assert.ok(done.messages.some((m) => /nenhum modelo ou ferramenta real/i.test(m.text)))
    assert.ok(DEMO_STEPS.every((s) => s.includes('(simulado)')))
  })

  it('cenário de falha: termina em failed com erro estruturado', () => {
    const { scheduler, manager } = setup()
    const run = manager.start({ agentId: 'agente', scenario: 'failure' })
    scheduler.flush()
    const failed = manager.get(run.id)!
    assert.equal(failed.state, 'failed')
    assert.equal(failed.error?.code, 'simulated-failure')
    assert.ok(failed.finishedAt)
    assert.ok(failed.progress.percent! < 100)
  })

  it('cancelar pendente encerra na hora e para o temporizador', () => {
    const { scheduler, manager } = setup()
    const run = manager.start({ agentId: 'agente', scenario: 'success' })
    const cancelled = manager.cancel(run.id)
    assert.equal(cancelled.state, 'cancelled')
    assert.equal(cancelled.startedAt, null)
    assert.equal(scheduler.pending, 0)
  })

  it('cancelar em execução é cooperativo: marca o pedido e encerra na etapa seguinte', () => {
    const { scheduler, manager } = setup()
    const run = manager.start({ agentId: 'agente', scenario: 'success' })
    scheduler.step() // pending → running
    scheduler.step() // primeira etapa
    const requested = manager.cancel(run.id)
    assert.equal(requested.state, 'running')
    assert.equal(requested.cancelRequested, true)
    assert.equal(manager.cancel(run.id).cancelRequested, true, 'pedido repetido é idempotente')

    scheduler.flush()
    const final = manager.get(run.id)!
    assert.equal(final.state, 'cancelled')
    assert.ok(final.progress.percent! < 100)
  })

  it('não cancela execução encerrada nem inexistente', () => {
    const { scheduler, manager } = setup()
    const run = manager.start({ agentId: 'agente', scenario: 'success' })
    scheduler.flush()
    assert.throws(() => manager.cancel(run.id), isCode('invalid-state'))
    assert.throws(() => manager.cancel('run-999'), isCode('not-found'))
    assert.throws(() => manager.cancel(42), isCode('validation'))
  })

  it('valida o pedido e o agente', () => {
    const { manager } = setup()
    assert.throws(() => manager.start({ agentId: 'outro', scenario: 'success' }), isCode('invalid-state'))
    assert.throws(() => manager.start({ agentId: 'agente' }), isCode('validation'))
    assert.equal(manager.list().length, 0)
  })

  it('cópias entregues não alteram o estado interno', () => {
    const { manager } = setup()
    const run = manager.start({ agentId: 'agente', scenario: 'success' })
    run.state = 'completed'
    manager.list()[0]!.messages.push({ at: '', level: 'info', text: 'intruso' })
    assert.equal(manager.get(run.id)!.state, 'pending')
    assert.equal(manager.get(run.id)!.messages.length, 1)
  })

  it('limita o histórico descartando as encerradas mais antigas', () => {
    const { scheduler, manager } = setup(2)
    manager.start({ agentId: 'agente', scenario: 'success' })
    scheduler.flush()
    manager.start({ agentId: 'agente', scenario: 'success' })
    manager.start({ agentId: 'agente', scenario: 'success' })
    assert.deepEqual(manager.list().map((r) => r.id), ['run-3', 'run-2'])
  })
})
