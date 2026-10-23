import type { Conversation } from './types'

/** Conversas simuladas para o protótipo da tela de Chat. */
export const conversations: Conversation[] = [
  {
    id: 'c1',
    title: 'Plano de lançamento do produto',
    agentId: 'assistente-geral',
    updatedAt: 'Hoje, 14:32',
    messages: [
      { role: 'user', content: 'Me ajude a montar um plano de lançamento em quatro semanas para um app de finanças pessoais.' },
      {
        role: 'assistant',
        content:
          'Claro. Uma proposta em quatro fases:\n\n1. Semana 1 — Preparação: definir público, mensagem principal e métricas de sucesso.\n2. Semana 2 — Pré-lançamento: lista de espera, conteúdo de bastidores e convites beta.\n3. Semana 3 — Lançamento: anúncio coordenado, imprensa e suporte reforçado.\n4. Semana 4 — Pós-lançamento: coleta de feedback, correções rápidas e primeiro relatório.\n\nQuer que eu detalhe alguma fase?'
      },
      { role: 'user', content: 'Detalhe a semana 2.' }
    ]
  },
  {
    id: 'c2',
    title: 'Revisão do módulo de autenticação',
    agentId: 'revisor-codigo',
    updatedAt: 'Hoje, 14:05',
    messages: [
      { role: 'user', content: 'Revise a função de validação de token.' },
      { role: 'assistant', content: 'Encontrei dois pontos: a comparação não é em tempo constante e o tempo de expiração não considera desvio de relógio.' }
    ]
  },
  {
    id: 'c3',
    title: 'Comparativo de bancos vetoriais',
    agentId: 'pesquisador',
    updatedAt: 'Ontem',
    messages: [{ role: 'user', content: 'Compare três bancos vetoriais para uso local.' }]
  },
  { id: 'c4', title: 'Rascunho de e-mail', agentId: null, updatedAt: '20 out', messages: [] }
]
