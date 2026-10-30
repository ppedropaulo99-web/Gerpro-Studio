import { useCallback, useEffect, useState } from 'react'
import type { RunRecord } from '@shared/runs'
import { upsertRun } from './runs'
import { watchRuns, type SessionRunsState } from './session-runs'

/**
 * Execuções desta sessão (Main), mantidas atualizadas pelo evento
 * `runs:updated` (ver `watchRuns`). A assinatura é encerrada ao desmontar.
 * `update` aplica na hora uma execução devolvida por `start`/`cancel`.
 */
export function useSessionRuns() {
  const [state, setState] = useState<SessionRunsState>({ status: 'loading' })
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    setState({ status: 'loading' })
    return watchRuns(window.gerpro.runs, setState)
  }, [generation])

  const reload = useCallback(() => setGeneration((g) => g + 1), [])

  const update = useCallback((fn: (data: RunRecord[]) => RunRecord[]) => {
    setState((s) => (s.status === 'ready' ? { status: 'ready', data: fn(s.data) } : s))
  }, [])

  return { state, reload, update }
}

/** Aplica uma execução recebida fora do evento (resposta de `start`/`cancel`). */
export const withRun = (run: RunRecord) => (list: RunRecord[]) => upsertRun(list, run)
