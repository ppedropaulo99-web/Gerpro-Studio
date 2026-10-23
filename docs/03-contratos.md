# Contratos

Todos os contratos ficam em `src/shared/` e são compartilhados por Main,
Preload e Renderer. Cada contrato que recebe dados de fora tem um validador
em tempo de execução, que rejeita campos desconhecidos.

## Agentes (`src/shared/agents.ts`)

**Status:** implementado (definição, validação e persistência). A execução é
planejada.

`AgentDefinition` é o que o usuário configura e o Main grava:

| Campo | Regra |
|---|---|
| `id` | slug; imutável |
| `name` | 1–120 caracteres |
| `description` | até 1.000 caracteres |
| `version` | versão semântica (`1.0.0`) |
| `instructions` | até 32.000 caracteres |
| `model` | `{ engineId: string \| null, modelId }` ou `null`. Com `engineId: null`, qualquer motor que ofereça o modelo serve: o agente não fica preso a um único motor. |
| `settings` | `temperature` 0–2, `topP` 0–1, `maxOutputTokens` (`null` = padrão do motor) |
| `tools` | até 64 IDs de ferramentas, sem repetição |
| `requestedPermissions` | `network`, `filesystem:read`, `filesystem:write`, `process` |
| `state` | `draft` (incompleto), `ready` (exige modelo e instruções), `archived` |
| `createdAt` / `updatedAt` | definidos pelo Main |

`AgentDraft` é a definição sem as datas, que o Renderer envia em
`agents:create` / `agents:update`.

**Disponibilidade:** `AgentAvailability` é calculada a cada leitura e nunca
gravada. `evaluateAgentAvailability` gera problemas com código:

- `draft`, `missing-model`, `missing-instructions`
- `unknown-tool`, `tool-disabled`, `tool-not-implemented`
- `missing-permission`, `engine-unavailable`

Nesta versão não há motor nem ferramenta executável. Portanto **nenhum
agente fica `available`**, e a interface mostra os motivos.

## Ferramentas (`src/shared/tools.ts`)

**Status:** as declarações estão implementadas; a execução é planejada.

- `ToolDefinition`: `id`, `name`, `description`, `version`, `source`
  (`builtin` | `plugin`, com `pluginId`), `inputSchema` / `outputSchema` (um
  subconjunto de JSON Schema) e `permissions`.
- `ToolCatalogEntry`: a definição mais `enabled` e `availability`
  (`available` | `disabled` | `not-implemented`).
- `validateAgainstSchema`: valida um valor contra o esquema.
- `missingPermissions`: lista as permissões exigidas que ainda não foram
  concedidas.
- **Contrato de execução futura:**
  - `ToolExecutor.execute(input, context)` recebe `ToolExecutionContext`
    (`runId`, `agentId`, `grantedPermissions`, `signal`) e devolve
    `ToolExecutionResult`.
  - Antes de chamar `execute`, o Main deverá validar `input` contra o esquema
    e conferir as permissões.

O catálogo (`src/main/tools/catalog.ts`) declara 7 ferramentas: Busca na Web,
Calculadora, Arquivos, Terminal, Leitor de Documentos, Planilhas e Base de
Conhecimento. **Nenhuma tem executor**, então todas aparecem como
`not-implemented`. O `ToolRegistry` combina o catálogo com
`settings.tools.enabled`.

## Modelos e motor (`src/shared/engine.ts`, `src/shared/recommendations.ts`)

**Status:** planejado (só contrato).

- `InferenceEngine`: `id`, `listModels()`, `load(modelId)`,
  `unload(modelId)` e `chat(modelId, messages, signal)`, que devolve um
  `AsyncIterable<string>` (streaming).
- `ModelDescriptor`: `id`, `name`, `publisher`, `format` (`gguf` |
  `safetensors` | `onnx`), `parameters`, `quantization`, `sizeGb`,
  `contextLength`, `capabilities` (`chat`, `vision`, `tools`, `embedding`,
  `reasoning`).
- `ModelProfile` (recomendações): a parte do modelo relevante para avaliar
  hardware, mais `availability` (`installed` | `not-installed` |
  `downloading` | `error`) e `source` (`example` | `local-provider`).
- `effectiveModelAvailability`: modelos com `source: 'example'` valem sempre
  como `not-installed`, qualquer que seja o `availability` declarado. Assim,
  um modelo fictício nunca aparece como instalado nem torna um agente
  executável. Um provedor local futuro deverá informar `local-provider`.

A tela Modelos e a biblioteca usada nas recomendações
(`src/renderer/src/data/models.ts`) são **fictícias**. Ver
[Motor de inferência](05-motor-de-inferencia.md).

## Execuções (`src/shared/runs.ts`)

**Status:** o contrato e a máquina de estados estão implementados; as
execuções são simuladas.

- `RunRecord`: `id` (`run-...`), `agentId`, `origin` (`simulated` | `real`),
  `state`, `createdAt`, `startedAt`, `finishedAt`, `progress`
  (`percent`/`step`, ambos anuláveis), `messages` (com nível),
  `error: StructuredError | null` e `cancelRequested`.
