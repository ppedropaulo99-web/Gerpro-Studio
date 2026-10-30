# Inventário de funcionalidades e riscos

Estado verificado no encerramento técnico do Lote 3.3.8, sobre o commit
`f68f2b2` mais as alterações locais do lote.

## Inventário

Classificação:

1. **Implementada e funcional:** opera de verdade, com dados reais.
2. **Parcial:** parte real, com lacunas relevantes.
3. **Simulada:** fluxo demonstrativo com dados fictícios, identificado.
4. **Apenas interface:** tela ou controle sem comportamento por trás.
5. **Planejada:** existe como contrato, ponto de extensão ou intenção.
6. **Não implementada:** não há nada além de uma eventual menção.

Uma interface existente não significa integração funcional: a coluna
"Evidência" diz o que sustenta cada classificação.

| Funcionalidade | Classificação | Evidência no código | Observação |
|---|---|---|---|
| Dashboard (Início) | 2. Parcial | `pages/HomePage.tsx` lê agentes, execuções da sessão e configurações | Indicadores e atalhos reais; modelos carregados e tokens do dia ainda não existem |
| Agentes | 1. Implementada e funcional | `AgentService`, `AgentEditor`, `tests/main/agents-integrity.test.ts` | Cadastro, editor, exemplos e proteção dos dados. Agentes conversam; não executam ferramentas nem agem sozinhos |
| Modelos | 2. Parcial | `pages/ModelsPage.tsx`, `providers:list` | Lista real dos modelos instalados; a biblioteca é de exemplo e não há download |
| Conversas | 1. Implementada e funcional | `ConversationService`, `tests/main/conversation-service.test.ts` | Persistentes e com contexto; sem resumo, memória, busca ou exportação |
| Execuções | 1. Implementada e funcional | `RunService`, `pages/RunsPage.tsx` | Monitoramento real, só da sessão: nada é gravado. Inclui demonstração simulada identificada |
| Gerpro AI | 4. Apenas interface | `pages/ChatPage.tsx` não chama o motor | Tela informativa do futuro assistente, com controles desativados |
| Ferramentas | 2. Parcial | `tools/catalog.ts`, `ToolRegistry` | Catálogo de 7 declarações é real; nenhuma tem executor nem controle de ativação |
| Execução de ferramentas | 5. Planejada | `ToolExecutor` em `shared/tools.ts`, sem implementação | Nenhuma ferramenta chega ao modelo |
| Permissões | 2. Parcial | `requestedPermissions`, `missingPermissions` | Registradas por agente e preservadas; não há concessão nem aplicação |
| Provedores | 1. Implementada e funcional | `InferenceProvider`, `RunService`, `providers:list` | Contrato real com um provedor real e um simulado |
| Ollama | 1. Implementada e funcional | `engine/ollama/ollama-provider.ts`, `tests/main/ollama-provider.test.ts` | Só modelos já instalados, em endereço fixo; não inicia o serviço nem baixa modelos |
| Integração Gerpro Web | 6. Não implementada | Só o consentimento `serverSharing`, que não pode ser concedido, e propostas na documentação | Sem cliente, endpoints ou autenticação |
| Detecção de hardware | 5. Planejada | `HardwareDetector`; `UnimplementedLocalDetector` sempre responde indisponível | Consentimento real; análise só com cenários fictícios |
| Hardware Advisor (recomendações) | 3. Simulada | `recommendations.ts` com perfis e biblioteca fictícios | Regras reais e testadas sobre entradas de demonstração |
| Avaliador de compatibilidade | 5. Planejada | `compatibility-evaluator.ts`, testado, sem chamador | Lógica pronta, não ligada a dados reais |
| Benchmark | 6. Não implementada | Nenhum código | `tested-compatible` existe como estado, sem produtor |
| Integração VS Code | 6. Não implementada | Nenhum código; só registro no roadmap | |
| Motor de inferência próprio | 5. Planejada | `kind: 'embedded'` no contrato | Tecnologia não decidida |
| Plugins | 5. Planejada | `PluginManifest`, sem carregamento | Botão desativado em Ferramentas |
| Credenciais (`SecretVault`) | 5. Planejada | Implementado e testado, não instanciado | Nenhuma credencial é usada hoje |
| Configurações | 2. Parcial | `SettingsService` | Tudo é gravado; só tema e nome têm efeito; privacidade bloqueada nos valores seguros |
| Desenvolvedor | 2. Parcial | `pages/DeveloperPage.tsx` | Informações do app reais; logs de exemplo; servidor local só como interface desativada |
| Apresentação Guiada | 3. Simulada | `tour/`, `runs:start-demo` | Percorre as telas reais com execução simulada |
| Empacotamento e atualização | 6. Não implementada | Sem configuração | Só desenvolvimento e build local |

