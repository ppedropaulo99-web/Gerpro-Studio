import type { LibraryModel } from './types'

/** Biblioteca de modelos simulada. Nomes genéricos e fictícios. */
export const models: LibraryModel[] = [
  {
    id: 'aurora-8b-instruct',
    name: 'Aurora 8B Instruct',
    publisher: 'Gerpro Labs',
    format: 'gguf',
    parameters: '8B',
    quantization: 'Q4_K_M',
    sizeGb: 4.9,
    contextLength: 32768,
    capabilities: ['chat', 'tools'],
    status: 'loaded',
    description: 'Modelo geral equilibrado para conversa e uso de ferramentas.'
  },
  {
    id: 'sirius-14b-reasoner',
    name: 'Sirius 14B Reasoner',
    publisher: 'Open Model Collective',
    format: 'gguf',
    parameters: '14B',
    quantization: 'Q5_K_M',
    sizeGb: 10.2,
    contextLength: 65536,
    capabilities: ['chat', 'reasoning', 'tools'],
    status: 'available',
    description: 'Raciocínio em várias etapas, ideal para análise e planejamento.'
  },
  {
    id: 'lumen-vision-7b',
    name: 'Lumen Vision 7B',
    publisher: 'Prisma AI',
    format: 'safetensors',
    parameters: '7B',
    quantization: 'BF16',
    sizeGb: 14.8,
    contextLength: 16384,
    capabilities: ['chat', 'vision'],
    status: 'downloading',
    downloadProgress: 62,
    description: 'Entende imagens e documentos digitalizados.'
  },
  {
    id: 'koda-coder-6b',
    name: 'Koda Coder 6B',
    publisher: 'Gerpro Labs',
    format: 'gguf',
    parameters: '6B',
    quantization: 'Q6_K',
    sizeGb: 5.1,
    contextLength: 32768,
    capabilities: ['chat', 'tools'],
    status: 'available',
    description: 'Especializado em geração e revisão de código.'
  },
  {
    id: 'vetor-embed-small',
    name: 'Vetor Embed Small',
    publisher: 'Open Model Collective',
    format: 'onnx',
    parameters: '137M',
    quantization: 'FP16',
    sizeGb: 0.3,
    contextLength: 8192,
    capabilities: ['embedding'],
    status: 'loaded',
    description: 'Embeddings rápidos para busca semântica e RAG.'
  },
  {
    id: 'atlas-70b-instruct',
    name: 'Atlas 70B Instruct',
    publisher: 'Northwind Research',
    format: 'gguf',
    parameters: '70B',
    quantization: 'Q3_K_S',
    sizeGb: 30.9,
    contextLength: 131072,
    capabilities: ['chat', 'reasoning', 'tools'],
    status: 'error',
    description: 'Alta qualidade; exige muita memória. Falhou no último carregamento.'
  }
]

export const modelById = Object.fromEntries(models.map((m) => [m.id, m])) as Record<string, LibraryModel>