- Transições permitidas (`RUN_TRANSITIONS`), aplicadas por
  `applyRunTransition`, que lança erro em transição inválida:

```text
pending ──► running ──► completed
   │           ├──────► failed
   ├──► failed └──────► cancelled
   └──► cancelled
```

- **Cancelamento cooperativo:** uma execução pendente é cancelada na hora.
  Uma execução em andamento marca `cancelRequested` e encerra na próxima
  etapa.
- **`DemoRunManager`:**
  - Percorre quatro etapas fixas marcadas "(simulado)", a cada 700 ms.
  - O cenário `failure` falha na terceira etapa.
  - Execuções ficam só em memória, sempre com `origin: 'simulated'`.
  - Exige que o agente exista e não esteja arquivado.
- **Dados antigos:** o histórico de exemplo da tela usa estados antigos,
  convertidos por `legacyRunState` (`src/renderer/src/lib/runs.ts`).

## Configurações (`src/shared/settings.ts`)

**Status:** a persistência está implementada. Só a aparência tem efeito; o
efeito das demais preferências é planejado.

`AppSettings` tem cinco seções:

- `appearance`: `theme` (`dark` | `light`; padrão `dark`). Única preferência
  com efeito: aplicada na hora à interface e às cores nativas da janela.
- `general`: `language`, `density`, `startOnLogin`
- `models`: `directory`, `maxRamGb`
- `privacy`: `confirmSensitiveTools`, `telemetry`
- `tools`: `enabled`, por ID de ferramenta

`settings:update` recebe um `SettingsPatch` parcial (um nível por seção),
validado campo a campo. **Nenhum campo guarda credencial**: segredos ficam no
`SecretVault` e são referenciados por ID. Exceto o tema, nenhuma preferência
tem efeito ainda, e a tela diz isso em cada campo.

**Formato:** `settings.json` está na versão 2. Arquivos da versão 1 (sem
`appearance`) são migrados por `migrateSettingsV1`, que acrescenta o tema
padrão e preserva todo o resto, inclusive escolhas de privacidade antigas
(que continuam sem efeito).

**Tema:**

- O elemento raiz recebe `data-theme`. As cores de cada tema ficam só em
  `renderer/src/styles/tokens.css`; componentes usam tokens semânticos.
- Para não piscar o tema errado: o Main lê o tema salvo, cria a janela com
  o fundo nativo nessa cor e passa o tema como argumento
  (`--gerpro-theme=`, `themeArgument`). O Preload o valida
  (`themeFromArguments`; valor desconhecido vira `dark`) e o expõe como
  `window.gerpro.app.initialTheme`. Até o tema ser aplicado, o CSS não pinta
  nada.
- Ao trocar o tema, o Renderer aplica na hora e grava com
  `settings:update({ appearance })`. O Main avisa os ouvintes de
  `SettingsService.onChange`, e a janela atualiza o fundo e os botões da
  barra de título (`applyWindowTheme`). Se a gravação falhar, o tema anterior
  volta.
- **Alterações não salvas:** o tema fica fora do formulário de
  Configurações. Trocá-lo não cria pendência, e as edições pendentes de
  outros campos continuam pendentes. "Descartar", "Cancelar" ou sair sem
  salvar não revertem o tema: para voltar, escolhe-se o outro tema.

**Preferências de privacidade inativas** (`INACTIVE_PRIVACY_SETTINGS`:
`confirmSensitiveTools` e `telemetry`):

- O Main recusa alterá-las com `invalid-state` (`inactiveSettingsInPatch`),
  inclusive quando vêm junto com outros campos. Nada é gravado nesse caso.
- Valores gravados antes são **preservados**, mas não valem como decisão:
  `effectivePrivacy` devolve sempre os valores seguros (`SAFE_PRIVACY_VALUES`:
  confirmação exigida, telemetria desligada).
- A tela mostra os interruptores desativados, nos valores seguros, e avisa
  quando há uma escolha anterior gravada que não será aplicada.
- **Ativação futura:** ler o valor gravado como consentimento é proibido. A
  função nova deve pedir uma nova decisão explícita ao usuário, com versão
  própria, e só então sair de `INACTIVE_PRIVACY_SETTINGS`.

## Erros (`src/shared/errors.ts`)

- `Result<T>` = `{ ok: true, data }` | `{ ok: false, error: StructuredError }`.
- `StructuredError`: `code` (`validation`, `not-found`, `conflict`,
  `invalid-state`, `storage`, `storage-read-only`,
  `secret-storage-unavailable`, `simulated-failure`, `internal`), `message`,
  `retryable`, `issues?` (validação) e `details?`.
- Nunca carrega stack trace nem dados sensíveis. No Main, `AppError` é
  convertido para essa forma.

## Plugins (`src/shared/plugins.ts`)

**Status:** planejado.

`PluginManifest` (`id`, `name`, `version`, `description`, `permissions`,
`contributes.tools` / `contributes.engines`). O vocabulário de permissões é o
mesmo das ferramentas. Não há carregamento de plugins.

## Hardware e recomendações

Ver [Hardware Advisor](04-hardware-advisor.md).
