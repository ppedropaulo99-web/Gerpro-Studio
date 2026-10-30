import { MessageSquarePlus, MessagesSquare, SendHorizontal, Sparkles } from 'lucide-react'
import { useNavigation } from '@renderer/app/navigation'
import { Button, EmptyState, FeatureBadge, Notice, Select, TextArea } from '@renderer/components/ui'

/** O que o Gerpro AI deverá fazer; nada disso existe ainda. */
const plannedAbilities = [
  'Tirar dúvidas sobre o uso do Gerpro Studio.',
  'Ajudar a criar e ajustar agentes.',
  'Sugerir modelos conforme a tarefa e o computador.',
  'Explicar erros e métricas das execuções.'
]

/**
 * Gerpro AI: reservada ao futuro assistente interno do Gerpro Studio. Não chama o motor
 * de IA nem executa agentes: conversar com um modelo local é em Conversas (um
 * único fluxo de inferência, pelo RunService).
 */
export function ChatPage() {
  const { navigate } = useNavigation()

  return (
    <div className="page page--full chat">
      <aside className="chat__list" aria-label="Conversas com o Gerpro AI" data-tour="chat.list">
        <div className="chat__list-head stack" style={{ gap: 'var(--space-2)' }}>
          <Button
            variant="secondary"
            icon={<MessageSquarePlus size={16} />}
            style={{ width: '100%' }}
            disabled
            title="Em desenvolvimento: conversas com o Gerpro AI"
          >
            Nova conversa
          </Button>
          <div className="row between">
            <span className="subtle">Conversas</span>
            <FeatureBadge state="planned">Em desenvolvimento</FeatureBadge>
          </div>
        </div>
        <p className="subtle chat__note">As conversas com o Gerpro AI aparecerão aqui quando ele estiver disponível.</p>
      </aside>

      <section className="chat__main">
        <header className="chat__head">
          <div className="stack" style={{ gap: 0, minWidth: 0 }}>
            <h2 className="truncate">Gerpro AI — Seu assistente inteligente</h2>
            <span className="subtle">Seu assistente integrado para ajudar a configurar, utilizar e gerenciar o Gerpro Studio.</span>
          </div>
          <div className="row">
            <FeatureBadge state="planned">Em desenvolvimento</FeatureBadge>
            {/* O Gerpro AI ainda não existe: o seletor fica desativado. */}
            <Select
              aria-label="Modelo do Gerpro AI (indisponível: em desenvolvimento)"
              title="Em desenvolvimento: escolher o modelo do Gerpro AI"
              style={{ width: 220 }}
              value=""
              disabled
              options={[{ value: '', label: 'Modelo ainda não definido' }]}
            />
          </div>
        </header>

        <div className="chat__thread">
          <div className="stack chat__welcome">
            <EmptyState icon={<Sparkles size={26} />} title="Um assistente para ajudar você a usar o Gerpro Studio">
              Quando estiver pronto, ele deverá:
            </EmptyState>
            <ul className="chat__planned">
              {plannedAbilities.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
            <Notice tone="neutral">
              Nada disso funciona ainda: esta tela não está ligada a nenhum modelo e não executa agentes. Para conversar agora com um modelo
              instalado neste computador, use Conversas.
            </Notice>
          </div>
        </div>

        <footer className="chat__composer" data-tour="chat.composer">
          <TextArea placeholder="O Gerpro AI está em desenvolvimento. Para falar com um modelo local agora, use Conversas." rows={2} disabled aria-label="Mensagem" />
          <div className="row between">
            <Button variant="ghost" size="sm" icon={<MessagesSquare size={14} />} onClick={() => navigate('conversations')}>
              Conversar com um modelo em Conversas
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
