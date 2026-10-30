# Etapas e estado atual

| Etapa | Tema | Commit |
|---|---|---|
| 1 | Protótipo visual navegável | `00a39f0` (junto com a 2.1) |
| 2.1 | Núcleo funcional: contratos, persistência local e IPC | `00a39f0` |
| 2.2 | Integração das telas com o Main e versionamento Git | `545e8b8` |
| 3.1 | Gerpro Hardware Advisor: contratos, consentimento e recomendações demonstrativas | `9376ce4` |
| 3.2.2 | Alterações não salvas, vocabulário de origem e temas | `57d72a6`, `4cac956`, `f447b3f` |
| 3.3.3 e 3.3.4 | Contratos de inferência local, migração de agentes e avaliador de compatibilidade | `d1a32f8`, `fe55bc4` |
| UX-P1 e UX-B1 | Apresentação Guiada e identidade visual oficial | `19325bf`, `4f487c5` |
| 3.3.5 | `RunService` e provedor simulado | `41a6729` |
| 3.3.6 | Ollama como provedor local | `feb9072` |
| 3.3.7 e 3.3.7-A | Conversas persistentes e interface de execução | `f68f2b2` |
| 3.3.8 | Agentes configuráveis e integridade dos dados | Commit `feat: add configurable agents and agent data protection` |

O repositório Git foi criado na Etapa 2.2. Por isso, o commit inicial reúne as
etapas 1 e 2.1.

---

## Etapa 1: protótipo visual

**Objetivo:** uma base visual navegável, sem inferência, agentes reais ou
integrações.

Entregue:

- Janela desktop com tema escuro e acento âmbar, barra de título própria
  (`titleBarStyle: 'hidden'`) e marca "G".
- Barra lateral com oito telas: Início, Agentes, Chat, Modelos, Execuções,
  Ferramentas, Desenvolvedor e Configurações. As rotas são registradas em
  `src/renderer/src/app/routes.ts`.
- Componentes reutilizáveis em `src/renderer/src/components/ui/`: botões,
  cards, menus, campos de formulário, selos de status, avisos e barras de
  progresso.
- Dados fictícios em `src/renderer/src/data/` (agentes, modelos, conversas,
  execuções e ferramentas).
- Separação Main / Preload / Renderer e configurações seguras do Electron
  (ver [Arquitetura](02-arquitetura.md)).
- Pastas reservadas para o motor de IA (`src/main/engine/`) e para plugins
  (`src/main/plugins/`).

Estado atual das telas da Etapa 1 (após a Etapa 3.2.2, Lote 2): Início e
Ferramentas leem dados reais do Main; Chat, Modelos e Desenvolvedor ainda
usam dados de exemplo, identificados como tal (ver "Identificação de origem"
abaixo).

---

## Etapa 2.1: núcleo funcional

**Objetivo:** fundação de agentes, ferramentas, execuções e persistência,
sem mexer na interface.

Entregue:

- **Contratos em `src/shared/`:** `agents.ts`, `tools.ts`, `runs.ts`,
  `settings.ts`, `errors.ts`, `validation.ts`, `engine.ts` e `plugins.ts`.
  Detalhes em [Contratos](03-contratos.md).
- **Validação em tempo de execução:** a classe `Checker` (`validation.ts`)
  rejeita campos desconhecidos e devolve a lista de problemas com caminho
  (`$.settings.temperature`).
- **Persistência:** `VersionedStore` com envelope versionado, escrita
  atômica, cópia de arquivos inválidos e bloqueio de arquivos de versão mais
  nova.
- **Cofre de credenciais:** `SecretVault`, cifrado pelo `safeStorage` do
  sistema. Quando não há cifra disponível, o cofre se recusa a gravar.
- **Serviços do Main:** `SettingsService`, `AgentService`, `ToolRegistry`
  (catálogo de 7 ferramentas declaradas, nenhuma executável) e
  `DemoRunManager`.
- **IPC:** handlers que recebem `unknown`, validam no Main, conferem a
  quantidade de argumentos e respondem `Result<T>`.
- **Testes** com `node:test`, sem dependências novas.

---

## Etapa 2.2: integração e versionamento

**Objetivo:** ligar os serviços da 2.1 à interface e versionar o projeto.

Entregue:

- **Git local:**
  - `.gitignore` exclui dependências, builds, `.env`, chaves, dados locais e o
    relatório de pesquisa sobre software de terceiros.
  - `.gitattributes` normaliza os finais de linha para LF.
  - Commit inicial `00a39f0`.
- **Agentes:**
  - "Meus agentes" cria, edita, arquiva e exclui definições reais, que são
    gravadas em disco.
  - Os exemplos continuam identificados e podem ser duplicados como novo
    agente.
  - Cada agente mostra por que está indisponível. Hoje, no mínimo, porque não
    há motor de IA.
