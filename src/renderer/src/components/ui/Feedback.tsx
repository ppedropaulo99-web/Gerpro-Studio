import { AlertTriangle, Loader2, RotateCw } from 'lucide-react'
import type { StructuredError } from '@shared/errors'
import { Button } from './Button'
import { EmptyState } from './Notice'

export function LoadingState({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite">
      <EmptyState icon={<Loader2 size={24} className="spin" />} title={label} />
    </div>
  )
}

export function ErrorState({ error, onRetry, title = 'Não foi possível carregar' }: { error: StructuredError; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert">
      <EmptyState icon={<AlertTriangle size={26} className="text-danger" />} title={title}>
        {error.message}
      </EmptyState>
      {onRetry && (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button size="sm" icon={<RotateCw size={13} />} onClick={onRetry}>
            Tentar novamente
          </Button>
        </div>
      )}
    </div>
  )
}

/** Mensagem de erro sob um campo de formulário. */
export function FieldError({ children }: { children?: string }) {
  return children ? <span className="field__error">{children}</span> : null
}
