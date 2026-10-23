# Motor de inferência próprio

**Status: planejado.** Não há motor, download nem carregamento de modelos,
nem inferência. A escolha da tecnologia é uma **decisão arquitetural futura**,
que ainda não foi tomada.

## O que existe hoje

| Item | Onde | Situação |
|---|---|---|
| Interface `InferenceEngine` | `src/shared/engine.ts` | Contrato: `listModels`, `load`, `unload`, `chat` (streaming e cancelamento por `AbortSignal`) |
| `ModelDescriptor` | `src/shared/engine.ts` | Formato, quantização, tamanho, contexto e capacidades |
| `ModelReference` no agente | `src/shared/agents.ts` | `engineId` opcional: o agente não fica preso a um motor |
| Pasta reservada | `src/main/engine/` | Só um README |
| `engineAvailable: () => false` | `src/main/services/index.ts` | Todos os agentes ficam com `engine-unavailable` |
| `engineAvailable: false` | `src/renderer/src/components/hardware/AgentRecommendations.tsx` | Nenhuma recomendação fica executável |
| Biblioteca de modelos | `src/renderer/src/data/models.ts` | **Fictícia** |
| Preferências `models.directory` e `models.maxRamGb` | `src/shared/settings.ts` | Gravadas, sem efeito |

## Requisitos que o contrato já impõe

- **Processo:** o motor roda fora do Renderer, que só o alcança por canais IPC
  declarados em `src/shared/ipc.ts`.
- **Respostas:** em streaming (`AsyncIterable<string>`), com cancelamento por
  `AbortSignal`, o que é compatível com o cancelamento cooperativo de
  `RunRecord`.
- **Vários motores:** cada um com `id`. Um agente com `engineId: null` aceita
  qualquer motor que ofereça o modelo.
- **Execuções reais:** devem usar `origin: 'real'` e seguir `RUN_TRANSITIONS`.
- **Ferramentas:** só podem ser chamadas pelo motor via `ToolExecutor`, com
  validação de esquema e permissões no Main.

## Questões em aberto para a decisão

1. **Runtime:** biblioteca nativa embutida, processo auxiliar (*sidecar*)
   empacotado com o app ou execução remota via Gerpro Web. As três opções
   cabem no contrato `InferenceEngine`.
2. **Isolamento:**
   - *Proposta:* não executar a inferência no processo Main, para não
     bloquear o IPC e a janela.
   - Um `utilityProcess` do Electron ou um processo auxiliar isolam falhas e
     uso de memória.
3. **Formatos de modelo:** o contrato prevê `gguf`, `safetensors` e `onnx`.
   Definir quais serão suportados primeiro.
4. **Origem dos modelos:** catálogo próprio, Gerpro Web ou repositórios
   públicos. Licenças, verificação de integridade (hash) e pasta de
   armazenamento.
5. **Aceleração:** CUDA, ROCm, Metal, Vulkan e DirectML. O Hardware Advisor já
   descreve essas capacidades no perfil.
6. **Limites:** aplicar `models.maxRamGb` antes de carregar um modelo.

## Integração com o Hardware Advisor

Quando o motor existir:

- **Disponibilidade do motor:** passar `engineAvailable: true` em
  `createServices` e em `AgentRecommendations.tsx`.
- **Lista de modelos:** substituir a biblioteca fictícia por
  `InferenceEngine.listModels()`, mapeando para `ModelProfile` com a
  disponibilidade real (`installed`, `downloading`, `error`).
- **Requisitos medidos pelo motor:** entram como `AgentRequirements` com
  `source: 'declared'` e prevalecem sobre a estimativa.
- **Recomendações:** `executableNow` passa a ser verdadeiro automaticamente
  quando motor, modelo instalado e ferramentas permitirem. Nenhuma outra
  mudança no motor de recomendações é necessária.

Ver também "Ponto de extensão 2" em
[`src/main/hardware/README.md`](../src/main/hardware/README.md).
