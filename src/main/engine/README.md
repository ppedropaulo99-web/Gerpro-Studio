# Motor de IA (reservado)

Ponto de entrada futuro para provedores de inferência local. Cada provedor
implementa `InferenceProvider` (`src/shared/inference.ts`) e é registrado no
Main; o Renderer só o alcança por canais declarados em `src/shared/ipc.ts`.
Inventário e eventos recebidos do provedor passam por `validateProviderModel`
e `validateInferenceEvent`.

Nada é implementado nesta etapa.

Integração com o Hardware Advisor: ver "Ponto de extensão 2" em
`src/main/hardware/README.md` (`engineAvailable`, lista de modelos e requisitos medidos).
