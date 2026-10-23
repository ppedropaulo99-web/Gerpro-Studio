import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from '@renderer/lib/cx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
  /** Botão só com ícone; exige `aria-label`. */
  iconOnly?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconOnly = false,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('btn', `btn--${variant}`, size === 'sm' && 'btn--sm', iconOnly && 'btn--icon', className)}
      {...rest}
    >
      {icon}
      {!iconOnly && children}
    </button>
  )
}
