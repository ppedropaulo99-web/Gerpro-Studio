# Pontos de integração (responsabilidade da equipe)

Cada item tem o contrato que já existe, o que falta fazer e os cuidados
obrigatórios. Nenhum deles está implementado.

## 1. Detector real de hardware

- **Contrato:** `HardwareDetector` (`src/shared/hardware.ts`).
- **A fazer:**
  - Implementar o detector em `src/main/hardware/`, com
    `source: 'local-detector'`.
  - Trocar `localDetector` em `src/main/services/index.ts`.
  - Passar `grantScope: 'device-detection'` ao `HardwareAdvisorService`.
  - Refazer a tela de consentimento: dizer que o hardware real será lido e
    remover o aviso "nenhuma informação é lida".
- **Cuidados:**
  - Não alterar `CURRENT_GRANT_SCOPE`.
  - Não converter registros `demo-only` existentes.
  - Respeitar o `AbortSignal` (o serviço aplica timeout de 15 s).
  - Usar `null` para o que não for identificável.
  - Não coletar números de série nem identificadores do usuário.
- **Fontes possíveis no Main:** `os.cpus()`, `os.totalmem()`,
  `os.freemem()`, `fs.statfs()`, `app.getGPUInfo('complete')`.
- **Passo a passo:** [`src/main/hardware/README.md`](../src/main/hardware/README.md).

## 2. Motor de inferência

- **Contrato:** `InferenceProvider` e tipos de `src/shared/inference.ts`;
  perfis em `src/shared/execution.ts`; compatibilidade em
  `src/shared/compatibility.ts`.
- **Pronto (Lote 3.3.6):**
  - Adaptador Ollama em `src/main/engine/ollama/` (provedor `external`,
    substituível), validando inventário e eventos com
    `validateProviderModel` e `validateInferenceEvent`.
  - Canal `providers:list` (estado e modelos instalados).
  - `engineAvailable` ligado: agente disponível só com o modelo instalado
    num provedor real pronto.
  - Tela Modelos mostra os modelos instalados, separados da biblioteca de
    exemplo.
- **A fazer:**
  - Contagem de tokens pelo motor para o recorte de contexto (hoje é uma
    estimativa conservadora por caracteres). As conversas contínuas já
    existem (`conversations:*`).
  - Motor próprio (`embedded`): decisão do runtime ainda em aberto.
  - Substituir de vez a biblioteca fictícia de modelos.
- **Cuidados:** não rodar a inferência no processo Main (o Ollama roda no
  próprio processo; o Main só faz a comunicação HTTP), nem expor caminhos de
  arquivo arbitrários ao Renderer.
- **Detalhes:** [Motor de inferência](05-motor-de-inferencia.md).

## 3. Execuções reais

- **Contrato:** `RunRequest` / `validateRunRequest`, `RealRunRecord`,
  `resolveExecution`, `RUN_TRANSITIONS` e `applyRunTransition`
  (`src/shared/runs.ts`, `src/shared/execution.ts`).
- **Pronto (Lote 3.3.5):** `RunService` com fila, cancelamento, tempo
  limite, limites e eventos agrupados; canal `runs:start`; provedor simulado.
- **Pronto (Lote 3.3.6):** provedor real (Ollama) registrado; execuções dele
  saem `origin: 'real'` com métricas medidas. Validado pelo `RunService`; a
  interface ainda não iniciava uma execução real.
- **Pronto (Lote 3.3.7):** a tela Conversas inicia execuções reais por
  `conversations:send` → `RunService.start` com o histórico permitido
  (modelo instalado escolhido em `overrides.model`), acompanha a
  resposta em tempo real, interrompe e explica erros; a tela Execuções
  monitora o histórico da sessão, as métricas e os registros. Erros estruturados do
  `RunService` podem trazer `details.reason` (hoje
  `output-limit-before-text`).
- **A fazer:**
  - Implementar uma `resourcePolicy` com memória medida.
  - Decidir se o histórico será persistido.
  - Retirar `runs:start-demo` quando a demonstração simulada e a Apresentação
    Guiada passarem a usar `runs:start`.
- **Cuidados:**
  - Manter a distinção visual simulada × real.
  - Exigir agente `available` antes de iniciar.
  - Propagar o cancelamento até o motor e as ferramentas.

## 4. Ferramentas e permissões

- **Contrato:** `ToolExecutor`, `ToolExecutionContext.grantedPermissions`,
  `validateAgainstSchema` e `missingPermissions` (`src/shared/tools.ts`).
- **A fazer:**
  - Implementar os executores e registrá-los no `ToolRegistry`.
  - Criar o fluxo de **concessão de permissões** pelo usuário (hoje só há
    permissões "solicitadas").
  - Adicionar à tela Ferramentas o controle de ativação ligado a
    `settings.tools.enabled` (hoje a tela só exibe o catálogo, sem
    interruptores) e trocar o selo "Execução planejada" pela disponibilidade
    real.