## Riscos e pendências

Nas tabelas, "Probabilidade" só traz estimativa quando há evidência; caso
contrário, diz "sem evidência".

### Defeitos confirmados

Nenhum defeito confirmado permanece aberto. Os defeitos encontrados na
homologação do Lote 3.3.8 foram corrigidos e estão em
[Etapas](01-etapas.md#lote-338-agentes-configuráveis-e-integridade-dos-dados).

### Limitações intencionais

Comportamentos decididos; não são defeitos.

| Limitação | Descrição | Impacto | Probabilidade | Mitigação atual | Ação futura | Prioridade |
|---|---|---|---|---|---|---|
| Rascunho conversa | Conversas aceitam agente em rascunho | Agente incompleto pode responder sem orientação | Certa quando escolhido | Rótulo "(rascunho)" e observações | Reavaliar a política com o produto | Baixa |
| Armazenamento protegido | `agents.json` inválido bloqueia alterações, sem reparo automático | Usuário não edita agentes até corrigir o arquivo | Sem evidência | Aviso, leitura preservada, cópia e [procedimento manual](02-arquitetura.md#procedimento-manual-de-diagnóstico) | Criar reparo assistido | Média |
| Agente indisponível na conversa | Conversa não troca de agente nem envia sem ele | Conversa fica só para leitura | Certa ao excluir o agente | Histórico preservado e aviso | Avaliar exportação ou troca explícita | Baixa |
| Cancelar no editor | "Cancelar" descarta sem pedir confirmação; a confirmação cobre a navegação | Perda do que foi digitado por ação explícita | Sem evidência | Ação com rótulo claro | Avaliar confirmação | Baixa |
| Fechar o app | Fechar a janela descarta edições pendentes | Perda do que não foi salvo | Sem evidência | Documentado | Adicionar confirmação | Baixa |
| Execuções só em memória | Até 100 por sessão | Detalhes técnicos somem ao fechar | Certa | Conversa guarda texto e modelo | Decidir persistência | Média |
| Contexto estimado | 3 caracteres por token, sem medição | Motor pode descartar contexto sem avisar | Sem evidência | Recorte conservador e registro por resposta | Contagem real de tokens | Média |
| Capacidade desconhecida | Modelo que não declara capacidades é aceito | Pode falhar na geração | Sem evidência | O motor responde com erro explicado | Consultar capacidades do provedor | Baixa |
| Tempo limite | Vale para a geração inteira | Respostas longas em CPU podem ser cortadas | Observada: ~5 tokens/s em CPU na homologação do Lote 3.3.7 | Limite ajustável por agente | Revisar o padrão | Baixa |
| Seletor durante a verificação | Enquanto os modelos são consultados, o seletor desativado de Conversas mostra "Nenhum modelo disponível" | Texto impreciso por instantes; com motor lento, por segundos | Certa com motor lento | Controle desativado e nada é enviado | Mostrar um estado de verificação | Baixa |
| Teclado no menu | Sem navegação por setas; Tab percorre os itens e o menu segue aberto até Esc | Navegação menos fluida | Certa | Enter, Tab e Esc funcionam | Adotar o padrão ARIA de menu | Baixa |
| Exclusão de agente | Usa o diálogo nativo `window.confirm` | Visual diferente do app | Certa | Funciona por teclado | Usar o `Dialog` do app | Baixa |

### Funcionalidades planejadas

| Funcionalidade | Descrição | Impacto da ausência | Mitigação atual | Ação futura | Prioridade |
|---|---|---|---|---|---|
| Integração Gerpro Web | APIs e módulos web | Studio opera isolado | Arquitetura preparada, sem contratos | Equipe define os contratos reais | Alta |
| Empacotamento | Instalador e atualização | Distribuição impossível | Execução em desenvolvimento | Definir ferramenta, assinatura e ícone | Alta |
| Ferramentas e permissões | Executores e concessão | Agentes só conversam | Avisos em Agentes e Conversas | Implementar com validação no Main | Alta |
| Detecção de hardware | Detector real | Recomendações são demonstrativas | Selo e avisos | Seguir `src/main/hardware/README.md` | Média |
| Download de modelos | Instalação assistida | Depende do Ollama externo | Mensagens orientam | Definir origem e licenças | Média |
| Motor próprio | Provedor `embedded` | Depende do Ollama | Provedor substituível | Decidir runtime | Média |
| Benchmark | Medição real | Sem testes de compatibilidade | Estimativas identificadas | Definir metodologia | Baixa |
| Integração VS Code | Extensão opcional | Nenhum | Não há | Definir escopo | Baixa |
| Gerpro AI | Assistente interno | Tela informativa | Selo "Em desenvolvimento" | Definir escopo | Média |

### Lacunas de teste

| Lacuna | Descrição | Impacto | Mitigação atual | Ação futura | Prioridade |
|---|---|---|---|---|---|
| Telas React | Sem renderização automatizada de componentes | Regressão visual ou de interação passa nos testes | Lógica pura testada, regex no fonte e homologação manual | Adotar testes de componente | Média |
| Homologação não versionada | Scripts de CDP ficam fora do repositório | Difícil repetir | Isolamento descrito no Handoff | Versionar testes de ponta a ponta | Média |
| Homologação em área de trabalho em uso | Janela minimizada durante a medição para os frames e congela transições; roteiros sem proteção relatam falso contraste e captura sem resposta | Falso negativo na homologação, sem efeito no app | Verificar visibilidade, frames e transições antes de medir | Levar a verificação para os testes versionados; rodar em sessão dedicada | Média |
| Modelo ambíguo no Electron | Só um provedor real existe | Tela não exercitada nesse estado | Testes automatizados em `tests/shared/inference.test.ts` e `tests/renderer/agent-status.test.ts` | Homologar ao adicionar um provedor | Baixa |
| Ollama real na homologação final | A homologação final usou Ollama simulado por HTTP | Mudança de versão real pode divergir | Inferência real validada nos Lotes 3.3.6 e 3.3.7 | Teste de fumaça com Ollama real | Média |
| Outras plataformas | Só Windows 11 | Comportamento desconhecido | Código sem dependência de plataforma, salvo `scripts/windows/` | Validar macOS e Linux, se forem alvo | Conforme decisão |
| Disco cheio e permissões reais | Falhas simuladas por injeção ou diretório no lugar do arquivo | Mensagem do sistema pode variar | Testes em `tests/main/storage.test.ts` | Teste manual em ambiente controlado | Baixa |
| Build empacotado | Só o `out/` local foi executado | Caminhos e `userData` podem mudar | Não há empacotamento | Homologar ao criar o instalador | Alta quando existir |

### Decisões arquiteturais pendentes

| Decisão | Descrição | Impacto | Responsável | Prioridade |
|---|---|---|---|---|
| Contratos do Gerpro Web | Autenticação, ambientes, versionamento e APIs | Define toda a integração | Equipe de integração | Alta |
| Contêiner de módulos web | Como incorporar módulos com segurança | Exige revisar CSP e `isAppUrl` | Equipe de integração | Alta |
| Runtime do motor próprio | Biblioteca, processo auxiliar ou remoto | Empacotamento e isolamento | Equipe técnica | Média |
| Persistência de execuções | Gravar ou não, e por quanto tempo | Privacidade e auditoria | Produto e equipe técnica | Média |
| Proteção dos demais arquivos | `settings.json` e `hardware.json` regravam após copiar o inválido; conversas têm política própria | Consistência entre arquivos | Equipe técnica | Baixa |
| Política de rascunhos | Permitir ou não conversar | Regra de produto | Produto | Baixa |
