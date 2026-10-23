import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Button, type ButtonVariant } from './Button'

interface ConfirmDialogProps {
  open: boolean
  title: string
  children: ReactNode
  /** Ação segura, focada ao abrir; também é a escolha do Esc. */
  cancelLabel: string
  confirmLabel: string
  confirmVariant?: ButtonVariant
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Diálogo de confirmação modal (`<dialog>` nativo: fundo inerte e foco
 * contido). Abre com o foco na ação segura e devolve o foco ao fechar.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  cancelLabel,
  confirmLabel,
  confirmVariant = 'danger',
  onCancel,
  onConfirm
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const bodyId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog || !open || dialog.open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.showModal()
    cancelRef.current?.querySelector('button')?.focus()
    return () => {
      dialog.close()
      if (previous?.isConnected) previous.focus()
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      className="dialog"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(e) => {
        // Esc = ação segura; o fechamento é controlado por `open`.
        e.preventDefault()
        onCancel()
      }}
    >
      {open && (
        <>
          <h2 id={titleId} className="dialog__title">
            {title}
          </h2>
          <div id={bodyId} className="dialog__body muted">
            {children}
          </div>
          <div className="dialog__actions">
            <div ref={cancelRef}>
              <Button onClick={onCancel}>{cancelLabel}</Button>
            </div>
            <Button variant={confirmVariant} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </>
      )}
    </dialog>
  )
}
