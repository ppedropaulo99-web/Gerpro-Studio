# Gerpro Studio

Aplicação desktop de IA para conversar com modelos instalados neste computador, por meio de
agentes configuráveis. A inferência é real e local, pelo Ollama. As conversas ficam gravadas
neste computador.

Ainda não há execução de ferramentas, detecção real de hardware, instalador nem integração com
o Gerpro Web.

Documentação completa: [`docs/`](docs/README.md). Para continuar o desenvolvimento, comece pelo
[Handoff](docs/08-handoff.md) e pelo [Inventário e riscos](docs/09-inventario-e-riscos.md).

## Dados reais × demonstrativos

| Tela | Dados do Main (reais) | Dados de exemplo (fictícios, identificados) |
|---|---|---|
| Agentes | "Meus agentes": criar, editar, arquivar, restaurar, excluir; modelo escolhido entre os instalados, tipos de tarefa e configurações avançadas | "Exemplos": podem ser duplicados como novo agente |
| Conversas | Conversas gravadas, com contexto, com modelos instalados | — |
| Configurações | Tema escuro/claro (aplicado na hora); demais preferências gravadas, ainda sem efeito; as de privacidade ficam bloqueadas nos valores seguros | — |
| Execuções | Execuções reais da sessão, com métricas medidas (só em memória) | "Demonstração simulada", identificada |
| Barra lateral | Contadores de agentes salvos e execuções em andamento; estado do motor | — |
| Configurações › Hardware e desempenho | Consentimento (gravado, revogável) e exclusão de dados | Perfis de hardware fictícios |
| Agentes › Recomendações | Agentes salvos entram na avaliação | Perfil de hardware e biblioteca de modelos fictícios |
| Início | Agentes salvos e execuções da sessão | — (modelos carregados e tokens: planejado) |
| Ferramentas | Catálogo e permissões declaradas (execução planejada) | — |
| Gerpro AI | — | — (em desenvolvimento) |
| Modelos | Modelos instalados no Ollama | Biblioteca de modelos de exemplo |
| Desenvolvedor | Informações do aplicativo | Logs de exemplo (servidor local: planejado) |

Os estados dos dados de exemplo são convertidos para o contrato por `legacyRunState`
(`renderer/src/lib/runs.ts`): `queued→pending`, `succeeded→completed`, demais iguais.

**Stack:** Electron 45 · React 19 · TypeScript · Vite 8 (via electron-vite 6)

## Requisitos

- Node.js ≥ 22.12 (testado com 24.22)
- npm ≥ 10
- Ollama, opcional: sem ele o app abre, mas Conversas não envia mensagens

## Como iniciar

```bash
npm install      # instala dependências e baixa o binário do Electron (postinstall)
npm run dev      # abre o app em modo desenvolvimento, com hot reload na interface
```

Outros scripts:

| Script | O que faz |
|---|---|
| `npm run typecheck` | Verifica os tipos de Main/Preload e Renderer |
| `npm run build` | Verifica os tipos e gera o build de produção em `out/` |
| `npm run preview` | Executa o build de produção localmente |
| `npm test` | Testes automatizados (`node:test`, sem dependências extras; exige Node ≥ 22.18) |

> Se `npm run dev` falhar com `Electron uninstall`, o binário não foi baixado. Rode `npx install-electron`.

### Abrir pelo Windows, sem terminal (desenvolvimento)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-shortcuts.ps1          # cria os atalhos
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-shortcuts.ps1 -Remove  # remove
```

- Cria o atalho **Gerpro Studio** na Área de Trabalho e no Menu Iniciar. Os
  dois executam `scripts\windows\start-gerpro-studio.ps1`, que roda
  `npm run dev` sem janela de terminal e com o hot reload de sempre.
- Os atalhos e o processo Main usam o mesmo AppUserModelID
  (`br.com.gerpro.studio`). Por isso a janela aparece na barra de tarefas
  como Gerpro Studio, não como Electron.
- **Fixar na barra de tarefas:** Menu Iniciar → "Gerpro Studio" → botão
  direito → **Fixar na barra de tarefas**. Também funciona com o botão direito
  no ícone do app aberto.
- Abrir de novo com o app aberto só traz a janela para a frente.
- **Logs:** `%LOCALAPPDATA%\Gerpro Studio\logs` (`inicializador-*.log` e
  `dev-*.log`, os 10 mais recentes de cada). Se o app não abrir, uma mensagem
  informa o motivo e o caminho do log.
- **Ícone provisório:** o do Electron. O ícone próprio aguarda aprovação.
- Se a pasta do projeto mudar de lugar, rode `install-shortcuts.ps1` de novo.

## Estrutura

```text
src/
├── main/                 Processo Main (Node.js + Electron)
│   ├── index.ts          Ciclo de vida do app e instância única
│   ├── window.ts         Criação da janela e webPreferences seguros
│   ├── security.ts       CSP e bloqueio de permissões de dispositivo
│   ├── ipc.ts            Registro IPC com validação de remetente
│   ├── ipc-handlers.ts   Handlers de dados (aridade + Result estruturado)
│   ├── errors.ts         AppError → StructuredError
│   ├── env.ts            Detecção de dev/produção e URLs confiáveis
│   ├── services/         Configurações, agentes, conversas e montagem dos serviços
│   ├── storage/          Escrita atômica, arquivo JSON versionado, cofre cifrado
│   ├── tools/            Catálogo e registro de ferramentas (só declarações)
│   ├── runs/             RunService (fila, cancelamento, prazo) e provedor simulado
│   ├── engine/           Provedores de inferência (adaptador Ollama, HTTP local)
│   ├── hardware/         Hardware Advisor e detectores
│   └── plugins/          (reservado) sistema de plugins
├── preload/
│   ├── index.ts          Ponte contextBridge → window.gerpro (API mínima)
│   └── index.d.ts        Tipagem de window.gerpro para o Renderer
├── shared/               Contratos usados pelos três processos
│   ├── ipc.ts            Canais IPC permitidos e tipos da API
│   ├── agents.ts         Definição, validação e disponibilidade de agentes
│   ├── conversations.ts  Conversas, mensagens e recorte de contexto
│   ├── tools.ts          Definição, esquemas e executor (futuro) de ferramentas
│   ├── runs.ts           Estados, transições e pedidos de execuções
│   ├── inference.ts      Provedores de inferência, identidade de modelos, eventos e erros
│   ├── execution.ts      Perfis, substituição por execução e resolução do modelo
│   ├── compatibility.ts  Estados de compatibilidade (estimada, testada, confirmada)
│   ├── settings.ts       Configurações do app
│   ├── validation.ts     Validação em tempo de execução
│   ├── errors.ts         Erros estruturados e Result<T>
│   ├── engine.ts         Tipos da biblioteca de modelos de exemplo
│   └── plugins.ts        Manifesto de plugin
└── renderer/             Processo Renderer (React, sem acesso a Node)
    ├── index.html
    └── src/
        ├── app/          Registro de rotas e contexto de navegação
        ├── components/
        │   ├── layout/   AppShell, Sidebar, PageHeader
        │   └── ui/       Button, Card, StatusBadge, Tag, ProgressBar, Menu,
        │                 Field, TextInput, Select, Switch, Segmented, Notice
        ├── pages/        Uma tela por item da barra lateral
        ├── data/         Dados simulados (agentes, modelos, execuções...)
        ├── lib/          Formatação, mapeamento de status, utilitários
        └── styles/       tokens.css (cores, espaço, tipografia) + estilos
