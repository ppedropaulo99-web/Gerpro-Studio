import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AppError } from '../../src/main/errors'
import { DemoHardwareDetector, UnimplementedLocalDetector } from '../../src/main/hardware/detectors'
import { HardwareAdvisorService } from '../../src/main/hardware/hardware-advisor-service'
import { createDataHandlers, invokeHandler } from '../../src/main/ipc-handlers'
import { createServices } from '../../src/main/services'
import { uniformQuality, type DemoScenario, type HardwareAdvisorState, type HardwareDetector, type HardwareProfile, type LocalAnalysisScope } from '../../src/shared/hardware'
import { IpcChannels } from '../../src/shared/ipc'
import { agentDraft, fakeClock, tempDir } from '../support/fixtures'

const isCode = (code: string) => (e: unknown) => e instanceof AppError && e.code === code

async function setup(
  overrides: { localDetector?: HardwareDetector; demoDetector?: (s: DemoScenario) => HardwareDetector; grantScope?: LocalAnalysisScope } = {}
) {
  const dir = await tempDir()
  const filePath = join(dir, 'hardware.json')
  const now = fakeClock()
  const make = () =>
    new HardwareAdvisorService({
      filePath,
      localDetector: overrides.localDetector ?? new UnimplementedLocalDetector(),
      demoDetector: overrides.demoDetector ?? ((s) => new DemoHardwareDetector(s, now)),
      grantScope: overrides.grantScope,
      now
    })
  const service = make()
  await service.init()
  return { dir, filePath, service, reopen: async () => (await make().init(), make()) }
}

