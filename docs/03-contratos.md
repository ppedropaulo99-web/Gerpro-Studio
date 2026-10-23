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
| `taskTypes` | finalidade: tipos de tarefa (`chat`, `code`, `research`, `data`, `documents`, `support`), sem repetição; vazio = não declarada |
| `defaultModel` | `ModelRef` (`{ providerId: string \| null, modelId }`) ou `null`. Com `providerId: null`, qualquer provedor que ofereça o modelo serve; o vínculo é resolvido ao iniciar a execução. |
| `defaultProfile` | `ExecutionProfile` completo (ver [Inferência local](#inferência-local-contratos)) |
| `tools` | até 64 IDs de ferramentas, sem repetição |
| `requestedPermissions` | `network`, `filesystem:read`, `filesystem:write`, `process` |
| `state` | `draft` (incompleto), `ready` (exige modelo e instruções), `archived` |
| `createdAt` / `updatedAt` | definidos pelo Main |

`AgentDraft` é a definição sem as datas, que o Renderer envia em
`agents:create` / `agents:update`.

**Formato gravado:** `agents.json` está na versão 2. `migrateAgentsV1`
converte arquivos da versão 1:

- `settings` vira `defaultProfile` (demais parâmetros nos padrões) e
  `taskTypes` começa vazio;
- `model.engineId` só vira `defaultModel.providerId` se houver
  correspondência explícita em `LEGACY_ENGINE_PROVIDERS` (hoje vazia: nenhum
  motor existiu na v1). Sem correspondência, o modelo fica sem vínculo
  (`providerId: null`), e um id antigo nunca é tratado como provedor real;
- antes de usar os dados migrados, o arquivo v1 é copiado para
  `agents.v1-<data>.json`, preservando inclusive o `engineId` descartado. Se
  a cópia falhar, nada é gravado (modo somente leitura).

O arquivo só é regravado na próxima alteração. Agentes v1 inválidos seguem a
recuperação normal (cópia do original e manutenção dos válidos).

O formulário da tela Agentes edita só modelo, `temperature`, `topP` e
`maxOutputTokens`; ao salvar, preserva a finalidade, os demais parâmetros do
perfil e o provedor do modelo (este só enquanto o modelo não muda).

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

## Inferência local: contratos

**Status:** só contratos e validadores (Lote 3.3.3). Não há provedor, chamada
HTTP, inferência nem streaming funcional.

### Provedores e modelos (`src/shared/inference.ts`)

- **Provedor:** `ProviderInfo` (`id`, `displayName`, `kind`: `external`,
  processo separado como o Ollama, ou `embedded`, o runtime próprio futuro).
  Só provedores locais existem; modelos remotos estão bloqueados.
- **Estado do provedor:** `ProviderStatus.state` é `not-configured`,
  `not-detected`, `unreachable`, `starting`, `ready`, `incompatible-version`
  ou `error`, com `version`, `checkedAt` e `message` (`null` quando não
  verificados).
- **Identidade do modelo:** `ModelRef` (`providerId` + `modelId`);
  `ResolvedModelRef` exige `providerId`. `modelId` aceita ids reais de
  provedores (`llama3.2:3b`, `org/modelo:q4_k_m`), até 200 caracteres, sem
  caracteres de controle nem espaços nas pontas.
- **Separação:** identidade (`ProviderModel`: metadados informados pelo
  provedor, inclusive `digest`, `location` (`local` ou `remote`) e
  `contextBytesPerToken` (memória por token de contexto), `null` quando ele
  não informa) ≠ disponibilidade
  (`ModelAvailability`, em `ProviderModelEntry`) ≠ requisitos
  (`AgentRequirements`, em `recommendations.ts`) ≠ parâmetros
  (`ExecutionProfile`).
- **Interface `InferenceProvider`:** `status`, `listModels` e
  `generate(request, signal)`, que devolve `AsyncIterable<InferenceEvent>`.
  Substitui o antigo `InferenceEngine`, nunca implementado.
- **Eventos:** `loading` → `delta`* → `done` (`finishReason`: `stop`,
  `length` ou `cancelled`, e métricas) ou `error`.
- **Métricas (`InferenceMetrics`):** `source: 'measured'` obrigatório; tempo
  de carga, até o primeiro token e total, tokens de entrada e saída, tokens
  por segundo e pico de memória, cada um `null` quando não medido. Execuções
  simuladas não têm métricas.
- **Erros tipados (`InferenceError`):** `provider-unavailable`,
  `model-not-found`, `model-unsupported`, `insufficient-memory`,
  `context-too-long`, `timeout`, `cancelled`, `invalid-request`,
  `provider-error`. `INFERENCE_ERROR_NATURE` diz se o erro é permanente (só
  `model-unsupported`), transitório (inclusive falta de memória) ou alheio ao
  modelo; `retryable` deriva disso, nunca do provedor. Nas execuções, o erro
  vira `StructuredError` com código `inference` e `details.inferenceCode`.
- **Validadores** para dados externos: `validateModelRef`,
  `validateProviderModel`, `validateInferenceEvent` e
  `validateInferenceMetrics`, com limites de tamanho e recusa de campos
  desconhecidos.

### Perfil de execução (`src/shared/execution.ts`)

`ExecutionProfile` (configuração, não medição):

| Campo | Regra | Quem aplica |
|---|---|---|
| `temperature` | 0–2 | provedor |
| `topP` | 0–1 | provedor |
| `maxOutputTokens` | 1–1.000.000 ou `null` (padrão do provedor) | provedor |
| `contextLength` | 256–1.048.576 ou `null` | provedor |
| `seed` | 0–2³¹−1 ou `null` (aleatória) | provedor |
| `cpuThreads` | 1–256 ou `null` | provedor |
| `gpuMode` | `auto` ou `cpu-only` | provedor |
| `timeoutSeconds` | 10–3.600 (padrão 300) | app (cancela a geração) |

- O perfil fica embutido no agente (`defaultProfile`). Perfis nomeados e
  reutilizáveis ficam para quando houver onde guardá-los.
- `RunOverrides` substitui o modelo e/ou parte do perfil em uma execução,
  sem alterar o agente.
- `resolveExecution(padrões, substituições, inventário)` é pura: escolhe o
  modelo (substituição ou padrão), vincula o provedor entre os modelos
  **instalados** e combina o perfil. Erros: `no-model`,
  `model-not-installed` e `ambiguous-provider`. Com `providerId: null`, o
  vínculo só é automático quando exatamente um provedor oferece o modelo;
  com mais de um, nada é escolhido e o usuário precisa indicar o provedor.
- **Extração futura para perfis nomeados:** o perfil é um objeto completo,
  sem campos implícitos (a migração v1 → v2 grava os padrões por extenso), e
  a resolução o usa tal como está. Um perfil nomeado pode receber o mesmo
  objeto, e o agente passa a referenciá-lo numa migração v2 → v3, sem perda
  de parâmetros nem mudança de comportamento.

### Compatibilidade (`src/shared/compatibility.ts`)

| Estado | Origem |
|---|---|
| `tested-compatible` | geração real bem-sucedida |
| `estimated-compatible` | estimativa favorável (com ou sem ressalvas) |
| `not-recommended` | estimativa desfavorável ou falta de memória em teste |
| `confirmed-incompatible` | recusa permanente do provedor (`model-unsupported`) |
| `not-verified` | sem dados |

- `stateFromEstimate` traduz o `fit` do Hardware Advisor (algoritmo
  inalterado) para os estados de estimativa: `recommended-local` e
  `limited` → `estimated-compatible`; `needs-resources` →
  `not-recommended`; `unknown` → `not-verified`.
- `stateAfterTest`: sucesso → `tested-compatible`; recusa permanente →
  `confirmed-incompatible`; falta de memória → no máximo `not-recommended`,
  sem apagar um sucesso anterior; demais falhas não mudam o estado.
- `CompatibilityAssessment` reúne a base da avaliação, o estado, os motivos
  (no formato do Advisor), a origem do perfil de hardware, o último teste e
  as alternativas (`smaller-model`, `other-model`, `profile-adjustment`,
  `free-memory`). São produzidas por `evaluateCompatibility` (abaixo).
- **Base da avaliação (`CompatibilityBasis`):** modelo, digest, parâmetros
  do perfil que afetam memória ou dispositivo (`contextLength`, `gpuMode`,
  `cpuThreads`), identificador do dispositivo (`deviceKey`) e versão das
  regras (`COMPATIBILITY_RULES_VERSION`).
- **Validade (`effectiveState`):** devolve `not-verified` quando muda o
  modelo, o digest, um parâmetro relevante do perfil ou o dispositivo.
  Resultados de teste só valem com digest e dispositivo conhecidos e não
  dependem da versão das regras; estimativas deixam de valer quando as
  regras mudam. Parâmetros de amostragem (`temperature`, `topP`, `seed`) não
  invalidam.

### Avaliação e recomendação (`src/shared/compatibility-evaluator.ts`)

Funções puras e determinísticas: não leem relógio (`now` é entrada), disco,
rede nem hardware, e não dependem de nenhum provedor. Avaliam a combinação
modelo + perfil + tarefa + dispositivo, nunca "a qualidade do computador".

**`evaluateCompatibility(entrada do inventário, contexto)`** aplica as regras
em ordem e registra cada uma em `steps` (`stage`, `rule`, `kind`, `factor`,
`message`, `values`), para auditoria e exibição futura:

1. **Elegibilidade:** modelo `remote` → inelegível (nunca é execução local);
   sem capacidade `chat` → inelegível; contexto máximo do modelo menor que
   `minContextTokens` da tarefa → inelegível; contexto do modelo
   desconhecido → elegibilidade `unknown`.
2. **Disponibilidade:** só o inventário diz se está instalado.
3. **Recursos:** perfil de hardware só via `usableProfile` (sem
   consentimento, não há perfil, mesmo com análise gravada). Pesos =
   `sizeBytes`; contexto = `contextLength × contextBytesPerToken`, só quando
   os dois são conhecidos. Posicionamento: `cpu` (perfil `cpu-only` ou
   nenhuma GPU), `gpu-full`, `gpu-partial`, `shared-memory` (GPU integrada:
   conta só a RAM), `unknown-vram` e `unknown-gpu`. `gpu-partial` não afirma
   proporção de camadas nem desempenho.
4. **Estimativa (capacidade):** cabe na RAM utilizável → `estimated-compatible`;
   não cabe → `not-recommended`, exceto quando a VRAM ou a GPU são
   desconhecidas (`not-verified`). Perfil com contexto acima do máximo do
   modelo ou abaixo do exigido pela tarefa → `not-recommended`. Faltando
   perfil de hardware, RAM ou tamanho do modelo → `not-verified`.
   **Estimativa incompleta:** sem a memória do contexto (contexto no padrão
   do provedor ou `contextBytesPerToken` desconhecido), o componente vai para
   `unknownComponents` e a conta só com os pesos é um piso: se o piso já não
   cabe → `not-recommended`; se cabe → `not-verified`, nunca
   `estimated-compatible`.
   **Disponibilidade atual (`memoryNow`), separada da capacidade:** compara a
   parte na RAM com a memória livre no momento da análise: `sufficient`,
   `insufficient` ou `unknown` (análise `stale` ou estimativa incompleta). A
   falta de memória livre gera a sugestão `free-memory` e nunca muda o estado
   de compatibilidade.
5. **Testes:** só o teste mais recente do modelo, e só se a base for a
   mesma, com digest e dispositivo conhecidos (mesma regra de
   `effectiveState`, aplicada também a falhas). O novo estado vem de
   `stateAfterTest`: falta de memória nunca confirma incompatibilidade.
6. **Adequação à tarefa:** só com `TaskQualityEvidence` (modelo, digest,
   tarefa, avaliação, fonte). Sem evidência, de outro digest ou com
   avaliações divergentes → `unknown`, e a adequação não pesa.
7. **Ajuste de perfil** (só contexto, conservador): reduzir ao máximo do
   modelo; ampliar ao mínimo da tarefa; reduzir pela metade até
   `max(mínimo da tarefa, 2048)`. Só é proposto se o perfil ajustado
   passar a `estimated-compatible` pela mesma regra, e vale o menor ajuste.
   Se o modelo já cabe na capacidade mas não na memória livre, o ajuste
   proposto é o menor que também caiba na memória livre.

Premissas da estimativa (`ESTIMATE_RULES`, regras e não medições; mudá-las
exige subir `COMPATIBILITY_RULES_VERSION`): GB = 2³⁰ bytes, 25 % da RAM total
reservados ao sistema, 10 % da VRAM reservados ao driver. O resultado
(`MemoryEstimate`) tem `source: 'estimate'` e nenhum campo de desempenho.

**`recommendModels(pedido)`** decide, nesta ordem:

| Decisão | Quando |
|---|---|
| `use-target` | o modelo pedido está instalado e é `tested-compatible` ou `estimated-compatible`, sem avaliação de inadequação à tarefa, e a memória livre não é sabidamente insuficiente |
| `free-memory` | o modelo pedido cabe na capacidade, mas não na memória livre no momento da análise; um ajuste de perfil que caiba agora vem como opção secundária |
| `adjust-profile` | um ajuste de perfil torna o modelo pedido compatível pela estimativa (tem preferência sobre trocar de modelo) |
| `use-alternative` | outro modelo instalado serve |
| `insufficient-data` | sem perfil de hardware ou com o modelo pedido `not-verified` |
| `no-suitable-option` | nenhuma das anteriores |

- Alternativas: modelos elegíveis, compatíveis (testado ou estimado) e não
  avaliados como inadequados. Ficam em duas listas: `installedAlternatives`
  e `notInstalledAlternatives`; um modelo não instalado nunca é apresentado
  como disponível nem decide a recomendação.
- Ordem, sem pontuação: testado antes de estimado → memória livre
  suficiente, desconhecida, insuficiente → adequado à tarefa antes de
  desconhecido → `providerId` → `modelId`.
- As decisões tratam de recursos: a justificativa sempre declara que
  compatibilidade de recursos não garante a qualidade das respostas.
- Modelo fora do inventário (`not-in-inventory`) ou presente em mais de um
  provedor sem `providerId` (`ambiguous-provider`) não é escolhido por
  conta própria.

## Modelos de exemplo (`src/shared/engine.ts`, `src/shared/recommendations.ts`)

**Status:** dados de exemplo da interface.

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
  `error: StructuredError | null` e `cancelRequested`. É uma união
  discriminada por `origin`:
  - `SimulatedRunRecord`: `execution: null`; não tem saída nem métricas.
  - `RealRunRecord` (futuro): `execution` (`ResolvedExecution`: modelo
    resolvido, perfil efetivo e o que foi substituído), `output` (texto
    simples) e `metrics` (só valores medidos, ou `null`).
- `RunRequest` (execução real, sem canal IPC nesta etapa): `agentId`,
  `input` (1–32.000 caracteres, não em branco) e `overrides`
  (`RunOverrides`: `model` e/ou parte do `profile`, ou `null`). Validado por
  `validateRunRequest`, que recusa campos desconhecidos.
- `DemoRunRequest` (execução simulada) não mudou.
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
