import { isRealProvider, sameModel, type ModelRef, type ProviderModelEntry, type ProviderOverview } from '@shared/inference'
import type { Tone } from '@renderer/components/ui/tone'
import { formModelRef, type AgentFormValues } from './agent-form'
import { eligibleModels, friendlyModelName, inventoryProblem, matchesModelRef, type ModelOption } from './real-runs'
import type { Resource } from './use-resource'

/**
 * Lógica do campo de modelo do agente, sem React (testável).
 *
 * O campo é sempre derivado de `providers:list` e do formulário: ler ou
 * atualizar o inventário nunca altera o formulário. Só `withModelChoice`, com
 * uma escolha do usuário, muda o modelo; nenhum modelo é escolhido, trocado ou
 * vinculado a um provedor por conta própria.
 */

/** O que se sabe do inventário. Ausência de resposta nunca conta como lista vazia. */
export type ModelInventoryState =
  /** Consulta em andamento: ainda não se sabe nada. */
  | 'loading'
  /** A consulta ao Main falhou. */
  | 'failed'
  /** Nenhum provedor real registrado. */
  | 'no-provider'
  /** Nenhum provedor real respondeu. */
  | 'unavailable'
  /** Respondeu, sem modelos instalados. */
  | 'empty'
  /** Respondeu, com modelos instalados, nenhum de conversa. */
  | 'no-chat-models'
  /** Há modelos para escolher. */
  | 'ready'

/** Situação do modelo configurado no agente. */
export type ConfiguredModelState =
  /** Nenhum modelo configurado. */
  | 'none'
  /** Instalado, de conversa e em um único provedor. */
  | 'installed'
  /** Sem provedor vinculado e presente em mais de um. */
  | 'ambiguous'
  /** Instalado, mas sem capacidade de conversa. */
  | 'incompatible'
  /** Todos os provedores possíveis responderam e nenhum o tem. */
  | 'missing'
  /** Algum provedor possível não respondeu: não dá para afirmar nada. */
  | 'unverified'

/** Chave do modelo configurado que não está entre os instalados. Não colide com `modelKey`. */
export const CONFIGURED_MODEL_KEY = 'configured'
/** Chave do modelo com que o formulário abriu, depois de o usuário escolher outro. */
export const ORIGINAL_MODEL_KEY = 'original'
export const NO_MODEL_KEY = ''

export interface AgentModelChoice {
  key: string
  label: string
  /** Identificador exato; `null` em "nenhum modelo". */
  ref: ModelRef | null
  kind: 'none' | 'installed' | 'configured' | 'original'
}

export interface AgentModelField {
  inventory: ModelInventoryState
  configured: ConfiguredModelState
  /** Modelo configurado sem provedor vinculado (agentes antigos). */
  unbound: boolean
  choices: AgentModelChoice[]
  selectedKey: string
  /** Identificador exato do modelo selecionado. */
  identifier: string | null
  /** Chave e valores que devolvem o formulário ao modelo com que ele abriu. */
  restore: { key: string; modelId: string; boundModel: ModelRef | null } | null
  /** Por que não há o que escolher. `null` = há modelos, ou ainda não se sabe. */
  problem: { tone: Tone; text: string } | null
  /** Aviso sobre o modelo configurado. O modelo continua salvo em todos os casos. */
  notice: { tone: Tone; text: string } | null
}

const installedLocal = (provider: ProviderOverview): ProviderModelEntry[] =>
  (provider.models ?? []).filter((e) => e.availability === 'installed' && e.model.location === 'local' && e.model.ref.providerId === provider.info.id)

/** Só um provedor pronto e com lista respondeu de verdade; `models: null` significa "não consultado". */
const answered = (provider: ProviderOverview) => provider.status.state === 'ready' && provider.models !== null

function inventoryState(providers: readonly ProviderOverview[], options: readonly ModelOption[]): ModelInventoryState {
  const real = providers.filter((p) => isRealProvider(p.info))
  if (real.length === 0) return 'no-provider'
  if (options.length > 0) return 'ready'
  const responding = real.filter(answered)
  if (responding.length === 0) return 'unavailable'
  return responding.some((p) => installedLocal(p).length > 0) ? 'no-chat-models' : 'empty'
}

function configuredState(ref: ModelRef, providers: readonly ProviderOverview[], matches: readonly ModelOption[]): ConfiguredModelState {
  if (matches.length === 1) return 'installed'
  if (matches.length > 1) return 'ambiguous'
  const possible = providers.filter((p) => isRealProvider(p.info) && (ref.providerId === null || p.info.id === ref.providerId))
  if (possible.length === 0 || !possible.every(answered)) return 'unverified'
  return possible.some((p) => installedLocal(p).some((e) => matchesModelRef(e.model.ref, ref))) ? 'incompatible' : 'missing'
}

const STATE_SUFFIX: Partial<Record<ConfiguredModelState, string>> = {
  ambiguous: 'em mais de um provedor',
  incompatible: 'não disponível para conversa',
  missing: 'não instalado',
  unverified: 'não verificado'
}

