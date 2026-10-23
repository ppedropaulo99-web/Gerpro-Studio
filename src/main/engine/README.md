# Motor de IA (reservado)

Ponto de entrada futuro para provedores de inferência local. Cada provedor
implementa `InferenceProvider` (`src/shared/inference.ts`) e é registrado no
Main; o Renderer só o alcança por canais declarados em `src/shared/ipc.ts`.
Inventário e eventos recebidos do provedor passam por `validateProviderModel`
e `validateInferenceEvent`.

Nenhum provedor real é implementado. O único registrado é o provedor
simulado (`src/main/runs/simulated-provider.ts`, `kind: 'simulated'`), que
exercita o `RunService` sem inferência. Um provedor real é registrado na lista
`providers` do `RunService` em `src/main/services/index.ts`; a origem das
execuções (`real`) e `engineAvailable` passam a valer a partir dele.

Integração com o Hardware Advisor: ver "Ponto de extensão 2" em
`src/main/hardware/README.md` (`engineAvailable`, lista de modelos e requisitos medidos).
