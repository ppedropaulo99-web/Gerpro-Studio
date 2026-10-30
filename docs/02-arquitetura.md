# Arquitetura

## Visão geral

```text
┌──────────────────────────── Processo Main (Node.js) ────────────────────────────┐
│ index.ts      ciclo de vida, instância única                                    │
│ security.ts   CSP, permissões de dispositivo negadas                            │
│ window.ts     BrowserWindow com sandbox; navegação e novas janelas bloqueadas   │
│ ipc.ts        valida o remetente → ipc-handlers.ts (aridade + validação)        │
│ services/     SettingsService, AgentService                                     │
│ tools/        ToolRegistry (catálogo declarado)                                 │
│ runs/         RunService (fila, cancelamento, prazo) + provedor simulado        │
│ hardware/     HardwareAdvisorService + detectores                               │
│ storage/      VersionedStore, escrita atômica, SecretVault                      │
│ engine/       (reservado)          plugins/  (reservado)                        │
└───────────────────────────────▲──────────────────────────────────────────────────┘
                                │ ipcRenderer.invoke / on (só canais de shared/ipc.ts)
┌───────────────────────────────┴── Preload (sandbox, CommonJS) ───────────────────┐
│ contextBridge.exposeInMainWorld('gerpro', api): funções de alto nível            │
└───────────────────────────────▲──────────────────────────────────────────────────┘
                                │ window.gerpro.*
┌───────────────────────────────┴── Renderer (React, sem Node) ────────────────────┐
│ pages/  components/  lib/ (callApi, useResource, mapeamentos puros)  data/       │
└──────────────────────────────────────────────────────────────────────────────────┘

src/shared/  contratos, validação e regras puras, usados pelos três processos
```

**Regra de dependência:** `src/shared/` não importa React, Electron nem
APIs do Node. Por isso os contratos, a validação e o motor de recomendações
podem ser reaproveitados em um serviço web, o que é relevante para a
integração com o Gerpro Web.

## Limites de segurança entre Main, Preload e Renderer

### Renderer (não confiável por padrão)

`webPreferences` da janela (`src/main/window.ts`):

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
  `nodeIntegrationInWorker: false`, `nodeIntegrationInSubFrames: false`
- `webSecurity: true`, `webviewTag: false`, `devTools` só em desenvolvimento

O que o Renderer **não** tem:

- Acesso a Node.js, `require`, `ipcRenderer` ou ao sistema de arquivos.
- Navegação para fora da aplicação: `will-navigate` bloqueia URLs que não
  são do app.
- Novas janelas. Links `https://` abrem no navegador do sistema.
- Permissões de dispositivo (câmera, microfone, notificações etc.): todas
  negadas em `src/main/security.ts`.

