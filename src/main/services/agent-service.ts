import {
  evaluateAgentAvailability,
  migrateAgentsV1,
  validateAgentDefinition,
  validateAgentDraft,
  type AgentDefinition,
  type AgentRecord
} from '@shared/agents'
import { Checker, isRecord, readSlug } from '@shared/validation'
import { AppError, unwrap } from '../errors'
import { VersionedStore, type ParseOutcome, type StoreStatus } from '../storage/versioned-store'
import type { ToolRegistry } from '../tools/tool-registry'
import type { SettingsService } from './settings-service'

/** v2: modelo e perfil de execução padrão (`defaultModel`, `defaultProfile`) e finalidade (`taskTypes`). */
export const AGENTS_FORMAT_VERSION = 2
const MAX_AGENTS = 500

interface AgentsFile {
  agents: AgentDefinition[]
}

/** Aproveita os agentes válidos e relata os inválidos (o arquivo original é copiado pelo store). */
export function parseAgentsFile(data: unknown): ParseOutcome<AgentsFile> {
  if (!isRecord(data) || !Array.isArray(data['agents'])) {
    return { value: undefined, issues: [{ path: '$.agents', message: 'deve ser uma lista' }] }
  }
  const issues: ParseOutcome<AgentsFile>['issues'] = []
  const agents: AgentDefinition[] = []
  const seen = new Set<string>()
  data['agents'].forEach((raw, i) => {
    const result = validateAgentDefinition(raw)
    if (!result.ok) {
      issues.push(...result.issues.map((issue) => ({ ...issue, path: issue.path.replace(/^\$/, `$.agents[${i}]`) })))
    } else if (seen.has(result.value.id)) {
      issues.push({ path: `$.agents[${i}].id`, message: 'ID repetido' })
    } else {
      seen.add(result.value.id)
      agents.push(result.value)
    }
  })
  if (Object.keys(data).some((k) => k !== 'agents')) issues.push({ path: '$', message: 'campos não permitidos' })
  if (agents.length > MAX_AGENTS) issues.push({ path: '$.agents', message: `no máximo ${MAX_AGENTS} agentes` })
  return { value: { agents: agents.slice(0, MAX_AGENTS) }, issues }
}

export interface AgentServiceDeps {
  filePath: string
  tools: ToolRegistry
  settings: SettingsService
  /** Há motor de inferência? Sempre `false` nesta etapa. */
  engineAvailable: () => boolean
  now?: () => Date
}

export class AgentService {
  private readonly store: VersionedStore<AgentsFile>
  private readonly deps: AgentServiceDeps

  constructor(deps: AgentServiceDeps) {
    this.deps = deps
    this.store = new VersionedStore({
      filePath: deps.filePath,
      format: 'gerpro.agents',
      version: AGENTS_FORMAT_VERSION,
      defaults: () => ({ agents: [] }),
      migrations: { 1: migrateAgentsV1 },
      // A migração v1 → v2 descarta `engineId` sem correspondência; o original fica copiado.
      backupBeforeMigration: true,
      parse: parseAgentsFile,
      now: deps.now
    })
  }

  async init(): Promise<StoreStatus> {
    await this.store.load()
    return this.store.status
  }

  list(): AgentRecord[] {
    return this.store.get().agents.map((a) => this.toRecord(a))
  }

  find(id: string): AgentDefinition | undefined {
    return this.store.get().agents.find((a) => a.id === id)
  }

  /** Cria um agente novo. Falha com `conflict` se o ID já existir. */
  create(input: unknown): Promise<AgentRecord> {
    return this.save(input, 'create')
  }

  /** Atualiza um agente existente, preservando `createdAt`. Falha com `not-found` se ele não existir. */
  update(input: unknown): Promise<AgentRecord> {
    return this.save(input, 'update')
  }

  private async save(input: unknown, mode: 'create' | 'update'): Promise<AgentRecord> {
    const draft = unwrap(validateAgentDraft(input))
    const unknownTools = draft.tools.filter((t) => !this.deps.tools.has(t))
    if (unknownTools.length > 0) {
      throw AppError.validation(unknownTools.map((t) => ({ path: '$.tools', message: `ferramenta desconhecida: ${t}` })))
    }

    const now = (this.deps.now?.() ?? new Date()).toISOString()
    let saved: AgentDefinition | undefined
    await this.store.update(({ agents }) => {
      const existing = agents.find((a) => a.id === draft.id)
      if (mode === 'create' && existing) {
        throw new AppError('conflict', `Já existe um agente com o ID "${draft.id}".`, { issues: [{ path: '$.id', message: 'ID já em uso' }] })
      }
      if (mode === 'update' && !existing) throw new AppError('not-found', `Agente "${draft.id}" não encontrado.`)
      if (!existing && agents.length >= MAX_AGENTS) {
        throw new AppError('conflict', `Limite de ${MAX_AGENTS} agentes atingido.`)
      }
      saved = { ...draft, createdAt: existing?.createdAt ?? now, updatedAt: now }
      return { agents: existing ? agents.map((a) => (a.id === draft.id ? saved! : a)) : [...agents, saved] }
    })
    return this.toRecord(saved!)
  }

  async remove(input: unknown): Promise<void> {
    const c = new Checker()
    const id = unwrap(c.result(readSlug(c, input, '$')))
    await this.store.update(({ agents }) => {
      if (!agents.some((a) => a.id === id)) throw new AppError('not-found', `Agente "${id}" não encontrado.`)
      return { agents: agents.filter((a) => a.id !== id) }
    })
  }

  private toRecord(definition: AgentDefinition): AgentRecord {
    const tools = this.deps.tools.list(this.deps.settings.get().tools.enabled)
    return {
      definition,
      availability: evaluateAgentAvailability(definition, { tools, engineAvailable: this.deps.engineAvailable() })
    }
  }
}