- **Cuidados:**
  - Validar a entrada contra `inputSchema` no Main.
  - Confirmar ferramentas sensíveis (`confirmSensitiveTools`).
  - Restringir `filesystem` a pastas autorizadas.
  - Terminal sempre com aprovação.

## 5. Plugins

- **Contrato:** `PluginManifest` (`src/shared/plugins.ts`).
- **A fazer:** carregar os plugins em `src/main/plugins/`, aprovar permissões
  antes do carregamento e registrar as ferramentas e motores contribuídos.
- **Cuidados:** o código de plugin nunca roda no Renderer. Definir a política
  de assinatura e origem dos plugins.

## 6. Gerpro Web: APIs

- **Contrato existente:** `Result<T>` / `StructuredError`, validadores de
  `src/shared/`, `SecretVault` e consentimento `serverSharing`.
- **A fazer:**
  - Escolher a forma de autenticação.
  - Criar um cliente HTTP no Main.
  - Configurar ambientes (URLs de desenvolvimento e produção).
  - Instanciar o `SecretVault` em `createServices` para guardar tokens.
  - Criar canais IPC por operação.
  - Definir o versionamento das APIs.
- **Cuidados:**
  - Tokens nunca vão ao Renderer.
  - Respostas do servidor passam pelos validadores.
  - Manter a CSP `connect-src 'self'` no Renderer (chamadas feitas pelo Main).
  - Enviar o perfil de hardware ou outros dados só com `serverSharing`
    concedido em fluxo próprio. Isso exige liberar `granted` na validação de
    forma deliberada.
- **Detalhes:** [Arquitetura › Arquitetura híbrida
  planejada](02-arquitetura.md#arquitetura-híbrida-planejada-gerpro-web).

## 7. Gerpro Web: módulos incorporados durante a migração

- **A fazer:** escolher o contêiner e definir a lista de origens permitidas e
  o canal de comunicação (se houver) entre o módulo e o app.
- **Cuidados:**
  - Não reativar `webviewTag`.
  - Não carregar o módulo na janela principal nem com o preload do app.
  - Usar partição de sessão separada.
  - Limitar a navegação às origens permitidas.
  - Revisar `isAppUrl`, `assertTrustedSender` e a CSP para que a origem remota
    **não** passe a ser tratada como "app".

## 8. Evolução dos contratos persistidos

- **Tipos de tarefa nos agentes salvos:** já fazem parte da
  `AgentDefinition` v2 (`taskTypes`), mas a tela ainda não os edita.
- **Requisitos nos agentes salvos:** hoje só os exemplos têm
  (`src/renderer/src/data/agent-requirements.ts`). Para incluí-los:
  - subir `AGENTS_FORMAT_VERSION` para 3;
  - escrever `migrateAgentsV2` e registrá-la em
    `src/main/services/agent-service.ts`;
  - atualizar `validateAgentDraft`.
- **Conversas:** `gerpro.conversation` versão 1, um arquivo por conversa.
  Campos novos (ex.: resumo) exigem subir a versão e migrar.
- **Qualquer formato novo:** usar `VersionedStore` com migrações. Nunca
  editar um formato publicado sem subir a versão.

## 9. Efeito das configurações

Cada preferência hoje é só gravada. A equipe deve ligá-las uma a uma e
remover o aviso "ainda sem efeito" do campo correspondente:

- idioma e densidade (Renderer);
- iniciar com o sistema (`app.setLoginItemSettings`);
- pasta e limite de RAM de modelos (motor);
- confirmação de ferramentas sensíveis (execuções);
- telemetria: exige política própria e consentimento.

**Confirmação de ferramentas sensíveis e telemetria** estão bloqueadas
(`INACTIVE_PRIVACY_SETTINGS` em `src/shared/settings.ts`). Ao implementar
qualquer uma delas:

- não use o valor gravado em `settings.json`: ele foi escolhido quando a
  função não existia;
- peça uma nova decisão explícita, registrada com versão própria (mesmo
  princípio do escopo do Hardware Advisor);
- só então retire a preferência de `INACTIVE_PRIVACY_SETTINGS` e libere o
  interruptor na tela.

## Checklist para qualquer integração

- [ ] Canal IPC declarado em `src/shared/ipc.ts`, com validação e aridade no
      Main.
- [ ] Nada de Node, `ipcRenderer` ou acesso genérico a arquivos no Renderer.
- [ ] Dados simulados continuam identificados. Nada fictício é apresentado
      como real.
- [ ] Novo consentimento quando a finalidade ou o alcance mudar. Nunca
      ampliar um consentimento existente.
- [ ] Testes em `tests/` e `npm test`, `npm run typecheck` e `npm run build`
      sem erros.
