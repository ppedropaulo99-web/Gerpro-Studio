import type { Tool } from './types'

/** Ferramentas simuladas que os agentes poderão usar. */
export const tools: Tool[] = [
  { id: 'web-search', name: 'Busca na Web', description: 'Pesquisa páginas e retorna trechos relevantes.', kind: 'Integrada', permissions: ['Rede'], enabled: true },
  { id: 'calculator', name: 'Calculadora', description: 'Avalia expressões matemáticas com precisão.', kind: 'Integrada', permissions: [], enabled: true },
  { id: 'filesystem', name: 'Arquivos', description: 'Lê e grava arquivos em pastas autorizadas.', kind: 'Integrada', permissions: ['Leitura de disco', 'Escrita de disco'], enabled: true },
  { id: 'terminal', name: 'Terminal', description: 'Executa comandos de shell com aprovação.', kind: 'Integrada', permissions: ['Processos'], enabled: false },
  { id: 'document-reader', name: 'Leitor de Documentos', description: 'Extrai texto de PDF, DOCX e imagens.', kind: 'Plugin', permissions: ['Leitura de disco'], enabled: true },
  { id: 'spreadsheet', name: 'Planilhas', description: 'Abre CSV e XLSX e consulta células.', kind: 'Plugin', permissions: ['Leitura de disco'], enabled: true },
  { id: 'knowledge-base', name: 'Base de Conhecimento', description: 'Busca semântica em documentos indexados.', kind: 'Plugin', permissions: ['Leitura de disco'], enabled: false }
]

export const toolById = Object.fromEntries(tools.map((t) => [t.id, t])) as Record<string, Tool>
