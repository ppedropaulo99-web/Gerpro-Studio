import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from '@renderer/lib/cx'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean
  selected?: boolean
}

export function Card({ interactive, selected, className, ...rest }: CardProps) {
  return (
    <div
      className={cx('card', interactive && 'card--interactive', selected && 'card--selected', className)}
      {...rest}
    />
  )
}

interface CardHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}

export function CardHeader({ title, subtitle, actions }: CardHeaderProps) {
  return (
    <div className="card__header">
      <div className="card__title">
        <h3>{title}</h3>
        {subtitle && <span className="subtle">{subtitle}</span>}
      </div>
      {actions}
    </div>
  )
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('card__body', className)} {...rest} />
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('card__footer', className)} {...rest} />
}
