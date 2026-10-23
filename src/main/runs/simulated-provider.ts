import {
  INFERENCE_ERROR_CODES,
  inferenceError,
  type InferenceErrorCode,
  type InferenceEvent,
  type InferenceProvider,
  type InferenceRequest,
  type ProviderInfo,
  type ProviderModelEntry,
  type ProviderStatus
} from '@shared/inference'
import type { DemoRunRequest, RunRequest } from '@shared/runs'
import { defaultScheduler, delay, untilAborted, type Scheduler } from './scheduler'

/**
 * Provedor SIMULADO e determinístico.
 *
 * Implementa o contrato `InferenceProvider` sem inferência: cada "modelo" é
 * um roteiro fixo de eventos (texto em partes, erro tipado, espera até o
 * cancelamento). Não usa aleatoriedade, rede nem arquivos. Todo texto gerado
 * começa com "[Resposta simulada]" e nenhuma métrica é produzida
 * (`metrics: null`). Serve para validar fila, cancelamento, tempo limite e
 * eventos; não prova compatibilidade com o hardware.
 */

export const SIMULATED_PROVIDER_ID = 'simulado'

export const SIMULATED_TEXT_PREFIX = '[Resposta simulada]'

/** Janela de contexto declarada pelos modelos simulados, em tokens. */
export const SIMULATED_CONTEXT_LENGTH = 8_192

/** Estimativa fixa usada pelo provedor simulado para converter caracteres em tokens. */
export const SIMULATED_CHARS_PER_TOKEN = 4

export const DEFAULT_SIMULATED_STEP_DELAY_MS = 400

type Step = { kind: 'delta'; text: string } | { kind: 'error'; code: InferenceErrorCode; message: string } | { kind: 'hang' }

interface Script {
  displayName: string
  steps: (inputChars: number) => Step[]
}

const received = (n: number) => `a mensagem recebida tinha ${n} caractere(s).`

const ERROR_SCRIPTS = Object.fromEntries(
  INFERENCE_ERROR_CODES.map((code): [string, Script] => [
    `erro-${code}`,
    {
      displayName: `Simulado: erro ${code}`,
      steps: () => [{ kind: 'error', code, message: `Erro simulado "${code}". Nenhum provedor real foi consultado.` }]
    }
  ])
)

export const SIMULATED_SCRIPTS: Readonly<Record<string, Script>> = {
  'resposta-curta': {
    displayName: 'Simulado: resposta curta',
    steps: (n) => [{ kind: 'delta', text: `${SIMULATED_TEXT_PREFIX} Nenhum modelo foi executado; ${received(n)}` }]
  },
  'resposta-em-fluxo': {
    displayName: 'Simulado: resposta em fluxo',
    steps: (n) =>
      [
        `${SIMULATED_TEXT_PREFIX} `,
        'Este texto chega em partes ',
        'para demonstrar o fluxo de resposta. ',
        'Nenhum modelo foi executado ',
        `e ${received(n)}`
      ].map((text) => ({ kind: 'delta', text }))
  },
  'falha-na-geracao': {
    displayName: 'Simulado: falha durante a geração',
    steps: () => [
      { kind: 'delta', text: `${SIMULATED_TEXT_PREFIX} ` },
      { kind: 'delta', text: 'Início da resposta antes da falha. ' },
      { kind: 'error', code: 'provider-error', message: 'Falha simulada durante a geração.' }
    ]
  },
  'sem-resposta': {
    displayName: 'Simulado: sem resposta (aguarda cancelamento ou tempo limite)',
    steps: () => [{ kind: 'hang' }]
  },
  ...ERROR_SCRIPTS
}

export interface SimulatedProviderOptions {
  /** Intervalo entre os eventos do roteiro. */
  stepDelayMs?: number
  scheduler?: Scheduler
  now?: () => Date
}

export class SimulatedInferenceProvider implements InferenceProvider {
  readonly info: ProviderInfo = { id: SIMULATED_PROVIDER_ID, displayName: 'Provedor simulado', kind: 'simulated' }
  private readonly stepDelayMs: number
  private readonly scheduler: Scheduler
  private readonly now: () => Date

