# Handoff para a equipe de desenvolvimento

Guia para continuar o Gerpro Studio. O código é a fonte primária; este
documento aponta o caminho e remete aos demais para os detalhes. O que existe
de verdade está em [Inventário e riscos](09-inventario-e-riscos.md). Para a
primeira leitura, comece pelo
[Guia de transferência](12-guia-de-transferencia.md).

Estado: Etapa H2 (preparação do handoff). O app é o do Lote 3.3.8. A linha de
hardware avançou depois disso (detector local, auxiliar DXCore, launcher e
testes de contenção), mas **fora do app**: ver a seção 11.

## 1. Ambiente

| Item | Requisito |
|---|---|
| Sistema | Windows 11 é o único ambiente exercitado. O código não depende dele, exceto `scripts/windows/`, mas macOS e Linux não foram testados. |
| Node.js | ≥ 22.12 para rodar; ≥ 22.18 para `npm test`, que usa a remoção de tipos nativa. Verificado com 24.22.1. |
| npm | ≥ 10. Verificado com 11.19.1. |
| Ollama | Opcional. Sem ele o app abre normalmente, mas Conversas não envia. Espera-se em `127.0.0.1:11434`, com modelos já baixados. |
| MSVC v143 + Windows SDK 10.0.26100 | Opcional: só para recompilar os nativos de `native/` (seção 11). O app, os testes e o build não precisam dele. |

O `package.json` não declara `engines`; confira a versão do Node à mão.

## 2. Dependências

`npm install` instala tudo e baixa o binário do Electron (`postinstall`). Se o
binário faltar, rode `npx install-electron`. A aplicação não tem dependências
de servidor, banco de dados nem variáveis de ambiente obrigatórias.

## 3. Executar

```bash
npm run dev       # desenvolvimento, com recarregamento da interface
npm run preview   # build de produção, localmente
```

No Windows, `scripts\windows\install-shortcuts.ps1` cria atalhos para o modo
de desenvolvimento (ver [`README.md`](../README.md)).

Os dados ficam em `<userData>/storage/`; no Windows,
`%APPDATA%\Gerpro Studio\storage`. **Não use essa pasta em testes manuais de
falha.** Para isolar, crie um arquivo externo que chame
`app.setPath('userData', <pasta temporária>)` antes de importar
`out/main/index.js`, e confira o caminho efetivo antes de gravar qualquer
coisa. Foi assim que a homologação do Lote 3.3.8 foi feita.

## 4. Testes

```bash
npm test            # node:test, sem dependências extras
npm run typecheck   # Main/Preload, Renderer e testes
```

- **Resultado esperado:** 1.565 testes. Num clone limpo, 1.539 passam e 26
  são pulados. Os pulados só leem (hash, cabeçalho PE) binários nativos
  compilados localmente, que nunca entram no Git. Com os builds locais, os
  1.565 passam. **Nenhum teste executa binário nativo**: os processos dos
  supervisores são simulados.
- Os testes da linha de hardware (`tests/main/dxcore-*`, `host-*`,
  `hardware-*`, `lock-holder-*`, `helper-*`, `native-pe-inspect`) cobrem
  código que não faz parte do app (seção 11). Eles também conferem que o app
  não importa esse código e que os hashes de produção continuam `null`.
- `tests/support/fake-ollama.ts` simula o Ollama por HTTP local; os testes não
  dependem de um Ollama instalado.
- `tests/support/fixtures.ts` tem `tempDir`, `agentDraft`, `settle` e
  `VirtualScheduler`.
- Depois de testes de conversa: `await settle()` e
  `await services.conversations.whenSaved()`.
- A remoção de tipos não processa JSX. Por isso a lógica de tela fica em `.ts`
  puro (`renderer/src/lib/`), testada diretamente; as telas são verificadas por
  expressões regulares sobre o código-fonte e por homologação no Electron.

## 5. Build

`npm run build` roda o `typecheck` e gera `out/`. **Não há empacotamento,
instalador nem atualização automática:** isso precisa ser criado, junto com o
ícone do aplicativo, que depende de aprovação.

## 6. Contratos IPC

