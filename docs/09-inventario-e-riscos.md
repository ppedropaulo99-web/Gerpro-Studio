# Inventário de funcionalidades e riscos

Estado verificado na Etapa H2 (preparação do handoff), sobre o commit
`7198e36` mais as alterações locais que acompanham a entrega. Verificação:
typecheck, `npm test` (1.565 testes; num clone limpo, 1.539 passam e 26 são
pulados) e `npm run build`, todos sem falha. A auditoria H1 conferiu cada
linha no código; uma tela existente, sozinha, não conta como evidência.

## Inventário

Classificação:

1. **Implementada:** opera de verdade, com dados reais e testes. Pode ter
   limitações, descritas na observação.
2. **Parcialmente implementada:** parte real, com lacunas relevantes.
3. **Simulada:** fluxo demonstrativo com dados fictícios, identificado na
   interface.
4. **Planejada:** existe só como contrato, ponto de extensão, tela
   informativa ou intenção; nenhum comportamento real.
5. **Ferramenta de diagnóstico:** código manual de engenharia, fora do app;
   nunca empacotado.
6. **Experimental desativada:** código real e testado, mas **desligado** do
   app e **não autorizado para produção**.

### Aplicativo

| Funcionalidade | Classificação | Evidência no código | Observação |
|---|---|---|---|
| Agentes | 1. Implementada | `AgentService`, `AgentEditor`, `tests/main/agents-integrity.test.ts` | Cadastro, editor, exemplos e proteção dos dados. Agentes conversam; não executam ferramentas nem agem sozinhos |
| Conversas | 1. Implementada | `ConversationService`, `tests/main/conversation-service.test.ts` | Persistentes e com contexto; sem resumo, memória, busca ou exportação |
| Execuções | 1. Implementada | `RunService`, `pages/RunsPage.tsx` | Monitoramento real, só da sessão: nada é gravado. Inclui demonstração simulada identificada |
| Provedores | 1. Implementada | `InferenceProvider`, `RunService`, `providers:list` | Contrato real com um provedor real e um simulado |
| Ollama | 1. Implementada | `engine/ollama/ollama-provider.ts`, `tests/main/ollama-provider.test.ts` | Só modelos já instalados, só em `127.0.0.1:11434`; não inicia o serviço nem baixa modelos |
| Persistência local | 1. Implementada | `VersionedStore`, `atomic-file.ts`, `tests/main/storage.test.ts` | Envelope versionado, migrações, escrita atômica, esquemas estritos |
| Consentimento de hardware | 1. Implementada | `HardwareAdvisorService`, `hardware.json` v4, `tests/main/hardware-advisor.test.ts` | Gravado e revogável; escopo concedido `demo-only`; `serverSharing` recusado pela validação |
| Dashboard (Início) | 2. Parcial | `pages/HomePage.tsx` lê agentes, execuções da sessão e configurações | Indicadores e atalhos reais; modelos carregados e tokens do dia ainda não existem |
| Modelos | 2. Parcial | `pages/ModelsPage.tsx`, `providers:list` | Lista real dos modelos instalados; a biblioteca é de exemplo e não há download |
| Ferramentas | 2. Parcial | `tools/catalog.ts`, `ToolRegistry` | Catálogo de 7 declarações é real; nenhuma tem executor nem controle de ativação |
| Permissões | 2. Parcial | `requestedPermissions`, `missingPermissions` | Registradas por agente e preservadas; não há concessão nem aplicação |
| Configurações | 2. Parcial | `SettingsService` | Tudo é gravado; só tema e nome têm efeito; privacidade bloqueada nos valores seguros |
| Desenvolvedor | 2. Parcial | `pages/DeveloperPage.tsx` | Informações do app reais; logs de exemplo; servidor local só como interface desativada |
| Avaliador de compatibilidade | 2. Parcial | `compatibility-evaluator.ts`, testado | Lógica pronta; no app só recebe perfis de demonstração |
| Hardware Advisor (recomendações) | 3. Simulada | `recommendations.ts`, `DemoHardwareDetector` (`source: 'demo'`, qualidade `simulated`) | Regras reais e testadas sobre perfis e biblioteca fictícios |
| Apresentação Guiada | 3. Simulada | `tour/`, `runs:start-demo` | Percorre as telas reais com execução simulada |
| Detecção de hardware no app | 4. Planejada | `services/index.ts` usa `UnimplementedLocalDetector`, que sempre responde indisponível | O detector real existe e está dormente (tabela seguinte) |
| Gerpro AI | 4. Planejada | `pages/ChatPage.tsx` não faz chamada ao Main | Tela informativa, controles desativados |
| Execução de ferramentas | 4. Planejada | `ToolExecutor` em `shared/tools.ts`, sem implementação | Nenhuma ferramenta chega ao modelo |
| Credenciais (`SecretVault`) | 4. Planejada | Implementado e testado, não instanciado em `createServices` | Nenhuma credencial é usada hoje |
| Plugins | 4. Planejada | `PluginManifest`, sem carregamento | Botão desativado em Ferramentas |
| Motor de inferência próprio | 4. Planejada | `kind: 'embedded'` no contrato | Tecnologia não decidida |
| Integração Gerpro.com | 4. Planejada | Só o consentimento `serverSharing`, que não pode ser concedido, e propostas na documentação | Sem cliente, endpoints, autenticação nem contratos |
| Motor de personalização | 4. Planejada | Nenhum código | Metadados, layouts, regras, workflows, publicação e auditoria: escopo da equipe |
| Benchmark | 4. Planejada | Nenhum código | `tested-compatible` existe como estado, sem produtor |
| Integração VS Code | 4. Planejada | Nenhum código; só registro no roadmap | |
| Empacotamento e atualização | 4. Planejada | Sem configuração | Só desenvolvimento e build local; sem ícone próprio |

