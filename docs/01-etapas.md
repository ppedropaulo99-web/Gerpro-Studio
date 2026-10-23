# Etapas e estado atual

| Etapa | Tema | Commit |
|---|---|---|
| 1 | Protótipo visual navegável | `00a39f0` (junto com a 2.1) |
| 2.1 | Núcleo funcional: contratos, persistência local e IPC | `00a39f0` |
| 2.2 | Integração das telas com o Main e versionamento Git | `545e8b8` |
| 3.1 | Gerpro Hardware Advisor: contratos, consentimento e recomendações demonstrativas | `9376ce4` |

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

## Quadro geral: implementado × simulado × planejado

| Área | Implementado | Simulado | Planejado |
|---|---|---|---|
| Agentes | CRUD persistido, validação e cálculo de disponibilidade | Biblioteca de exemplos | Execução real; requisitos e tipos de tarefa na definição persistida |
| Configurações | Gravação, validação e persistência | — | Efeito real de cada preferência |
| Ferramentas | Catálogo declarado (7 itens) com esquemas e permissões, exibido na tela | — | Executores, ativação, concessão de permissões e plugins |
| Execuções | `RunService` (Lote 3.3.5): fila FIFO com uma execução ativa, cancelamento por `AbortController`, tempo limite, limites e eventos agrupados; canal `runs:start` | Quem responde: o provedor simulado determinístico (`origin: 'simulated'`, só em memória) | Provedor real e histórico persistido |
| Hardware Advisor | Consentimento com escopo, revogação, exclusão de dados e validação do perfil | Perfis de hardware (cenários fictícios) | Detector real; envio ao Gerpro Web |
| Recomendações | Motor de regras puro e testado | Entradas: perfil e biblioteca de modelos fictícios | Modelos e requisitos vindos do motor |
| Modelos | Contratos de inferência local (`InferenceProvider`, `ModelRef`, `ExecutionProfile`, compatibilidade); origem `ModelSource` | Tela Modelos (biblioteca de exemplo, sem estado operacional) | Provedor local de modelos e motor de inferência |
| Credenciais | `SecretVault` cifrado (testado) | — | Uso pelos serviços; ainda não está ligado a nenhum |
| Gerpro Web | Espaço reservado para o consentimento `serverSharing`, que hoje não pode ser concedido | — | APIs, autenticação e módulos web |
| Início | Agentes salvos e simulações da sessão (data local atual) | — | Modelos carregados e tokens |
| Chat, Desenvolvedor | Informações do aplicativo (Desenvolvedor) | Conversas e logs de exemplo | Inferência, servidor local e exposição na rede |

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

## Verificação

Em `9376ce4`, `npm test` passa 116 testes em 8 arquivos (`tests/main`,
`tests/renderer` e `tests/shared`). `npm run typecheck` não tem erros nas
três configurações. `npm run build` termina sem erros.
