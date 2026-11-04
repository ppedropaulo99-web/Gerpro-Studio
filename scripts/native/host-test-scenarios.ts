/**
 * Cenários do alvo sintético dos testes reais do launcher (Etapa 6C.6C.1;
 * roteiro em docs/11-testes-contencao.md). Um binário por cenário, com o
 * número fixado no build (`/DGERPRO_SYNTHETIC_SCENARIO=<n>`), sempre com o
 * nome `gerpro-synthetic-helper.exe`. Nada aqui é usado pelo app.
 *
 * `expectedHostExit`: código esperado de `gerpro-helper-host-test.exe` com
 * esse alvo, se a contenção se comportar como documentado (hipóteses a
 * confirmar na 6C.6C, não fatos).
 */

/** Nomes e pasta da variante de testes (iguais a protocol.h com GERPRO_HOST_TEST_BUILD). */
export const TEST_LAUNCHER_NAME = 'gerpro-helper-host-test.exe'
export const SYNTHETIC_HELPER_NAME = 'gerpro-synthetic-helper.exe'
export const TEST_HELPERS_DIRECTORY = 'host-test'

export const SCENARIOS = Object.freeze([
  Object.freeze({ id: 'exit-ok', number: 1, helperExit: 0, expectedHostExit: 0, purpose: 'início e saída normais; uma linha na saída padrão' }),
  Object.freeze({ id: 'exit-contract', number: 2, helperExit: 12, expectedHostExit: 12, purpose: 'código dentro do contrato repassado sem mudança' }),
  Object.freeze({ id: 'exit-out-of-contract', number: 3, helperExit: 77, expectedHostExit: 28, purpose: 'código fora do contrato vira 28' }),
  Object.freeze({ id: 'hang', number: 4, helperExit: 13, expectedHostExit: 27, purpose: 'travado (prazo próprio de 30 s): prazo do launcher, cancelamento e fechamento do job' }),
  Object.freeze({ id: 'spawn-child', number: 5, helperExit: 0, expectedHostExit: 0, purpose: 'tenta criar descendente (comum e com saída do job), sempre suspenso' }),
  Object.freeze({ id: 'memory', number: 6, helperExit: 0, expectedHostExit: 0, purpose: 'reserva e toca 64 MiB; relata picos do job imediato' }),
  Object.freeze({ id: 'job-probe', number: 7, helperExit: 0, expectedHostExit: 0, purpose: 'relata o job imediato (limites e contabilidade)' })
])