describe('Hardware Advisor: consentimento', () => {
  it('começa sem autorização e sem dados; o app funciona assim', async () => {
    const { service } = await setup()
    const s = await service.getState()
    assert.equal(s.status, 'not-authorized')
    assert.equal(s.consent.localAnalysis.status, 'not-asked')
    assert.equal(s.consent.serverSharing.status, 'not-asked')
    assert.equal(s.analysis, null)
    assert.equal(s.hasStoredData, false)
    assert.equal(s.detectors.real.available, false)
  })

  it('sem autorização, nenhuma análise é executada (nem demonstrativa)', async () => {
    let called = false
    const spy: HardwareDetector = {
      id: 'spy',
      source: 'demo',
      availability: async () => ({ available: true, reason: null }),
      detect: async () => {
        called = true
        throw new Error('não deveria ser chamado')
      }
    }
    const { service } = await setup({ demoDetector: () => spy })
    await assert.rejects(service.analyze({ mode: 'demo' }), isCode('invalid-state'))
    await service.setLocalConsent({ granted: false })
    assert.equal((await service.getState()).consent.localAnalysis.status, 'denied')
    await assert.rejects(service.analyze({ mode: 'demo' }), isCode('invalid-state'))
    assert.equal(called, false)
  })

  it('autorizar → aguardando análise; persiste após reiniciar', async () => {
    const { service, reopen } = await setup()
    const s = await service.setLocalConsent({ granted: true })
    assert.equal(s.status, 'awaiting-analysis')
    assert.ok(s.consent.localAnalysis.decidedAt)
    const again = await (await reopen()).getState()
    assert.equal(again.consent.localAnalysis.status, 'granted')
    assert.equal(again.consent.serverSharing.status, 'not-asked', 'autorização local não autoriza envio ao servidor')
  })

  it('revogar mantém os dados ocultos; revogar com exclusão apaga', async () => {
    const { service, filePath } = await setup()
    await service.setLocalConsent({ granted: true })
    await service.analyze({ mode: 'demo' })

    const revoked = await service.setLocalConsent({ granted: false })
    assert.equal(revoked.consent.localAnalysis.status, 'revoked')
    assert.equal(revoked.status, 'not-authorized')
    assert.equal(revoked.analysis, null, 'dados não são exibidos sem autorização')
    assert.equal(revoked.hasStoredData, true)

    await service.setLocalConsent({ granted: true })
    assert.equal((await service.getState()).status, 'completed')
    const wiped = await service.setLocalConsent({ granted: false, deleteData: true })
    assert.equal(wiped.hasStoredData, false)
    const file = JSON.parse(await readFile(filePath, 'utf8'))
    assert.equal(file.data.lastAnalysis, null)
    assert.equal(file.data.consent.localAnalysis.status, 'revoked')
  })

  it('apagar dados funciona com ou sem autorização e mantém o consentimento', async () => {
    const { service } = await setup()
    await service.setLocalConsent({ granted: true })
    await service.analyze({ mode: 'demo' })
    await service.setLocalConsent({ granted: false })
    const s = await service.deleteData()
    assert.equal(s.hasStoredData, false)
    assert.equal(s.consent.localAnalysis.status, 'revoked')
  })

  it('esta versão grava autorizações com escopo apenas demonstrativo', async () => {
    const { service, reopen } = await setup()
    assert.equal((await service.setLocalConsent({ granted: true })).consent.localAnalysis.scope, 'demo-only')
    assert.equal((await service.setLocalConsent({ granted: false })).consent.localAnalysis.scope, null)
    await service.setLocalConsent({ granted: true })
    assert.equal((await (await reopen()).getState()).consent.localAnalysis.scope, 'demo-only')
  })

  it('autorização demonstrativa NÃO é reutilizada por um detector real disponível', async () => {
    let read = false
    const realDetector: HardwareDetector = {
      id: 'local-futuro',
      source: 'local-detector',
      availability: async () => ({ available: true, reason: null }),
      detect: async (signal) => {
        read = true
        const { provenance: _p, ...data } = await new DemoHardwareDetector('workstation').detect(signal)
        return { ...data, provenance: { source: 'local-detector', detectorId: 'local-futuro', collectedAt: new Date().toISOString(), confidence: 'high', quality: uniformQuality(data, 'detected') } }
      }
    }
    // Autorizado na versão demonstrativa; depois o app passa a ter detecção real.
    const old = await setup({ localDetector: realDetector })
    await old.service.setLocalConsent({ granted: true })
    await assert.rejects(old.service.analyze({ mode: 'real' }), (e: unknown) => e instanceof AppError && e.code === 'invalid-state' && /nova autorização/.test(e.message))
    assert.equal(read, false, 'o hardware não foi lido')
    assert.equal((await old.service.getState()).hasStoredData, false)
    // A demonstração continua funcionando com a mesma autorização.
    assert.equal((await old.service.analyze({ mode: 'demo' })).status, 'completed')

    // Com uma autorização específica para leitura real, a análise acontece.
    const fresh = await setup({ localDetector: realDetector, grantScope: 'device-detection' })
    await fresh.service.setLocalConsent({ granted: true })
    assert.equal((await fresh.service.analyze({ mode: 'real' })).status, 'completed')
    assert.equal(read, true)
  })

  it('revogação durante a análise descarta o resultado', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow: HardwareDetector = {
      id: 'demo-slow',
      source: 'demo',
      availability: async () => ({ available: true, reason: null }),
      detect: async (signal) => {
        await gate
        return new DemoHardwareDetector('workstation').detect(signal)
      }
    }
    const { service } = await setup({ demoDetector: () => slow })
    await service.setLocalConsent({ granted: true })
    const analysis = service.analyze({ mode: 'demo' })
    await new Promise((r) => setTimeout(r, 5))
    await service.setLocalConsent({ granted: false })
    release()
    await assert.rejects(analysis, isCode('invalid-state'))
    assert.equal((await service.getState()).hasStoredData, false)
  })
})

