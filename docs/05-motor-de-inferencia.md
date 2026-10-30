# Motor de inferência próprio

**Status do motor próprio: planejado.** A escolha da tecnologia continua uma
**decisão arquitetural futura**, ainda não tomada.

**Status da inferência local (Lote 3.3.6): implementada com o Ollama como
provedor substituível.** O adaptador Ollama roda modelos já instalados neste
computador pelo `RunService` (inferência real validada com `llama3.1:8b` e
`qwen3:8b`). Download e gerenciamento de modelos continuam fora do app.

**Execução pela interface (Lote 3.3.7): iniciada em Conversas e monitorada em
Execuções.** Ver "Execução real pela interface" abaixo.

## Adaptador Ollama (Lote 3.3.6)

- **Onde:** `src/main/engine/ollama/ollama-provider.ts`, `kind: 'external'`.
  Detalhes técnicos em [`src/main/engine/README.md`](../src/main/engine/README.md).
- **Isolamento do formato:** só esse arquivo conhece a API do Ollama
  (`/api/version`, `/api/tags`, `/api/chat` com NDJSON). Contratos
  genéricos, `RunService`, agentes e React não citam o Ollama (há um teste
  que verifica isso).
- **Comunicação:** só no Main, só loopback (`http://127.0.0.1:11434`), sem
  seguir redirecionamentos, com limites de tamanho por resposta, por evento e
  por streaming. Não instala, não inicia o serviço e não baixa modelos.
- **Disponibilidade:** `capabilities().realEngine` só fica `available` depois
  que o Ollama responde `ready`; com ele desligado, o app abre normalmente e
  as recusas vêm como `provider-unavailable`. As transições (serviço cai,
  volta, modelos mudam) são reconhecidas sem reiniciar o app.
- **Substituível:** é um provedor como qualquer outro. O motor próprio entra
  como novo `InferenceProvider` (`kind: 'embedded'`) registrado em
  `createServices`, sem mudar agentes, execuções nem interface.
- **Limitações:** ver "Inferência local (Ollama)" em
  [Decisões e limitações](07-decisoes-e-limitacoes.md).

## Execução real pela interface (Lote 3.3.7)

Organização das telas:

| Tela | Papel |
|---|---|
| Início | Dashboard: indicadores, execuções recentes e atalhos; não envia mensagens |
| Conversas | Interação: escolher o modelo, escrever, enviar, acompanhar a resposta e interromper |
| Execuções | Monitoramento: resumo da sessão, histórico real e simulado, estados, métricas, erros, registro técnico e a demonstração simulada |
| Gerpro AI | Reservado ao futuro assistente interno do Gerpro Studio (em desenvolvimento); não chama o motor |

Fluxo em Conversas (`pages/ConversationsPage.tsx`):

1. A tela lê `providers:list` e oferece só modelos **locais, instalados e de
   conversa** de provedores reais prontos (`eligibleModels`,
   `renderer/src/lib/real-runs.ts`), com nome amigável
   (`friendlyModelName`: `llama3.1:8b` → "Llama 3.1 (8B)"); o identificador
   exato fica nos detalhes. Modelos de raciocínio aparecem marcados. O botão
   de atualizar consulta de novo.
2. O usuário escolhe o agente (instruções e perfil), o modelo e escreve a
   mensagem (até 32.000 caracteres; Enter envia, Shift+Enter quebra a
   linha). Em conversa nova, escolher um agente seleciona o modelo padrão dele,
   se estiver disponível; senão, a escolha atual fica. "Usar em Conversas" tem
   prioridade. O pedido vai por
   `conversations:send` (ver "Conversas contínuas" abaixo), que chama o
   `RunService` com `overrides.model` = modelo escolhido; o perfil é o do
   agente.
3. A execução entra na fila única do `RunService`. A tela acompanha
   `runs:updated` (`watchRuns`, `renderer/src/lib/session-runs.ts`): assina
   antes de listar, junta por `revision` e nunca acumula texto por conta
   própria; o texto exibido é sempre o do `RunService`.
4. Estados com rótulo de texto, não só cor: "Aguardando na fila (Nª)",
   "Carregando modelo", "Gerando resposta", "Interrompendo…", "Concluída",
   "Concluída com aviso" (texto cortado no limite), "Interrompida",
   "Tempo esgotado", "Sem resposta (limite)" e "Falhou".
