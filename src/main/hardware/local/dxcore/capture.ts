import type { CommandResult } from '../command-runner'
import { GPU_COMMAND_IDS, type GpuCommandId } from '../commands'
import { deviceKeysFrom, parseRegistryOutput, type GpuApi, type RegistryStatus } from '../probes/gpu'
import type { RegistrySnapshot } from './selection'

/**
 * Captura das fontes da sondagem atual (Electron + Registro) para a seleção
 * da lista de GPUs (D54), sem consulta nenhuma a mais.
 *
 * `api` é a mesma `GpuApi` recebida, envolvida de forma transparente:
 * - `getGPUInfo`: devolve exatamente o retorno original e guarda uma cópia
 *   da referência (só para a composição de pares em `selectGpuList`);
 * - `runCommand`: cada consulta fixa do catálogo roda no máximo uma vez; uma
 *   segunda chamada com o mesmo identificador recebe a mesma resposta.
 *
 * `probeGpus` recebe essa `api` e se comporta como antes: mesmas chamadas,
 * mesmos valores, mesmos erros. Nada é gravado; as respostas ficam só em
 * memória durante a coleta.
 */
export interface GpuSourceCapture {
  api: GpuApi
  /** Retorno de `getGPUInfo`, ou `null` se ele não respondeu. */
  electronRaw(): unknown
  /** Registro já lido pela sondagem, com a situação que ela informou. */
  registry(status: RegistryStatus): RegistrySnapshot
}

export function captureGpuSources(api: GpuApi): GpuSourceCapture {
  let raw: unknown = null
  const pending = new Map<GpuCommandId, Promise<CommandResult>>()
  const settled = new Map<GpuCommandId, CommandResult>()
  const { getGPUInfo, runCommand } = api

  const wrapped: GpuApi = {}
  if (getGPUInfo) {
    wrapped.getGPUInfo = async (type) => {
      const value = await getGPUInfo(type)
      raw = value
      return value
    }
  }
  if (runCommand) {
    wrapped.runCommand = (id, signal) => {
      let response = pending.get(id)
      if (!response) {
        response = runCommand(id, signal)
        pending.set(id, response)
        // Registrado antes de quem chamou: quando `probeGpus` termina, o resultado já está aqui.
        response.then(
          (r) => settled.set(id, r),
          () => undefined
        )
      }
      return response
    }
  }

  return {
    api: wrapped,
    electronRaw: () => raw,
    registry(status) {
      const ids = settled.get(GPU_COMMAND_IDS.deviceIds)
      const sizes = settled.get(GPU_COMMAND_IDS.memorySizes)
      const idValues = ids?.kind === 'success' ? parseRegistryOutput(ids.stdout, 'MatchingDeviceId') : null
      return {
        status,
        deviceKeys: idValues ? deviceKeysFrom(idValues) : null,
        sizes: sizes?.kind === 'success' ? parseRegistryOutput(sizes.stdout, 'HardwareInformation.qwMemorySize') : null
      }
    }
  }
}
