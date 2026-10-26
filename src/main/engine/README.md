# Motor de IA

Provedores de inferência local. Cada provedor implementa `InferenceProvider`
(`src/shared/inference.ts`) e é registrado no Main, na lista `providers` do
`RunService` (`src/main/services/index.ts`). O Renderer só o alcança por
canais declarados em `src/shared/ipc.ts` (`runs:*`, `providers:list`); nunca
fala com um provedor diretamente. Inventário e eventos recebidos passam por
`validateProviderModel` e `validateInferenceEvent`.

## Provedores

- **Simulado** (`src/main/runs/simulated-provider.ts`, `kind: 'simulated'`):
  roteiros fixos, sem inferência. Exercita o `RunService`; execuções feitas
  com ele são `origin: 'simulated'` e nunca contam como motor real.
- **Ollama** (`ollama/ollama-provider.ts`, `kind: 'external'`): adaptador da
  API HTTP local do Ollama (`/api/version`, `/api/tags`, `/api/chat` com
  streaming). Registrado só quando `createServices` recebe `ollamaBaseUrl`
  (o app passa `http://127.0.0.1:11434`). Não instala, não inicia o serviço e
  não baixa modelos. Todo formato específico do Ollama fica nesse arquivo.

## Peças reutilizáveis

- `local-http.ts`: HTTP restrito a loopback (`127.0.0.1`, `localhost`,
  `[::1]`), sem seguir redirecionamentos, com leitura limitada de corpos
  inteiros ou NDJSON. Serve a qualquer provedor local que fale HTTP.
- `provider-error.ts`: `InferenceProviderError`, para um provedor informar
  por que o inventário falhou (`provider-unavailable` × `provider-error`).

## Disponibilidade

O `RunService` guarda a última verificação de cada provedor
(`refreshProviders`): estado e modelos locais instalados. `capabilities()`
só informa `realEngine: 'available'` quando um provedor real respondeu
`ready`; estar registrado não basta. `canRunReal(model)` alimenta
`engineAvailable` dos agentes: o agente só fica disponível se um provedor
real pronto tem o modelo dele instalado. A verificação inicial roda sem
bloquear a abertura do app.

## Novo provedor (ex.: motor próprio)

1. Implementar `InferenceProvider` com `kind: 'embedded'` (runtime próprio)
   ou `'external'` (processo separado).
2. Converter o formato nativo para `ProviderStatus`, `ProviderModelEntry` e
   `InferenceEvent` dentro do próprio adaptador; lançar
   `InferenceProviderError` quando não puder listar modelos.
3. Respeitar o `AbortSignal` em `generate` (cancelamento e tempo limite são
   do `RunService`) e só preencher métricas medidas.
4. Registrar em `createServices`. Nada mais muda: fila, cancelamento,
   eventos, origem `real` e disponibilidade dos agentes já valem.

Integração com o Hardware Advisor: ver "Ponto de extensão 2" em
`src/main/hardware/README.md` (`engineAvailable`, lista de modelos e requisitos medidos).
