import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AppError, toStructuredError } from '../../src/main/errors'
import { DetectionAbortedError, abortReasonOf } from '../../src/main/hardware/detection-errors'
import { DemoHardwareDetector } from '../../src/main/hardware/detectors'
import { DETECT_TIMEOUT_LIMITS, HARDWARE_FORMAT_VERSION, HardwareAdvisorService, type HardwareAdvisorDeps } from '../../src/main/hardware/hardware-advisor-service'
import { LocalHardwareDetector } from '../../src/main/hardware/local/local-hardware-detector'
import { createDataHandlers, invokeHandler } from '../../src/main/ipc-handlers'
import { uniformQuality, type HardwareDetector, type HardwareProfile, type HardwareProfileData } from '../../src/shared/hardware'
import { IpcChannels } from '../../src/shared/ipc'
import { fakeClock, tempDir } from '../support/fixtures'

/**
 * Cancelamento, prazo global, resultados tardios e revogação na análise real.
 * Detectores simulados e `hardware.json` temporário; prazos curtos injetados
 * (`detectTimeoutMs`), sem esperas reais de 15 s. O `LocalHardwareDetector`
 * só aparece com dependências simuladas; o app continua sem ele.
 */

const DECIDED_AT = '2026-10-20T09:00:00.000Z'
const CONSENT = {
  localAnalysis: { status: 'granted', decidedAt: DECIDED_AT, scope: 'device-detection' },
  serverSharing: { status: 'not-asked', decidedAt: null }
} as const

const profileData: HardwareProfileData = {
  cpu: { model: 'CPU sintética', architecture: 'x64', physicalCores: null, logicalCores: 8 },
  memory: { totalGb: 16, availableGb: 8 },
  gpus: [],
  storage: { freeGb: 100, totalGb: 500 },
  os: { platform: 'windows', version: '11 (build 26200)', architecture: 'x64' },
  acceleration: null
}

const realProfile = (collectedAt: string, model = 'CPU sintética'): HardwareProfile => {
  const data = { ...structuredClone(profileData), cpu: { ...profileData.cpu!, model } }
  return {
    ...data,
    provenance: { source: 'local-detector', detectorId: 'local-hardware', collectedAt, confidence: 'medium', quality: uniformQuality(data, 'detected') }
  }
}

/** Último perfil válido, já gravado. */
const PREVIOUS = { mode: 'real', attemptedAt: '2026-10-22T09:00:00.000Z', outcome: { kind: 'completed', profile: realProfile('2026-10-22T09:00:00.000Z') } }
/** Perfil que um detector entregaria tarde demais. */
const LATE = realProfile('2026-10-23T12:00:00.000Z', 'CPU tardia')

async function open(localDetector: HardwareDetector, extra: Partial<HardwareAdvisorDeps> = {}) {
  const dir = await tempDir()
  const filePath = join(dir, 'hardware.json')
  const original = `${JSON.stringify({ format: 'gerpro.hardware', formatVersion: HARDWARE_FORMAT_VERSION, savedAt: DECIDED_AT, data: { consent: CONSENT, lastAnalysis: PREVIOUS } }, null, 2)}\n`
  await writeFile(filePath, original)
  const now = fakeClock(Date.parse('2026-10-23T12:00:00.000Z'))
  let writes = 0
  const service = new HardwareAdvisorService({
    filePath,
    localDetector,
    demoDetector: (s) => new DemoHardwareDetector(s, now),
    now,
    writer: async (path, text) => {
      writes++
      await writeFile(path, text)
    },
    detectTimeoutMs: 30,
    ...extra
  })
  await service.init()
  return { service, filePath, original, writes: () => writes }
}

const detector = (detect: HardwareDetector['detect']): HardwareDetector => ({
  id: 'local-hardware',
  source: 'local-detector',
  availability: async () => ({ available: true, reason: null }),
  detect
})

