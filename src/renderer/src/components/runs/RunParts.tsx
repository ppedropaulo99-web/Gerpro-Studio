import { useState } from 'react'
import { Square } from 'lucide-react'
import type { StructuredError } from '@shared/errors'
import type { RunOrigin, RunRecord } from '@shared/runs'
import { isTerminalRunState } from '@shared/runs'
import { Button, Notice } from '@renderer/components/ui'
import { callApi } from '@renderer/lib/api'
import { friendlyError } from '@renderer/lib/real-runs'

/** Erro explicado em linguagem simples, com a mensagem original junto. */
export function ErrorExplanation({ error, origin }: { error: StructuredError; origin?: RunOrigin }) {
  const { title, detail } = friendlyError(error, origin)
  return (
    <Notice tone="danger">
      <div className="stack" style={{ gap: 4 }}>
        <span>{title}</span>
        {detail && detail !== title && <span className="subtle">Detalhe: {detail}</span>}
      </div>
    </Notice>
  )
}

/**
 * Pedido de cancelamento ao `RunService` (`runs:cancel`). Uma execução que
 * terminou enquanto o pedido ia (`invalid-state`) não é erro para o usuário.
 */
export function useCancelRun(run: RunRecord | null, onChanged: (run: RunRecord) => void) {
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<StructuredError | null>(null)

  async function cancel() {
    if (!run) return
    setCancelling(true)
    setError(null)
    const result = await callApi(() => window.gerpro.runs.cancel(run.id))
    setCancelling(false)
    if (result.ok) onChanged(result.data)
    else if (result.error.code !== 'invalid-state') setError(result.error)
  }

  return { cancel, cancelling, error, clearError: () => setError(null) }
}

/** "Interromper geração" (ou "Tirar da fila"); some quando a execução termina. */
export function CancelRunButton({
  run,
  cancelling,
  onCancel,
  size = 'sm',
  variant = 'secondary'
}: {
  run: RunRecord
  cancelling: boolean
  onCancel: () => void
  size?: 'sm' | 'md'
  variant?: 'secondary' | 'primary'
}) {
  if (isTerminalRunState(run.state)) return null
  return (
    <Button size={size} variant={variant} icon={<Square size={12} />} disabled={cancelling || run.cancelRequested} onClick={onCancel}>
      {run.cancelRequested ? 'Interrompendo…' : run.state === 'pending' ? 'Tirar da fila' : 'Interromper geração'}
    </Button>
  )
}
