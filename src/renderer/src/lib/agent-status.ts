import type { AgentDefinition, AgentRecord, AgentsStorageBlock, AgentsStorageStatus } from '@shared/agents'
import type { ProviderOverview } from '@shared/inference'
import type { Tone } from '@renderer/components/ui/tone'
import { emptyAgentForm, formFromDefinition } from './agent-form'
import { agentModelField, type AgentModelField, type ConfiguredModelState } from './agent-model'
import { permissionLabel } from './format'
import type { Resource } from './use-resource'

/**
 * Como um agente salvo aparece nas telas, sem React (testável). São três
 * informações separadas:
 * - estado: o que está gravado (Rascunho, Pronto, Arquivado);
 * - executabilidade: se dá para conversar com ele agora em Conversas;
 * - observações: limitações que não impedem a conversa.
 *
 * Reflete as regras do Main, sem substituí-las: o `RunService` recusa só agente
 * arquivado, e Conversas sempre envia um modelo instalado escolhido na hora.
 * Por isso rascunho, falta de instruções, ferramentas e modelo padrão ausente
 * não bloqueiam; o que falta é haver algum modelo instalado para escolher.
 */

export type AgentExecutability =
  /** Consulta dos modelos em andamento. */
  | 'checking'
  /** Agente aceito e há modelo instalado para escolher. */
  | 'conversable'
  /** A consulta falhou: nada se sabe sobre o motor nem sobre os modelos. */
  | 'unverified'
  /** Nenhum motor respondeu. */
  | 'no-engine'
  /** O motor respondeu, sem modelo de conversa (ou não há motor registrado). */
  | 'no-model'
  /** Arquivado: o `RunService` recusa a execução. */
  | 'blocked'

export interface AgentNote {
  kind: 'state' | 'model' | 'instructions' | 'tools'
  text: string
}

export interface AgentStatusView {
  executability: AgentExecutability
  badge: { tone: Tone; label: string }
  /** "Executar" abre Conversas, que explica o que faltar; só o arquivado fica sem a ação. */
  canOpen: boolean
  actionTitle: string
  notes: AgentNote[]
}

export const TOOLS_NOTICE = 'Este agente possui ferramentas configuradas que ainda não estão disponíveis. A conversa com o modelo pode continuar sem essas ferramentas.'
/** Editor: vale antes de marcar qualquer ferramenta. */
export const TOOLS_PLANNED_NOTICE = 'Os agentes ainda não executam ferramentas. O que for marcado aqui fica salvo no agente, mas não muda as conversas.'

const BADGES: Record<AgentExecutability, AgentStatusView['badge']> = {
  checking: { tone: 'neutral', label: 'Verificando…' },
  conversable: { tone: 'success', label: 'Pode conversar' },
  unverified: { tone: 'neutral', label: 'Não verificado' },
  'no-engine': { tone: 'warning', label: 'Motor não responde' },
  'no-model': { tone: 'warning', label: 'Sem modelo instalado' },
  blocked: { tone: 'neutral', label: 'Não executável' }
}

function executability(field: AgentModelField): AgentExecutability {
  switch (field.inventory) {
    case 'loading':
      return 'checking'
    case 'ready':
      return 'conversable'
    case 'failed':
      return 'unverified'
    case 'unavailable':
      return 'no-engine'
    default:
      return 'no-model'
  }
}

function modelNote(state: ConfiguredModelState, modelId: string, canChoose: boolean): string | null {
  const choose = canChoose ? ' Escolha outro para conversar.' : ''
  switch (state) {
    case 'none':
      return `Sem modelo padrão.${canChoose ? ' Escolha um modelo instalado para conversar.' : ''}`
    case 'ambiguous':
      return `O modelo padrão "${modelId}" existe em mais de um provedor. Escolha qual usar para conversar.`
    case 'incompatible':
      return `O modelo padrão "${modelId}" está instalado, mas não serve para conversa.${choose}`
    case 'missing':
      return `O modelo padrão "${modelId}" não está instalado. Ele continua salvo no agente.${choose}`
    case 'unverified':
      return `Não foi possível verificar o modelo padrão "${modelId}" agora. Ele continua salvo no agente.`
    default:
      return null
  }
}

