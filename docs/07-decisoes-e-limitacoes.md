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

## Limitações conhecidas

### Funcionais

- Não há inferência, download de modelos nem chat real. Chat, Modelos e os
  logs do Desenvolvedor usam dados de exemplo, identificados com o selo
  "Exemplo". No Início, modelos carregados e tokens aparecem como
  "Planejado", sem valor.
- Nenhuma ferramenta executa. Todas aparecem como `not-implemented`.
- Nenhum agente fica `available`, porque falta o motor.
- Execuções são só simuladas e se perdem ao fechar o app.
- As preferências são gravadas, mas, exceto o tema, não têm efeito. As de
  privacidade e segurança (confirmação de ferramentas sensíveis e telemetria)
  nem podem ser alteradas.
- O tema não acompanha o tema do sistema operacional, e "Descartar" ou sair
  sem salvar não o revertem (ver D27).
- A paleta clara é uma proposta inicial inspirada no Gerpro Web, não as cores
  oficiais. Não havia tokens institucionais no projeto. Alguns tons foram
  escurecidos para atingir contraste AA.
- `settings.json` passou à versão 2. Uma versão anterior do app que abra esse
  arquivo o trata como "mais novo": usa os padrões e não grava.
- A proteção de alterações não salvas cobre a navegação pelo app (barra
  lateral e atalhos internos). Fechar a janela ou sair do aplicativo descarta
  as alterações sem perguntar.
- A tela Ferramentas só exibe o catálogo; não há controle de ativação.
  `settings.tools.enabled` existe, mas nenhuma tela o altera.
- A detecção real de hardware não existe. O botão sempre leva a
  "indisponível".
- Requisitos só existem nos agentes de exemplo. Agentes salvos já guardam
  tipos de tarefa (`taskTypes`), mas a tela ainda não os edita; sem eles, a
  tarefa fica "desconhecida" nas recomendações.
- `agents.json` passou à versão 2. Uma versão anterior do app que abra o
  arquivo regravado o trata como "mais novo": usa os padrões e não grava.
- Os contratos de inferência local (provedores, perfis, compatibilidade e
  execução real) existem, mas não há provedor nem canal IPC de execução
  real. O avaliador de compatibilidade e a recomendação de alternativas
  (`compatibility-evaluator.ts`) existem e são testados, mas nada na
  interface ou no Main os chama ainda.
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
  - `digest` dos modelos só existirá quando um provedor real preencher o
    inventário (lote do primeiro provedor de inferência).
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
- Não há empacotamento, instalador nem atualização automática.
- Não há lint configurado. A qualidade é verificada por `typecheck` estrito e
  testes.
- **Testes de interface:** os testes cobrem contratos, serviços e a lógica
  pura da interface. As telas React não têm testes automatizados, e a
  verificação visual foi manual (via DevTools Protocol, fora do repositório).

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
