/**
 * Contratos do futuro motor de IA. Nada aqui é implementado nesta etapa;
 * os tipos existem para que Main, plugins e UI convirjam na mesma forma
 * quando o motor real for adicionado.
 */

export type ModelFormat = 'gguf' | 'safetensors' | 'onnx'

export type ModelStatus = 'available' | 'downloading' | 'loaded' | 'error'

export interface ModelDescriptor {
  id: string
  name: string
  publisher: string
  format: ModelFormat
  parameters: string
  quantization: string
  sizeGb: number
  contextLength: number
  capabilities: Array<'chat' | 'vision' | 'tools' | 'embedding' | 'reasoning'>
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

/** Interface que qualquer motor de inferência deverá implementar. */
export interface InferenceEngine {
  readonly id: string
  listModels(): Promise<ModelDescriptor[]>
  load(modelId: string): Promise<void>
  unload(modelId: string): Promise<void>
  chat(modelId: string, messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<string>
}
