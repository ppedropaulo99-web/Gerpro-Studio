# Gerpro Hardware Advisor

Avalia os recursos do computador para recomendar agentes e modelos compatíveis.

**Estado atual (etapa 3.1):** não há leitura real de hardware. O detector real
(`UnimplementedLocalDetector`) sempre responde "indisponível". Só o detector
demonstrativo produz perfis, todos **fictícios** e marcados com
`provenance.source = 'demo'`.

## Camadas

| Camada | Arquivo | Responsabilidade |
|---|---|---|
| Contrato | `src/shared/hardware.ts` | Perfil, consentimento, estados, `HardwareDetector`, validação |
| Recomendações | `src/shared/recommendations.ts` | Motor puro: requisitos × perfil × tarefa × modelos × ferramentas × motor |
| Detectores | `src/main/hardware/detectors.ts` | `UnimplementedLocalDetector`, `DemoHardwareDetector` |
| Serviço | `src/main/hardware/hardware-advisor-service.ts` | Consentimento, análise, gravação em `hardware.json` |
| IPC | `hardware:get-state`, `hardware:set-local-consent`, `hardware:analyze`, `hardware:delete-data` | Argumentos validados no Main |
| Interface | `renderer/src/components/hardware/*`, `renderer/src/lib/advisor.ts` | Painel em Configurações e recomendações em Agentes |

O motor de recomendações e os contratos não dependem de React, Electron ou
Node: podem ser usados no Main, no Renderer ou num serviço web.

## Privacidade

- **Duas autorizações independentes:** `localAnalysis` (análise neste computador)
  e `serverSharing` (envio ao Gerpro Web). `serverSharing` não pode ser
  concedido nesta versão (a validação rejeita).
- Sem `localAnalysis = granted`, o serviço **não chama nenhum detector**.
- **Escopo da autorização:** cada concessão grava `localAnalysis.scope`. Esta
  versão grava `'demo-only'` (`CURRENT_GRANT_SCOPE`), porque a tela diz que nada
  do computador é lido. A leitura real exige `'device-detection'`
  (`SCOPE_REQUIRED.real`), e o serviço recusa chamar `detect()` de um detector
  real disponível sem esse escopo (`consentCovers`). Autorizações antigas
  **nunca são ampliadas automaticamente**: quem autorizou a demonstração terá
  de autorizar de novo quando a detecção real existir.
- Revogar oculta os dados imediatamente; "Desativar e apagar dados" e
  `hardware:delete-data` removem o registro do disco.
- Se a autorização for revogada durante uma análise, o resultado é descartado.
- Arquivo ilegível volta ao padrão seguro: não autorizado e sem dados.
- O perfil não contém identificadores do usuário nem números de série
  (campos extras são rejeitados pela validação).

## Ponto de extensão 1: detector real

1. Implemente `HardwareDetector` (`src/shared/hardware.ts`) em
   `src/main/hardware/`, com `source = 'local-detector'`:
   - `availability()`: diga se o detector funciona nesta plataforma, e por quê.
   - `detect(signal)`: devolva um `HardwareProfile`. Use `null` para o que não
     conseguir identificar e `[]` para o que verificou e não existe. Respeite
     o `signal` (timeout de 15 s no serviço).
   - Preencha `provenance` com `detectorId`, `collectedAt` e `confidence`.
2. Troque `localDetector` em `src/main/services/index.ts` e passe
   `grantScope: 'device-detection'` ao `HardwareAdvisorService` **junto com**
   uma tela de consentimento que diga claramente que o hardware real será lido
   (e remova o aviso "nenhuma informação é lida"). Não altere
   `CURRENT_GRANT_SCOPE` nem converta registros `demo-only` existentes.
3. Nada mais muda: o serviço valida o perfil (`validateHardwareProfile`),
   grava, e a interface já mostra os seis estados.

Fontes possíveis no Main: `os.cpus()`, `os.totalmem()`, `os.freemem()`,
`fs.statfs()`, `app.getGPUInfo('complete')` do Electron e, para VRAM e
aceleração, um módulo nativo ou o próprio motor de inferência. Nenhuma delas
exige permissão do sistema operacional, mas **só devem ser chamadas após o
consentimento**, o que o serviço já garante.

## Ponto de extensão 2: motor de inferência

`recommendAgent` recebe `engineAvailable` e `ModelProfile.availability`.

- Quando o motor existir, passe `engineAvailable: true` (hoje fixo em `false`
  em `AgentRecommendations.tsx` e em `createServices`).
- Substitua a biblioteca demonstrativa de modelos (`renderer/src/data/models.ts`)
  pela lista do motor (`InferenceEngine.listModels()`), mapeando para
  `ModelProfile` com a disponibilidade real (instalado, baixando, erro).
- O motor pode informar requisitos medidos (memória por token, offload por
  camada); eles entram como `AgentRequirements` com `source: 'declared'` e
  prevalecem sobre a estimativa (`estimateRequirementsFromModel`).
- `executableNow` só fica verdadeiro com motor disponível, modelo instalado e
  ferramentas implementadas.

## Ponto de extensão 3: requisitos e tarefas dos agentes

Os exemplos declaram tipos de tarefa e, opcionalmente, requisitos em
`renderer/src/data/agent-requirements.ts`. A `AgentDefinition` persistida
ainda não tem esses campos; adicioná-los exige subir `AGENTS_FORMAT_VERSION`
para 2 com migração em `agent-service.ts`.

## Ponto de extensão 4: Gerpro Web

Não implementado. Um envio futuro deve: exigir `serverSharing = granted` (com
fluxo de consentimento próprio), enviar só o perfil validado, sem
identificadores, e usar um canal IPC dedicado. A validação atual impede
conceder `serverSharing` até que isso exista.
