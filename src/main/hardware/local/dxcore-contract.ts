/**
 * Protocolo do auxiliar DXCore (D54): contrato entre o executável auxiliar
 * (código-fonte em `native/dxcore-helper/`; binário só local, fora do git),
 * o executor dedicado do auxiliar empacotado (D56), o parser e a sondagem de
 * GPU.
 *
 * Só especificação: tipos e constantes, sem lógica e sem uso pelo app. O
 * hash esperado é `null` e nada aqui o executa. As
 * regras completas (validação, lista de GPUs, classificação, VRAM) estão em
 * `docs/04-hardware-advisor.md`, seção "Auxiliar DXCore (protocolo 1)".
 *
 * Arquitetura revisada (6C.1.2): o Electron 45 não informa o LUID, então não
 * há associação DXCore ↔ Electron. Com resposta válida e coerente, o DXCore é
 * a fonte da lista de GPUs, e cada GPU leva só atributos do seu próprio
 * registro de adaptador; senão, a lista vem do Electron, como antes, com
 * `sharedMemory: null`. As duas listas nunca se misturam.
 *
 * Privacidade: LUID e identificadores PCI só existem em memória, durante a
 * coleta. Nenhum tipo de saída do parser para fora da sondagem os carrega;
 * diagnósticos usam apenas os motivos enumerados abaixo.
 */

// ── Protocolo ────────────────────────────────────────────────────────────────

/** Identificador fixo do protocolo, obrigatório na resposta. */
export const DXCORE_PROTOCOL = 'gerpro.dxcore-adapters'

/**
 * Versão do protocolo. Qualquer outra é recusada (`unsupported-version`).
 * Continua 1 com `description`: nenhum auxiliar foi compilado ou distribuído.
 * Depois da primeira distribuição, qualquer mudança de campo exige nova versão.
 */
export const DXCORE_PROTOCOL_VERSION = 1

/**
 * Argumentos fixos do auxiliar. Ele recusa qualquer outra linha de comando
 * (código `usage`) e só responde na versão pedida.
 */
export const DXCORE_HELPER_ARGS = ['--protocol', '1'] as const

/** Maior inteiro sem sinal de 64 bits. */
export const UINT64_MAX = 2n ** 64n - 1n

export const DXCORE_LIMITS = {
  /** Adaptadores na resposta; acima disso a resposta inteira é recusada. */
  maxAdapters: 16,
  /** Bytes de stdout (limite do executor dedicado; acima, `output-limit`). Cabe o pior caso com descrições escapadas. */
  maxOutputBytes: 65_536,
  /** Prazo do processo; o executor encerra o auxiliar ao estourar. */
  timeoutMs: 3_000,
  /** `vendorId`/`deviceId`: inteiros sem sinal de 32 bits (Qualcomm usa `0x4D4F4351`). */
  maxHardwareId: 0xffff_ffff,
  /** Dígitos de um inteiro de 64 bits em decimal (`18446744073709551615`). */
  maxUint64Digits: 20,
  /** `description`: unidades UTF-16 depois de decodificar o JSON; acima, a resposta é recusada. */
  maxDescriptionLength: 128
} as const

/** LUID canônico: parte alta e parte baixa em hexadecimal maiúsculo, 8 dígitos cada. */
export const LUID_PATTERN = /^[0-9A-F]{8}:[0-9A-F]{8}$/
/** LUID nulo: não identifica adaptador. */
export const LUID_ZERO = '00000000:00000000'
/** Inteiro de 64 bits sem sinal em decimal, sem zeros à esquerda (o teto é conferido com `UINT64_MAX`). */
export const UINT64_DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,19})$/

/**
 * Sanitização da descrição (só exibição, nunca associação). Depois de remover
 * `DESCRIPTION_STRIP` e normalizar espaços, a descrição vira `null` se ficar
 * vazia ou se casar com qualquer padrão de `DESCRIPTION_REJECT`: caminhos,
 * identificadores de dispositivo, GUIDs e sequências hexadecimais longas.
 */