### Fora do aplicativo

Nada desta tabela é importado pelo app (só `src/main/hardware/local/` se
referencia), nem aparece em `out/`. Testes de fonte conferem isso.

| Componente | Classificação | Evidência no código | Observação |
|---|---|---|---|
| Detector local de hardware (CPU, memória, SO, disco, GPU) | 6. Experimental desativada | `src/main/hardware/local/local-hardware-detector.ts`, `probes/*`, `tests/main/local-hardware-detector.test.ts` | **Dormente.** Para ligar: trocar o detector em `createServices`, conceder o escopo `device-detection` e criar uma tela de consentimento nova ([Hardware README](../src/main/hardware/README.md)) |
| Auxiliar DXCore (`gerpro-dxcore-helper.exe`) | 6. Experimental desativada | `native/dxcore-helper/`, `bundled-helper.ts` (`DXCORE_HELPER_SHA256 = { x64: null, arm64: null }`) | **Não autorizado para produção.** Com hash `null`, o executor recusa (`integrity-unknown`). Binário fora do Git |
| Launcher com Job Object (`gerpro-helper-host.exe`) | 6. Experimental desativada | `native/helper-host/`, `dxcore-host-contract.ts` (`DXCORE_HOST_SHA256 = { x64: null, arm64: null }`, `DXCORE_HOST_JOB_MEMORY_LIMIT_BYTES = null`) | **Não autorizado para produção.** Nunca executado pelo app; bloqueado também por `memory-limit-pending` |
| Diagnóstico manual de hardware | 5. Diagnóstico | `scripts/diagnostics/run-hardware-diagnostic.mjs`, `hardware-diagnostic.mjs` | Só com flags `--confirm-*`; roda em pasta temporária própria |
| Supervisor de testes de contenção | 5. Diagnóstico | `scripts/diagnostics/run-host-containment.mjs`, `host-containment/*` | Só com `--confirm-host-containment-run`; usa os artefatos de teste, nunca o DXCore real |
| Segurador de travas (`gerpro-lock-holder-test.exe`) | 5. Diagnóstico | `native/lock-holder-test/`, `host-containment/lock-holder.ts` | **Só de teste; nunca executado; não autorizado para produção** |
| Launcher de testes e alvos sintéticos | 5. Diagnóstico | `native/helper-host/test-artifacts/`, `scripts/native/build-host-test-artifacts.mjs` | Variante de build com outros nomes; histórico em [docs/11](11-testes-contencao.md) |
| Builds MSVC e inspeção de PE | 5. Diagnóstico | `scripts/native/*` | Exigem MSVC v143; gravam só em `native/*/build/` (ignorado) |

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
| Origem confiável ampla | `isAppUrl` (`env.ts`) aceita qualquer URL `file:` como origem do app, e a navegação para `file:` é permitida | Um HTML local carregado na janela passaria pela checagem do IPC | Sem evidência: o app só carrega o próprio `index.html` e bloqueia novas janelas | Restringir ao `index.html` do build antes de incorporar módulos web | Média |
| Estilos inline na CSP | `style-src 'unsafe-inline'` em produção | Superfície maior se houver injeção de HTML | Sem evidência; `script-src 'self'` continua restrito | Avaliar remoção | Baixa |

### Funcionalidades planejadas