/** Detector que só termina quando liberado. */
function gated(result: () => Promise<HardwareProfile> = async () => LATE) {
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const running = new Promise<void>((r) => (started = r))
  const d = detector(async () => {
    started()
    await gate
    return result()
  })
  return { detector: d, release: () => release(), running }
}

const isAborted = (reason: 'cancelled' | 'timeout') => (e: unknown) =>
  e instanceof AppError && e.code === 'invalid-state' && e.retryable && e.details?.['aborted'] === reason

/** Nada mudou: arquivo idêntico, sem gravações, último perfil e consentimento preservados. */
async function assertUntouched(o: Awaited<ReturnType<typeof open>>) {
  assert.equal(o.writes(), 0)
  assert.equal(await readFile(o.filePath, 'utf8'), o.original)
  const state = await o.service.getState()
  assert.deepEqual(state.consent, CONSENT)
  assert.deepEqual(state.analysis, PREVIOUS)
  assert.equal(state.status, 'completed')
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('análise real: cancelamento e prazo global', () => {
  it('cancelamento antes da conclusão: rejeita sem gravar perfil nem erro', async () => {
    const o = await open(detector(async () => Promise.reject(new DetectionAbortedError('cancelled'))))
    await assert.rejects(o.service.analyze({ mode: 'real' }), isAborted('cancelled'))
    await assertUntouched(o)
  })

  it('prazo global esgotado (detector que respeita o sinal): o último perfil válido é mantido', async () => {
    const o = await open(
      detector(
        (signal) =>
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DetectionAbortedError(abortReasonOf(signal))), { once: true }))
      )
    )
    await assert.rejects(o.service.analyze({ mode: 'real' }), isAborted('timeout'))
    await assertUntouched(o)
  })

  it('detector que ignora o sinal não prende a análise: prazo encerra em pouco tempo', async () => {
    const o = await open(detector(() => new Promise(() => undefined)))
    const started = Date.now()
    await assert.rejects(o.service.analyze({ mode: 'real' }), isAborted('timeout'))
    assert.ok(Date.now() - started < 1_000)
    await assertUntouched(o)
  })

  it('detector que falha com erro comum depois do prazo: tratado como interrupção, sem registro de erro', async () => {
    const o = await open(detector((signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('socket fechado')), { once: true }))))
    await assert.rejects(o.service.analyze({ mode: 'real' }), isAborted('timeout'))
    await assertUntouched(o)
  })

  it('resultado entregue depois do prazo é descartado, mesmo chegando mais tarde', async () => {
    const o = await open(detector(() => tick(80).then(() => LATE)))
    await assert.rejects(o.service.analyze({ mode: 'real' }), isAborted('timeout'))
    await tick(120) // o resultado tardio chega aqui
    await assertUntouched(o)
    const state = await o.service.getState()
    assert.ok(state.analysis?.outcome.kind === 'completed')
    assert.notEqual(state.analysis.outcome.profile.cpu?.model, 'CPU tardia')
  })

  it('resultado entregue no próprio aviso de interrupção também é descartado', async () => {
    // O detector resolve com um perfil válido assim que o sinal dispara.
    const o = await open(detector((signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(LATE), { once: true }))))
    await assert.rejects(o.service.analyze({ mode: 'real' }), isAborted('timeout'))
    await assertUntouched(o)
  })

  it('análises simultâneas compartilham a interrupção: nenhuma grava', async () => {
    const o = await open(detector(() => new Promise(() => undefined)))
    const results = await Promise.allSettled([o.service.analyze({ mode: 'real' }), o.service.analyze({ mode: 'real' })])
    assert.ok(results.every((r) => r.status === 'rejected' && isAborted('timeout')(r.reason)))
    await assertUntouched(o)
  })

  it('depois de uma interrupção, uma nova análise funciona normalmente', async () => {
    let calls = 0
    const o = await open(detector(async () => (++calls === 1 ? Promise.reject(new DetectionAbortedError('cancelled')) : LATE)))
    await assert.rejects(o.service.analyze({ mode: 'real' }), isAborted('cancelled'))
    const state = await o.service.analyze({ mode: 'real' })
    assert.ok(state.analysis?.outcome.kind === 'completed')
    assert.equal(state.analysis.outcome.profile.cpu?.model, 'CPU tardia')
    assert.equal(o.writes(), 1)
  })
})

