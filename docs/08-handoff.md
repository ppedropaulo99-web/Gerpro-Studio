# Handoff para a equipe de desenvolvimento

Guia para continuar o Gerpro Studio. O código é a fonte primária; este
documento aponta o caminho e remete aos demais para os detalhes. O que existe
de verdade está em [Inventário e riscos](09-inventario-e-riscos.md).

## 1. Ambiente

| Item | Requisito |
|---|---|
| Sistema | Windows 11 é o único ambiente exercitado. O código não depende dele, exceto `scripts/windows/`, mas macOS e Linux não foram testados. |
| Node.js | ≥ 22.12 para rodar; ≥ 22.18 para `npm test`, que usa a remoção de tipos nativa. Verificado com 24.22.1. |
| npm | ≥ 10. Verificado com 11.19.1. |
| Ollama | Opcional. Sem ele o app abre normalmente, mas Conversas não envia. Espera-se em `127.0.0.1:11434`, com modelos já baixados. |

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
| `HardwareAdvisorService` | Consentimento e análise demonstrativa | Ler o hardware real |
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

## Extensão para o Gerpro Web

**A arquitetura pretendida é híbrida.** O Gerpro Studio usa uma interface
desktop própria, consome APIs do Gerpro Web existente e preserva a
possibilidade de incorporar módulos web durante a migração.

**Nada dessa integração existe.** Este repositório não contém endpoints,
autenticação nem contratos do Gerpro Web, e nenhum deve ser presumido. A equipe
responsável define e implementa os contratos conforme as capacidades reais do
Gerpro Web.

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
