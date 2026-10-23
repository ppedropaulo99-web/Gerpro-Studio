import { useCallback, useEffect, useRef, useState } from 'react'
import type { Result, StructuredError } from '@shared/errors'
import { callApi } from './api'

export type Resource<T> =
  | { status: 'loading' }
  | { status: 'error'; error: StructuredError }
  | { status: 'ready'; data: T }

/**
 * Carrega um recurso do Main ao montar o componente e expõe os estados de
 * carregamento, erro e pronto. `update` altera o dado já carregado sem
 * nova ida ao Main (por exemplo, após salvar).
 */
export function useResource<T>(load: () => Promise<Result<T>>) {
  const [state, setState] = useState<Resource<T>>({ status: 'loading' })
  const loadRef = useRef(load)
  loadRef.current = load

  const reload = useCallback(() => {
    let active = true
    setState({ status: 'loading' })
    void callApi(loadRef.current).then((result) => {
      if (active) setState(result.ok ? { status: 'ready', data: result.data } : { status: 'error', error: result.error })
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => reload(), [reload])

  const update = useCallback((fn: (data: T) => T) => {
    setState((s) => (s.status === 'ready' ? { status: 'ready', data: fn(s.data) } : s))
  }, [])

  return { state, reload, update }
}