describe('análise real: falhas que continuam gravadas', () => {
  it('falha comum do detector mantém o tratamento atual: registro de erro gravado', async () => {
    const o = await open(detector(async () => Promise.reject(new Error('Falha do detector.'))))
    const state = await o.service.analyze({ mode: 'real' })
    assert.deepEqual(state.analysis?.outcome, { kind: 'error', message: 'Falha do detector.' })
    assert.equal(o.writes(), 1)
    assert.deepEqual(state.consent, CONSENT)
  })

  it('falha parcial de sondagem não é cancelamento: perfil parcial concluído e gravado', async () => {
    const local = new LocalHardwareDetector({
      storageTarget: null,
      platform: 'win32',
      cpu: { cpus: () => Array.from({ length: 8 }, () => ({ model: 'CPU sintética' })), machine: () => 'x86_64' },
      memory: { totalmem: () => 16 * 1024 ** 3, freemem: () => 8 * 1024 ** 3, platform: () => 'win32' },
      os: { platform: () => 'win32', release: () => '10.0.26200', version: () => 'Windows 11 Pro', machine: () => 'x86_64' },
      gpu: { getGPUInfo: async () => Promise.reject(new Error('gpu process crashed')) }
    })
    const o = await open(local, { detectTimeoutMs: 5_000 })
    const state = await o.service.analyze({ mode: 'real' })
    assert.ok(state.analysis?.outcome.kind === 'completed')
    assert.equal(state.analysis.outcome.profile.gpus, null)
    assert.equal(state.analysis.outcome.profile.storage, null)
    assert.equal(state.analysis.outcome.profile.cpu?.logicalCores, 8)
    assert.equal(o.writes(), 1)
  })
})

describe('análise real: revogação e concorrência', () => {
  it('revogação durante a análise: resultado descartado, revogação gravada, último perfil intacto', async () => {
    const g = gated()
    const o = await open(g.detector, { detectTimeoutMs: 5_000 })
    const analysis = o.service.analyze({ mode: 'real' })
    await g.running
    await o.service.setLocalConsent({ granted: false })
    g.release()
    await assert.rejects(analysis, (e: unknown) => e instanceof AppError && e.code === 'invalid-state' && e.details === undefined)
    const file = JSON.parse(await readFile(o.filePath, 'utf8'))
    assert.equal(file.data.consent.localAnalysis.status, 'revoked')
    assert.deepEqual(file.data.lastAnalysis, PREVIOUS)
    assert.equal(o.writes(), 1) // só a revogação
  })

  it('revogada e concedida de novo durante a análise: o resultado da autorização anterior é descartado', async () => {
    const g = gated()
    const o = await open(g.detector, { detectTimeoutMs: 5_000, grantScope: 'device-detection' })
    const analysis = o.service.analyze({ mode: 'real' })
    await g.running
    await o.service.setLocalConsent({ granted: false })
    await o.service.setLocalConsent({ granted: true })
    g.release()
    await assert.rejects(analysis, (e: unknown) => e instanceof AppError && e.code === 'invalid-state' && /mudou durante a análise/.test(e.message))
    const state = await o.service.getState()
    assert.equal(state.consent.localAnalysis.status, 'granted')
    assert.notEqual(state.consent.localAnalysis.decidedAt, DECIDED_AT)
    assert.deepEqual(state.analysis, PREVIOUS)
  })

  it('revogação pedida junto com a liberação do detector: em qualquer ordem, nada da análise é gravado', async () => {
    const g = gated()
    const o = await open(g.detector, { detectTimeoutMs: 5_000 })
    const analysis = o.service.analyze({ mode: 'real' })
    await g.running
    const revoke = o.service.setLocalConsent({ granted: false })
    g.release()
    const [a, r] = await Promise.allSettled([analysis, revoke])
    assert.equal(a.status, 'rejected')
    assert.equal(r.status, 'fulfilled')
    const file = JSON.parse(await readFile(o.filePath, 'utf8'))
    assert.equal(file.data.consent.localAnalysis.status, 'revoked')
    assert.deepEqual(file.data.lastAnalysis, PREVIOUS)
  })

  it('revogação durante uma análise que depois estoura o prazo: só a revogação é gravada', async () => {
    const o = await open(detector(() => new Promise(() => undefined)), { detectTimeoutMs: 50 })
    const analysis = o.service.analyze({ mode: 'real' })
    await o.service.setLocalConsent({ granted: false, deleteData: true })
    await assert.rejects(analysis, isAborted('timeout'))
    const file = JSON.parse(await readFile(o.filePath, 'utf8'))
    assert.equal(file.data.consent.localAnalysis.status, 'revoked')
    assert.equal(file.data.lastAnalysis, null) // excluído a pedido; a análise não o recriou
    assert.equal(o.writes(), 1)
  })
})

