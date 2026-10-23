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

## Limitações conhecidas

### Funcionais

- Não há inferência, download de modelos nem chat real. As telas Chat,
  Modelos, Início e Desenvolvedor usam dados de exemplo.
- Nenhuma ferramenta executa. Todas aparecem como `not-implemented`.
- Nenhum agente fica `available`, porque falta o motor.
- Execuções são só simuladas e se perdem ao fechar o app.
- As preferências são gravadas, mas não têm efeito. As de privacidade e
  segurança (confirmação de ferramentas sensíveis e telemetria) nem podem ser
  alteradas.
- A proteção de alterações não salvas cobre a navegação pelo app (barra
  lateral e atalhos internos). Fechar a janela ou sair do aplicativo descarta
  as alterações sem perguntar.
- Os interruptores da tela Ferramentas não são gravados: são só estado visual
  da tela. `settings.tools.enabled` existe, mas nenhuma tela o altera.
- A detecção real de hardware não existe. O botão sempre leva a
  "indisponível".
- Requisitos e tipos de tarefa só existem nos agentes de exemplo. Agentes
  salvos são avaliados por estimativa do modelo ou ficam com tarefa
  "desconhecida".
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