/** Situação do agente para o inventário atual. Nada aqui altera o agente. */
export function agentStatus({ definition, availability }: AgentRecord, providers: Resource<readonly ProviderOverview[]>): AgentStatusView {
  if (definition.state === 'archived') {
    return {
      executability: 'blocked',
      badge: BADGES.blocked,
      canOpen: false,
      actionTitle: 'Agente arquivado não pode ser executado',
      notes: [{ kind: 'state', text: 'Agente arquivado. Restaure-o para voltar a conversar.' }]
    }
  }

  const field = agentModelField(formFromDefinition(definition), providers)
  const state = executability(field)
  const model = field.inventory === 'loading' ? null : modelNote(field.configured, field.identifier ?? '', state === 'conversable')
  const notes: AgentNote[] = []
  if (definition.state === 'draft') notes.push({ kind: 'state', text: 'Em rascunho: a configuração pode estar incompleta. Conversas aceitam rascunhos.' })
  if (model) notes.push({ kind: 'model', text: model })
  if (!definition.instructions.trim()) notes.push({ kind: 'instructions', text: 'Sem instruções: o modelo responde sem orientação deste agente.' })
  if (definition.tools.length > 0) notes.push({ kind: 'tools', text: TOOLS_NOTICE })
  // `tool-not-implemented` já está em `TOOLS_NOTICE`; as demais pendências do Main seguem visíveis.
  for (const issue of availability.issues) {
    if (issue.code === 'unknown-tool' || issue.code === 'tool-disabled' || issue.code === 'missing-permission') {
      notes.push({ kind: 'tools', text: issue.permission ? issue.message.replace(issue.permission, permissionLabel[issue.permission]) : issue.message })
    }
  }

  return {
    executability: state,
    badge: BADGES[state],
    canOpen: true,
    actionTitle:
      state === 'conversable' || state === 'checking'
        ? 'Enviar uma mensagem com este agente em Conversas'
        : 'Abrir Conversas. Não há modelo disponível para enviar mensagens agora.',
    notes
  }
}

/** O que muda a conversa que vai começar: as ferramentas já têm aviso em Conversas. */
export const conversationNotes = (view: AgentStatusView) => view.notes.filter((n) => n.kind === 'model' || n.kind === 'instructions')

/** Nome no seletor de Conversas; rascunhos são aceitos, mas identificados. */
export const agentOptionLabel = ({ name, state }: Pick<AgentDefinition, 'name' | 'state'>) => (state === 'draft' ? `${name} (rascunho)` : name)

/** Por que as alterações estão bloqueadas. Só afirma o que o Main confirmou: há cópia apenas em `damaged`. */
const STORAGE_NOTICES: Record<AgentsStorageBlock, string> = {
  damaged:
    'Encontramos um problema nos dados dos agentes. Para proteger suas configurações, as alterações foram temporariamente bloqueadas. O arquivo original foi preservado e há uma cópia de segurança. Aqui aparecem só os agentes que puderam ser lidos.',
  'backup-failed':
    'Encontramos um problema nos dados dos agentes. Para proteger suas configurações, as alterações foram bloqueadas. O arquivo original não foi alterado, mas não foi possível confirmar uma cópia de segurança.',
  'newer-version':
    'Os agentes foram gravados por uma versão mais nova do aplicativo. Para protegê-los, a lista não é exibida e as alterações foram bloqueadas. O arquivo não foi alterado.',
  unreadable: 'Não foi possível ler os dados dos agentes. Para protegê-los, as alterações foram bloqueadas. O arquivo não foi alterado.'
}

/** Aviso da página de Agentes; `null` quando as alterações estão liberadas. */
export const agentStorageNotice = (status: AgentsStorageStatus) => (status.block ? STORAGE_NOTICES[status.block] : null)

/**
 * Por que uma conversa não aceita novas mensagens. Sem o agente na lista e com o
 * armazenamento protegido, ele pode só não ter sido lido: não se afirma exclusão.
 */
export function conversationAgentNotice(loaded: boolean, status: AgentsStorageStatus | null): string {
  if (!loaded && status?.block) {
    return 'Não foi possível carregar o agente desta conversa, porque os dados dos agentes estão protegidos. As mensagens foram preservadas e podem ser lidas; novos envios ficam indisponíveis até os dados serem corrigidos.'
  }
  return 'O agente desta conversa foi excluído ou arquivado. Para continuar, crie uma nova conversa.'
}

/** Título das ações desabilitadas enquanto o armazenamento está protegido. */
export const AGENT_STORAGE_LOCKED = 'Alterações bloqueadas para proteger os dados dos agentes.'

/** Aviso único da lista de agentes: vale para todos, e falha de consulta não é erro do agente. */
export function agentsInventoryNotice(providers: Resource<readonly ProviderOverview[]>): { tone: Tone; text: string } | null {
  const { problem } = agentModelField(emptyAgentForm(), providers)
  return problem && { tone: problem.tone === 'danger' ? 'warning' : problem.tone, text: problem.text }
}
