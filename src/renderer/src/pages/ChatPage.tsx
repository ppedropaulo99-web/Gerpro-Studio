import { useState } from 'react'
import { MessageSquarePlus, Paperclip, SendHorizontal } from 'lucide-react'
import { Button, EmptyState, FeatureBadge, Select, TextArea } from '@renderer/components/ui'
import { conversations } from '@renderer/data/conversations'
import { agentById } from '@renderer/data/agents'
import { models } from '@renderer/data/models'
import { cx } from '@renderer/lib/cx'

const chatModels = models.filter((m) => m.capabilities.includes('chat'))

export function ChatPage() {
  const [activeId, setActiveId] = useState(conversations[0].id)
  const active = conversations.find((c) => c.id === activeId) ?? conversations[0]

  return (
    <div className="page page--full chat">
      <aside className="chat__list" aria-label="Conversas" data-tour="chat.list">
        <div className="chat__list-head stack" style={{ gap: 'var(--space-2)' }}>
          <Button
            variant="secondary"
            icon={<MessageSquarePlus size={16} />}
            style={{ width: '100%' }}
            disabled
            title="Planejado: depende do motor de IA"
          >
            Nova conversa
          </Button>
          <div className="row between">
            <span className="subtle">Conversas de exemplo</span>
            <FeatureBadge state="example" />
          </div>
        </div>
        {conversations.map((c) => (
          <button
            key={c.id}
            type="button"
            className={cx('chat__item', c.id === activeId && 'chat__item--active')}
            aria-current={c.id === activeId}
            onClick={() => setActiveId(c.id)}
          >
            <span className="chat__item-title">{c.title}</span>
            <span className="subtle">
              {c.agentId ? agentById[c.agentId]?.name : 'Sem agente'} · {c.updatedAt}
            </span>
          </button>
        ))}
      </aside>

      <section className="chat__main">
        <header className="chat__head">
          <div className="stack" style={{ gap: 0, minWidth: 0 }}>
            <h2 className="truncate">{active.title}</h2>
            <span className="subtle">
              {active.agentId ? agentById[active.agentId]?.name : 'Conversa livre'} · conversa de exemplo, sem resposta de IA real
            </span>
          </div>
          <div className="row">
            <FeatureBadge state="planned">Inferência planejada</FeatureBadge>
            {/* Sem motor conectado, escolher modelo não teria efeito: o seletor fica desativado. */}
            <Select
              aria-label="Modelo (indisponível: motor de IA não conectado)"
              title="Planejado: a escolha de modelo depende do motor de IA"
              style={{ width: 220 }}
              value={chatModels[0].id}
              disabled
              options={chatModels.map((m) => ({ value: m.id, label: `${m.name} (exemplo)` }))}
            />
          </div>
        </header>

        <div className="chat__thread">
          {active.messages.length === 0 ? (
            <EmptyState title="Conversa vazia">Envie uma mensagem para começar.</EmptyState>
          ) : (
            active.messages.map((m, i) => (
              <div key={i} className={cx('bubble', `bubble--${m.role}`)}>
                {m.content}
              </div>
            ))
          )}
        </div>

        <footer className="chat__composer" data-tour="chat.composer">
          <TextArea
            placeholder="Envio planejado: o motor de IA ainda não está conectado."
            rows={2}
            disabled
            aria-label="Mensagem"
          />
          <div className="row between">
            <Button variant="ghost" size="sm" icon={<Paperclip size={14} />} disabled>
              Anexar
            </Button>
            <Button variant="primary" icon={<SendHorizontal size={15} />} disabled>
              Enviar
            </Button>
          </div>
        </footer>
      </section>
    </div>
  )
}
