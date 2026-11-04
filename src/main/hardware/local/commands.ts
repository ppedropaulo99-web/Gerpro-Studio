import { defineCommands } from './command-runner'

/**
 * Catálogo de produção do CommandRunner: as únicas consultas que os
 * detectores de hardware podem executar. Só leitura, argumentos fixos.
 *
 * Nada aqui é executado ao importar; quem executa é `CommandRunner.run()`,
 * chamado por um detector em uma análise autorizada.
 */

/** Classe de dispositivos de vídeo (Display adapters) no Registro. */
export const DISPLAY_CLASS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'

export const GPU_COMMAND_IDS = {
  /** `MatchingDeviceId` de cada adaptador (ex.: `pci\ven_10de&dev_2504`). */
  deviceIds: 'gpu.registry-device-ids',
  /** `HardwareInformation.qwMemorySize`: memória dedicada em bytes (REG_QWORD, 64 bits). */
  memorySizes: 'gpu.registry-memory-sizes'
} as const

export type GpuCommandId = (typeof GPU_COMMAND_IDS)[keyof typeof GPU_COMMAND_IDS]

const REGISTRY_QUERY = { executable: 'reg', timeoutMs: 5_000, maxOutputBytes: 65_536 } as const

export const HARDWARE_COMMANDS = defineCommands([
  { ...REGISTRY_QUERY, id: GPU_COMMAND_IDS.deviceIds, args: ['query', DISPLAY_CLASS_KEY, '/s', '/v', 'MatchingDeviceId'] },
  { ...REGISTRY_QUERY, id: GPU_COMMAND_IDS.memorySizes, args: ['query', DISPLAY_CLASS_KEY, '/s', '/v', 'HardwareInformation.qwMemorySize'] }
])