  constructor(options: SimulatedProviderOptions = {}) {
    this.stepDelayMs = options.stepDelayMs ?? DEFAULT_SIMULATED_STEP_DELAY_MS
    this.scheduler = options.scheduler ?? defaultScheduler
    this.now = options.now ?? (() => new Date())
  }

  async status(): Promise<ProviderStatus> {
    return {
      providerId: this.info.id,
      state: 'ready',
      version: null,
      checkedAt: this.now().toISOString(),
      message: 'Provedor simulado: respostas fixas, nenhum modelo real.'
    }
  }

  async listModels(): Promise<ProviderModelEntry[]> {
    return Object.entries(SIMULATED_SCRIPTS).map(([modelId, script]) => ({
      availability: 'installed',
      model: {
        ref: { providerId: this.info.id, modelId },
        digest: null,
        location: 'local',
        displayName: script.displayName,
        family: null,
        parameterSize: null,
        quantization: null,
        format: null,
        sizeBytes: null,
        contextLength: SIMULATED_CONTEXT_LENGTH,
        contextBytesPerToken: null,
        capabilities: ['chat']
      }
    }))
  }

  async *generate(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent> {
    const script = request.model.providerId === this.info.id ? SIMULATED_SCRIPTS[request.model.modelId] : undefined
    if (!script) {
      yield { type: 'error', error: inferenceError('model-not-found', `Modelo simulado "${request.model.modelId}" não existe.`) }
      return
    }
    const promptChars = request.messages.reduce((sum, m) => sum + m.content.length, 0)
    const contextTokens = request.profile.contextLength ?? SIMULATED_CONTEXT_LENGTH
    if (Math.ceil(promptChars / SIMULATED_CHARS_PER_TOKEN) > contextTokens) {
      yield { type: 'error', error: inferenceError('context-too-long', `A mensagem excede o contexto simulado de ${contextTokens} tokens.`) }
      return
    }
    const input = request.messages.findLast((m) => m.role === 'user')?.content ?? ''
    const maxChars = request.profile.maxOutputTokens === null ? Infinity : request.profile.maxOutputTokens * SIMULATED_CHARS_PER_TOKEN
    let emitted = 0

    yield { type: 'loading' }
    for (const step of script.steps(input.length)) {
      await delay(this.scheduler, this.stepDelayMs, signal)
      if (signal.aborted) break
      if (step.kind === 'hang') {
        await untilAborted(signal)
        break
      }
      if (step.kind === 'error') {
        yield { type: 'error', error: inferenceError(step.code, step.message) }
        return
      }
      if (emitted + step.text.length > maxChars) {
        yield { type: 'delta', text: step.text.slice(0, maxChars - emitted) }
        yield { type: 'done', finishReason: 'length', metrics: null }
        return
      }
      emitted += step.text.length
      yield { type: 'delta', text: step.text }
    }
    yield { type: 'done', finishReason: signal.aborted ? 'cancelled' : 'stop', metrics: null }
  }
}

// ---------------------------------------------------------------------------
// Compatibilidade: `runs:start-demo`
// ---------------------------------------------------------------------------

export const DEMO_RUN_INPUT = 'Demonstração do ciclo de vida de uma execução.'

/**
 * Converte o pedido antigo de demonstração num `RunRequest` para o provedor
 * simulado. Mantido enquanto a tela Execuções e a Apresentação Guiada usarem
 * `runs:start-demo`; não há fila própria: tudo passa pelo `RunService`.
 */
export function demoRunRequest(demo: DemoRunRequest): RunRequest {
  return {
    agentId: demo.agentId,
    input: DEMO_RUN_INPUT,
    overrides: {
      model: { providerId: SIMULATED_PROVIDER_ID, modelId: demo.scenario === 'success' ? 'resposta-em-fluxo' : 'falha-na-geracao' },
      profile: null
    }
  }
}
