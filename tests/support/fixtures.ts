import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import type { AgentDraft } from '../../src/shared/agents'
import type { Scheduler } from '../../src/main/runs/demo-run-manager'

/** Diretório temporário removido ao fim do arquivo de teste. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gerpro-test-'))
  after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

export function agentDraft(overrides: Partial<AgentDraft> = {}): AgentDraft {
  return {
    id: 'assistente-geral',
    name: 'Assistente Geral',
    description: 'Responde perguntas.',
    version: '1.0.0',
    instructions: 'Seja objetivo.',
    model: { engineId: null, modelId: 'aurora-8b-instruct' },
    settings: { temperature: 0.7, topP: 0.95, maxOutputTokens: null },
    tools: ['calculator'],
    requestedPermissions: [],
    state: 'ready',
    ...overrides
  }
}

/** Relógio controlável: avança um segundo a cada leitura. */
export function fakeClock(start = Date.parse('2026-10-23T12:00:00.000Z')): () => Date {
  let t = start
  return () => new Date((t += 1000))
}

/** Agendador manual: os temporizadores só disparam quando `flush` ou `step` são chamados. */
export class ManualScheduler implements Scheduler {
  private queue: Array<{ id: number; callback: () => void }> = []
  private nextId = 1

  setTimeout(callback: () => void): unknown {
    const id = this.nextId++
    this.queue.push({ id, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter((t) => t.id !== handle)
  }

  get pending(): number {
    return this.queue.length
  }

  /** Dispara o próximo temporizador. */
  step(): boolean {
    const next = this.queue.shift()
    next?.callback()
    return Boolean(next)
  }

  flush(limit = 100): void {
    for (let i = 0; i < limit && this.step(); i++);
  }
}