function configuredNotice(state: ConfiguredModelState, modelId: string): AgentModelField['notice'] {
  switch (state) {
    case 'ambiguous':
      return { tone: 'warning', text: `O modelo "${modelId}" existe em mais de um provedor. Escolha na lista qual usar.` }
    case 'incompatible':
      return { tone: 'warning', text: `O modelo "${modelId}" está instalado, mas não serve para conversa. Ele continua salvo no agente até você escolher outro.` }
    case 'missing':
      return { tone: 'warning', text: `O modelo "${modelId}" não está instalado. Ele continua salvo no agente até você escolher outro.` }
    case 'unverified':
      return { tone: 'neutral', text: `Não foi possível verificar o modelo "${modelId}" agora. Ele continua salvo no agente.` }
    default:
      return null
  }
}

const labelFor = (ref: ModelRef, state: ConfiguredModelState, inventory: ModelInventoryState) => {
  const suffix = inventory === 'loading' ? undefined : STATE_SUFFIX[state]
  return suffix ? `${friendlyModelName(ref.modelId)} — ${suffix}` : friendlyModelName(ref.modelId)
}

/**
 * Estado do campo de modelo para o formulário e o inventário atuais. `initial`
 * é o formulário como foi aberto: o modelo dele continua na lista depois de
 * outra escolha, mesmo fora dos instalados, para poder ser restaurado.
 */
export function agentModelField(form: AgentFormValues, providers: Resource<readonly ProviderOverview[]>, initial: AgentFormValues = form): AgentModelField {
  const list = providers.status === 'ready' ? providers.data : null
  const options = list ? eligibleModels(list) : []
  const inventory = list ? inventoryState(list, options) : providers.status === 'loading' ? 'loading' : 'failed'

  /** Sem inventário nada é afirmado; só um modelo instalado sem ambiguidade é uma opção da lista. */
  const situation = (ref: ModelRef): { state: ConfiguredModelState; key: string } => {
    if (!list) return { state: 'unverified', key: CONFIGURED_MODEL_KEY }
    const matches = options.filter((o) => matchesModelRef(o.ref, ref))
    const state = configuredState(ref, list, matches)
    return { state, key: state === 'installed' ? matches[0]!.key : CONFIGURED_MODEL_KEY }
  }

  const ref = formModelRef(form)
  const current = ref && situation(ref)
  const originalRef = formModelRef(initial)
  const unchanged = ref !== null && originalRef !== null && sameModel(ref, originalRef)
  const original = originalRef && situation(originalRef)
  const originalKey = original && !unchanged && original.key === CONFIGURED_MODEL_KEY ? ORIGINAL_MODEL_KEY : original?.key

  const manyProviders = new Set(options.map((o) => o.ref.providerId)).size > 1
  const choices: AgentModelChoice[] = [
    { key: NO_MODEL_KEY, label: 'Nenhum modelo selecionado', ref: null, kind: 'none' },
    ...(ref && current?.key === CONFIGURED_MODEL_KEY
      ? [{ key: CONFIGURED_MODEL_KEY, label: labelFor(ref, current.state, inventory), ref, kind: 'configured' as const }]
      : []),
    ...(originalRef && original && originalKey === ORIGINAL_MODEL_KEY
      ? [{ key: ORIGINAL_MODEL_KEY, label: labelFor(originalRef, original.state, inventory), ref: originalRef, kind: 'original' as const }]
      : []),
    ...options.map((o) => ({
      key: o.key,
      label: manyProviders ? `${o.label} · ${o.providerName}` : o.label,
      ref: o.ref,
      kind: 'installed' as const
    }))
  ]

  const failed: AgentModelField['problem'] = { tone: 'danger', text: 'Não foi possível consultar a lista de modelos. Clique em "Atualizar lista".' }
  // `inventoryProblem` trata provedor pronto como consultado; sem lista, o único fato é que não houve resposta.
  const notConsulted = list?.some((p) => isRealProvider(p.info) && p.status.state === 'ready') && inventory === 'unavailable'
  const problem = !list ? (inventory === 'failed' ? failed : null) : notConsulted ? { ...failed, tone: 'warning' as const } : inventoryProblem(list)

  return {
    inventory,
    configured: current?.state ?? 'none',
    unbound: ref?.providerId === null,
    choices,
    selectedKey: current?.key ?? NO_MODEL_KEY,
    identifier: ref?.modelId ?? null,
    restore: originalKey ? { key: originalKey, modelId: initial.modelId, boundModel: initial.boundModel } : null,
    problem,
    notice: ref && current && inventory !== 'loading' ? configuredNotice(current.state, ref.modelId) : null
  }
}

/**
 * Registra uma escolha explícita do usuário. Manter o que já está selecionado,
 * ou uma chave que saiu da lista, devolve o mesmo formulário: um agente sem
 * provedor só ganha vínculo ao escolher outro modelo. Voltar ao modelo com que
 * o formulário abriu restaura a referência original, inclusive `providerId: null`.
 */
export function withModelChoice(form: AgentFormValues, key: string, field: AgentModelField): AgentFormValues {
  if (key === field.selectedKey) return form
  if (key === field.restore?.key) return { ...form, modelId: field.restore.modelId, boundModel: field.restore.boundModel }
  const choice = field.choices.find((c) => c.key === key)
  if (!choice || choice.kind === 'configured' || choice.kind === 'original') return form
  return { ...form, modelId: choice.ref?.modelId ?? '', boundModel: choice.ref && { ...choice.ref } }
}