- **Configurações:**
  - As preferências são gravadas e sobrevivem ao reinício.
  - Cada campo informa "Gravado; ainda sem efeito nesta versão".
- **Execuções:**
  - "Execuções simuladas desta sessão" vêm do `DemoRunManager`, só em memória
    e com `origin: 'simulated'` (substituído no Lote 3.3.5 pelo `RunService`
    com o provedor simulado).
  - O "Histórico de exemplo" fica em uma seção separada.
  - A conversão dos estados antigos dos dados de exemplo para o novo contrato
    é explícita: `legacyRunState`, com `queued→pending` e
    `succeeded→completed`.
- **Barra lateral:** os contadores vêm dos agentes salvos e das simulações em
  andamento.
- **Telas:** estados de carregamento, vazio e erro.
- **Correção de contrato:** `agents:save` foi dividido em `agents:create`
  (falha com `conflict` se o ID já existe) e `agents:update` (falha com
  `not-found` se o agente não existe). Isso evita sobrescrever um agente sem
  querer.
- **Commit:** `545e8b8`.

---

## Etapa 3.1: Gerpro Hardware Advisor

**Objetivo:** experiência visual, contratos e fluxos demonstrativos do
Advisor, sem detecção real, APIs nem motor.

Entregue (detalhes em [Hardware Advisor](04-hardware-advisor.md)):

- Contrato do perfil de hardware: CPU, RAM, GPU/VRAM, armazenamento, sistema,
  aceleração e procedência (origem, data e confiabilidade).
- Consentimento com duas finalidades independentes: análise local e envio ao
  Gerpro Web. A análise local tem **escopo**: `demo-only` ou
  `device-detection`.
- Seção "Hardware e desempenho" em Configurações, com seis estados e cinco
  cenários fictícios.
- Recomendações na tela Agentes, com quatro categorias e justificativas.
- Ponto de extensão `HardwareDetector` para o detector real.
- Canais IPC `hardware:get-state`, `hardware:set-local-consent`,
  `hardware:analyze` e `hardware:delete-data`.
- Ajustes de finalização:
  - O motivo de "indisponível" deixou de aparecer duplicado.
  - Uma autorização demonstrativa não é aceita para leitura real.
- **Commit:** `9376ce4`.

---

## Organização das telas (Lote 3.3.7)

Organização definitiva da barra lateral:

| Tela | Papel |
|---|---|
| Início | Dashboard: saudação, indicadores da sessão, execuções recentes e atalhos ("Conversar com IA", "Criar agente", "Abrir Modelos") |
| Conversas | Interação com modelos locais: modelo, agente, mensagem, resposta em tempo real, interrupção e lista das conversas gravadas |
| Gerpro AI | Reservado ao futuro assistente interno do Gerpro Studio (em desenvolvimento); não chama nenhum modelo |
| Agentes | Cadastro de agentes; "Executar" abre Conversas com o agente escolhido |
| Modelos | Modelos instalados no motor local e biblioteca de exemplo; "Usar em Conversas" abre Conversas com o modelo escolhido |
| Execuções | Histórico, monitoramento, métricas, erros e registro técnico da sessão, além da demonstração simulada |
| Ferramentas, Desenvolvedor, Configurações | Sem mudança de papel |

Atalhos entre telas (`renderer/src/lib/run-intent.ts`, só em memória):
"Conversar com IA" (Início), "Executar" (Agentes) e "Usar em Conversas"
(Modelos) abrem Conversas; "Detalhes técnicos" (Conversas) abre a execução
em Execuções; "Nova mensagem" (Execuções) volta a Conversas.

Funcionalidades futuras registradas no roadmap:

- Resumo automático de conversas longas e memória entre conversas (fora do escopo das conversas contínuas atuais).
- Assistente interno do Gerpro Studio (tela Gerpro AI).
- Integração opcional com o VS Code.
- Instalação assistida de modelos.
- Recomendações conforme o hardware.

## Quadro geral: implementado × simulado × planejado

