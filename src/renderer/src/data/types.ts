import type { ModelDescriptor, ModelStatus } from '@shared/engine'

export type AgentStatus = 'active' | 'idle' | 'draft' | 'error'

export type AgentCategory = 'Produtividade' | 'Desenvolvimento' | 'Pesquisa' | 'Atendimento' | 'Dados'

export interface Agent {
  id: string
  name: string
  description: string
  category: AgentCategory
  status: AgentStatus
  modelId: string
  tools: string[]
  runsLast7d: number
  updatedAt: string
}

export interface LibraryModel extends ModelDescriptor {
  status: ModelStatus
  /** 0–100 quando `status === 'downloading'`. */
  downloadProgress?: number
  description: string
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'queued' | 'cancelled'

export interface Run {
  id: string
  agentId: string
  modelId: string
  trigger: 'Manual' | 'Agendado' | 'API'
  status: RunStatus
  startedAt: string
  durationSec: number | null
  tokens: number
}

export interface Tool {
  id: string
  name: string
  description: string
  kind: 'Integrada' | 'Plugin'
  permissions: string[]
  enabled: boolean
}

export interface Conversation {
  id: string
  title: string
  agentId: string | null
  updatedAt: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}
