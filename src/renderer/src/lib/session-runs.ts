import type { Result, StructuredError } from '@shared/errors'
import type { RunRecord } from '@shared/runs'
import { upsertRun } from './runs'

type RunsApi = {
  list(): Promise<Result<RunRecord[]>>
  onUpdated(listener: (run: RunRecord) => void): () => void
}

/** Mesmo formato de `Resource` (`use-resource.ts`), que as telas já usam. */
export type SessionRunsState = { status: 'loading' } | { status: 'error'; error: StructuredError } | { status: 'ready'; data: RunRecord[] }

/**
 * Acompanha as execuções desta sessão: assina `runs:updated` ANTES de pedir a
 * lista, para não perder eventos que chegam enquanto ela carrega, e junta
 * tudo por `revision` (uma versão mais antiga nunca sobrescreve uma mais
 * nova). O texto é sempre o do `RunService`: nada é acumulado aqui.
 * Devolve a função que encerra a assinatura; depois dela, nada mais é entregue.
 */
export function watchRuns(api: RunsApi, onChange: (state: SessionRunsState) => void): () => void {
  let stopped = false
  let early: RunRecord[] = []
  let list: RunRecord[] | null = null

  const unsubscribe = api.onUpdated((run) => {
    if (stopped) return
    if (list === null) {
      early = upsertRun(early, run)
      return
    }
    const next = upsertRun(list, run)
    if (next.some((r, i) => r !== list![i]) || next.length !== list.length) {
      list = next
      onChange({ status: 'ready', data: list })
    }
  })

  void api.list().then(
    (result) => {
      if (stopped) return
      if (!result.ok) return onChange({ status: 'error', error: result.error })
      list = early.reduce(upsertRun, result.data.reduce(upsertRun, [] as RunRecord[]))
      early = []
      onChange({ status: 'ready', data: list })
    },
    () => {
      if (!stopped) onChange({ status: 'error', error: { code: 'internal', message: 'Não foi possível comunicar com o processo principal.', retryable: true } })
    }
  )

  return () => {
    stopped = true
    unsubscribe()
  }
}
