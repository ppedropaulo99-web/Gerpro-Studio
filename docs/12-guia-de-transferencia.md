# Guia de transferência para a equipe Cognitiva

Leitura de entrada e **guia técnico de continuidade** para quem assume o
Gerpro Studio. É curto de propósito: os detalhes ficam nos documentos
indicados na seção 5.

Estado descrito: commit `6996e55` da `main` (handoff). O inventário
verificável está em [Inventário e riscos](09-inventario-e-riscos.md).

Pacote de transferência:

| Documento | Para quê |
|---|---|
| [Visão do produto](13-visao-do-produto.md) | Visão funcional, público, proposta de valor, existente × planejado |
| Este guia | Continuidade técnica: arquitetura, tecnologias, repositório, execução, testes, build, componentes desativados, limitações |
| [Roadmap de engenharia](14-roadmap-de-engenharia.md) | Sequência proposta de implementação, sujeita à validação da Cognitiva |
| [Checklist de transferência](15-checklist-de-transferencia.md) | Acesso, execução, demonstração, responsáveis, pendências e aceite |

## 1. Objetivo e visão

### Visão do produto (alvo)

O Gerpro Studio é o **ambiente DIY/low-code de personalização do ecossistema
Gerpro**. Ele se destina a **usuários comuns e técnicos**, que vão poder,
sem depender de desenvolvimento sob medida:

- incluir e configurar campos;
- personalizar telas e layouts;
- criar workflows e regras de negócio;
- validar as alterações, controlar quem pode fazê-las (permissões) e
  publicá-las de forma controlada, com auditoria.

Os **agentes de IA** são um **módulo complementar** dessa visão: ajudam o
usuário a personalizar e a operar, mas não são a finalidade exclusiva do
produto.

### O que existe hoje (protótipo)

**O que é entregue:** um **protótipo de referência funcional** da base
desktop (Electron) e do **módulo de agentes de IA**. Ele traz arquitetura,
contratos, segurança do Electron, persistência local e inferência local real
pelo Ollama: o usuário configura agentes e conversa com modelos executados
**neste computador**.

**Nenhuma funcionalidade de personalização está implementada.** Inclusão de
campos, telas e layouts, workflows, regras, validação, permissões e
publicação são **planejadas**. O protótipo também não é um produto pronto
para distribuição: não há instalador, integração com servidores nem execução
de ferramentas.

**O que a equipe Cognitiva desenvolve a partir daqui:**

- a **integração com o Gerpro.com**: identidade, organizações, permissões e
  APIs;
- o **motor de personalização**: metadados de telas e campos, layouts, regras,
  workflows, validação e publicação de customizações, auditoria;
- a engenharia de produto: empacotamento, atualização, executores de
  ferramentas e as demais funcionalidades planejadas.

Nenhum contrato do Gerpro.com existe neste repositório, e nenhum deve ser
presumido a partir dele.

## 2. Versões e ferramentas

| Ferramenta | Versão | Obrigatória? |
|---|---|---|
| Windows 11 x64 | único sistema exercitado | Sim, hoje (macOS e Linux não foram testados) |
| Node.js | ≥ 22.12 para rodar; **≥ 22.18 para `npm test`** (remoção de tipos nativa). Verificado com 24.22.1 | Sim |
| npm | ≥ 10 (verificado com 11.19.1) | Sim |
| Git | qualquer versão recente | Sim |
| Ollama | atual, em `127.0.0.1:11434`, com algum modelo de conversa baixado | Não: sem ele o app abre, mas Conversas não envia |
| MSVC v143 + Windows SDK 10.0.26100 | só para recompilar os nativos de `native/` | Não: o app não usa nada nativo |

Dependências do app (lockfile v3): Electron 45, React 19, TypeScript 7,
Vite 8 via electron-vite 6 e `lucide-react`. Não há servidor, banco de dados
nem variável de ambiente obrigatória. O `package.json` ainda não declara
`engines`.

## 3. Instalar, executar, testar e gerar o build

```bash
git clone <repositório> && cd gerpro-studio
npm install        # também baixa o binário do Electron (postinstall)
npm run dev        # app em desenvolvimento, com recarregamento da interface
npm test           # testes automatizados (node:test)
npm run typecheck  # tipos de Main/Preload, Renderer e testes
npm run build      # typecheck + build de produção em out/
npm run preview    # roda o build de produção localmente
```

- Se `npm run dev` falhar com `Electron uninstall`: `npx install-electron`.
- **Testes num clone limpo:** 1.539 passam e 26 são **pulados**. Os pulados
  só leem binários nativos compilados localmente (hash, cabeçalho PE), e
  esses binários nunca entram no Git. Numa máquina com os builds locais, os
  1.565 passam. Nenhum teste executa binário nativo.
