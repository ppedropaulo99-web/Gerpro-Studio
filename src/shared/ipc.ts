/**
 * Contrato de IPC compartilhado entre Main, Preload e Renderer.
 *
 * Toda comunicação passa por canais declarados aqui: o Preload só expõe
 * esses canais e o Main só registra handlers para eles. Um canal novo
 * começa neste arquivo.
 */

import type { AgentDraft, AgentRecord, AgentsStorageStatus } from './agents'
import type { Conversation, ConversationList, ConversationSaveChange, ConversationSaveStatus, ConversationSendRequest } from './conversations'
import type { Result } from './errors'
import type { AnalysisRequest, HardwareAdvisorState, LocalConsentChange } from './hardware'
import type { ProviderOverview } from './inference'
import type { DemoRunRequest, RunRecord, RunRequest } from './runs'
import type { AppSettings, SettingsPatch, Theme } from './settings'
import type { ToolCatalogEntry } from './tools'

export const IpcChannels = {
  appGetInfo: 'app:get-info',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  agentsList: 'agents:list',
  agentsCreate: 'agents:create',
  agentsUpdate: 'agents:update',
  agentsDelete: 'agents:delete',
  agentsStorageStatus: 'agents:storage-status',
  toolsList: 'tools:list',
  runsList: 'runs:list',
  runsStart: 'runs:start',
  /** Compatibilidade: convertido no Main em `runs:start` com o provedor simulado. */
  runsStartDemo: 'runs:start-demo',
  runsCancel: 'runs:cancel',
  providersList: 'providers:list',
  conversationsList: 'conversations:list',
  conversationsGet: 'conversations:get',
  conversationsSend: 'conversations:send',
  conversationsRename: 'conversations:rename',
  conversationsDelete: 'conversations:delete',
  conversationsRetrySave: 'conversations:retry-save',
  hardwareGetState: 'hardware:get-state',
  hardwareSetLocalConsent: 'hardware:set-local-consent',
  hardwareAnalyze: 'hardware:analyze',
  hardwareDeleteData: 'hardware:delete-data'
} as const

/** Canais de evento Main → Renderer. */
export const IpcEvents = {
  runsUpdated: 'runs:updated',
  conversationsUpdated: 'conversations:updated',
  conversationsSaveChanged: 'conversations:save-changed'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

export interface AppInfo {
  name: string
  version: string
  platform: string
  versions: {
    electron: string
    chrome: string
    node: string
  }
}

/** API exposta ao Renderer via contextBridge como `window.gerpro`. */
export interface GerproApi {
  app: {
    getInfo(): Promise<AppInfo>
    /** Tema salvo quando a janela abriu; usado só para pintar o primeiro quadro. */
    readonly initialTheme: Theme
  }
  settings: {
    get(): Promise<Result<AppSettings>>
    update(patch: SettingsPatch): Promise<Result<AppSettings>>
  }
  agents: {
    /** Inclui a disponibilidade calculada de cada agente. */
    list(): Promise<Result<AgentRecord[]>>
    /** Falha com `conflict` se o ID já existir. */
    create(draft: AgentDraft): Promise<Result<AgentRecord>>
    /** Falha com `not-found` se o agente não existir. */
    update(draft: AgentDraft): Promise<Result<AgentRecord>>
    remove(id: string): Promise<Result<null>>
    /** As gravações podem estar bloqueadas para proteger o arquivo; o Main recusa de qualquer forma. */
    storageStatus(): Promise<Result<AgentsStorageStatus>>
  }
  tools: {
    list(): Promise<Result<ToolCatalogEntry[]>>
  }
  runs: {
    /** Somente execuções desta sessão. `origin` vem do provedor que atendeu (simulado ou real). */
    list(): Promise<Result<RunRecord[]>>
    /**
     * Valida, resolve modelo e perfil e enfileira (uma execução ativa, até 10
     * aguardando). Com o provedor simulado, o resultado é `origin: 'simulated'`.
     * Recusas antes da fila: `validation`, `not-found`, `invalid-state`,
     * `conflict` (fila cheia) ou `inference` (código em `details.inferenceCode`).
     */
    start(request: RunRequest): Promise<Result<RunRecord>>
    /**
     * Compatibilidade: inicia a demonstração no provedor simulado pela mesma
     * fila de `start`. Nenhum modelo ou ferramenta é chamado.
     */
    startDemo(request: DemoRunRequest): Promise<Result<RunRecord>>
    /** Pendente sai da fila; em andamento é abortada. Ambas terminam `cancelled` na hora. */
    cancel(id: string): Promise<Result<RunRecord>>
    /**
     * Recebe as mudanças de execução: estados na hora, texto agrupado (no
     * máximo uma atualização a cada ~75 ms). Guarde a de maior `revision`.
     * Devolve a função que cancela a inscrição.
     */
    onUpdated(listener: (run: RunRecord) => void): () => void
  }
  /**
   * Provedores de inferência registrados no Main, com estado verificado na
   * hora e modelos locais instalados (`models: null` = não foi possível consultar).
   * O Renderer nunca fala com um provedor diretamente.
   */
  providers: {
    list(): Promise<Result<ProviderOverview[]>>
  }
  /**
   * Conversas contínuas, gravadas neste computador. Cada envio é uma
   * execução do `RunService` com o recorte permitido do histórico; o texto em
   * geração chega por `runs.onUpdated` e a resposta final, por `onUpdated`.
   */
  conversations: {
    /** Mais recente primeiro; `damaged` conta arquivos que não puderam ser lidos. */
    list(): Promise<Result<ConversationList>>
    get(id: string): Promise<Result<Conversation>>
    /**
     * `conversationId: null` cria a conversa com a mensagem. Recusas:
     * `conflict` (resposta em geração ou limite), `invalid-state` (outro
     * agente), além das recusas de `runs.start`.
     */
    send(request: ConversationSendRequest): Promise<Result<{ conversation: Conversation; run: RunRecord }>>
    rename(id: string, title: string): Promise<Result<Conversation>>
    /** Interrompe a resposta em geração, se houver, e apaga o arquivo. */
    remove(id: string): Promise<Result<null>>
    /** Tenta gravar de novo uma conversa que ficou sem salvar; devolve a situação depois da tentativa. */
    retrySave(id: string): Promise<Result<ConversationSaveStatus>>
    onUpdated(listener: (conversation: Conversation) => void): () => void
    /** Mudanças na situação de gravação (salva, salvando, falha). */
    onSaveChanged(listener: (change: ConversationSaveChange) => void): () => void
  }
  /** Gerpro Hardware Advisor. Nesta etapa, só análises demonstrativas produzem dados (fictícios). */
  hardware: {
    getState(): Promise<Result<HardwareAdvisorState>>
    /** Autoriza ou revoga a análise local. Revogar pode apagar os dados (`deleteData`). */
    setLocalConsent(change: LocalConsentChange): Promise<Result<HardwareAdvisorState>>
    /** Exige autorização. `mode: 'real'` responde "indisponível" nesta etapa. */
    analyze(request: AnalysisRequest): Promise<Result<HardwareAdvisorState>>
    deleteData(): Promise<Result<HardwareAdvisorState>>
  }
}