describe('Hardware Advisor: análise', () => {
  async function authorized(o: Parameters<typeof setup>[0] = {}) {
    const ctx = await setup(o)
    await ctx.service.setLocalConsent({ granted: true })
    return ctx
  }

  it('detecção real: indisponível nesta etapa, sem inventar dados', async () => {
    const { service } = await authorized()
    const s = await service.analyze({ mode: 'real' })
    assert.equal(s.status, 'unavailable')
    assert.equal(s.analysis?.outcome.kind, 'unavailable')
  })

  it('demonstração concluída: perfil marcado como fictício', async () => {
    const { service } = await authorized()
    const s = await service.analyze({ mode: 'demo', scenario: 'workstation' })
    assert.equal(s.status, 'completed')
    assert.ok(s.analysis?.outcome.kind === 'completed' && s.analysis.outcome.profile.provenance.source === 'demo')
  })

  it('cenários de erro e dados desatualizados', async () => {
    const { service } = await authorized()
    assert.equal((await service.analyze({ mode: 'demo', scenario: 'error' })).status, 'error')
    assert.equal((await service.analyze({ mode: 'demo', scenario: 'stale' })).status, 'stale')
  })

  it('perfil inválido de um detector vira erro, não dado gravado', async () => {
    const broken: HardwareDetector = {
      id: 'broken',
      source: 'local-detector',
      availability: async () => ({ available: true, reason: null }),
      detect: async () => ({ cpu: { model: '' } }) as unknown as HardwareProfile
    }
    const { service } = await authorized({ localDetector: broken, grantScope: 'device-detection' })
    const s = await service.analyze({ mode: 'real' })
    assert.equal(s.status, 'error')
    assert.match(s.analysis?.outcome.kind === 'error' ? s.analysis.outcome.message : '', /Perfil inválido/)
  })

  it('detector demonstrativo que tenta se passar por real é recusado', async () => {
    const liar: HardwareDetector = {
      id: 'liar',
      source: 'demo',
      availability: async () => ({ available: true, reason: null }),
      detect: async (signal) => {
        const { provenance: _p, ...data } = await new DemoHardwareDetector('workstation').detect(signal)
        return { ...data, provenance: { source: 'local-detector', detectorId: 'x', collectedAt: new Date().toISOString(), confidence: 'high', quality: uniformQuality(data, 'detected') } }
      }
    }
    const { service } = await authorized({ demoDetector: () => liar })
    assert.equal((await service.analyze({ mode: 'demo' })).status, 'error')
  })

  it('arquivo corrompido volta ao padrão seguro: sem autorização e sem dados', async () => {
    const { filePath, reopen } = await setup()
    await writeFile(filePath, JSON.stringify({ format: 'gerpro.hardware', formatVersion: 1, savedAt: 'x', data: { consent: { localAnalysis: 'sim' } } }))
    const s = await (await reopen()).getState()
    assert.equal(s.status, 'not-authorized')
    assert.equal(s.hasStoredData, false)
  })
})

describe('Hardware Advisor: integração com os serviços existentes', () => {
  it('IPC valida argumentos e os demais serviços seguem funcionando', async () => {
    const dir = await tempDir()
    const services = await createServices(dir, { stepDelayMs: 1 })
    const handlers = createDataHandlers(services)
    const call = (ch: keyof typeof handlers, ...args: unknown[]) => invokeHandler(ch, handlers[ch], args)
    try {
      const initial = await call(IpcChannels.hardwareGetState)
      assert.ok(initial.ok && (initial.data as HardwareAdvisorState).status === 'not-authorized')
      const bad = await call(IpcChannels.hardwareSetLocalConsent, { granted: 'sim' })
      assert.equal(!bad.ok && bad.error.code, 'validation')
      const extra = await call(IpcChannels.hardwareDeleteData, 'tudo')
      assert.equal(!extra.ok && extra.error.code, 'validation')
      const blocked = await call(IpcChannels.hardwareAnalyze, { mode: 'demo' })
      assert.equal(!blocked.ok && blocked.error.code, 'invalid-state')

      assert.ok((await call(IpcChannels.hardwareSetLocalConsent, { granted: true })).ok)
      assert.ok((await call(IpcChannels.hardwareAnalyze, { mode: 'demo', scenario: 'modest' })).ok)

      // Agentes, configurações e execuções não são afetados.
      assert.ok((await call(IpcChannels.agentsCreate, agentDraft())).ok)
      assert.ok((await call(IpcChannels.settingsUpdate, { general: { density: 'compact' } })).ok)
      assert.ok((await call(IpcChannels.runsStartDemo, { agentId: 'assistente-geral', scenario: 'success' })).ok)
    } finally {
      services.runs.dispose()
    }
  })
})
