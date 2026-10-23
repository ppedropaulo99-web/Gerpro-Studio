import type { ReactNode } from 'react'
import { cx } from '@renderer/lib/cx'

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'neutral'

interface StatusBadgeProps {
  tone: Tone
  children: ReactNode
  /** Ponto pulsante para estados em andamento. */
  pulse?: boolean
}

export function StatusBadge({ tone, children, pulse }: StatusBadgeProps) {
  return (
    <span className={cx('status', `tone-${tone}`, pulse && 'status--pulse')}>
      <span className="status__dot" aria-hidden />
      {children}
    </span>
  )
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress__bar" style={{ width: `${pct}%` }} />
    </div>
  )
}