5. Durante a geração, o botão "Enviar" vira "Interromper geração" (ou
   "Tirar da fila"), que chama `runs:cancel`; o texto recebido até ali é
   mantido.
6. Erros são explicados em linguagem simples (`friendlyError`), sempre com a
   mensagem original junto. Uma falha real nunca vira simulação, e a falha de
   uma simulação nunca é atribuída ao motor local.
7. A lista lateral mostra as conversas gravadas. "Detalhes técnicos", sob
   cada resposta desta sessão, abre a execução em Execuções.

Em Execuções aparecem só as métricas medidas pelo motor (tempo total,
carregamento, tempo até o primeiro texto, tokens e velocidade); as ausentes
são omitidas, e memória não é estimada. A seção "Demonstração simulada"
continua lá, usa a mesma fila e fica identificada com o selo "Simulado". As
execuções reais e simuladas aparecem juntas em "Execuções desta sessão", cada
uma com o tipo.

Navegação: "Conversar com IA" (Início), "Executar" (Agentes) e "Usar em
Conversas" (Modelos) abrem Conversas, os dois últimos com o agente ou o
modelo pré-selecionado; "Detalhes técnicos" e "Histórico e métricas"
(Conversas) abrem Execuções; "Nova mensagem" (Execuções) volta a Conversas
(`renderer/src/lib/run-intent.ts`, só em memória).

## Resolução do modelo e capacidade

Toda execução passa por `resolveExecution`, função pura em
`src/shared/execution.ts`, nesta ordem:

1. Modelo: o de `overrides.model`, senão o padrão do agente. Sem nenhum:
   `no-model`.
2. Localização entre os modelos instalados, com o provedor indicado ou em
   qualquer um. Nenhum: `model-not-installed`. Mais de um: `ambiguous-provider`.
3. Capacidade: lista vazia é aceita; lista sem `chat` dá `model-unsupported`.
4. Perfil: o do agente com as substituições da execução.

A recusa acontece antes da fila, sem chamar o provedor. Assim, um modelo de
embedding nunca chega ao motor, tanto como padrão quanto como escolha direta.

**Disponibilidade × capacidade:** `canRunReal` responde se o modelo do agente
está instalado em provedor real pronto; não olha capacidades. A recusa por
capacidade vem de `resolveExecution`, e a tela de agentes avisa pelo estado
`incompatible`.

## Conversas contínuas

Cada conversa tem várias mensagens e o modelo recebe o contexto anterior de
verdade, não só na tela.

Arquitetura (o caminho continua React → Preload → IPC → Main):

- `ConversationService` (`src/main/services/conversation-service.ts`) guarda
  as conversas e monta o contexto. Não conhece o Ollama: fala só com o
  `RunService`.
- `RunService.start(request, { history })`: o histórico vai entre as
  instruções do agente e a nova mensagem, dentro do mesmo limite
  `promptChars`, da mesma fila, cancelamento e tempo limite. O registro
  técnico da execução conta as mensagens enviadas, sem o conteúdo.
- `InferenceRequest.messages` já era uma lista de mensagens, e o adaptador
  Ollama já usava `/api/chat`: nenhum contrato de provedor nem o adaptador
  mudaram. Outro provedor recebe o mesmo `messages`.

Envio de uma mensagem:

1. Identifica a conversa ativa (ou cria uma, com `conversationId: null`).
2. Recusa se a conversa já está gerando uma resposta ou se o agente pedido
   não é o dela.
3. Recorta o histórico permitido (`selectContext`) e chama o `RunService`.
   Uma recusa (modelo não instalado, motor parado, fila cheia) não grava
   nada.
4. Grava a mensagem do usuário e a resposta pendente (`state: 'pending'`,
   com `runId` e o contexto enviado).
5. Durante a geração, a tela mostra o texto da execução (`runs:updated`):
   não há segundo buffer. A conversa copia o texto parcial para a resposta
   pendente e grava no máximo a cada 2 s (`CHECKPOINT_INTERVAL_MS`), nunca a
   cada trecho; ao fechar o app, grava na hora o que chegou desde o último
   ponto (até 1,5 s de espera).
6. Ao fim, a conversa grava o texto final, o estado (`complete`,
   `cancelled`, `failed`) e o modelo, e avisa a tela por
   `conversations:updated`.
