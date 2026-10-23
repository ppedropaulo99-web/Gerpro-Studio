# Motor de IA (reservado)

Ponto de entrada futuro para motores de inferência. Cada motor implementa
`InferenceEngine` (`src/shared/engine.ts`) e é registrado no Main; o Renderer
só o alcança por canais declarados em `src/shared/ipc.ts`.

Nada é implementado nesta etapa.

Integração com o Hardware Advisor: ver "Ponto de extensão 2" em
`src/main/hardware/README.md` (`engineAvailable`, lista de modelos e requisitos medidos).
