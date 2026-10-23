import {
  evaluateAgentAvailability,
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

export const AGENTS_FORMAT_VERSION = 1
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

  /** Cria ou atualiza. `createdAt` é preservado; `updatedAt` é sempre do Main. */
  async save(input: unknown): Promise<AgentRecord> {
    const draft = unwrap(validateAgentDraft(input))
    const unknownTools = draft.tools.filter((t) => !this.deps.tools.has(t))
    if (unknownTools.length > 0) {
      throw AppError.validation(unknownTools.map((t) => ({ path: '$.tools', message: `ferramenta desconhecida: ${t}` })))
    }

    const now = (this.deps.now?.() ?? new Date()).toISOString()
    let saved: AgentDefinition | undefined
    await this.store.update(({ agents }) => {
      const existing = agents.find((a) => a.id === draft.id)
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