| Área | Implementado | Simulado | Planejado |
|---|---|---|---|
| Agentes | CRUD persistido, validação e cálculo de disponibilidade; "Executar" abre Conversas com o agente escolhido (Lote 3.3.7); modelo escolhido entre os instalados, tipos de tarefa, configurações avançadas e proteção de `agents.json` (Lote 3.3.8) | Biblioteca de exemplos | Ferramentas e execução autônoma; requisitos na definição persistida |
| Configurações | Gravação, validação e persistência | — | Efeito real de cada preferência |
| Ferramentas | Catálogo declarado (7 itens) com esquemas e permissões, exibido na tela | — | Executores, ativação, concessão de permissões e plugins |
| Execuções | `RunService` (Lote 3.3.5): fila FIFO com uma execução ativa, cancelamento por `AbortController`, tempo limite, limites e eventos agrupados; canal `runs:start`. Provedor real Ollama (Lote 3.3.6). Tela Execuções (Lote 3.3.7): central de monitoramento com resumo da sessão, histórico real e simulado, estados, modelo, provedor, métricas medidas, erros, registro técnico e interrupção | Seção "Demonstração simulada" (provedor simulado, `origin: 'simulated'`), separada e identificada | Histórico persistido |
| Hardware Advisor | Consentimento com escopo, revogação, exclusão de dados e validação do perfil | Perfis de hardware (cenários fictícios) | Detector real; envio ao Gerpro Web |
| Recomendações | Motor de regras puro e testado | Entradas: perfil e biblioteca de modelos fictícios | Modelos e requisitos vindos do motor |
| Modelos | Contratos de inferência local (`InferenceProvider`, `ModelRef`, `ExecutionProfile`, compatibilidade); origem `ModelSource`; modelos realmente instalados no Ollama, listados na tela Modelos (Lote 3.3.6) | Biblioteca de exemplo da tela Modelos, sem estado operacional | Download e gerenciamento de modelos; motor de inferência próprio |
| Credenciais | `SecretVault` cifrado (testado) | — | Uso pelos serviços; ainda não está ligado a nenhum |
| Gerpro Web | Espaço reservado para o consentimento `serverSharing`, que hoje não pode ser concedido | — | APIs, autenticação e módulos web |
| Início | Dashboard com indicadores reais da sessão (agentes salvos, execuções de hoje) e execuções recentes | — | Modelos carregados e tokens do dia, quando o motor informar |
| Conversas | Conversas contínuas gravadas neste computador: nova conversa, lista, renomear, excluir com confirmação, contexto real entre mensagens (recorte limitado e registrado em cada resposta), troca de modelo no meio da conversa, resposta em tempo real, "Interromper geração" e erros explicados | — | Resumo automático de conversas longas, memória entre conversas, contagem exata de tokens do contexto, busca e exportação |
| Gerpro AI, Desenvolvedor | Informações do aplicativo (Desenvolvedor); o Gerpro AI explica o futuro assistente e aponta para Conversas | Logs de exemplo (Desenvolvedor) | Assistente interno do Gerpro Studio (Gerpro AI), servidor local e exposição na rede |

## Identificação de origem (Etapa 3.2.2, Lote 2)

Todas as telas usam o mesmo vocabulário (`featureStatus` em
`renderer/src/lib/status.ts`, componentes `FeatureBadge` e `FeatureNotice`):

| Selo | Significado |
|---|---|
| **Real** | Implementado e operacional: dados gravados ou serviços do Main |
| **Simulado** | Fluxo demonstrativo; a funcionalidade representada não roda |
| **Planejado** | Ainda não implementado |
| **Exemplo** | Registro fictício (agente, conversa, modelo, histórico, log) |

Regras: telas que importam `renderer/src/data/` precisam identificar os
exemplos (verificado por teste); modelos de exemplo nunca mostram
"Carregado", progresso de download ou "disponível localmente"; controles sem
efeito ficam desativados e explicados, nunca com aparência operacional.

## Lote 3.3.8: agentes configuráveis e integridade dos dados

Entregue:

- **Modelo do agente:** escolhido na lista de modelos instalados, sem seleção
  automática. Modelo ausente ou incompatível fica salvo e identificado.
- **Editor:** tipos de tarefa, configurações avançadas recolhíveis (parâmetros,
  desempenho, identificação técnica e ferramentas) e preservação dos campos não
  exibidos.
- **Situação do agente:** estado gravado, executabilidade e observações
  separados, com a mesma regra que o `RunService` aplica.
- **Capacidade:** modelo que declara capacidades sem `chat` é recusado por
  `resolveExecution` (`model-unsupported`).
- **Integridade:** `agents.json` inválido bloqueia alterações, sem perder os
  registros recusados; canal `agents:storage-status`; cópias sem repetição.

Correções da homologação final, todas na apresentação:

- Conversas dizia que o agente fora excluído quando só não pôde ser carregado,
  e convidava a criar agente com as alterações bloqueadas.
- Arquivar agente com ferramenta desconhecida mostrava erro técnico.
- Trocar de agente em conversa nova mantinha o modelo anterior, contrariando o
  texto do editor.
- Esc no menu deixava o foco fora do botão.
- Dois textos auxiliares tinham contraste abaixo de 4,5:1 no tema escuro.
- O seletor dizia "Nenhum modelo instalado" com o motor desligado.

## Verificação

No encerramento técnico do Lote 3.3.8, `npm test` passa todos os testes em
`tests/main`, `tests/renderer` e `tests/shared`. `npm run typecheck` não tem
erros nas três configurações e `npm run build` termina sem erros. A contagem de
cada entrega fica no relatório do lote, para não envelhecer aqui.