| Funcionalidade | Descrição | Impacto da ausência | Mitigação atual | Ação futura | Prioridade |
|---|---|---|---|---|---|
| Integração Gerpro.com | Identidade, organizações, permissões, APIs e módulos web | Studio opera isolado | Arquitetura preparada, sem contratos | Equipe define os contratos reais | Alta |
| Motor de personalização | Metadados de telas e campos, layouts, regras, workflows, validação, publicação e auditoria | Sem personalização | Padrões de validador e `Result<T>` servem de molde | Equipe desenha e implementa | Alta |
| Empacotamento | Instalador e atualização | Distribuição impossível | Execução em desenvolvimento | Definir ferramenta, assinatura e ícone | Alta |
| Ferramentas e permissões | Executores e concessão | Agentes só conversam | Avisos em Agentes e Conversas | Implementar com validação no Main | Alta |
| Detecção de hardware | Ligar o detector local dormente ao app | Recomendações são demonstrativas | Selo e avisos | Novo consentimento (`device-detection`) e tela, conforme `src/main/hardware/README.md`; DXCore só depois dos critérios da [docs/10 §7](10-ativacao-dxcore.md#7-critérios-objetivos-para-liberar-a-ativação-6c8) | Média |
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
| Testes que leem builds nativos | 26 testes só rodam com os binários compilados localmente (MSVC), que ficam fora do Git | Num clone limpo, aparecem como pulados | Os demais testes cobrem a lógica com binários simulados | Gerar os builds numa máquina de engenharia, se a linha DXCore for retomada | Baixa |
| Sem CI, lint ou formatação | Nada roda automaticamente a cada alteração | Regressão só aparece quando alguém roda os testes | `npm test`, `typecheck` e `build` documentados | Configurar CI com os três comandos (sem os supervisores de diagnóstico) | Média |

### Componentes desativados e de diagnóstico

| Risco | Descrição | Impacto | Mitigação atual | Ação futura | Prioridade |
|---|---|---|---|---|---|
| Ativação acidental do DXCore | Alguém preenche um hash de produção ou liga o detector local | Processo nativo não aprovado rodaria no computador do usuário | Hashes e limite de memória `null`; `UnimplementedLocalDetector`; escopo `demo-only`; testes de fonte | Tratar como decisão de ativação, com revisão e os critérios da docs/10 §7 | Alta |
| Binários na entrega | A pasta local contém `.exe` em `resources/helpers/` e `native/*/build/` | Executáveis não aprovados circulariam | `.gitignore` bloqueia `*.exe`, `*.obj`, `*.pdb` e as pastas de build | Entregar só por clone do repositório | Alta |
| Supervisores em automação | `scripts/diagnostics/` inicia processos nativos de teste | Execução fora do ambiente controlado | Só com flags de confirmação explícitas | Não incluir em CI | Média |
| Volume do histórico | docs/10 e docs/11 somam ~2.900 linhas de engenharia nativa | Confusão sobre o que está ativo | [Guia de transferência](12-guia-de-transferencia.md) e este inventário | Ler só ao retomar a linha de hardware | Baixa |

### Decisões arquiteturais pendentes

| Decisão | Descrição | Impacto | Responsável | Prioridade |
|---|---|---|---|---|
| Contratos do Gerpro.com | Autenticação, ambientes, versionamento e APIs | Define toda a integração | Equipe de integração | Alta |
| Modelo de personalização | Como metadados, layouts e regras são representados, validados, publicados e auditados | Define o motor de personalização | Equipe Cognitiva e produto | Alta |
| Ativação da detecção real | Ligar ou não o detector local e, depois, o DXCore | Privacidade, empacotamento e assinatura | Produto e equipe técnica | Média |
| Criptografia das conversas | Hoje gravadas em texto claro no `userData` | Privacidade em máquinas compartilhadas | Produto e equipe técnica | Média |
| Contêiner de módulos web | Como incorporar módulos com segurança | Exige revisar CSP e `isAppUrl` | Equipe de integração | Alta |
| Runtime do motor próprio | Biblioteca, processo auxiliar ou remoto | Empacotamento e isolamento | Equipe técnica | Média |
| Persistência de execuções | Gravar ou não, e por quanto tempo | Privacidade e auditoria | Produto e equipe técnica | Média |
| Proteção dos demais arquivos | `settings.json` e `hardware.json` regravam após copiar o inválido; conversas têm política própria | Consistência entre arquivos | Equipe técnica | Baixa |
| Política de rascunhos | Permitir ou não conversar | Regra de produto | Produto | Baixa |
