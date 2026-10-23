import { useEffect } from 'react'
import { upsertRun } from './runs'
import { useResource } from './use-resource'

/** Execuções desta sessão (Main), mantidas atualizadas pelo evento `runs:updated`. */
export function useSessionRuns() {
  const runs = useResource(() => window.gerpro.runs.list())
  const { update } = runs
  useEffect(() => window.gerpro.runs.onUpdated((run) => update((list) => upsertRun(list, run))), [update])
  return runs
}
