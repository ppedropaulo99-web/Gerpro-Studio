# Gerpro Studio

Aplicação desktop de IA. Etapa 1: protótipo visual navegável. Etapa 2.1: núcleo funcional
(contratos, persistência local e IPC). Etapa 2.2: telas Agentes, Configurações e Execuções
conectadas ao Main. Etapa 3.1: Gerpro Hardware Advisor (contratos, consentimento e fluxos
demonstrativos; ver `src/main/hardware/README.md`).
Ainda não há inferência, detecção real de hardware, execução de ferramentas nem integrações externas.

Documentação completa (arquitetura, contratos, Hardware Advisor, pontos de integração e decisões): [`docs/`](docs/README.md).

## Dados reais × demonstrativos

| Tela | Dados do Main (reais) | Dados de exemplo (fictícios, identificados) |
|---|---|---|
| Agentes | "Meus agentes": criar, editar, arquivar, excluir | "Exemplos": podem ser duplicados como novo agente |
| Configurações | Tema escuro/claro (aplicado na hora); demais preferências gravadas, ainda sem efeito; as de privacidade ficam bloqueadas nos valores seguros | — |
| Execuções | "Execuções simuladas desta sessão" (só em memória, `origin: simulated`) | "Histórico de exemplo" |
| Barra lateral | Contadores de agentes salvos e simulações em andamento | — |
| Configurações › Hardware e desempenho | Consentimento (gravado, revogável) e exclusão de dados | Perfis de hardware fictícios |
| Agentes › Recomendações | Agentes salvos entram na avaliação | Perfil de hardware e biblioteca de modelos fictícios |
| Início | Agentes salvos e simulações da sessão | — (modelos e tokens: planejado) |
| Ferramentas | Catálogo e permissões declaradas (execução planejada) | — |
| Chat, Modelos | — | Conversas e biblioteca de modelos de exemplo |
| Desenvolvedor | Informações do aplicativo | Logs de exemplo (servidor local: planejado) |

Os estados dos dados de exemplo são convertidos para o contrato por `legacyRunState`
(`renderer/src/lib/runs.ts`): `queued→pending`, `succeeded→completed`, demais iguais.

**Stack:** Electron 45 · React 19 · TypeScript · Vite 8 (via electron-vite 6)

## Requisitos

- Node.js ≥ 22.12 (testado com 24.14)
- npm ≥ 10

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
│   ├── services/         Configurações e agentes (persistidos), montagem dos serviços
│   ├── storage/          Escrita atômica, arquivo JSON versionado, cofre cifrado
│   ├── tools/            Catálogo e registro de ferramentas (só declarações)
│   ├── runs/             Gerenciador DEMONSTRATIVO de execuções
│   ├── engine/           (reservado) motor de IA
│   └── plugins/          (reservado) sistema de plugins
├── preload/
│   ├── index.ts          Ponte contextBridge → window.gerpro (API mínima)
│   └── index.d.ts        Tipagem de window.gerpro para o Renderer
├── shared/               Contratos usados pelos três processos
│   ├── ipc.ts            Canais IPC permitidos e tipos da API
│   ├── agents.ts         Definição, validação e disponibilidade de agentes
│   ├── tools.ts          Definição, esquemas e executor (futuro) de ferramentas
│   ├── runs.ts           Estados, transições e pedidos de execuções
│   ├── inference.ts      Provedores de inferência, identidade de modelos, eventos e erros
│   ├── execution.ts      Perfis de execução e substituição por execução
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

Canais IPC: `app:get-info`, `settings:get|update`, `agents:list|create|update|delete`, `tools:list`,
`runs:list|start-demo|cancel`, `hardware:get-state|set-local-consent|analyze|delete-data`
e o evento `runs:updated`. Os canais de dados recebem argumentos
como `unknown`, validam no Main e respondem `Result<T>` (`{ ok, data }` ou `{ ok, error }`).

## Persistência local

Arquivos em `<userData>/storage/` (`settings.json`, `agents.json`, `hardware.json`), gravados só pelo Main:

- Envelope versionado `{ format, formatVersion, savedAt, data }`, com migrações por versão.
- Escrita atômica (temporário + `fsync` + `rename`), gravações serializadas.
- Arquivo corrompido ou inválido: cópia `*.invalid-<data>.json` e recuperação dos dados válidos.
- Arquivo de versão mais nova: carregado como padrão e **nunca sobrescrito**.
- Esquemas estritos (campos desconhecidos são rejeitados). Credenciais só no cofre
  `SecretVault`, cifrado pelo `safeStorage` do sistema; sem cifra disponível, nada é gravado.

## Como expandir

- **Nova tela:** crie o componente em `renderer/src/pages/` e adicione uma entrada em `renderer/src/app/routes.ts`. A barra lateral e a navegação se atualizam sozinhas.
- **Novo canal IPC:**
  1. Declare o canal e o tipo em `shared/ipc.ts`.
  2. Registre o handler em `main/ipc.ts`, chamando `assertTrustedSender`.
  3. Exponha a função em `preload/index.ts`.
- **Motor de IA:** implemente `InferenceProvider` (`shared/inference.ts`) dentro de `main/engine/` e exponha-o por novos canais IPC. Perfis e substituições por execução estão em `shared/execution.ts`.
- **Plugins:** carregue manifestos `PluginManifest` (`shared/plugins.ts`) em `main/plugins/`. A tela **Ferramentas** já exibe origem e permissões.
- **Visual:** cores, espaçamentos e tipografia saem de `renderer/src/styles/tokens.css`.

## Originalidade

Código, nomes e dados de exemplo são próprios deste projeto; a identidade visual segue o logo oficial Gerpro 25 anos e suas cores. Nenhum arquivo, código, recurso gráfico ou componente do LM Studio foi copiado. A semelhança é apenas no tipo de organização de uma estação de trabalho de IA: barra lateral, biblioteca de modelos e chat.
