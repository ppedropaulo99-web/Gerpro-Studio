/**
 * Descrição dos modelos da biblioteca de exemplo da interface.
 *
 * Os contratos de inferência real (provedores, identidade de modelos,
 * eventos e métricas) ficam em `inference.ts`.
 */

import type { ModelCapability } from './inference'

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
  capabilities: ModelCapability[]
}
