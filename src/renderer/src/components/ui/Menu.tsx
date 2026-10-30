import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Button } from './Button'
import { cx } from '@renderer/lib/cx'

export type MenuEntry =
  | {
      label: string
      icon?: ReactNode
      onSelect?: () => void
      disabled?: boolean
      danger?: boolean
    }
  | 'separator'

interface MenuProps {
  items: MenuEntry[]
  label?: string
  trigger?: ReactNode
}

/** Menu suspenso acessível: fecha com Esc, clique fora ou ao escolher um item. */
export function Menu({ items, label = 'Mais ações', trigger }: MenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      // Fechar pelo teclado devolve o foco ao botão do menu.
      rootRef.current?.querySelector<HTMLElement>('button')?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="menu" ref={rootRef} onClick={(e) => e.stopPropagation()}>
      {trigger ? (
        <span onClick={() => setOpen((v) => !v)}>{trigger}</span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<MoreHorizontal size={16} />}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        />
      )}
      {open && (
        <div className="menu__panel" role="menu" id={panelId}>
          {items.map((item, i) =>
            item === 'separator' ? (
              <div key={`sep-${i}`} className="menu__separator" role="separator" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={cx('menu__item', item.danger && 'menu__item--danger')}
                disabled={item.disabled}
                onClick={() => {
                  item.onSelect?.()
                  setOpen(false)
                }}
              >
                {item.icon}
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}