A lista completa está em
[Arquitetura › Canais IPC](02-arquitetura.md#canais-ipc). Regras:

- Todo canal é declarado em `src/shared/ipc.ts`.
- O Main verifica remetente, quantidade de argumentos e conteúdo, nessa ordem.
- A resposta é `Result<T>`: `{ ok: true, data }` ou
  `{ ok: false, error: StructuredError }`. A única exceção é `app:get-info`.
- O Renderer usa `window.gerpro.*`; nunca recebe `ipcRenderer`.

## 7. Serviços

Montados por `createServices(dataDir, opções)` em
`src/main/services/index.ts`, que não importa o Electron e por isso roda nos
testes.

| Serviço | Responsabilidade | Não faz |
|---|---|---|
| `SettingsService` | Preferências e tema | Aplicar efeito às preferências, exceto tema e nome |
| `AgentService` | Cadastro, disponibilidade calculada e estado do armazenamento | Executar agentes |
| `ToolRegistry` | Catálogo declarado | Executar ferramentas |
| `RunService` | Fila, cancelamento, prazo, resolução de modelo e provedores | Gravar execuções |
| `ConversationService` | Conversas gravadas e recorte de contexto | Falar com provedores diretamente |
| `HardwareAdvisorService` | Consentimento e análise demonstrativa (`hardware.json` v4, cancelamento e prazo) | Ler o hardware real: recebe `UnimplementedLocalDetector`; o detector local está dormente (seção 11) |
| `OllamaInferenceProvider` | Único arquivo que conhece a API do Ollama | Instalar, iniciar ou baixar modelos |

## 8. Persistência

Ver [Arquitetura › Persistência local](02-arquitetura.md#persistência-local).
Resumo para quem vai mexer:

- Use `VersionedStore`. Nunca edite um formato publicado sem subir a versão e
  escrever a migração.
- Esquemas são estritos: um campo desconhecido torna o registro inválido.
  Por isso campo novo sempre exige nova versão de formato.
- `agents.json` bloqueia gravações ao encontrar dados inválidos
  (`protectOnRecovery`). Essa opção não vale para os demais arquivos.
- O conteúdo do usuário nunca entra em mensagens de erro nem em logs.

## 9. Como adicionar funcionalidades

**Tela:** crie o componente em `renderer/src/pages/` e registre em
`renderer/src/app/routes.ts`. Coloque a lógica em `renderer/src/lib/`, em
função pura. Identifique o que não for real com `FeatureBadge` e `FeatureNotice`.

**Canal IPC:**

1. Declare o canal e o tipo em `src/shared/ipc.ts`.
2. Crie o validador em `src/shared/`.
3. Registre o handler em `src/main/ipc-handlers.ts`, com a aridade.
4. Exponha a função em `src/preload/index.ts`.
5. Teste pelo handler, como em `tests/main/services.test.ts`.

**Provedor de inferência:** implemente `InferenceProvider` e registre em
`createServices`. Ver [`src/main/engine/README.md`](../src/main/engine/README.md).

**Formato gravado:** suba a versão, escreva a migração, registre-a no
`VersionedStore` e cubra com teste.

**Regras que não devem ser quebradas:**

- `src/shared/` não importa React, Electron nem Node.
- Rede, disco e credenciais ficam no Main.
- Nada simulado ou de exemplo aparece como real.
- Controle sem efeito fica desativado e explicado.
- Finalidade nova exige consentimento novo.

## 10. Erros comuns

| Sintoma | Causa | O que fazer |
|---|---|---|
| `Electron uninstall` ao rodar `npm run dev` | Binário não baixado | `npx install-electron` |
| `npm test` não interpreta TypeScript | Node abaixo de 22.18 | Atualizar o Node |
| Teste falha com sintaxe em `.tsx` | JSX não é processado por `node:test` | Mover a lógica para `.ts` |
| Campo novo some ou invalida o agente | Esquema estrito | Atualizar validador, versão e migração |
| "Agente não carregado" em Conversas | `agents.json` protegido | Seguir o [procedimento manual](02-arquitetura.md#procedimento-manual-de-diagnóstico) |
| Alterações de agente recusadas (`storage-read-only`) | Armazenamento protegido | Mesmo procedimento; não apague arquivos |
| "O motor de IA local não está respondendo" | Ollama fechado | Abrir o Ollama e usar "Atualizar lista" |
| Modelo recusado como incompatível | Modelo sem capacidade de conversa | Escolher outro; embeddings não conversam |
| Modelo recusado como não instalado | Identificador exato não encontrado | `llama3.1` não equivale a `llama3.1:8b` |
| Canal novo responde erro de validação | Aridade divergente | Conferir o registro em `ipc-handlers.ts` |
| Chamada de rede bloqueada no Renderer | CSP `connect-src 'self'` | Fazer a chamada no Main; não afrouxe a CSP |
| 26 testes pulados | Builds nativos locais ausentes | Esperado num clone; não é falha |

## 11. Componentes desativados e ferramentas de diagnóstico

Código real e testado, mas **fora do app**. Nenhum módulo do app o importa,
e `out/` não o contém.

| Componente | Onde | Situação |
|---|---|---|
| Detector local de hardware | `src/main/hardware/local/` | **Dormente.** O app usa `UnimplementedLocalDetector`, e o escopo concedido continua `demo-only` |
| Auxiliar DXCore | `native/dxcore-helper/`, `src/main/hardware/local/bundled-helper.ts` | **Não autorizado para produção.** `DXCORE_HELPER_SHA256 = { x64: null, arm64: null }`, por isso o executor recusa |
| Launcher com Job Object | `native/helper-host/`, `src/main/hardware/local/dxcore-host-contract.ts` | **Não autorizado para produção.** `DXCORE_HOST_SHA256` e `DXCORE_HOST_JOB_MEMORY_LIMIT_BYTES` são `null` |
| Segurador de travas | `native/lock-holder-test/` | **Só de teste**, nunca executado; não autorizado para produção |
| Diagnósticos | `scripts/diagnostics/` | Manuais; só rodam com flags `--confirm-*`. Fora de CI |
| Builds nativos | `scripts/native/` | Exigem MSVC; gravam só em `native/*/build/` |

**Regras:**

- Não altere hashes, limite de memória, detector em `createServices` nem
  escopo de consentimento sem uma decisão de ativação, conforme os critérios
  da [docs/10 §7](10-ativacao-dxcore.md#7-critérios-objetivos-para-liberar-a-ativação-6c8).
- Nenhum binário entra no Git nem em `resources/`. O `.gitignore` bloqueia
  `*.exe`, `*.obj`, `*.pdb`, `/resources/helpers/` e `native/*/build/`.
- Entregue e receba o projeto por **clone**, nunca por cópia da pasta: a pasta
  local contém binários e arquivos ignorados.
- Histórico e decisões: [Hardware Advisor](04-hardware-advisor.md),
  [Ativação do DXCore](10-ativacao-dxcore.md),
  [Testes de contenção](11-testes-contencao.md) e as decisões D47 em diante (Lote 3.3.9) em
  [Decisões](07-decisoes-e-limitacoes.md).

## Extensão para o Gerpro Web

**A arquitetura pretendida é híbrida.** O Gerpro Studio usa uma interface
desktop própria, consome APIs do Gerpro Web existente e preserva a
possibilidade de incorporar módulos web durante a migração.

**Nada dessa integração existe.** Este repositório não contém endpoints,
autenticação nem contratos do Gerpro Web (Gerpro.com), e nenhum deve ser
presumido. A equipe Cognitiva define e implementa os contratos conforme as
capacidades reais do Gerpro.com. O mesmo vale para o **motor de
personalização** (metadados de telas e campos, layouts, regras, workflows,
validação, publicação e auditoria): nenhum código existe.

Pontos do código prontos para receber a integração:

| Necessidade | Onde | Situação |
|---|---|---|
| Chamadas de API | Novo cliente no Main | Criar. O Renderer não pode chamar servidores (CSP). |
| Exposição à interface | Novos canais em `src/shared/ipc.ts` | Um canal por operação, nunca um canal genérico de requisição |
| Validação de respostas | Validadores em `src/shared/` | Dado de servidor é entrada externa |
| Formato de erro | `Result<T>` e `StructuredError` | Pronto; códigos específicos a definir |
| Credenciais | `SecretVault` | Pronto, mas não instanciado em `createServices` |
| Ambientes | Configuração | Inexistente |
| Envio de dados do usuário | Consentimento `serverSharing` | A validação recusa concedê-lo; exige fluxo próprio |
| Módulos web | Contêiner isolado | Decisão aberta, ver [proposta](02-arquitetura.md#proposta-para-a-equipe-avaliar) |

Cuidados e tarefas estão em
[Pontos de integração](06-pontos-de-integracao.md), itens 6 e 7. Depois de
definir os contratos, documente-os em [Contratos](03-contratos.md) antes de
implementar.
