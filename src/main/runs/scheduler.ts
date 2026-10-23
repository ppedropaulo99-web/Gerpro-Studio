/**
 * Temporizadores injetáveis. Em produção usam os do Node; nos testes, um
 * relógio virtual controla quando cada callback dispara.
 */
export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const defaultScheduler: Scheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * Espera `ms` ou até `signal` abortar, o que vier primeiro. Nunca rejeita:
 * quem chama confere `signal.aborted` depois.
 */
export function delay(scheduler: Scheduler, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = () => {
      scheduler.clearTimeout(handle)
      resolve()
    }
    const handle = scheduler.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Resolve só quando `signal` abortar. */
export function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}
