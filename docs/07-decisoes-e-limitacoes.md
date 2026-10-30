# Decisões e limitações conhecidas

## Registro de decisões

| # | Etapa | Decisão | Motivo |
|---|---|---|---|
| D1 | 1 | Electron + React + TypeScript + Vite (electron-vite) | Stack definida no pedido inicial |
| D2 | 1 | Identidade visual própria (tema escuro, acento âmbar, marca "G"); nada copiado do LM Studio | Produto proprietário. A semelhança é só no tipo de organização (barra lateral, biblioteca, chat). |
| D3 | 1 | `contextIsolation`, `sandbox`, sem `nodeIntegration`, CSP, permissões negadas, navegação bloqueada | O Renderer é tratado como não confiável |
| D4 | 1 | Preload expõe funções de alto nível, nunca `ipcRenderer` | Superfície mínima e auditável |
| D5 | 2.1 | Contratos puros em `src/shared/`, sem React, Electron nem Node | Reuso nos três processos e, no futuro, no Gerpro Web |
| D6 | 2.1 | Validação em tempo de execução no Main, com campos desconhecidos rejeitados | Tipos TypeScript não protegem contra dados do Renderer ou do disco |
| D7 | 2.1 | `Result<T>` / `StructuredError` em todo canal de dados | Erros previsíveis na interface, sem stack trace |
| D8 | 2.1 | `VersionedStore`: envelope versionado, escrita atômica, cópia de arquivos inválidos, nunca sobrescrever versão futura | Reduzir corrupção e perda de dados |
| D9 | 2.1 | Credenciais só no `SecretVault` (`safeStorage`); sem cifra, recusar | Nunca texto puro em disco |
| D10 | 2.1 | Disponibilidade do agente calculada a cada leitura, nunca gravada | Depende de ferramentas e motor, que mudam |
| D11 | 2.1 | Execuções com `origin` obrigatório; só o `DemoRunManager`, em memória | Impossível confundir simulação com execução real |
| D12 | 2.1 | Testes com `node:test` e remoção de tipos nativa do Node | Nenhuma dependência nova |
| D13 | 2.2 | Repositório Git local, sem remoto configurado pelo assistente; relatório sobre o LM Studio fora do Git | Material de terceiros e caminhos locais não devem ser versionados |
| D14 | 2.2 | `agents:save` dividido em `agents:create` e `agents:update` | Evitar sobrescrever um agente existente sem querer |
| D15 | 2.2 | Exemplos e dados reais em seções separadas; `legacyRunState` explícito | Não misturar dados fictícios com registros do usuário |
| D16 | 2.2 | Preferências sem efeito marcadas como tal em cada campo | Não apresentar configuração inerte como funcional |
| D17 | 3.1 | Consentimentos separados: análise local × envio ao servidor | Exigência de privacidade da etapa |
| D18 | 3.1 | Detectores injetados (`HardwareDetector`); detector real "indisponível" | Trocar por um real sem mudar o serviço, o IPC ou a interface |
| D19 | 3.1 | Adequação ao hardware (`fit`) separada de executabilidade (`executableNow`) | Hardware suficiente não significa agente executável sem motor |
| D20 | 3.1 | Recomendação combina vários fatores; nenhum critério isolado | Exigência da etapa; evita recomendações enganosas |
| D21 | 3.1 (final) | Escopo de consentimento `demo-only` × `device-detection`, sem ampliação automática | A autorização demonstrativa foi dada numa tela que diz que nada é lido |
| D22 | 3.1 (final) | `hardware.json` sem escopo cai no padrão seguro, sem migração | Não presumir consentimento. A 3.1 não tinha sido distribuída. |
| D23 | — | Motor de inferência, Gerpro Web e módulos web: **decisão adiada** | Exigem autorização e definição da equipe |
| D24 | 3.2.2 | Navegação pelo app com alterações não salvas pede confirmação ("Continuar editando" / "Descartar alterações") | Evitar perda silenciosa do que foi digitado (achado 1 da auditoria 3.2.1) |
| D25 | 3.2.2 | Confirmação de ferramentas sensíveis e telemetria bloqueadas nos valores seguros; o Main recusa alterá-las; valores antigos preservados, mas sem efeito | Uma escolha feita sem a função existir não pode virar decisão efetiva depois (achado 2) |
| D26 | 3.2.2 | Vocabulário único Real / Simulado / Planejado / Exemplo; modelos de exemplo sem estado operacional; controles sem efeito desativados | Nada fictício pode parecer operacional, e a demonstração futura precisa distinguir execuções reais de simuladas (Lote 2) |
| D27 | 3.2.2 | Temas escuro (padrão, grafite e âmbar) e claro (azul e branco); cores só em tokens; tema aplicado e gravado na hora, fora do formulário Salvar/Descartar | Mudança visual reversível com um clique; segue o padrão das ações imediatas do Hardware Advisor e não mistura com o fluxo de alterações não salvas |
| D28 | 3.3.3 | Agente, modelo e perfil de execução separados; provedores atrás de `InferenceProvider`; perfil embutido no agente com substituição por execução; `agents.json` v2 com migração | Usar o Ollama temporariamente e um runtime próprio depois sem refazer agentes, execuções e interface; perfis nomeados só quando houver onde guardá-los |
| D29 | 3.3.3 | Compatibilidade em cinco estados; só teste real confirma; falta de memória é transitória | Estimativa nunca é apresentada como confirmação, e uma falha momentânea não marca o modelo como incompatível para sempre |
| D30 | 3.3.4 | Avaliador e recomendação por regras ordenadas e ordenação lexicográfica, sem pontuação; ajuste de perfil antes de outro modelo; instalados e não instalados em listas separadas | Cada conclusão é explicável passo a passo e reproduzível; nenhuma fórmula arbitrária decide, e nada não instalado parece disponível |
| D31 | UX-P1 | Apresentação Guiada nas telas reais: roteiro declarativo em capítulos (`tour/steps.ts`), componentes marcados com `data-tour`, painel numa coluna reservada à direita (o app encolhe, o painel nunca cobre o destaque) e app inerte durante a apresentação | Mostrar o produto real, não slides; somente leitura por construção; editar o roteiro sem mexer na mecânica |
| D32 | UX-B1 | Identidade oficial Gerpro: cores extraídas do PDF do logo (marinho #333366, azul #58AED9, azul-claro #ACD7EC) substituem o âmbar e a paleta clara provisória (D2, D27); logo convertido do PDF para SVG sem alterar geometria; no tema escuro, logo sobre placa branca; barra de título só com o nome | Usar a marca real, sem redesenho; o logo não tem versão para fundo escuro nem versão reduzida, e abaixo de ~44 px de altura deixa de ser legível |
| D33 | UX-B1.1 | Logo só na barra lateral (113 × 52 px); saudação no Início com nome de exibição opcional em `profile.displayName` (`settings.json` v3, migração explícita); ícone do aplicativo sem alteração até a aprovação de uma versão reduzida | Evitar a marca repetida na mesma tela; nome digitado pelo usuário, local e fora de logs; nenhum símbolo reduzido é escolhido sem aprovação |
| D34 | 3.3.5 | `RunService` único no Main (fila FIFO, uma ativa, até 10 pendentes, `AbortController`, prazo a partir de `running`, finalização única) com provedor simulado determinístico; execuções simuladas registram modelo e texto simulados, nunca métricas (Opção A); `runs:start-demo` vira adaptador da mesma fila; texto agrupado a cada 75 ms com `revision`; `engineAvailable` só considera provedor real | Validar todo o ciclo de vida antes do motor real, sem segunda fila nem simulação confundida com inferência ou com prova de compatibilidade |
| D35 | 3.3.6 | Ollama como primeiro provedor real, atrás de `InferenceProvider` (`kind: 'external'`): conversão só no adaptador, comunicação só no Main e só loopback, sem redirecionamentos, com limites de tamanho; motor real disponível só após resposta `ready`; agente disponível só com o modelo instalado num provedor real pronto; limite atingido sem texto é falha | Ter inferência real sem prender o app ao Ollama: o motor próprio futuro entra como outro provedor, e nada simulado, remoto ou vazio parece resposta real |

| D36 | 3.3.7 | Execução real pela interface com `runs:start` (agente escolhido, modelo em `overrides.model`), sem mudar contratos; as telas só exibem o estado do `RunService` (`watchRuns` por `revision`, sem buffer próprio); falha de execução simulada nunca é atribuída ao motor local | Uma única fila e uma única fonte de verdade; nada simulado parece real e nada real é convertido em simulação |
| D39 | 3.3.7-A | Situação de gravação por conversa (`saved`/`saving`/`failed`) avisada só quando muda; falha não descarta a memória nem desfaz alterações (inclusive renomear); nova tentativa manual; escritas seguidas agrupadas; ponto de controle do texto parcial no máximo a cada 2 s e na saída do app, sem retomar a geração | Não apresentar como salvo o que não foi gravado, sem perder o que está na tela; preservar o texto já recebido sem gravar a cada trecho nem afetar o streaming |
| D38 | 3.3.7 (conversas) | Conversas contínuas no Main (`ConversationService`), uma por arquivo (`VersionedStore`); contexto montado no Main e passado ao `RunService` por parâmetro interno, sem mudar `RunRequest`, `InferenceProvider` nem o adaptador Ollama; recorte conservador por caracteres, registrado em cada resposta; agente fixo por conversa e modelo trocável | O modelo recebe o histórico de verdade sem segunda fila nem segundo buffer; conversas isoladas e resistentes a arquivo corrompido; o histórico chega ao provedor sem que o Renderer possa injetá-lo pelo IPC |
| D37 | 3.3.7 (UX) | Papéis separados: Início como dashboard (saudação, indicadores, execuções recentes, atalhos), Conversas para interagir com modelos locais (lista lateral, mensagens, campo de entrada), Execuções para monitorar (resumo, histórico, métricas, erros, registro, demonstração simulada) e Chat reservado ao futuro assistente interno; nomes amigáveis derivados só do identificador (a lista de mensagens independentes foi substituída pelas conversas contínuas, D38) | Interface simples por padrão, com o técnico a um clique; preparar conversas futuras sem criar uma camada provisória que precise ser descartada |
| D40 | 3.3.7 (identidade) | Tela Chat renomeada para Gerpro AI só no que o usuário vê (menu, página, Apresentação Guiada); rota `chat`, `ChatPage`, classes CSS e marcas `data-tour` preservadas; a palavra chat continua com o sentido técnico em contratos, capacidades de modelo e na integração Ollama; a tela segue sem chamar o motor | Alinha o nome à função de assistente do produto sem tocar em arquitetura nem invalidar referências internas. |

| D41 | 3.3.8 | Modelo do agente escolhido na lista de instalados, sem seleção automática; modelo ausente, incompatível ou não verificado fica preservado e identificado | Uma indisponibilidade momentânea não pode reescrever a configuração do usuário |
| D42 | 3.3.8 | Estado gravado, executabilidade e observações separados na tela, seguindo as regras do `RunService` | Evitar que a tela prometa ou negue o que o Main faz |
| D43 | 3.3.8 | Regra de capacidade em `resolveExecution`: lista sem `chat` é recusada; lista vazia significa "não declarou" e é aceita | Bloquear embeddings antes do motor sem rejeitar modelos e provedores que não informam capacidades |
| D44 | 3.3.8 | `protectOnRecovery` só em `agents.json`: dados inválidos bloqueiam gravações, sem reparo automático; cópia conferida e sem repetição; `agents:storage-status` expõe só o motivo | Um agente recusado existe só no arquivo; regravar a lista o apagaria. Os demais arquivos mantêm a política anterior |
| D45 | 3.3.8 | Rascunhos conversam, e `tools`, `requestedPermissions` e `taskTypes` não afetam conversas | Mantém a política existente, sem promessa de ferramentas; os avisos dizem isso na tela |
| D46 | 3.3.8 | Conversa com agente indisponível fica só para leitura, sem exclusão, troca automática ou alteração do arquivo; escolher agente em conversa nova aplica o padrão dele | Histórico é do usuário; a promessa do editor precisa valer em Conversas |

## Limitações conhecidas

### Funcionais

- A inferência real existe no Main pelo adaptador Ollama (Lote 3.3.6) e é
  iniciada pela tela Conversas (Lote 3.3.7), uma execução por resposta, com o
  histórico permitido da conversa. Não há download de modelos. A biblioteca da
  tela Modelos e os logs do Desenvolvedor usam dados de exemplo,
  identificados com o selo "Exemplo"; o Gerpro AI só descreve o assistente
  em desenvolvimento. Em Execuções, modelos carregados e tokens aparecem como
  "Planejado", sem valor.
- Nenhuma ferramenta executa. Todas aparecem como `not-implemented`.
- Um agente só fica `available` com o modelo padrão instalado num provedor
  real pronto. O provedor simulado não muda isso.
- Execuções (reais e simuladas) ficam só na memória do Main: até 100 por
  sessão, descartadas ao fechar o app.
- A seção "Demonstração simulada" e a Apresentação Guiada ainda usam
  `runs:start-demo`.
- Durante a geração, o progresso fica indeterminado: a barra só mostra 100%
  ao concluir; a etapa ("Gerando resposta") aparece abaixo dela.
- As preferências são gravadas, mas, exceto o tema e o nome de exibição, não têm efeito. As de
  privacidade e segurança (confirmação de ferramentas sensíveis e telemetria)
  nem podem ser alteradas.
- O tema não acompanha o tema do sistema operacional, e "Descartar" ou sair
  sem salvar não o revertem (ver D27).
- As cores vêm do logo oficial (ver D32), não de um manual de marca: não
  havia guia com paleta de interface, tons de apoio nem regras de uso. Os
  azuis intermediários e as superfícies foram derivados do degradê oficial e
  ajustados para contraste AA.
- O logo não tem versão para fundo escuro nem versão reduzida. No tema escuro
  ele aparece sobre uma placa branca: sem placa, o marinho de "GERPRO" fica a
  1,5:1 do fundo, e uma placa azulada (#C7D6E7) apagava os traços
  comemorativos. A barra de título e a barra lateral recolhida não o exibem.
- O aplicativo ainda não tem ícone próprio. Em desenvolvimento, a janela e a
  barra de tarefas mostram o ícone do executável do Electron. O logo completo
  fica ilegível de 16 a 48 px, e uma versão reduzida depende de aprovação. Não
  há empacotamento configurado, então o ícone do executável empacotado ainda
  não existe.
- `settings.json` passou à versão 3 (nome de exibição). Uma versão anterior do
  app que abra esse arquivo o trata como "mais novo": usa os padrões e não
  grava.
- A proteção de alterações não salvas cobre a navegação pelo app (barra
  lateral e atalhos internos). Fechar a janela ou sair do aplicativo descarta
  as alterações sem perguntar, e "Cancelar" no editor de agentes também.
- A tela Ferramentas só exibe o catálogo; não há controle de ativação.
  `settings.tools.enabled` existe, mas nenhuma tela o altera.
- A detecção real de hardware não existe. O botão sempre leva a
  "indisponível".
- Requisitos só existem nos agentes de exemplo. Tipos de tarefa são editáveis,
  mas só influenciam as recomendações; sem eles, a tarefa fica "desconhecida".
- `agents.json` passou à versão 2. Uma versão anterior do app que abra o
  arquivo regravado o trata como "mais novo": usa os padrões e não grava.
- O avaliador de compatibilidade e a recomendação de alternativas
  (`compatibility-evaluator.ts`) existem e são testados, mas nada na interface
  ou no Main os chama ainda.
- A estimativa de memória do avaliador é deliberadamente simples (pesos +
  contexto, reservas fixas de RAM e VRAM). Não considera sobrecarga do
  runtime, buffers de computação nem a divisão real de camadas entre GPU e
  CPU; por isso só um teste real confirma compatibilidade. Sem a memória do
  contexto, a estimativa fica incompleta e não conclui que o modelo cabe:
  perfis no contexto padrão do provedor ficam `not-verified` até haver um
  contexto explícito ou um teste.
- A memória livre é um retrato do momento da análise de hardware; numa
  análise desatualizada ela é tratada como desconhecida.
- Lacunas que dependem de lotes futuros:
  - `deviceKey` (identificador do dispositivo e da configuração de hardware)
    não é gerado por ninguém: depende do lote de detecção real de hardware.
    Até lá, nenhum resultado de teste vale como confirmação
    (`effectiveState` exige dispositivo conhecido).
  - `digest` dos modelos já vem do inventário do Ollama (Lote 3.3.6), mas
    ainda não é usado pelo avaliador de compatibilidade.
  - Perfis nomeados e reutilizáveis: lote que criar o armazenamento de
    perfis (migração `agents.json` v2 → v3).
  - Ligar o avaliador a dados reais: inventário de um provedor (com
    `sizeBytes`, `contextLength` e `contextBytesPerToken`), testes reais
    gravados como `CompatibilityAssessment` e evidências de qualidade por
    tarefa (`TaskQualityEvidence`, hoje sem fonte): lote do primeiro
    provedor e das execuções reais.
  - Exibir as justificativas (`steps`) na interface: lote de interface da
    seleção de modelos. Cuidado obrigatório: `use-target` com
    `memoryNow: 'unknown'` (análise desatualizada ou estimativa incompleta)
    diz só que a capacidade comporta o modelo; NÃO confirma memória livre
    suficiente agora. A interface não pode apresentá-lo como pronto para
    executar sem esse aviso.
- Modelos que não estão na biblioteca fictícia têm requisitos desconhecidos.
- A interface está só em português. A preferência de idioma não tem efeito.

### Inferência local (Ollama, Lote 3.3.6)

- **Execução pela interface:** feita no Lote 3.3.7 (tela Conversas). A
  Apresentação Guiada continua usando só o provedor simulado.
- **Modelos com raciocínio (ex.: `qwen3:8b`):** o Ollama envia o raciocínio
  em `message.thinking`, que não entra na resposta nem é exibido. Os tokens
  de raciocínio contam no limite de saída e em `outputTokens`, e o tempo até
  o primeiro texto inclui o raciocínio (47 s no teste com `qwen3:8b`). Se o
  limite acabar antes de qualquer texto, a execução falha com
  `invalid-request` e uma mensagem explícita, nunca como conclusão. Exibir
  o raciocínio fica para etapa posterior. Versões do Ollama que não separam
  o raciocínio o entregariam dentro do texto.
- **Motivo de encerramento:** preservado no evento `done` e registrado nas
  mensagens da execução; o `RunRecord` ainda não tem um campo estruturado
  para ele.
- **Atualização na interface:** a barra lateral verifica os provedores a
  cada navegação; a tela Modelos ao abrir e no botão "Verificar de novo";
  a lista de agentes reaproveita verificações de até 5 s. Não há
  atualização contínua enquanto uma tela fica aberta.
- **Identificador exato:** `llama3.1` não corresponde a `llama3.1:8b`; não
  há apelidos.
- **Endereço fixo:** `127.0.0.1:11434`, sem configuração na interface nem
  leitura de `OLLAMA_HOST`.
- **Métricas:** `peakMemoryBytes` fica sempre `null` (o Ollama não informa).
- **Estados:** o Ollama aparece como `ready`, `unreachable` ou `error`;
  `not-detected` e `incompatible-version` não são usados.
- **Textos:** revisados no Lote 3.3.7 (Apresentação Guiada, Início, Conversas, Chat,
  Agentes, Modelos e recomendações). Os logs do Desenvolvedor continuam de exemplo,
  identificados como tal.

### Conversas e Execuções (Lote 3.3.7 e conversas contínuas)

- **Contexto estimado, não medido:** o recorte usa 3 caracteres por token e,
  sem `contextLength` no perfil do agente, supõe uma janela de 4.096 tokens.
  Se a janela real do motor for menor, o próprio motor pode descartar o
  início do contexto sem avisar; com `contextLength` no perfil, o recorte
  segue esse valor.
- **Sem resumo nem memória:** quando a conversa passa do limite, as mensagens
  mais antigas continuam gravadas e visíveis, mas deixam de ser enviadas. Não
  há resumo automático nem memória entre conversas.
- **Agente fixo por conversa:** para usar outro agente, crie uma nova
  conversa. Se o agente for excluído, arquivado ou não puder ser carregado, a
  conversa fica só para leitura. As ferramentas do agente não são usadas;
  Conversas avisa quando o agente tem alguma.
- **Conversas não são protegidas como agentes:** arquivo de conversa inválido é
  copiado e retirado da pasta, e a tela informa quantos ficaram de fora.
- **Uma resposta por vez em cada conversa:** enquanto uma resposta é gerada,
  a mesma conversa não aceita outro envio (outras conversas entram na fila do
  `RunService`).
- **Fechar durante a geração:** a resposta volta como "Interrompida ao fechar
  o aplicativo", com o texto gravado no último ponto de controle (a cada 2 s,
  mais a gravação feita ao fechar). Se o processo for encerrado à força ou o
  computador desligar, perdem-se até os últimos 2 s de texto. A geração não é
  retomada automaticamente.
- **"Detalhes técnicos":** só para respostas desta sessão; as execuções não
  são gravadas.
- **Limites:** até 500 conversas e 400 mensagens por conversa; acima disso, o
  envio é recusado com uma explicação.
- **Gravação:** se a escrita no disco falhar, a conversa continua na memória
  e na tela, marcada "Falha ao salvar", com a opção de tentar de novo; a
  próxima alteração também tenta. Se o app for fechado ainda com a falha, o
  que não foi gravado se perde (o arquivo fica na última versão gravada).
- **Janelas estreitas:** abaixo de 900 px, a lista de Conversas vira uma faixa
  curta acima das mensagens.
- **Agente obrigatório:** toda conversa usa um agente salvo (instruções e
  perfil vêm dele). Sem agentes salvos, Conversas explica e não envia.
- **Perfil:** o da execução é o do agente; a interface não oferece ajuste
  por execução (o contrato aceita).
- **"Sua mensagem" em Execuções:** guardada só na memória do Renderer (o
  `RunRecord` não guarda a entrada); some ao recarregar a janela. A mensagem
  continua gravada na conversa.
- **Métricas ao interromper:** execuções interrompidas não têm métricas (o
  motor não as envia), e a tela diz isso em vez de estimá-las.
- **Lista de modelos:** atualizada ao abrir Conversas, no botão de atualizar
  ao lado do seletor e após um erro do motor; não há atualização contínua.
- **Raciocínio:** não é exibido; os tokens de raciocínio aparecem somados em
  "Tokens gerados (inclui raciocínio)". O motor só avisa "carregando" antes do
  primeiro texto, então o estado fica "Carregando modelo" também enquanto o
  modelo raciocina; Conversas explica isso no texto de espera.
- **Nomes amigáveis:** só reformatam o identificador (`qwen3:8b` → "Qwen 3
  (8B)"); nada é inferido além dele. O identificador exato aparece em
  Execuções e na tela Modelos.
- **Desempenho em CPU:** na homologação, `llama3.1:8b` levou ~10 s para
  carregar e gerou ~5 tokens/s; respostas longas demoram, e o tempo limite do
  perfil do agente vale para a geração inteira.

### Técnicas

- O `SecretVault` está implementado e testado, mas não é instanciado por
  `createServices`. Nenhuma credencial é usada hoje.
- O Linux sem chaveiro (`basic_text`) é tratado como "sem cifra": o cofre se
  recusa a gravar.
- **Concorrência de análises:** chamadas simultâneas de `hardware:analyze`
  compartilham a mesma execução, mesmo com modos ou cenários diferentes. A
  segunda chamada recebe o resultado da primeira.
- **Estimativas de requisitos:** `estimateRequirementsFromModel` usa
  heurísticas aproximadas (tamanho do arquivo e contexto), não medições.
- **Limite de agentes:** até 500 agentes salvos.
- **Provedor que ignora o cancelamento:** a execução encerra na hora e a
  fila segue, mas o gerador do provedor pode continuar até seu próximo
  evento, que é descartado.
- **Atualizações de texto:** cada lote envia a execução inteira (com todo o
  texto acumulado, até 200.000 caracteres), não só o trecho novo.
- Não há empacotamento, instalador nem atualização automática.
- Não há lint configurado. A qualidade é verificada por `typecheck` estrito e
  testes.
- **Testes de interface:** os testes cobrem contratos, serviços e a lógica
  pura da interface. As telas React não têm testes de renderização, e a
  verificação visual foi manual (via DevTools Protocol, fora do repositório).
- **Protegido enquanto aberto:** o bloqueio de `agents.json` é avaliado ao
  iniciar. Mudanças no arquivo com o app aberto só valem depois de reiniciar.
- **Teclado:** o menu de ações não tem navegação por setas; Tab percorre os
  itens, e Esc fecha e devolve o foco ao botão. A exclusão de agente usa o
  diálogo nativo do sistema.

### Segurança e privacidade

- **CSP em desenvolvimento:** permite `'unsafe-inline'` em scripts por causa
  do recarregamento do Vite. Em produção, `script-src 'self'`.
- **`serverSharing`:** não pode ser concedido. Quando o envio ao Gerpro Web
  existir, a validação terá de ser alterada de forma deliberada, junto com o
  fluxo de consentimento.
- **Escopo de consentimento:** qualquer integração futura que leia dados
  reais do computador deve seguir o mesmo princípio: um escopo novo exige uma
  autorização nova.
- **Dados de hardware:** `hardware.json` fica no `userData` do usuário, sem
  cifra. Não contém identificadores pessoais nem números de série.