describe('análise real: erro de interrupção no IPC', () => {
  it('serializa como `invalid-state`, repetível, com `details.aborted`, sem dados internos', async () => {
    const o = await open(detector(() => new Promise(() => undefined)))
    const handlers = createDataHandlers({ hardware: o.service } as never)
    const result = await invokeHandler(IpcChannels.hardwareAnalyze, handlers[IpcChannels.hardwareAnalyze], [{ mode: 'real' }])
    // O IPC copia o valor por clonagem estruturada.
    const sent = structuredClone(result)
    assert.deepEqual(sent, {
      ok: false,
      error: {
        code: 'invalid-state',
        message: 'A análise de hardware excedeu o tempo limite. Nada foi alterado; a análise anterior foi mantida.',
        retryable: true,
        details: { aborted: 'timeout' }
      }
    })
    await assertUntouched(o)

    const c = await open(detector(async () => Promise.reject(new DetectionAbortedError('cancelled'))))
    const error = await c.service.analyze({ mode: 'real' }).then(
      () => null,
      (e: unknown) => e
    )
    assert.deepEqual(structuredClone(toStructuredError(error)), {
      code: 'invalid-state',
      message: 'A análise de hardware foi cancelada. Nada foi alterado; a análise anterior foi mantida.',
      retryable: true,
      details: { aborted: 'cancelled' }
    })
  })
})

describe('prazo global injetável', () => {
  it('aceita só inteiros na faixa permitida; o padrão de produção continua 15 s', async () => {
    const base = { filePath: join(await tempDir(), 'hardware.json'), localDetector: detector(async () => LATE), demoDetector: () => detector(async () => LATE) }
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, DETECT_TIMEOUT_LIMITS.max + 1]) {
      assert.throws(() => new HardwareAdvisorService({ ...base, detectTimeoutMs: bad }), RangeError, String(bad))
    }
    for (const ok of [DETECT_TIMEOUT_LIMITS.min, 30, DETECT_TIMEOUT_LIMITS.max, undefined]) {
      assert.doesNotThrow(() => new HardwareAdvisorService({ ...base, detectTimeoutMs: ok }))
    }
    const src = await readFile(join(import.meta.dirname, '../../src/main/hardware/hardware-advisor-service.ts'), 'utf8')
    assert.match(src, /const DETECT_TIMEOUT_MS = 15_000/)
    // Produção não passa `detectTimeoutMs`.
    const services = await readFile(join(import.meta.dirname, '../../src/main/services/index.ts'), 'utf8')
    assert.ok(!/detectTimeoutMs/.test(services))
  })
})
