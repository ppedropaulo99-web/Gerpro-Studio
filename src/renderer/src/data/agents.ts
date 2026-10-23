import type { Agent } from './types'

/** Catálogo de agentes simulado. */
export const agents: Agent[] = [
  {
    id: 'assistente-geral',
    name: 'Assistente Geral',
    description: 'Responde perguntas, resume textos e ajuda no dia a dia.',
    category: 'Produtividade',
    status: 'active',
    modelId: 'aurora-8b-instruct',
    tools: ['web-search', 'calculator'],
    runsLast7d: 142,
    updatedAt: '2026-10-22'
  },
  {
    id: 'revisor-codigo',
    name: 'Revisor de Código',
    description: 'Analisa diffs, aponta bugs e sugere melhorias de estilo.',
    category: 'Desenvolvimento',
    status: 'active',
    modelId: 'koda-coder-6b',
    tools: ['filesystem', 'terminal'],
    runsLast7d: 57,
    updatedAt: '2026-10-21'
  },
  {
    id: 'pesquisador',
    name: 'Pesquisador',
    description: 'Busca fontes, compara referências e produz relatórios citados.',
    category: 'Pesquisa',
    status: 'idle',
    modelId: 'sirius-14b-reasoner',
    tools: ['web-search', 'document-reader'],
    runsLast7d: 23,
    updatedAt: '2026-10-18'
  },
  {
    id: 'analista-dados',
    name: 'Analista de Dados',
    description: 'Lê planilhas e CSVs, calcula métricas e explica tendências.',
    category: 'Dados',
    status: 'idle',
    modelId: 'sirius-14b-reasoner',
    tools: ['spreadsheet', 'calculator'],
    runsLast7d: 31,
    updatedAt: '2026-10-15'
  },
  {
    id: 'suporte-cliente',
    name: 'Suporte ao Cliente',
    description: 'Atende dúvidas frequentes com base na base de conhecimento.',
    category: 'Atendimento',
    status: 'draft',
    modelId: 'aurora-8b-instruct',
    tools: ['knowledge-base'],
    runsLast7d: 0,
    updatedAt: '2026-10-20'
  },
  {
    id: 'leitor-documentos',
    name: 'Leitor de Documentos',
    description: 'Extrai informações de PDFs e imagens digitalizadas.',
    category: 'Produtividade',
    status: 'error',
    modelId: 'lumen-vision-7b',
    tools: ['document-reader'],
    runsLast7d: 8,
    updatedAt: '2026-10-12'
  }
]

export const agentById = Object.fromEntries(agents.map((a) => [a.id, a])) as Record<string, Agent>