- No Windows, `scripts\windows\install-shortcuts.ps1` cria atalhos para o
  modo de desenvolvimento (ver [`README.md`](../README.md)).
- Dados do app: `%APPDATA%\Gerpro Studio\storage`. Para testes manuais de
  falha, use um `userData` isolado ([Handoff §3](08-handoff.md#3-executar)).

## 4. Arquitetura e módulos principais

```text
Renderer (React, sem Node) ──window.gerpro──▶ Preload (24 funções) ──IPC──▶ Main (Node + Electron)
                                                                          ├─ services/  agentes, conversas, configurações
                                                                          ├─ runs/      fila, cancelamento, prazo
                                                                          ├─ engine/    provedor Ollama (só loopback)
                                                                          ├─ storage/   JSON versionado, escrita atômica, cofre
                                                                          ├─ tools/     catálogo declarado
                                                                          └─ hardware/  consentimento + detector de demonstração
src/shared/  contratos e validadores puros (sem React, Electron nem Node)
```

| Módulo | Onde | O que faz |
|---|---|---|
| Montagem dos serviços | `src/main/services/index.ts` (`createServices`) | Liga todos os serviços; não importa o Electron, por isso roda nos testes |
| Segurança do Electron | `src/main/window.ts`, `security.ts`, `env.ts`, `ipc.ts` | `contextIsolation`, `sandbox`, CSP, remetente confiável, permissões negadas |
| IPC | `src/shared/ipc.ts`, `src/main/ipc-handlers.ts`, `src/preload/index.ts` | Canais declarados num só lugar; aridade e conteúdo validados no Main; `Result<T>` |
| Agentes | `src/main/services/agent-service.ts`, `src/shared/agents.ts` | Cadastro, validação, disponibilidade, proteção do arquivo |
| Conversas | `src/main/services/conversation-service.ts`, `src/shared/conversations.ts` | Conversas gravadas e recorte de contexto |
| Execuções | `src/main/runs/` | Fila, cancelamento, prazo, resolução do modelo |
| Inferência | `src/main/engine/` | `InferenceProvider`; Ollama real e provedor simulado |
| Persistência | `src/main/storage/` | `VersionedStore` (migrações, esquemas estritos), `SecretVault` |
| Hardware Advisor | `src/main/hardware/`, `src/shared/hardware.ts`, `recommendations.ts` | Consentimento real; análise só com perfis fictícios |
| Interface | `src/renderer/src/` | Rotas, telas, componentes, lógica pura em `lib/` |

**Fora do app (não empacotar, não ligar):**

| Pasta | O que é |
|---|---|
| `src/main/hardware/local/` | Detector local real: CPU, memória, SO, disco, GPU e DXCore. **Dormente**: nenhum módulo do app o importa |
| `native/dxcore-helper/`, `native/helper-host/` | Fontes C++ do auxiliar DXCore e do launcher com Job Object. **Experimentais e desativados** |
| `native/lock-holder-test/`, `native/helper-host/test-artifacts/` | Fontes de artefatos só de teste |
| `scripts/diagnostics/` | Supervisores de diagnóstico manual e de testes de contenção |
| `scripts/native/` | Builds MSVC e inspeção de PE dos nativos |

## 5. Sequência recomendada de leitura

1. Este guia e a [Visão do produto](13-visao-do-produto.md).
2. [`README.md`](../README.md): visão rápida, scripts e segurança.
3. [Inventário e riscos](09-inventario-e-riscos.md): o que é real, simulado,
   parcial, planejado, de diagnóstico ou desativado.
4. [Handoff](08-handoff.md): ambiente, serviços, como adicionar
   funcionalidades, erros comuns e extensão para o Gerpro Web.
5. [Arquitetura](02-arquitetura.md) e [Contratos](03-contratos.md).
6. [Pontos de integração](06-pontos-de-integracao.md), em especial os itens
   6 e 7 (Gerpro Web).
7. [Decisões e limitações](07-decisoes-e-limitacoes.md), como consulta.
8. [Roadmap de engenharia](14-roadmap-de-engenharia.md) e
   [Checklist de transferência](15-checklist-de-transferencia.md).
9. Só para quem for mexer em hardware: [Hardware Advisor](04-hardware-advisor.md),
   [Ativação do DXCore](10-ativacao-dxcore.md) e
   [Testes de contenção](11-testes-contencao.md). Os dois últimos são
   **histórico de engenharia** e não são necessários para o restante do produto.

## 6. Limitações conhecidas

- Só Windows 11 foi exercitado. Nunca existiu build empacotado.
- O Ollama tem de estar instalado e com modelos baixados; o app não inicia o
  serviço nem baixa modelos.
- Execuções ficam só em memória (até 100 por sessão).
- O contexto é estimado em 3 caracteres por token, sem contagem real.
- Configurações são todas gravadas, mas só tema e nome têm efeito. As de
  privacidade ficam travadas nos valores seguros.
- As recomendações de hardware usam perfis **fictícios**, identificados na
  interface.
- Conversas ficam em texto claro no `userData` do usuário.
- Telas React não têm testes de componente; a homologação manual pelo CDP não
  está versionada.
- Não há CI, lint nem formatação automática configurados.

Lista completa, com impacto e prioridade:
[Inventário e riscos](09-inventario-e-riscos.md#riscos-e-pendências).

## 7. Ainda não implementado

- Integração com o Gerpro.com: identidade, organizações, usuários, perfis e
  permissões, APIs.
- Motor de personalização, o núcleo da visão do produto: inclusão e
  configuração de campos, metadados de telas, personalização de layouts,
  regras de negócio, workflows, validação, permissões, publicação
  controlada, auditoria e rastreabilidade.
- Execução de ferramentas e concessão de permissões (só há declarações).
- Plugins (só o manifesto).
- Uso de credenciais (o `SecretVault` existe e é testado, mas não é
  instanciado).
- Detecção real de hardware no app (o detector existe e está dormente).
- Empacotamento, assinatura, instalador, atualização e ícone próprio.
- Download de modelos, motor de inferência próprio, benchmark, integração
  com VS Code.
- Assistente Gerpro AI (a tela é só informativa).

## 8. Regras de segurança que vêm junto

1. **DXCore, launcher e Lock Holder não estão autorizados para produção.** Os
   hashes de produção (`DXCORE_HELPER_SHA256`, `DXCORE_HOST_SHA256`) ficam
   `null`. O limite de memória do job (`DXCORE_HOST_JOB_MEMORY_LIMIT_BYTES`)
   fica `null`. O app usa `UnimplementedLocalDetector`, e o consentimento
   concedido fica com o escopo `demo-only`. Mudar qualquer um desses pontos é
   uma decisão de ativação, com os critérios em
   [docs/10 §7](10-ativacao-dxcore.md#7-critérios-objetivos-para-liberar-a-ativação-6c8).
2. Nenhum binário entra no Git, em `resources/` ou num pacote sem esse
   processo de ativação. O `.gitignore` bloqueia `*.exe`, `*.obj`, `*.pdb`,
   `resources/helpers/` e as pastas `build/` de `native/`.
3. Os supervisores de `scripts/diagnostics/` são manuais e só rodam com
   flags de confirmação explícitas. Não os coloque em CI.
4. **Entregue por clone do repositório, nunca por cópia da pasta.** A pasta
   local contém binários e arquivos ignorados que não devem circular.
5. Rede, disco e credenciais ficam no Main. O Renderer não chama servidores
   (CSP `connect-src 'self'`). Não afrouxe a CSP para integrar: crie um
   cliente no Main e um canal IPC por operação.
6. Finalidade nova de uso de dados exige consentimento novo. Nada simulado
   aparece como real.

## 9. Responsabilidades da equipe após a transferência

A arquitetura descrita neste guia é a **do protótipo, não uma decisão
definitiva**. A equipe Cognitiva tem autonomia para definir a arquitetura
definitiva: manter, adaptar ou substituir o que existe. A única exigência é
manter as regras de segurança da seção 8 enquanto o código atual estiver em
uso.

| Área | Responsabilidade |
|---|---|
| Integração Gerpro.com | Definir com o Gerpro.com os contratos reais e implementar cliente no Main, canais IPC, validadores, ambientes e credenciais (`SecretVault`) |
| Motor de personalização | Desenhar e implementar metadados, layouts, regras, workflows, validação, publicação e auditoria |
| Identidade e permissões | Autenticação, sessão, organizações, usuários, perfis, aplicação das permissões no Main |
| Engenharia de produto | Empacotamento, assinatura, atualização, CI, lint, `engines`, testes de componente |
| Segurança | Manter o isolamento do Electron; revisar CSP e `isAppUrl` antes de incorporar módulos web; decidir criptografia das conversas |
| Hardware e nativos | Decidir se e quando ativar o detector real e o DXCore, seguindo os critérios da docs/10; até lá, manter tudo desativado |
| Documentação | Registrar contratos novos em [Contratos](03-contratos.md) antes de implementar; manter o [inventário](09-inventario-e-riscos.md) atualizado |

O responsável pelo produto segue como PM/PO: prioriza o backlog, aprova as
regras de produto e decide as questões abertas
([Inventário › Decisões pendentes](09-inventario-e-riscos.md#decisões-arquiteturais-pendentes)).
