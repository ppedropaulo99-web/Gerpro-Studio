import type { ReactNode } from 'react'
import { BookOpen, CheckCircle2, Clock, FlaskConical, type LucideIcon } from 'lucide-react'
import { featureStatus, type FeatureState } from '@renderer/lib/status'
import { Notice } from './Notice'
import { StatusBadge } from './Status'

const icons: Record<FeatureState, LucideIcon> = {
  real: CheckCircle2,
  simulated: FlaskConical,
  planned: Clock,
  example: BookOpen
}

/** Selo de origem: Real, Simulado, Planejado ou Exemplo. `children` substitui o rótulo padrão. */
export function FeatureBadge({ state, children }: { state: FeatureState; children?: ReactNode }) {
  const meta = featureStatus[state]
  return (
    <span title={meta.description}>
      <StatusBadge tone={meta.tone}>{children ?? meta.label}</StatusBadge>
    </span>
  )
}

/**
 * Aviso padronizado de estado funcional. Use no máximo um por tela ou seção;
 * para itens individuais, prefira `FeatureBadge`.
 */
export function FeatureNotice({ state, children }: { state: FeatureState; children: ReactNode }) {
  const meta = featureStatus[state]
  const Icon = icons[state]
  return (
    <Notice tone={meta.tone} icon={<Icon size={16} />}>
      <strong>{meta.label}.</strong> {children}
    </Notice>
  )
}