```

## Segurança do Electron

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` e `webSecurity: true`. Também ficam desligados `nodeIntegrationInWorker`, `nodeIntegrationInSubFrames` e `webviewTag`.
- **IPC controlado:** os canais permitidos são declarados só em `src/shared/ipc.ts`. O Preload expõe funções de alto nível em `window.gerpro`, nunca o `ipcRenderer`. O Main valida a origem de cada chamada (`assertTrustedSender`).
- **CSP restritiva** em produção (`script-src 'self'`). Em desenvolvimento há uma variante que permite o HMR do Vite.
- **Navegação:** novas janelas são bloqueadas e links `https` abrem no navegador do sistema. Navegar para fora do app é impedido.
- **Permissões** de câmera, microfone, notificações etc. são negadas por padrão.
- **DevTools** só em desenvolvimento.

Canais IPC: `app:get-info`, `settings:get|update`, `agents:list|create|update|delete|storage-status`,
`tools:list`, `runs:list|start|start-demo|cancel`, `providers:list`,
`conversations:list|get|send|rename|delete|retry-save`,
`hardware:get-state|set-local-consent|analyze|delete-data` e os eventos `runs:updated`,
`conversations:updated` e `conversations:save-changed`. Os canais de dados recebem argumentos
como `unknown`, validam no Main e respondem `Result<T>` (`{ ok, data }` ou `{ ok, error }`).

## Persistência local

Arquivos em `<userData>/storage/` (`settings.json`, `agents.json`, `hardware.json` e `conversations/`), gravados só pelo Main:

- Envelope versionado `{ format, formatVersion, savedAt, data }`, com migrações por versão.
- Escrita atômica (temporário + `fsync` + `rename`), gravações serializadas.
- Arquivo corrompido ou inválido: cópia `*.invalid-<data>.json`. Em `agents.json`, as alterações ficam bloqueadas até a correção manual; em `settings.json` e `hardware.json`, o app segue com o que foi recuperado.
- Arquivo de versão mais nova: **nunca sobrescrito**.
- Esquemas estritos (campos desconhecidos são rejeitados). Credenciais só no cofre
  `SecretVault`, cifrado pelo `safeStorage` do sistema; sem cifra disponível, nada é gravado.

## Como expandir

- **Nova tela:** crie o componente em `renderer/src/pages/` e adicione uma entrada em `renderer/src/app/routes.ts`. A barra lateral e a navegação se atualizam sozinhas.
- **Novo canal IPC:**
  1. Declare o canal e o tipo em `shared/ipc.ts`.
  2. Registre o handler em `main/ipc-handlers.ts`, com validação e aridade.
  3. Exponha a função em `preload/index.ts`.
- **Provedor de inferência:** implemente `InferenceProvider` (`shared/inference.ts`) em `main/engine/` e registre-o em `createServices`. Fila, interface e agentes não mudam (ver `src/main/engine/README.md`).
- **Plugins:** carregue manifestos `PluginManifest` (`shared/plugins.ts`) em `main/plugins/`. A tela **Ferramentas** já exibe origem e permissões.
- **Visual:** cores, espaçamentos e tipografia saem de `renderer/src/styles/tokens.css`.

## Originalidade

Código, nomes e dados de exemplo são próprios deste projeto; a identidade visual segue o logo oficial Gerpro 25 anos e suas cores. Nenhum arquivo, código, recurso gráfico ou componente do LM Studio foi copiado. A semelhança é apenas no tipo de organização de uma estação de trabalho de IA: barra lateral, biblioteca de modelos e chat.