7. No próximo início, respostas que ficaram `pending` viram `interrupted`,
   com o texto do último ponto gravado. Nada é gerado de novo sem o usuário
   enviar outra mensagem.

Gravação: cada conversa tem uma situação (`saved`, `saving`, `failed`),
avisada por `conversations:save-changed` só quando muda. As escritas são
atômicas (arquivo temporário + troca) e seguidas: pedidos acumulados viram
uma escrita com o estado mais recente. Se uma escrita falha, o arquivo
anterior fica intacto, as mensagens continuam na memória e na tela, e a
conversa fica marcada como não salva até uma gravação dar certo (próxima
alteração ou "Tentar salvar novamente", `conversations:retry-save`). A
mensagem mostrada é genérica, sem caminhos; o log técnico registra só a
primeira falha de cada sequência e a recuperação.

Estratégia de contexto (inicial, sem medir tokens):

- Janela: `contextLength` do perfil do agente; sem ela, supõe 4.096 tokens,
  padrão comum dos motores locais.
- Reserva para a resposta: `maxOutputTokens` ou 512 tokens.
- Conversão conservadora de 3 caracteres por token; no máximo 40 mensagens
  anteriores; nunca acima de `promptChars`.
- Entram as trocas mais recentes inteiras (pergunta + resposta), sem cortar
  mensagens nem pular trocas. Trocas com falha ou sem texto não entram;
  respostas interrompidas com texto entram.
- Nada sai do histórico gravado. Cada resposta registra o que foi enviado, e
  a tela marca onde o contexto da última resposta começou quando as mais
  antigas ficaram de fora.
- Sem resumo automático nem memória semântica.

Troca de modelo: o seletor muda o modelo das próximas respostas; o histórico
continua e vai inteiro (dentro do limite) para o novo modelo. Cada resposta
registra o modelo que a gerou, e a tela mostra "Modelo alterado para …". O
agente (instruções e perfil) não muda com o modelo: fica fixo na conversa.

Agentes indisponíveis: arquivados ficam fora da lista de novas conversas; uma
conversa cujo agente foi excluído, arquivado ou não carregado continua legível,
com o envio desativado, sem troca automática de agente.

Ficam para etapas futuras: resumo automático de conversas longas, memória
entre conversas, contagem exata de tokens pelo motor, o assistente interno
Gerpro AI, ferramentas, instalação assistida de modelos, recomendações conforme o hardware e a
integração opcional com o VS Code.

## O que existe hoje

| Item | Onde | Situação |
|---|---|---|
| Interface `InferenceProvider` | `src/shared/inference.ts` | Contrato: `status`, `listModels`, `generate` (eventos de streaming e cancelamento por `AbortSignal`) |
| `ModelRef` / `ProviderModel` | `src/shared/inference.ts` | Identidade estável (provedor + modelo), separada de disponibilidade e requisitos |
| `ExecutionProfile` / `RunOverrides` | `src/shared/execution.ts` | Parâmetros padrão do agente e substituição por execução |
| `CompatibilityState` | `src/shared/compatibility.ts` | Estimado × testado × confirmado |
| `evaluateCompatibility` / `recommendModels` | `src/shared/compatibility-evaluator.ts` | Avaliação por regras e recomendação de alternativas; puras, testadas, ainda sem chamador |
| `defaultModel` / `defaultProfile` no agente | `src/shared/agents.ts` | `providerId` opcional: o agente não fica preso a um provedor |
| `ModelDescriptor` | `src/shared/engine.ts` | Só para a biblioteca de exemplo |
| Provedores locais | `src/main/engine/` | Adaptador Ollama, HTTP restrito a loopback (`local-http.ts`) e `InferenceProviderError` (Lote 3.3.6) |
| `RunService` | `src/main/runs/run-service.ts` | Fila, cancelamento, tempo limite, limites e eventos funcionais (Lote 3.3.5); verificação de provedores, `providers()` e `canRunReal` (Lote 3.3.6) |
| Provedor simulado | `src/main/runs/simulated-provider.ts` | `kind: 'simulated'`, roteiros determinísticos; **não é motor** |
| `engineAvailable` | `src/main/services/index.ts` | Verdadeiro só quando um provedor real pronto tem o modelo do agente instalado (`canRunReal`) |
| Canal `providers:list` | `src/shared/ipc.ts` | Estado verificado e modelos instalados de cada provedor, para a interface |
| `engineAvailable` nas recomendações | `src/renderer/src/components/hardware/AgentRecommendations.tsx` | Verdadeiro com motor conectado; exemplos seguem sem execução |
| Biblioteca de modelos | `src/renderer/src/data/models.ts` | **Fictícia**; a tela Modelos mostra à parte os modelos realmente instalados |
| Preferências `models.directory` e `models.maxRamGb` | `src/shared/settings.ts` | Gravadas, sem efeito |

