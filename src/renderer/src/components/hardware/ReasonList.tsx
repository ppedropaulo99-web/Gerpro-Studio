import { AlertTriangle, CheckCircle2, CircleHelp, Info, XCircle } from 'lucide-react'
import type { ReasonKind, RecommendationReason } from '@shared/recommendations'

const icons: Record<ReasonKind, { icon: typeof Info; className: string; label: string }> = {
  positive: { icon: CheckCircle2, className: 'text-success', label: 'Atende' },
  limitation: { icon: AlertTriangle, className: 'text-warning', label: 'Limitação' },
  blocker: { icon: XCircle, className: 'text-danger', label: 'Impede' },
  unknown: { icon: CircleHelp, className: 'subtle', label: 'Desconhecido' },
  notice: { icon: Info, className: 'text-info', label: 'Observação' }
}

/** Justificativas do Hardware Advisor, com ícone e rótulo acessível por tipo. */
export function ReasonList({ reasons }: { reasons: readonly RecommendationReason[] }) {
  return (
    <ul className="reason-list">
      {reasons.map((r, i) => {
        const { icon: Icon, className, label } = icons[r.kind]
        return (
          <li key={`${r.factor}-${i}`}>
            <Icon size={14} className={className} aria-label={label} />
            <span>{r.message}</span>
          </li>
        )
      })}
    </ul>
  )
}
