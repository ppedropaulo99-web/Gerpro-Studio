import { useCallback, useEffect, useState } from 'react'
import type { ConversationList, ConversationSaveStatus } from '@shared/conversations'
import { watchConversations, type ConversationListState } from './conversations'

/**
 * Lista de conversas gravadas (Main), atualizada por `conversations:updated`.
 * `update` aplica na hora o resultado de envio, renomeação ou exclusão.
 */
export function useConversationList() {
  const [state, setState] = useState<ConversationListState>({ status: 'loading' })
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    setState({ status: 'loading' })
    return watchConversations(window.gerpro.conversations, setState)
  }, [generation])

  const reload = useCallback(() => setGeneration((g) => g + 1), [])

  const update = useCallback((fn: (data: ConversationList) => ConversationList) => {
    setState((s) => (s.status === 'ready' ? { status: 'ready', data: fn(s.data) } : s))
  }, [])

  return { state, reload, update }
}

/**
 * Situação de gravação avisada pelo Main (`conversations:save-changed`), por
 * conversa. Só muda quando a situação muda; `set` aplica o resultado de uma
 * nova tentativa.
 */
export function useSaveStates() {
  const [states, setStates] = useState<Record<string, ConversationSaveStatus>>({})
  useEffect(() => window.gerpro.conversations.onSaveChanged(({ conversationId, save }) => setStates((s) => ({ ...s, [conversationId]: save }))), [])
  const set = useCallback((id: string, save: ConversationSaveStatus) => setStates((s) => ({ ...s, [id]: save })), [])
  return { states, set }
}
