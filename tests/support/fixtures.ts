import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import type { AgentDraft } from '../../src/shared/agents'
import { DEFAULT_EXECUTION_PROFILE } from '../../src/shared/execution'
import type { Scheduler } from '../../src/main/runs/scheduler'

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
    taskTypes: [],
    defaultModel: { providerId: null, modelId: 'aurora-8b-instruct' },
    defaultProfile: { ...DEFAULT_EXECUTION_PROFILE },
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


/** Deixa as promessas pendentes andarem (geradores assíncronos, `await`s em cadeia). */
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Relógio virtual: os temporizadores disparam em ordem de vencimento (e de
 * criação, quando vencem juntos) só quando `advance` é chamado.
 */
export class VirtualScheduler implements Scheduler {
  /** Milissegundos virtuais desde o início. */
  time = 0
  private timers: Array<{ id: number; at: number; callback: () => void }> = []
  private nextId = 1

  private readonly origin = Date.parse('2026-10-23T12:00:00.000Z')

  /** Relógio para `now`: acompanha o tempo virtual. */
  readonly now = () => new Date(this.origin + this.time)

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.push({ id, at: this.time + Math.max(0, ms), callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle)
  }

  get pending(): number {
    return this.timers.length
  }

  /** Avança `ms`, disparando cada temporizador vencido e deixando as promessas andarem entre eles. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms
    await settle()
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target)
      if (due.length === 0) break
      const next = due.reduce((a, b) => (b.at < a.at || (b.at === a.at && b.id < a.id) ? b : a))
      this.timers = this.timers.filter((t) => t !== next)
      this.time = next.at
      next.callback()
      await settle()
    }
    this.time = target
  }
}