## Requisitos que o contrato já impõe

- **Processo:** o motor roda fora do Renderer, que só o alcança por canais IPC
  declarados em `src/shared/ipc.ts`.
- **Respostas:** em streaming (`AsyncIterable<InferenceEvent>`), com
  cancelamento por `AbortSignal`, o que é compatível com o cancelamento
  cooperativo de `RunRecord`. Cada evento recebido passa por
  `validateInferenceEvent` antes de seguir adiante.
- **Vários provedores:** cada um com `id`. O Ollama pode ser usado
  temporariamente como provedor `external`, e o runtime próprio futuro entra
  como `embedded`, sem mudar agentes, execuções nem interface. Um agente com
  `providerId: null` aceita qualquer provedor que ofereça o modelo.
- **Execuções reais:** devem usar `origin: 'real'` (`RealRunRecord`), registrar
  a `ResolvedExecution` e seguir `RUN_TRANSITIONS`. Métricas só com valores
  medidos.
- **Falhas:** falta de memória é transitória e nunca vira incompatibilidade
  confirmada (`stateAfterTest`).
- **Ferramentas:** só podem ser chamadas pelo motor via `ToolExecutor`, com
  validação de esquema e permissões no Main.

## Questões em aberto para a decisão

1. **Runtime:** biblioteca nativa embutida, processo auxiliar (*sidecar*)
   empacotado com o app ou execução remota via Gerpro Web. As duas primeiras
   cabem no contrato `InferenceProvider`; execução remota exigiria uma
   decisão própria (hoje bloqueada).
2. **Isolamento:**
   - *Proposta:* não executar a inferência no processo Main, para não
     bloquear o IPC e a janela.
   - Um `utilityProcess` do Electron ou um processo auxiliar isolam falhas e
     uso de memória.
3. **Formatos de modelo:** o contrato prevê `gguf`, `safetensors` e `onnx`.
   Definir quais serão suportados primeiro.
4. **Origem dos modelos:** catálogo próprio, Gerpro Web ou repositórios
   públicos. Licenças, verificação de integridade (hash) e pasta de
   armazenamento.
5. **Aceleração:** CUDA, ROCm, Metal, Vulkan e DirectML. O Hardware Advisor já
   descreve essas capacidades no perfil.
6. **Limites:** aplicar `models.maxRamGb` antes de carregar um modelo. O
   lugar é a `resourcePolicy` do `RunService`, com memória medida, nunca a
   do hardware demonstrativo.

## Integração com o Hardware Advisor

`engineAvailable` já reflete o motor real, em `createServices` e em
`AgentRecommendations.tsx`. Falta ligar:

- **Lista de modelos:** substituir a biblioteca fictícia por
  `InferenceProvider.listModels()`, mapeando para `ModelProfile` com a
  disponibilidade real (`installed`, `downloading`, `error`).
- **Compatibilidade:** `evaluateCompatibility` recebe as entradas do
  inventário do provedor; o provedor deve informar `location`, `sizeBytes`,
  `contextLength` e, se possível, `contextBytesPerToken`. Testes reais
  gravados como `CompatibilityAssessment` (com digest e `deviceKey`) passam a
  prevalecer sobre a estimativa nas mesmas condições.
- **Requisitos medidos pelo motor:** entram como `AgentRequirements` com
  `source: 'declared'` e prevalecem sobre a estimativa.
- **Recomendações:** `executableNow` passa a ser verdadeiro automaticamente
  quando motor, modelo instalado e ferramentas permitirem. Nenhuma outra
  mudança no motor de recomendações é necessária.

Ver também "Ponto de extensão 2" em
[`src/main/hardware/README.md`](../src/main/hardware/README.md).
