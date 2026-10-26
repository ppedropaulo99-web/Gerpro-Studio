import { isRealProvider, type ProviderOverview, type ProviderState } from '@shared/inference'
import type { Tone } from '@renderer/components/ui/tone'

/** Rótulo e tom de cada estado de provedor. */
export const providerState: Record<ProviderState, { tone: Tone; label: string }> = {
  'not-configured': { tone: 'neutral', label: 'Não configurado' },
  'not-detected': { tone: 'neutral', label: 'Não detectado' },
  unreachable: { tone: 'warning', label: 'Não responde' },
  starting: { tone: 'info', label: 'Iniciando' },
  ready: { tone: 'success', label: 'Conectado' },
  'incompatible-version': { tone: 'warning', label: 'Versão incompatível' },
  error: { tone: 'danger', label: 'Erro' }
}

/**
 * Resumo do motor de IA real a partir dos provedores informados pelo Main.
 * O provedor simulado nunca conta: sem provedor real pronto, o motor está
 * desconectado.
 */
export interface EngineSummary {
  connected: boolean
  /** Provedores reais registrados (prontos ou não). */
  real: ProviderOverview[]
  /** Provedores reais prontos. */
  ready: ProviderOverview[]
  /** Modelos locais instalados nos provedores reais prontos. */
  installedModels: number
  label: string
}

export function summarizeEngine(providers: readonly ProviderOverview[]): EngineSummary {
  const real = providers.filter((p) => isRealProvider(p.info))
  const ready = real.filter((p) => p.status.state === 'ready')
  const installedModels = ready.reduce((sum, p) => sum + (p.models?.length ?? 0), 0)
  const label = ready.length > 0 ? `${ready.map((p) => p.info.displayName).join(', ')} conectado` : 'Motor de IA não conectado'
  return { connected: ready.length > 0, real, ready, installedModels, label }
}
