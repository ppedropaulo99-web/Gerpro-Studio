import type { ToolDefinition } from '@shared/tools'

/**
 * Ferramentas conhecidas pelo app. Apenas declarações: nenhuma tem executor
 * nesta etapa. Os IDs coincidem com os dados demonstrativos da tela
 * Ferramentas, para facilitar a integração futura.
 */

export interface CatalogItem {
  definition: ToolDefinition
  enabledByDefault: boolean
}

const text = (description: string) => ({ type: 'string', description }) as const

export const BUILTIN_TOOLS: readonly CatalogItem[] = [
  {
    enabledByDefault: true,
    definition: {
      id: 'web-search',
      name: 'Busca na Web',
      description: 'Pesquisa páginas e retorna trechos relevantes.',
      version: '0.1.0',
      source: 'builtin',
      permissions: ['network'],
      inputSchema: {
        type: 'object',
        properties: { query: text('Termos da busca'), limit: { type: 'integer', minimum: 1, maximum: 20 } },
        required: ['query'],
        additionalProperties: false
      },
      outputSchema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: { title: text('Título'), url: text('Endereço'), snippet: text('Trecho') },
              required: ['title', 'url']
            }
          }
        },
        required: ['results']
      }
    }
  },
  {
    enabledByDefault: true,
    definition: {
      id: 'calculator',
      name: 'Calculadora',
      description: 'Avalia expressões matemáticas com precisão.',
      version: '0.1.0',
      source: 'builtin',
      permissions: [],
      inputSchema: {
        type: 'object',
        properties: { expression: { type: 'string', minLength: 1, maxLength: 1000 } },
        required: ['expression'],
        additionalProperties: false
      },
      outputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] }
    }
  },
  {
    enabledByDefault: true,
    definition: {
      id: 'filesystem',
      name: 'Arquivos',
      description: 'Lê e grava arquivos em pastas autorizadas.',
      version: '0.1.0',
      source: 'builtin',
      permissions: ['filesystem:read', 'filesystem:write'],
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['read', 'write', 'list'] },
          path: text('Caminho dentro de uma pasta autorizada'),
          content: text('Conteúdo, quando a operação é write')
        },
        required: ['operation', 'path'],
        additionalProperties: false
      },
      outputSchema: {
        type: 'object',
        properties: { content: text('Conteúdo lido'), entries: { type: 'array', items: { type: 'string' } } }
      }
    }
  },
  {
    enabledByDefault: false,
    definition: {
      id: 'terminal',
      name: 'Terminal',
      description: 'Executa comandos de shell com aprovação.',
      version: '0.1.0',
      source: 'builtin',
      permissions: ['process'],
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', minLength: 1, maxLength: 4000 }, cwd: text('Pasta de trabalho') },
        required: ['command'],
        additionalProperties: false
      },
      outputSchema: {
        type: 'object',
        properties: { exitCode: { type: 'integer' }, stdout: text('Saída'), stderr: text('Erros') },
        required: ['exitCode']
      }
    }
  },
  {
    enabledByDefault: true,
    definition: {
      id: 'document-reader',
      name: 'Leitor de Documentos',
      description: 'Extrai texto de PDF, DOCX e imagens.',
      version: '0.1.0',
      source: 'plugin',
      pluginId: 'gerpro-documents',
      permissions: ['filesystem:read'],
      inputSchema: { type: 'object', properties: { path: text('Arquivo') }, required: ['path'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { text: text('Texto extraído') }, required: ['text'] }
    }
  },
  {
    enabledByDefault: true,
    definition: {
      id: 'spreadsheet',
      name: 'Planilhas',
      description: 'Abre CSV e XLSX e consulta células.',
      version: '0.1.0',
      source: 'plugin',
      pluginId: 'gerpro-spreadsheets',
      permissions: ['filesystem:read'],
      inputSchema: {
        type: 'object',
        properties: { path: text('Arquivo'), range: text('Intervalo, ex.: A1:C10') },
        required: ['path'],
        additionalProperties: false
      },
      outputSchema: {
        type: 'object',
        properties: { rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } },
        required: ['rows']
      }
    }
  },
  {
    enabledByDefault: false,
    definition: {
      id: 'knowledge-base',
      name: 'Base de Conhecimento',
      description: 'Busca semântica em documentos indexados.',
      version: '0.1.0',
      source: 'plugin',
      pluginId: 'gerpro-knowledge',
      permissions: ['filesystem:read'],
      inputSchema: {
        type: 'object',
        properties: { query: text('Pergunta'), topK: { type: 'integer', minimum: 1, maximum: 50 } },
        required: ['query'],
        additionalProperties: false
      },
      outputSchema: {
        type: 'object',
        properties: {
          passages: {
            type: 'array',
            items: { type: 'object', properties: { source: text('Documento'), text: text('Trecho') }, required: ['text'] }
          }
        },
        required: ['passages']
      }
    }
  }
]
