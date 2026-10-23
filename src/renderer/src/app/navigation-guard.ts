/**
 * Controlador de navegação com proteção de alterações não salvas.
 *
 * Telas com formulário registram um guarda e informam se há alterações
 * pendentes. Uma navegação para outra tela com guarda pendente fica retida
 * até o usuário escolher "Continuar editando" (`keepEditing`) ou "Descartar
 * alterações" (`confirmDiscard`). Sem pendências, navega direto.
 *
 * Sem React nem DOM: a interface assina mudanças com `subscribe`.
 */

export interface NavigationSnapshot<R extends string> {
  current: R
  /** Destino retido aguardando decisão; `null` quando não há confirmação aberta. */
  pending: R | null
  /** Onde estão as alterações (rótulo do guarda pendente, ex.: "nas configurações"), para o diálogo. */
  blockedBy: string | null
}

export type NavigationOutcome = 'navigated' | 'blocked' | 'unchanged'

interface Guard {
  label: string
  dirty: boolean
}

export class NavigationController<R extends string> {
  private snapshot: NavigationSnapshot<R>
  private readonly guards = new Map<number, Guard>()
  private readonly listeners = new Set<() => void>()
  private nextId = 1

  constructor(initial: R) {
    this.snapshot = { current: initial, pending: null, blockedBy: null }
  }

  /** Mesmo objeto enquanto nada muda (requisito de `useSyncExternalStore`). */
  getSnapshot = (): NavigationSnapshot<R> => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Pede para ir a `to`. Retém a navegação se houver alterações pendentes. */
  request(to: R): NavigationOutcome {
    if (to === this.snapshot.current) return 'unchanged'
    const blocker = this.firstDirty()
    if (blocker) {
      this.set({ ...this.snapshot, pending: to, blockedBy: blocker.label })
      return 'blocked'
    }
    this.set({ current: to, pending: null, blockedBy: null })
    return 'navigated'
  }

  /** "Continuar editando": cancela a navegação retida; nada é alterado. */
  keepEditing(): void {
    if (this.snapshot.pending !== null) this.set({ ...this.snapshot, pending: null, blockedBy: null })
  }

  /** "Descartar alterações": segue para o destino retido. */
  confirmDiscard(): R | null {
    const to = this.snapshot.pending
    if (to === null) return null
    // A tela de origem será desmontada; suas pendências deixam de valer.
    for (const guard of this.guards.values()) guard.dirty = false
    this.set({ current: to, pending: null, blockedBy: null })
    return to
  }

  /** Registra um guarda (ex.: um formulário montado). Devolve o ID. */
  register(label: string): number {
    const id = this.nextId++
    this.guards.set(id, { label, dirty: false })
    return id
  }

  setDirty(id: number, dirty: boolean): void {
    const guard = this.guards.get(id)
    if (guard) guard.dirty = dirty
  }

  unregister(id: number): void {
    this.guards.delete(id)
  }

  hasUnsavedChanges(): boolean {
    return this.firstDirty() !== undefined
  }

  private firstDirty(): Guard | undefined {
    for (const guard of this.guards.values()) if (guard.dirty) return guard
    return undefined
  }

  private set(next: NavigationSnapshot<R>): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