CSP em produção: `default-src 'self'; script-src 'self'; connect-src 'self';
object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. Em
desenvolvimento, uma variante libera script inline e WebSocket de
`localhost` para o recarregamento do Vite.

### Preload (ponte mínima)

`src/preload/index.ts` expõe `window.gerpro` com funções de alto nível
(`agents.create`, `hardware.analyze`...). Cada função chama exatamente um
canal declarado em `src/shared/ipc.ts`. O objeto de evento do Electron nunca
chega ao Renderer: `runs.onUpdated` repassa só o `RunRecord`.

A única informação que não passa por IPC é o tema inicial
(`app.initialTheme`): o Main o envia como argumento da janela e o
Preload só aceita `dark` ou `light`.

### Main (fronteira de confiança)

Toda chamada passa por três verificações em `src/main/ipc.ts` e
`src/main/ipc-handlers.ts`:

1. **Remetente:** `assertTrustedSender` só aceita frames da própria
   aplicação (`file:` em produção; a origem do Vite em desenvolvimento).
2. **Aridade:** cada canal declara quantos argumentos aceita. Argumentos a
   mais ou a menos geram erro de validação.
3. **Conteúdo:** os argumentos chegam como `unknown` e passam pelos
   validadores de `src/shared/`. Os tipos TypeScript não são considerados
   garantia.

Os erros saem como `StructuredError` (código, mensagem, `retryable`,
problemas de validação), sem stack trace. Eventos Main → Renderer
(`runs:updated`) vão só para janelas que exibem o próprio app.

### Canais IPC

| Canal | Argumentos | Retorno |
|---|---|---|
| `app:get-info` | — | `AppInfo` (sem `Result`) |
| `settings:get` / `settings:update` | — / `SettingsPatch` | `Result<AppSettings>` |
| `agents:list` | — | `Result<AgentRecord[]>` |
| `agents:create` / `agents:update` | `AgentDraft` | `Result<AgentRecord>` |
| `agents:delete` | `id` | `Result<null>` |
| `tools:list` | — | `Result<ToolCatalogEntry[]>` |
| `runs:list` | — | `Result<RunRecord[]>` |
| `runs:start` | `RunRequest` | `Result<RunRecord>` |
| `runs:start-demo` (compatibilidade) | `DemoRunRequest` | `Result<RunRecord>` |
| `runs:cancel` | `id` | `Result<RunRecord>` |
| `conversations:list` | — | `Result<ConversationList>` |
| `conversations:get` | `id` | `Result<Conversation>` |
| `conversations:send` | `ConversationSendRequest` | `Result<{ conversation, run }>` |
| `conversations:rename` | `id`, `title` | `Result<Conversation>` |
| `conversations:delete` | `id` | `Result<null>` |
| `conversations:retry-save` | `id` | `Result<ConversationSaveStatus>` |
| `hardware:get-state` | — | `Result<HardwareAdvisorState>` |
| `hardware:set-local-consent` | `{ granted, deleteData? }` | `Result<HardwareAdvisorState>` |
| `hardware:analyze` | `{ mode, scenario? }` | `Result<HardwareAdvisorState>` |
| `hardware:delete-data` | — | `Result<HardwareAdvisorState>` |
| evento `runs:updated` | `RunRecord` | — |
| evento `conversations:updated` | `Conversation` | — |
| evento `conversations:save-changed` | `{ conversationId, save }` | — |

Para criar um canal: declare-o em `src/shared/ipc.ts`, registre o handler em
`src/main/ipc-handlers.ts` com validação e aridade, e exponha a função em
`src/preload/index.ts`.

## Persistência local

Os arquivos ficam em `<userData>/storage/` e são lidos e gravados só pelo Main:

| Arquivo | Formato | Conteúdo |
|---|---|---|
| `settings.json` | `gerpro.settings` | Preferências |
| `agents.json` | `gerpro.agents` | Definições de agentes (até 500); formato 2, migrado do 1 |
| `hardware.json` | `gerpro.hardware` | Consentimento e última análise |
| `conversations/<id>.json` | `gerpro.conversation` | Uma conversa por arquivo (até 500 conversas e 400 mensagens cada) |
| (cofre) | `gerpro.secrets` | Credenciais cifradas. O cofre ainda não é instanciado pelo app. |

Comportamento do `VersionedStore` (`src/main/storage/versioned-store.ts`):

- Envelope `{ format, formatVersion, savedAt, data }`, com migrações por
  versão. Com `backupBeforeMigration` (usado em `agents.json`), o arquivo
  antigo é copiado para `<nome>.v<versão>-<data>.json` antes da migração.
- Escrita atômica: arquivo temporário, `fsync` e `rename` (com novas
  tentativas). As gravações são serializadas.
- Arquivo corrompido ou inválido: cópia `*.invalid-<data>.json` e
  recuperação do que for válido. Sem cópia de segurança, o original não é
  sobrescrito.
- Arquivo de versão mais nova: o app usa os padrões e **não grava**, para não
  destruir dados de uma versão futura.
- `hardware.json` ilegível volta ao padrão seguro: não autorizado e sem dados.
- Conversa com arquivo inválido: não é usada pela metade. O original é
  copiado (`*.invalid-<data>.json`) e retirado da pasta, e as outras
  conversas carregam normalmente; a tela informa quantos arquivos ficaram
  de fora. Arquivo de versão mais nova fica intacto e fora da lista.

Execuções (reais e simuladas) não são persistidas: cada conversa guarda o
texto final de cada resposta, o modelo que a gerou e o `runId`.

## Arquitetura híbrida planejada (Gerpro Web)

**Status: planejado.** Nada desta seção está implementado.

A diretriz da Etapa 3.1 define o Gerpro Studio como uma aplicação desktop
proprietária que será integrada ao Gerpro Web existente, com três
componentes:

1. **Interface desktop própria:** a interface React atual, que continua sendo
   a principal.
2. **APIs do Gerpro Web:** dados e serviços do servidor consumidos por API.
3. **Módulos web incorporados durante a migração:** partes do Gerpro Web
   exibidas dentro do Studio enquanto não houver equivalente nativo.

### O que já prepara essa integração

- Contratos e regras em `src/shared/` são puros e podem ser compartilhados
  com o backend ou com o front-end web.
- Consentimento `serverSharing` separado da análise local
  (`src/shared/hardware.ts`). A validação atual impede concedê-lo até que
  exista um fluxo próprio.
- `SecretVault` para guardar tokens cifrados pelo sistema operacional.
- `Result<T>` / `StructuredError` como formato único de resposta, que pode
  envolver também respostas de API.

### O que a segurança atual bloqueia de propósito

Hoje, qualquer acesso ao Gerpro Web exige uma mudança consciente de
segurança:

- A CSP `connect-src 'self'` impede o Renderer de chamar servidores.
- `isAppUrl` e `will-navigate` impedem carregar páginas remotas na janela.
- `webviewTag: false` impede `<webview>`.
- Não há cliente HTTP, autenticação nem configuração de ambiente (URLs).

### Proposta para a equipe avaliar

- **APIs pelo Main:** o Main chama o Gerpro Web e o Renderer recebe os dados
  por canais IPC dedicados e validados. Assim, credenciais (no
  `SecretVault`) e tokens nunca chegam ao Renderer, e a CSP do Renderer não
  precisa ser afrouxada.
- **Módulos web em contêiner isolado:** exibir cada módulo num
  `WebContentsView` próprio, com partição de sessão separada, sem o preload
  do app (ou com um preload mínimo e específico), uma lista fixa de origens
  permitidas e `will-navigate` restrito a essas origens. O módulo web não
  deve ter acesso a `window.gerpro`.
- **Validação dos dados do servidor:** dados vindos do servidor passam pelos
  mesmos validadores de `src/shared/`, como qualquer entrada externa.
- **Envio de dados do usuário:** o perfil de hardware e outros dados só
  devem ser enviados com `serverSharing = granted`, em fluxo próprio, sem
  identificadores pessoais.

Essas escolhas, junto com autenticação, ambientes e versionamento das APIs,
estão listadas em [Pontos de integração](06-pontos-de-integracao.md).
