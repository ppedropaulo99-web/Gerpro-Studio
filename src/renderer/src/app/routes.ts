import type { ComponentType } from 'react'
import {
  Bot,
  Boxes,
  Code2,
  History,
  House,
  MessageSquare,
  Settings,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { HomePage } from '@renderer/pages/HomePage'
import { AgentsPage } from '@renderer/pages/AgentsPage'
import { ChatPage } from '@renderer/pages/ChatPage'
import { ModelsPage } from '@renderer/pages/ModelsPage'
import { RunsPage } from '@renderer/pages/RunsPage'
import { ToolsPage } from '@renderer/pages/ToolsPage'
import { DeveloperPage } from '@renderer/pages/DeveloperPage'
import { SettingsPage } from '@renderer/pages/SettingsPage'

export type RouteId = 'home' | 'agents' | 'chat' | 'models' | 'runs' | 'tools' | 'developer' | 'settings'

export interface RouteDef {
  id: RouteId
  label: string
  icon: LucideIcon
  section: 'workspace' | 'system'
  component: ComponentType
}

/** Registro único de telas. Adicionar uma tela = adicionar uma entrada aqui. */
export const routes: RouteDef[] = [
  { id: 'home', label: 'Início', icon: House, section: 'workspace', component: HomePage },
  { id: 'agents', label: 'Agentes', icon: Bot, section: 'workspace', component: AgentsPage },
  { id: 'chat', label: 'Chat', icon: MessageSquare, section: 'workspace', component: ChatPage },
  { id: 'models', label: 'Modelos', icon: Boxes, section: 'workspace', component: ModelsPage },
  { id: 'runs', label: 'Execuções', icon: History, section: 'workspace', component: RunsPage },
  { id: 'tools', label: 'Ferramentas', icon: Wrench, section: 'workspace', component: ToolsPage },
  { id: 'developer', label: 'Desenvolvedor', icon: Code2, section: 'system', component: DeveloperPage },
  { id: 'settings', label: 'Configurações', icon: Settings, section: 'system', component: SettingsPage }
]

export const routeById = Object.fromEntries(routes.map((r) => [r.id, r])) as Record<RouteId, RouteDef>