export const DESCRIPTION_STRIP = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g
export const DESCRIPTION_REJECT: readonly RegExp[] = [
  /\\/,
  /^\//,
  /\b[a-z]:\//i,
  /\b(ven|dev|subsys|rev)_[0-9a-f]/i,
  /\b(pci|acpi|root|usb)[\\#]/i,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /[0-9a-f]{12,}/i
]

// ── Resposta do auxiliar (formato na saída padrão) ──────────────────────────

/** Inteiro de 64 bits sem sinal em decimal (bytes). Nunca número JSON. */
export type Uint64Decimal = string
/** LUID no formato `LUID_PATTERN`. */
export type LuidText = string

/**
 * Um adaptador como o auxiliar o escreve. Todas as chaves são obrigatórias;
 * `null` = propriedade não suportada pelo driver ou não lida. Chave ausente
 * ou desconhecida invalida a resposta inteira.
 */
export interface DxcoreWireAdapter {
  /** `InstanceLuid`. Só para conferir que a lista não repete adaptadores. */
  luid: LuidText | null
  /** `HardwareID.vendorID` (inteiro, 0 a `maxHardwareId`). */
  vendorId: number | null
  /** `HardwareID.deviceID` (inteiro, 0 a `maxHardwareId`). */
  deviceId: number | null
  /**
   * `DriverDescription`: nome comercial, só para exibição. Até
   * `maxDescriptionLength` unidades UTF-16; caracteres fora do ASCII em
   * escapes `\uXXXX`. Nunca usado para associar adaptadores.
   */
  description: string | null
  /** `IsHardware`. */
  isHardware: boolean | null
  /** `IsIntegrated`. */
  isIntegrated: boolean | null
  /** `DedicatedAdapterMemory`, em bytes. */
  dedicatedAdapterMemory: Uint64Decimal | null
  /** `DedicatedSystemMemory`, em bytes. Só diagnóstico: nunca vira VRAM. */
  dedicatedSystemMemory: Uint64Decimal | null
  /** `SharedSystemMemory`, em bytes. Só diagnóstico: nunca vira VRAM. */
  sharedSystemMemory: Uint64Decimal | null
}

/** Resposta completa: um único objeto JSON, ASCII, sem BOM, com quebra de linha final opcional. */
export interface DxcoreWireResponse {
  protocol: typeof DXCORE_PROTOCOL
  version: typeof DXCORE_PROTOCOL_VERSION
  /** Adaptadores com o atributo `D3D11_GRAPHICS`, em qualquer ordem (a ordem não tem significado). */
  adapters: DxcoreWireAdapter[]
}

export const DXCORE_WIRE_ADAPTER_KEYS = [
  'luid',
  'vendorId',
  'deviceId',
  'description',
  'isHardware',
  'isIntegrated',
  'dedicatedAdapterMemory',
  'dedicatedSystemMemory',
  'sharedSystemMemory'
] as const satisfies ReadonlyArray<keyof DxcoreWireAdapter>

export const DXCORE_WIRE_RESPONSE_KEYS = ['protocol', 'version', 'adapters'] as const satisfies ReadonlyArray<keyof DxcoreWireResponse>

// ── Resposta interpretada (só em memória, dentro da sondagem) ───────────────

/** Adaptador validado: memórias em `bigint` (bytes), descrição já sanitizada. */
export interface DxcoreAdapter {
  luid: LuidText | null
  vendorId: number | null
  deviceId: number | null
  description: string | null
  isHardware: boolean | null
  isIntegrated: boolean | null
  dedicatedAdapterMemory: bigint | null
  dedicatedSystemMemory: bigint | null
  sharedSystemMemory: bigint | null
}

/** Motivos de recusa da resposta inteira (formato incompatível ou inválido). */
export type DxcoreResponseError =
  | 'output-too-large'
  | 'empty-output'
  | 'non-ascii'
  | 'not-json'
  | 'not-object'
  | 'protocol-mismatch'
  | 'unsupported-version'
  | 'missing-field'
  | 'unknown-field'
  /** Chave repetida no mesmo objeto (o `JSON.parse` ficaria só com a última). */
  | 'duplicate-field'
  | 'invalid-type'
  | 'invalid-luid'
  | 'invalid-hardware-id'
  | 'invalid-uint64'
  | 'invalid-description'
  | 'too-many-adapters'

export type DxcoreParseResult = { ok: true; adapters: DxcoreAdapter[] } | { ok: false; reason: DxcoreResponseError }

// ── Processo auxiliar ───────────────────────────────────────────────────────

/**
 * Códigos de saída do auxiliar. Só `ok` traz resposta na saída padrão; os
 * demais não escrevem nada nela. Qualquer outro código (inclusive de falha
 * do processo, como `0xC0000005`) é `crashed`.
 */
export const DXCORE_EXIT_CODES = {
  ok: 0,
  /** `dxcore.dll` ausente na pasta do sistema ou sem `DXCoreCreateAdapterFactory` (Windows sem DXCore). */
  dxcoreUnavailable: 10,
  /** `DXCoreCreateAdapterFactory` falhou. */
  factoryFailed: 11,
  /** Falha ao criar ou percorrer a lista de adaptadores. */
  enumerationFailed: 12,
  /** Falha ao escrever a resposta. */
  outputFailed: 13,
  /** Linha de comando diferente de `DXCORE_HELPER_ARGS`. */
  usage: 64
} as const

/** Situação da fonte DXCore numa coleta, sem dados do sistema. */
export type DxcoreSourceStatus =
  | 'not-queried'
  | 'ok'
  /** Plataforma não Windows, auxiliar ausente ou sem permissão de execução. */
  | 'helper-unavailable'
  /** Auxiliar presente mas recusado antes de executar: link, redirecionamento, tamanho, hash ausente ou diferente, ou arquivo trocado durante a execução. */
  | 'helper-rejected'
  | 'dxcore-unavailable'
  | 'factory-failed'
  | 'enumeration-failed'
  | 'output-failed'
  | 'usage'
  | 'crashed'
  | 'timeout'
  | 'cancelled'
  | 'output-limit'
  /** Resposta recusada pelo parser; o motivo fica em `DxcoreResponseError`. */
  | 'invalid-output'

// ── Lista de GPUs: fonte principal e alternativa ────────────────────────────

/**
 * Fonte da lista de GPUs de uma coleta, decidida uma vez para a lista toda.
 * Atributos de uma GPU vêm só da fonte da lista (o Registro só complementa a
 * VRAM, ver `VramDecision`); nunca de outra lista, por posição ou por nome.
 */
export type GpuListSource = 'dxcore' | 'electron'

/**
 * Motivo de a lista do DXCore não ser usada; a coleta cai para a lista do
 * Electron, igual à de hoje, com `sharedMemory: null`. Condições, nesta ordem:
 * fonte `ok`; todo adaptador com `isHardware` definido; ao menos um de
 * hardware; todo adaptador de hardware com `vendorId`/`deviceId` e LUID não
 * nulo, sem LUID repetido; e, se o Electron também listou adaptadores, a
 * mesma composição (quantidade de cada par fabricante/dispositivo, sem o
 * renderizador por software). A composição só confere a lista inteira; não
 * associa atributos de uma GPU a outra.
 */
export type DxcoreListRejection =
  | 'source-unavailable'
  | 'hardware-flag-unknown'
  | 'no-hardware-adapters'
  | 'hardware-id-unknown'
  | 'luid-invalid'
  | 'luid-duplicate'
  | 'lists-disagree'

// ── Classificação (`sharedMemory`) ──────────────────────────────────────────

/** Motivo de `sharedMemory` ficar `null` numa GPU da lista do DXCore. */
export type MemoryClassificationGap =
  /** Adaptador sem `isHardware === true` (a seleção da lista já o exclui). */
  | 'not-hardware'
  /** `IsIntegrated` não suportado ou não lido. */
  | 'integrated-unknown'
  /** `IsIntegrated === false` sem `DedicatedAdapterMemory` informado. */
  | 'dedicated-memory-unknown'
  /** `IsIntegrated === false` com memória dedicada fora de `VRAM_LIMITS` (inclusive 0). */
  | 'dedicated-memory-conflict'

export type MemoryClassification =
  | { sharedMemory: true; evidence: 'dxcore-integrated' }
  | { sharedMemory: false; evidence: 'dxcore-discrete-with-dedicated-memory' }
  | { sharedMemory: null; reason: MemoryClassificationGap | 'dxcore-not-used' }

// ── VRAM (política aprovada na 6C.1.1, ainda não implementada; tolerância provisória) ──

/**
 * Concordância entre a VRAM do Registro e a do DXCore: diferença de até 5% do
 * maior valor, com mínimo de 64 MiB (reservas do driver e arredondamentos).
 */
export const VRAM_AGREEMENT = { relativePercent: 5n, minBytes: 64n * 1024n ** 2n } as const

/**
 * Lista do DXCore: só GPU classificada `false` tem VRAM. Registro associado
 * (par fabricante/dispositivo único na lista do DXCore e no Registro) e
 * concordante: vale o Registro (`registry-confirmed`); divergente:
 * indisponível. Registro sem associação inequívoca (inclusive GPUs idênticas)
 * ou indisponível: vale a memória dedicada do próprio adaptador (`dxcore`).
 * Lista do Electron: regra atual (`registry`, par PCI único, D51).
 */
export type VramDecision =
  | { vramBytes: bigint; source: 'registry' | 'dxcore' | 'registry-confirmed' }
  | { vramBytes: null; reason: 'no-source' | 'sources-diverge' | 'not-dedicated' | 'out-of-range' }
