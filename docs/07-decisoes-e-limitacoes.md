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
| D47 | 3.3.9 | Qualidade por atributo (`detected`/`estimated`/`unavailable`/`simulated`) em `provenance.quality`, coerente com os valores e a origem; `physicalCores` anulável; `hardware.json` v2 | Um atributo não obtido nunca aparece como detectado; a CPU não é descartada por falta de um dado |
| D48 | 3.3.9 | Migração v1 → v2 descarta perfil `local-detector` da v1, mantém o consentimento e regrava o arquivo na abertura, com cópia do original | Sem registro de como cada atributo foi obtido, qualificá-lo seria presumir; regravar evita repetir migração e cópia a cada abertura |
| D49 | 3.3.9 | Atributos de `cpu`, `memory`, `storage` e `os` anuláveis; seção `null` só sem nenhum atributo conhecido; `hardware.json` v3 com migração sem alteração de dados | Um atributo não identificado não pode apagar os outros; mudar a versão impede que o app v2 trate um perfil parcial como inválido e regrave os padrões |
| D50 | 3.3.9 | `gpus[].model` e `gpus[].sharedMemory` anuláveis; GPU sem nenhum atributo conhecido recusada; `hardware.json` v4 com migração sem alteração de dados; VRAM só conta como dedicada com `sharedMemory === false` | Uma GPU sem nome ou de classificação não comprovada precisa caber no perfil sem que se invente um valor; tratar o desconhecido como dedicado usaria a reserva do firmware de uma integrada como VRAM |
| D51 | 3.3.9 | VRAM pelo `qwMemorySize` do Registro, associada ao adaptador só pelo par PCI único dos dois lados; GPUs idênticas ficam sem VRAM | Valores iguais não provam qual registro é de qual placa; atribuir por posição poderia dar a VRAM da dedicada à integrada |
| D52 | 3.3.9 | `LocalHardwareDetector` isolado: sondagens independentes, cancelamento/prazo global rejeitam sem perfil (`DetectionAbortedError`), confiança derivada só da qualidade, volume medido fora do perfil | Uma falha parcial não pode apagar o resto; um resultado cancelado não deve parecer análise; o contrato não tem campo para o volume e o caminho completo pode revelar o nome do usuário |
| D53 | 3.3.9 | Análise interrompida (cancelamento, prazo global, resultado tardio) não grava nada e devolve `AppError('invalid-state')` com `details.aborted`; resultado só é gravado se a decisão de consentimento não mudou durante a análise | Um cancelamento não pode apagar o último perfil válido; um código novo exigiria mudar o IPC; uma nova autorização no meio não legitima uma coleta iniciada antes dela |
| D54 | 3.3.9 | Classificação dedicada/compartilhada pelo DXCore (`IsIntegrated`), lido por um executável auxiliar mínimo em C++ (executado pelo executor dedicado da D56, não mais pelo `CommandRunner`) (processo separado, argumentos fixos, protocolo JSON versionado e estrito, 64 bits em decimal, `description` opcional sanitizada só para exibição). **Revisada na 6C.1.2:** a associação DXCore ↔ Electron por LUID foi descartada (o `getGPUInfo('basic')` do Electron 45 não traz `luid`); com resposta válida e coerente, o DXCore é a fonte da lista de GPUs e cada GPU leva só atributos do próprio registro de adaptador; senão, a lista do Electron como hoje, com `sharedMemory: null`; o Registro só complementa a VRAM quando o par é único nas duas fontes, e valores divergentes deixam a VRAM indisponível. Listas nunca se misturam; nada por posição, nome ou fabricante. `sharedMemory` segue anulável no v4. Parser, regras e seleção em TypeScript (6C.2, `local/dxcore/`), testados só com dados simulados; sem executável, catálogo ou integração ao detector e ao serviço | É a única fonte local leve com indicação explícita de integrada e que diz quando o driver não informa; fabricante, nome, VRAM e ordem não comprovam a classificação (APUs informam a reserva da RAM como memória dedicada). Tirar todos os atributos de uma GPU do mesmo registro dispensa associar fontes que não têm chave comum; a alternativa pelo Electron garante que uma falha do DXCore não tire informação que já existe hoje |
| D55 | 3.3.9 | Diagnóstico manual com supervisor em Node: cria a pasta temporária exclusiva, inicia o Electron com ela, espera o encerramento completo e só então remove a pasta que criou (mesmo caminho, dispositivo e inode; sem seguir links); sem varredura por prefixo; falha de limpeza informada sem caminho | O Chromium grava caches e o `Local State` ao encerrar, depois de qualquer limpeza feita dentro do próprio Electron; limpar na execução seguinte por prefixo poderia apagar a pasta de outra execução em andamento. Encerramento forçado do supervisor ainda pode deixar a pasta |
| D56 | 3.3.9 | Auxiliar empacotado executado por um executor dedicado (`BundledHelperRunner`), não pelo `CommandRunner`: um único executável de nome, pasta (`<recursos>\helpers\win32-<arquitetura>`) e argumentos fixos; raiz definida só pelo Main; arquivo comum, sem link nem junção no caminho, tamanho limitado e SHA-256 igual ao valor embutido no código (hoje `null`: bloqueado), conferido de novo após a execução; sem shell, PATH, diretório ou ambiente do usuário; 3 s, 64 KiB/4 KiB, uma execução por vez; qualquer falha volta para Electron + Registro. Parser passa a exigir números na forma canônica | Estender o catálogo criaria a primeira exceção à regra "só pasta do sistema" no código que roda o PowerShell; o executor dedicado não tem entrada além do cancelamento. Um hash ao lado do executável não provaria nada; dentro do pacote, protege contra corrupção e troca casual, mas não contra quem escreve na pasta do app. TOCTOU entre verificação e execução, ACLs da pasta, assinatura Authenticode e processos descendentes exigem código nativo e ficam como riscos documentados |
| D57 | 3.3.9 | Código-fonte do auxiliar DXCore em C++17 com headers oficiais do SDK (sem interfaces declaradas à mão, sem dependências de terceiros), build de referência com MSVC v143 e Windows SDK 10.0.26100 (no Build Tools 2026, v143 pedido explicitamente; outros conjuntos de ferramentas recusados); proteções de carregamento obrigatórias com falha em 10, saída só em pipe (13), mais de 16 adaptadores em 12, `DriverDescription` só como UTF-8 válido; Job Object, `MicrosoftSignedOnly` e `ProhibitDynamicCode` não ativados | Nenhum código de saída novo: o parser e o fallback continuam iguais. Uma codificação não documentada não pode ser adivinhada. Com o job da libuv permitindo saída silenciosa, não está comprovado que um job aninhado bloqueie processos filhos: ativá-lo seria uma proteção sem efeito garantido; as duas políticas podem impedir componentes do driver e ficam para depois de um teste autorizado |
| D58 | 3.3.9 | Primeira execução real do auxiliar só pelo diagnóstico manual (modo `--confirm-dxcore-helper-read` do supervisor da D55): o executor de produção recebe, pela injeção `expectedSha256`, o hash do build aprovado fixo no diagnóstico; `DXCORE_HELPER_SHA256` do app continua `null`. Pré-condições (hash, tamanho, manifesto do build, PE, caminho sem link, sem elevação, nenhum outro processo do auxiliar, trava exclusiva) antes; uma única chamada, sem nova tentativa | Executar sem enfraquecer o executor nem liberar o app: o mesmo código de produção faz as verificações; só o valor esperado vem de fora, e só num script que o app não importa. Preencher o hash de produção agora liberaria o auxiliar para o app antes da validação real. Mecanismo novo: sujeito a revisão antes da execução |
| D59 | 3.3.9 | Integração estrutural do DXCore ao `LocalHardwareDetector`, sem ativação: dependência opcional `dxcore` (sem ela, detector idêntico); com ela, uma execução do auxiliar por coleta em paralelo com `probeGpus`, ambos com o sinal da etapa de GPU; Electron + Registro capturados por `captureGpuSources` (cada consulta no máximo uma vez, compartilhada com o diagnóstico manual); `selectGpuList` uma vez; qualquer falha ou recusa devolve o resultado atual. Diagnóstico interno `gpuSource` só com valores enumerados. Raiz por `resolveHelperResourcesRoot` (pura; empacotado: `resourcesPath`; desenvolvimento: `<appPath>\resources`). Serviço, hash (`null`), IPC, consentimento e empacotamento inalterados | Separar a estrutura da ativação permite provar a paridade do fallback e o cancelamento só com simulações, sem executar o auxiliar real nem liberar a detecção. Um ponto único de captura evita consultas duplicadas ao Registro e a divergência entre o que o diagnóstico mostra e o que o detector usa. Fim do orçamento da GPU aparece como `cancelled` na fonte DXCore (o executor não distingue o motivo do sinal) |
| D60 | 3.3.9 | Encerramento de processos informado só pelo que foi observado (`ProcessTermination`: `not-started`, `exited`, `stopped`, `exit-unconfirmed`, `kill-failed`); o fim da tolerância de 2 s nunca conta como encerramento. Após encerramento não confirmado, o executor do auxiliar não inicia outro processo (`previous-unconfirmed`) até o `close` do anterior. O detector registra `helperStop` (`helper-timeout`, `gpu-budget`, `cancelled`) e `helperProcess`; cancelamento do usuário e prazo global continuam rejeitando a coleta (`DetectionAbortedError`). Sem Job Object | Um processo que não confirmou o encerramento pode estar vivo: presumir o contrário esconderia órfãos e permitiria dois auxiliares ao mesmo tempo. Distinguir os motivos pelos sinais não muda o protocolo nem o fallback. Garantias sobre a árvore de processos, encerramento na saída do app e limites de recursos exigem Job Object (código nativo), fora desta etapa |
| D61 | 3.3.9 | Direção para conter o auxiliar DXCore (aprovação da 6C.6A, com ressalvas): launcher nativo separado (`gerpro-helper-host.exe`) que cria o auxiliar suspenso, já no Job Object (`PROC_THREAD_ATTRIBUTE_JOB_LIST`), sem caminho alternativo; instalação por máquina com NSIS; MSIX como alternativa futura; avaliação de certificado de assinatura; detector e hashes de produção inalterados. Validação técnica (6C.6B.1) em `docs/10-ativacao-dxcore.md`: política de filhos e job não são barreira contra um auxiliar comprometido do mesmo usuário (R15, aberto); TOCTOU do auxiliar reduzido, não eliminado | `child_process.spawn` só associa a um job depois de o processo já estar rodando; código nativo fora do processo principal mantém `superviseProcess` e a D60; afirmar mais do que a documentação e os testes sustentam criaria uma proteção presumida |
| D62 | 3.3.9 | Launcher `gerpro-helper-host.exe` implementado e compilado (6C.6B.2), sem execução e sem integração: argumentos fixos `--protocol 1 --helper-sha256 <hex>`, códigos 20–29, caminho do auxiliar só a partir da própria pasta, job sem nome com `KILL_ON_JOB_CLOSE`/`ACTIVE_PROCESS = 1`/`DIE_ON_UNHANDLED_EXCEPTION` e sem saída, criação suspensa com `JOB_LIST`, conferências e hash definitivo antes da única retomada. Lista explícita de importações conferida no build; ambiente MSVC compartilhado com o auxiliar (`msvc-toolchain.mjs`). Limite de memória **não** fixado (pendente de medição) e bloqueio de produção por `dxcoreHostBlockers` | Nenhum valor de limite sem medição; um único caminho de criação, testável; dois hashes independentes; a integração e os testes reais são etapas próprias |
| D63 | 3.3.9 | Artefatos só de teste do launcher (6C.6C.1), compilados e **não executados**: variante `gerpro-helper-host-test.exe` dos MESMOS fontes (`/DGERPRO_HOST_TEST_BUILD`), que muda só o nome do launcher, o alvo (`gerpro-synthetic-helper.exe`), a pasta (`host-test`) e exige um dos resumos sintéticos fixados no build; alvo sintético com um binário por cenário (número fixado no build, sem opção de execução), só `KERNEL32`, sem arquivos, rede, registro ou hardware, prazo próprio de 30 s e recusa fora do layout de testes. Saídas só em `native/helper-host/build/test/`; build de produção sem a variante e conferido por identidade | Testar a contenção sem o auxiliar real e sem mudar o protocolo de produção; cenário por binário evita argumentos novos; resumos fixados impedem que a variante execute o auxiliar DXCore mesmo renomeado; o launcher de produção recompilado ficou byte a byte igual |
| D64 | 3.3.9 | Supervisor dos testes de contenção (6C.6C.2A), sem execução de cenários: `run-host-containment.mjs` com plano, `--check-only` e execução só com `--group=A --confirm-host-containment-run`; hashes completos fixados em `APPROVED_ARTIFACTS` (o manifesto do build só é conferido), PE e identidade da variante, sem elevação, censo 0, trava exclusiva, pasta exclusiva da D55 com prefixo próprio, prazo global por caso, cada caso uma vez e parada no primeiro desvio. Sobreviventes encerram a bateria; só processos cuja identidade completa (PID, criação, caminho) aponta para um arquivo da bateria são encerrados, pelo PID, depois de reler a identidade; nunca por nome. Entrada Electron só de teste para o T-R1 | Executar os testes reais sem tocar processos alheios e sem repetição que esconda falhas intermitentes; o hash fixado no código impede que um build trocado seja testado como aprovado; o `hang` saiu do Grupo A por poder deixar processo ativo |
| D65 | 3.3.9 | Execução única do Grupo A (6C.6C.2B): T-E1 aprovado (10 casos; link simbólico pulado), T-H1.exit-ok **reprovado** com 28 e sem linha do alvo; bateria parada, limpeza completa, censo final 0. O 28 prova que `CreateProcessW` funcionou com o arquivo travado (H-F5) e que o alvo estava em J antes da retomada; a causa do 28 não está isolada. Hipótese H-C1: `conhost.exe` do alvo de console entra no job e esbarra em `ACTIVE_PROCESS = 1`; correção candidata `DETACHED_PROCESS`, não aplicada. Sobreviventes deixaram de ser encerrados automaticamente (identidade não garantida só com PID) | O desvio foi detectado antes de qualquer uso do auxiliar real; a correção muda o launcher de produção e precisa de evidência e aprovação próprias |
| D66 | 3.3.9 | Investigação da falha do T-H1 (6C.6C.2C): variante diagnóstica da de testes (registro em blocos `#if` próprios, porta de conclusão própria, sem `OpenProcess`, um único resumo aceito) e filtro do supervisor que só aceita `T-H1.exit-ok`. Execução única: 28 de novo, código bruto `0xC0000142` (STATUS_DLL_INIT_FAILED), J com total 1 e 0 encerrados em todos os momentos. O 28 vem de `MapHelperExit`; H-C1 (conhost em J excedendo o limite) refutada na forma enunciada; causa provável na criação do console novo (H-C2 política de filhos ou H-C3 limite antes da contagem), não isolada. Correção recomendada: `DETACHED_PROCESS`, a validar antes com a variante `diag/detached` já compilada | O launcher de produção e o de testes continuam byte a byte iguais (controle no build); nenhuma mudança na produção sem nova evidência e aprovação |
| D67 | 3.3.9 | Validação de `DETACHED_PROCESS` (6C.6C.2D): execução única da variante `diag/detached` (SHA-256 `16acca85…`) no T-H1.exit-ok, com variante explícita obrigatória no filtro e critérios de aprovação próprios. Aprovado: código bruto 0, launcher 0, linha do alvo pelo pipe, alvo em J antes da retomada (`1,1,0`), J com um único processo e nenhum encerrado, censo final 0, limpeza completa, 796 ms. Causa da falha do T-H1 confirmada (console novo de `CREATE_NO_WINDOW`); H-C1 refutada; H-C2/H-C3 abertas; H-F5 confirmada. Recomendação: `DETACHED_PROCESS` na produção | Mudança mínima e já validada com a contenção intacta; aplicar exige nova autorização, novo hash e repetição do Grupo A |
| D68 | 3.3.9 | Correção aplicada (6C.6C.2E): o launcher cria o auxiliar com `DETACHED_PROCESS` no lugar de `CREATE_NO_WINDOW`, em produção, testes e diagnóstico; o resto da sequência de contenção e os códigos 20–29 não mudaram. Novos SHA-256: produção `101c3b4a…9bc7`, testes `4b7f9c7f…2e26` (aprovado só no supervisor de testes). Variante `nowindow` retirada. Auxiliar DXCore inspecionado estaticamente: sem dependência de console | Elimina a causa confirmada na D67; hashes de produção continuam `null` e o Grupo A precisa ser repetido, com nova autorização |
| D69 | 3.3.9 | Reexecução única do Grupo A (6C.6C.2F) com o launcher de testes `4b7f9c7f…2e26`: 16 casos aprovados, 1 pulado (T-E1.helper-symlink, sem permissão para link simbólico), nenhum reprovado; T-H1.exit-ok com código 0; descendentes recusados (T-R2/T-R4); alvo em J sob Electron (T-R1, `0x2408`); censo final 0 e limpeza completa | Confirma a correção da D68 no fluxo completo do Grupo A; Grupo B e DXCore real continuam dependendo de nova autorização |
| D70 | 3.3.9 | Encerramento pelo supervisor (6C.6C.3A): filtro restrito `--terminate=T-K1.hang`. Execução única, aprovada: alvo `hang` anunciado em 799 ms; o launcher foi encerrado pelo próprio identificador 515 ms depois (pedido aceito); `exit` com `SIGTERM` e `close` 5 ms depois do pedido; o fim do alvo foi observado pelo fechamento do pipe, muito antes do prazo próprio dele (30 s). Censo logo depois, final e independente: 0; limpeza completa | `KILL_ON_JOB_CLOSE` demonstrado; demais casos do Grupo B (T-T1, T-K2, T-K3, T-F1…T-F4) e repetições dependem de nova autorização |
| D71 | 3.3.9 | Prazo interno do launcher (6C.6C.3B): filtro restrito `--launcher-timeout=T-T1.hang`, prazo externo de 5 s (o mesmo do Grupo A, maior que o pior caso de 4,5 s). Execução única, aprovada: alvo anunciado em 255 ms; o launcher saiu sozinho com 27 em 2266 ms (2011 ms depois da linha), sem intervenção do supervisor; `close` junto com o `exit`; censos 0; limpeza completa. O código 27 não distingue `TerminateJobObject` do recurso a `TerminateProcess` | Prazo interno demonstrado; separar os dois caminhos exige variante diagnóstica que aceite o `hang`; repetições e demais casos do Grupo B dependem de nova autorização |
| D72 | 3.3.9 | Repetibilidade (6C.6C.3C): modo restrito `--repeat` (só T-K1.hang e T-T1.hang, até 10× cada, sequencial, para na primeira falha, mesmos critérios das execuções isoladas). Lote único de 20 execuções, 20 aprovadas. T-K1: alvo encerrado 4–9 ms depois do pedido. T-T1: código 27 em todas, 1994–2027 ms depois da linha, sem intervenção. Censos 0 em todas e no fim; limpeza completa. Linha do alvo em até 890 ms (limite 1500 ms) | Os dois mecanismos de encerramento são estáveis com os artefatos sintéticos; T-K2, T-K3 e T-F1…T-F4 dependem de nova autorização |
| D73 | 3.3.9 | Revisão estática de T-F1…T-F4 (6C.6C.3D). O launcher fecha as travas do arquivo e das pastas no passo 13, antes da retomada; o Node não consegue segurar travas (abre sempre com compartilhamento total) nem criar mapeamentos. T-F3 cabe no roteiro do `hang` sem artefato novo. T-F1, T-F2 e T-F4 precisam de um processo que segure as travas; recomendado um binário só de teste com hash aprovado. Ordem proposta: T-F3, depois construção do binário, depois T-F1+T-F4, depois T-F2 | Nada implementado nem executado; cada passo depende de autorização própria |
| D74 | 3.3.9 | T-F3.hang (6C.6C.3E): filtro `--file-lock=T-F3.hang`, sem executável novo, e uma abertura `r+` (GENERIC_READ \| GENERIC_WRITE, compartilhamento total) na cópia do alvo em execução, 1 ms depois da linha, com o launcher ativo. Recusada com `EBUSY` (violação de compartilhamento); SHA-256 idêntico antes, depois e no fim; código 27 sem intervenção; censos 0; limpeza completa. H-F3 confirmada para o alvo em execução | O passo 12 (processo suspenso) não é observável sem a variante com pausa; T-F1, T-F2 e T-F4 dependem do processo que segura as travas e de nova autorização |
| D75 | 3.3.9 | Segurador de travas só de teste (6C.6C.3F): `gerpro-lock-holder-test.exe` em `native/lock-holder-test/`, com três modos fixos (`file`, `mapping`, `directory`) que repetem as aberturas dos passos 5 e 6 do launcher ou seguram uma seção gravável com o arquivo fechado; aceita só uma pasta de caso `gerpro-6c6c-*` dois níveis abaixo da pasta temporária do sistema, sem links nem junções, com caminho final conferido e arquivo de um só nome; prazo próprio de 10 s; só KERNEL32 com lista explícita; 114.176 bytes, SHA-256 `74a99a07…e359e0`, reproduzível; nunca distribuído | Construído e não executado; a integração ao supervisor (T-F1, T-F2, T-F4) depende de nova autorização |
| D76 | 3.3.9 | Integração estática do segurador ao supervisor (6C.6C.3G): `--file-lock=` aceita exatamente um de `T-F3.hang`, `T-F1.exit-ok` ou `T-F4.exit-ok`, com `--confirm-host-containment-run` ou `--check-only` e nada mais. Segurador registrado em `APPROVED_ARTIFACTS.lockHolder` (114.176 bytes, `74a99a07…e359e0`), conferido nas pré-condições e de novo na cópia logo antes do início; entra no censo. Revisão de segurança sem falha no nativo (binário inalterado); três exigências cumpridas no supervisor: identidade com `lstat` bigint, `TMP` = `TEMP` = pasta temporária resolvida, pasta atual e imagem do segurador fora de `host-test`. Tentativas uma vez cada, com guardas de caminho fixas; uma tentativa que funcione interrompe o cenário e só o objeto movido é restaurado (identidade conferida); liberação só pelo fechamento da entrada; encerramento só do segurador iniciado, pelo identificador | Nada executado; a primeira execução de T-F1 e T-F4 depende de nova autorização. T-F2 continua fora |

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
- **Auxiliar DXCore (D56):** a verificação de identidade e integridade não
  impede a troca do arquivo entre a verificação e o início do processo
  (TOCTOU), não confere as permissões da pasta nem a assinatura, e o
  encerramento não alcança processos filhos. O hash embutido protege contra
  corrupção e troca casual, não contra quem já escreve na pasta do app.
  Hoje o hash é `null` e o auxiliar nunca é executado.
