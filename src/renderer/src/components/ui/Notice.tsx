import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import type { Tone } from './Status'

interface NoticeProps {
  tone?: Tone
  icon?: ReactNode
  children: ReactNode
}

export function Notice({ tone = 'info', icon, children }: NoticeProps) {
  return (
    <div className={`notice tone-${tone}`} role="note">
      {icon ?? <Info size={16} />}
      <div>{children}</div>
    </div>
  )
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
    </div>
  )
}
