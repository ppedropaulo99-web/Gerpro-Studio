import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AppError } from '../../src/main/errors'
import { DemoHardwareDetector, UnimplementedLocalDetector } from '../../src/main/hardware/detectors'
import { HARDWARE_FORMAT_VERSION, HardwareAdvisorService } from '../../src/main/hardware/hardware-advisor-service'
import { writeFileAtomic } from '../../src/main/storage/atomic-file'
import { VersionedStore } from '../../src/main/storage/versioned-store'
import { uniformQuality, type HardwareDetector } from '../../src/shared/hardware'
import { fakeClock, tempDir } from '../support/fixtures'

/**
 * `hardware.json` gravado pela v1 do app: mesmo envelope e mesmos perfis que o
 * detector demonstrativo da v1 produzia (sem `provenance.quality`).
 */
const DECIDED_AT = '2026-10-20T09:00:00.000Z'
const COLLECTED_AT = '2026-10-22T09:00:00.000Z'

const v1Consent = (scope: 'demo-only' | 'device-detection' | null = 'demo-only', status = 'granted') => ({
  localAnalysis: { status, decidedAt: DECIDED_AT, scope },
  serverSharing: { status: 'not-asked', decidedAt: null }
})

const v1PartialProfile = {
  cpu: { model: 'CPU Demonstrativa M8 (fictícia)', architecture: 'x64', physicalCores: 8, logicalCores: 16 },
  memory: { totalGb: 16, availableGb: 9.1 },
  gpus: null,
  storage: null,
  os: { platform: 'windows', version: '11 (demonstração)', architecture: 'x64' },
  acceleration: null,
  provenance: { source: 'demo', detectorId: 'demo-partial', collectedAt: COLLECTED_AT, confidence: 'low' }
}

const v1WorkstationProfile = {
  cpu: { model: 'CPU Demonstrativa X12 (fictícia)', architecture: 'x64', physicalCores: 12, logicalCores: 24 },
  memory: { totalGb: 32, availableGb: 21.5 },
  gpus: [{ vendor: 'other', model: 'GPU Demonstrativa G12 (fictícia)', vramGb: 12, sharedMemory: false }],
  storage: { freeGb: 412, totalGb: 1000 },
  os: { platform: 'windows', version: '11 (demonstração)', architecture: 'x64' },
  acceleration: ['avx2', 'cuda', 'vulkan', 'directml'],
  provenance: { source: 'demo', detectorId: 'demo-workstation', collectedAt: COLLECTED_AT, confidence: 'high' }
}

const completed = (profile: unknown, mode = 'demo') => ({ mode, attemptedAt: COLLECTED_AT, outcome: { kind: 'completed', profile } })

const envelope = (data: unknown, formatVersion = 1) =>
  `${JSON.stringify({ format: 'gerpro.hardware', formatVersion, savedAt: COLLECTED_AT, data }, null, 2)}\n`

async function open(
  contents: string,
  o: { localDetector?: HardwareDetector; writer?: (path: string, text: string) => Promise<void> } = {}
) {
  const dir = await tempDir()
  const filePath = join(dir, 'hardware.json')
  await writeFile(filePath, contents)
  const now = fakeClock(Date.parse('2026-10-23T12:00:00.000Z'))
  const make = ({ writer } = { writer: o.writer }) =>
    new HardwareAdvisorService({
      filePath,
      localDetector: o.localDetector ?? new UnimplementedLocalDetector(),
      demoDetector: (s) => new DemoHardwareDetector(s, now),
      now,
      writer
    })
  const service = make()
  const status = await service.init()
  const files = async () => (await readdir(dir)).sort()
  const disk = async () => JSON.parse(await readFile(filePath, 'utf8'))
  return { dir, filePath, service, status, files, disk, make }
}

const isCode = (code: string) => (e: unknown) => e instanceof AppError && e.code === code

describe('hardware.json: migração do formato 1 para o atual', () => {
  it('o formato atual é o 4', () => {
    assert.equal(HARDWARE_FORMAT_VERSION, 4)
  })

  it('perfil demonstrativo continua simulado; consentimento intacto; arquivo regravado e original copiado', async () => {
    const original = envelope({ consent: v1Consent(), lastAnalysis: completed(v1WorkstationProfile) })
    const { service, status, disk, files, dir } = await open(original)
    assert.equal(status.state, 'migrated')
    assert.equal(status.writeBlock, null)

    const s = await service.getState()
    assert.equal(s.status, 'completed')
    assert.deepEqual(s.consent, v1Consent(), 'consentimento preservado, sem ampliação')
    assert.ok(s.analysis?.outcome.kind === 'completed')
    const profile = s.analysis.outcome.profile
    assert.equal(profile.provenance.source, 'demo')
    assert.equal(profile.provenance.detectorId, 'demo-workstation')
    assert.deepEqual(profile.provenance.quality, uniformQuality(v1WorkstationProfile, 'simulated'))
    const { provenance: _p, ...values } = profile
    const { provenance: _v1, ...v1Values } = v1WorkstationProfile
    assert.deepEqual(values, v1Values, 'valores do perfil não mudam')

    // Gravado já no formato 2, com o original guardado byte a byte.
    const file = await disk()
    assert.equal(file.formatVersion, HARDWARE_FORMAT_VERSION)
    assert.deepEqual(file.data.consent, v1Consent())
    const backups = (await files()).filter((f) => f.startsWith('hardware.v1-'))
    assert.equal(backups.length, 1)
    assert.equal(await readFile(join(dir, backups[0]!), 'utf8'), original)
  })

  it('reabrir depois da migração não migra nem copia de novo', async () => {
    const { make, files } = await open(envelope({ consent: v1Consent(), lastAnalysis: completed(v1PartialProfile) }))
    const before = await files()
    const again = make()
    assert.equal((await again.init()).state, 'loaded')
    assert.deepEqual(await files(), before)
    const s = await again.getState()
    assert.ok(s.analysis?.outcome.kind === 'completed')
    assert.equal(s.analysis.outcome.profile.provenance.quality.fields.gpus, 'unavailable')
    assert.equal(s.analysis.outcome.profile.provenance.quality.fields['cpu.model'], 'simulated')
  })

  it('autorização demonstrativa migrada continua sem cobrir leitura real', async () => {
    let read = false
    const realDetector: HardwareDetector = {
      id: 'local-futuro',
      source: 'local-detector',
      availability: async () => ({ available: true, reason: null }),
      detect: async () => {
        read = true
        throw new Error('não deveria ser chamado')
      }
    }
    const { service, disk } = await open(envelope({ consent: v1Consent(), lastAnalysis: null }), { localDetector: realDetector })
    assert.equal((await service.getState()).consent.localAnalysis.scope, 'demo-only')
    await assert.rejects(service.analyze({ mode: 'real' }), isCode('invalid-state'))
    assert.equal(read, false)
    assert.equal((await disk()).data.consent.localAnalysis.scope, 'demo-only')
  })

  it('consentimentos revogados, negados e não perguntados são preservados; dados ocultos continuam ocultos', async () => {
    const revoked = { localAnalysis: { status: 'revoked', decidedAt: DECIDED_AT, scope: null }, serverSharing: { status: 'denied', decidedAt: DECIDED_AT } }
    const { service, status } = await open(envelope({ consent: revoked, lastAnalysis: completed(v1PartialProfile) }))
    assert.equal(status.state, 'migrated')
    const s = await service.getState()
    assert.deepEqual(s.consent, revoked)
    assert.equal(s.status, 'not-authorized')
    assert.equal(s.analysis, null)
    assert.equal(s.hasStoredData, true)

    const denied = await open(envelope({ consent: v1Consent(null, 'denied'), lastAnalysis: null }))
    assert.equal((await denied.service.getState()).consent.localAnalysis.status, 'denied')
  })

  it('autorização de leitura real da v1 (se existisse) mantém o escopo; o perfil real é descartado', async () => {
    const realV1 = { ...v1WorkstationProfile, provenance: { ...v1WorkstationProfile.provenance, source: 'local-detector', detectorId: 'local-v1' } }
    const original = envelope({ consent: v1Consent('device-detection'), lastAnalysis: completed(realV1, 'real') })
    const { service, status, files, dir } = await open(original)
    assert.equal(status.state, 'migrated')
    const s = await service.getState()
    assert.equal(s.consent.localAnalysis.scope, 'device-detection')
    assert.equal(s.status, 'awaiting-analysis', 'sem perfil de qualidade desconhecida')
    assert.equal(s.hasStoredData, false)
    const backup = (await files()).find((f) => f.startsWith('hardware.v1-'))
    assert.equal(await readFile(join(dir, backup!), 'utf8'), original, 'o original fica copiado')
  })

  it('tentativas sem perfil (indisponível e erro) passam sem alteração', async () => {
    const unavailable = { mode: 'real', attemptedAt: COLLECTED_AT, outcome: { kind: 'unavailable', reason: 'A detecção real de hardware ainda não foi implementada.' } }
    const a = await open(envelope({ consent: v1Consent(), lastAnalysis: unavailable }))
    assert.deepEqual((await a.service.getState()).analysis, unavailable)
    const error = { mode: 'demo', attemptedAt: COLLECTED_AT, outcome: { kind: 'error', message: 'Falha simulada do detector demonstrativo.' } }
    const b = await open(envelope({ consent: v1Consent(), lastAnalysis: error }))
    assert.equal((await b.service.getState()).status, 'error')
  })

  it('falha ao gravar a migração: o app abre e o arquivo v1 fica intacto', async () => {
    const original = envelope({ consent: v1Consent(), lastAnalysis: completed(v1PartialProfile) })
    const failing = async () => {
      throw new Error('disco cheio (simulado)')
    }
    const { service, status, filePath, make } = await open(original, { writer: failing })
    assert.equal(status.state, 'migrated')
    assert.equal((await service.getState()).consent.localAnalysis.status, 'granted')
    assert.equal(await readFile(filePath, 'utf8'), original)
    // Na próxima abertura, com gravação normal, a migração se completa.
    const next = make({ writer: undefined })
    assert.equal((await next.init()).state, 'migrated')
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).formatVersion, HARDWARE_FORMAT_VERSION)
  })
})

describe('hardware.json: comportamento seguro mantido', () => {
  it('v1 com autorização sem escopo (anterior à regra D22) volta ao padrão seguro', async () => {
    const legacy = { localAnalysis: { status: 'granted', decidedAt: DECIDED_AT }, serverSharing: { status: 'not-asked', decidedAt: null } }
    const { service, status, files } = await open(envelope({ consent: legacy, lastAnalysis: completed(v1PartialProfile) }))
    assert.equal(status.state, 'recovered')
    const s = await service.getState()
    assert.equal(s.status, 'not-authorized')
    assert.equal(s.consent.localAnalysis.status, 'not-asked')
    assert.equal(s.hasStoredData, false)
    assert.ok((await files()).some((f) => f.startsWith('hardware.invalid-')))
  })

  it('v1 com perfil demonstrativo inválido: consentimento fica, análise é recusada', async () => {
    const broken = { ...v1PartialProfile, memory: { totalGb: 8, availableGb: 16 } }
    const { service, status } = await open(envelope({ consent: v1Consent(), lastAnalysis: completed(broken) }))
    assert.equal(status.state, 'recovered')
    const s = await service.getState()
    assert.equal(s.consent.localAnalysis.scope, 'demo-only')
    assert.equal(s.hasStoredData, false)
  })

  it('v2 sem qualidade (gravado fora das regras) é recusado como inválido', async () => {
    const { service, status } = await open(envelope({ consent: v1Consent(), lastAnalysis: completed(v1PartialProfile) }, 2))
    assert.equal(status.state, 'recovered')
    assert.equal((await service.getState()).hasStoredData, false)
  })

  it('JSON corrompido continua indo para o padrão seguro', async () => {
    const { service, status } = await open('{ "format": "gerpro.hardware", ')
    assert.equal(status.state, 'recovered')
    assert.equal((await service.getState()).status, 'not-authorized')
  })
})

describe('hardware.json: versões futuras e versões antigas do app', () => {
  it('arquivo de uma versão futura (v4): somente leitura, nada é regravado', async () => {
    const future = envelope({ consent: v1Consent('device-detection'), lastAnalysis: null, novidade: true }, HARDWARE_FORMAT_VERSION + 1)
    const { service, status, filePath, files } = await open(future)
    assert.equal(status.state, 'read-only')
    assert.equal(status.writeBlock, 'newer-version')
    assert.equal((await service.getState()).status, 'not-authorized')
    await assert.rejects(service.setLocalConsent({ granted: true }), isCode('storage-read-only'))
    await assert.rejects(service.deleteData(), isCode('storage-read-only'))
    assert.equal(await readFile(filePath, 'utf8'), future)
    assert.deepEqual(await files(), ['hardware.json'])
  })

  for (const oldVersion of [1, 2, 3]) {
    it(`o app v${oldVersion} abrindo um arquivo do formato atual não o sobrescreve`, async () => {
      // Arquivo no formato atual, produzido pela versão atual.
      const { filePath } = await open(envelope({ consent: v1Consent(), lastAnalysis: completed(v1PartialProfile) }))
      const current = await readFile(filePath, 'utf8')
      assert.equal(JSON.parse(current).formatVersion, HARDWARE_FORMAT_VERSION)

      // Mesmo armazenamento, configurado como o app antigo.
      const oldApp = new VersionedStore<unknown>({
        filePath,
        format: 'gerpro.hardware',
        version: oldVersion,
        defaults: () => ({ consent: null, lastAnalysis: null }),
        parse: (data) => ({ value: data, issues: [] }),
        log: () => undefined
      })
      await oldApp.load()
      assert.equal(oldApp.status.writeBlock, 'newer-version')
      await assert.rejects(oldApp.update((d) => d), isCode('storage-read-only'))
      assert.equal(await readFile(filePath, 'utf8'), current)
    })
  }
})

describe('hardware.json: falhas e concorrência na migração', () => {
  // Relógio fixo: o nome do backup (`hardware.v1-<data>.json`) fica previsível.
  const NOW = new Date('2026-10-23T12:00:00.000Z')
  const BACKUP = `hardware.v1-${NOW.toISOString().replace(/[:.]/g, '-')}.json`

  /** Arquivo v1 isolado, sem inicializar; registra cada gravação (versão e consentimento). */
  async function prepare() {
    const dir = await tempDir()
    const filePath = join(dir, 'hardware.json')
    const original = envelope({ consent: v1Consent(), lastAnalysis: completed(v1PartialProfile) })
    await writeFile(filePath, original)
    const writes: Array<{ formatVersion: number; status: string; scope: string | null }> = []
    const writer = async (path: string, text: string) => {
      const { formatVersion, data } = JSON.parse(text)
      writes.push({ formatVersion, status: data.consent.localAnalysis.status, scope: data.consent.localAnalysis.scope })
      await writeFileAtomic(path, text)
    }
    const make = () =>
      new HardwareAdvisorService({
        filePath,
        localDetector: new UnimplementedLocalDetector(),
        demoDetector: (s) => new DemoHardwareDetector(s, () => NOW),
        now: () => NOW,
        writer
      })
    return { dir, filePath, original, writes, make, files: async () => (await readdir(dir)).sort() }
  }

  it('falha ao criar o backup: original intacto, nada gravado, somente leitura', async () => {
    const { dir, filePath, original, writes, make, files } = await prepare()
    // Um diretório no lugar do backup faz a cópia falhar.
    await mkdir(join(dir, BACKUP))
    const service = make()
    const status = await service.init()

    assert.equal(status.state, 'read-only')
    assert.equal(status.writeBlock, 'backup-failed')
    assert.equal(await readFile(filePath, 'utf8'), original, 'original intacto')
    assert.deepEqual(writes, [], 'nenhuma gravação no formato novo')

    // Toda escrita posterior é recusada, e o arquivo continua o mesmo.
    await assert.rejects(service.setLocalConsent({ granted: false }), isCode('storage-read-only'))
    await assert.rejects(service.setLocalConsent({ granted: false, deleteData: true }), isCode('storage-read-only'))
    await assert.rejects(service.deleteData(), isCode('storage-read-only'))
    await assert.rejects(service.analyze({ mode: 'demo' }), isCode('storage-read-only'))
    assert.deepEqual(writes, [])
    assert.equal(await readFile(filePath, 'utf8'), original)
    assert.deepEqual(await files(), ['hardware.json', BACKUP])

    // Consentimento exatamente o da v1: nem ampliado, nem alterado.
    const s = await service.getState()
    assert.deepEqual(s.consent, v1Consent())
    assert.equal(s.consent.localAnalysis.scope, 'demo-only')
  })

  it('operações simultâneas na inicialização: um backup, arquivo válido, ordem preservada', async () => {
    const { dir, filePath, original, writes, make, files } = await prepare()
    const service = make()

    // Inicializações, leituras e mudanças de consentimento disparadas juntas.
    const [first, second, , revoked, regranted] = await Promise.all([
      service.init(),
      service.init(),
      service.getState(),
      service.setLocalConsent({ granted: false }),
      service.setLocalConsent({ granted: true })
    ])
    assert.equal(first.state, 'migrated')
    assert.equal(second.state, 'migrated')
    assert.equal(revoked.consent.localAnalysis.status, 'revoked')
    assert.equal(regranted.consent.localAnalysis.status, 'granted')

    // Um único backup, idêntico ao original.
    assert.deepEqual(await files(), ['hardware.json', BACKUP])
    assert.equal(await readFile(join(dir, BACKUP), 'utf8'), original)

    // Fila: cada gravação na ordem em que foi pedida; nenhuma alteração perdida.
    // Quatro gravações: as duas mudanças de consentimento e a regravação de cada `init()`.
    assert.equal(writes.length, 4)
    assert.ok(writes.every((w) => w.formatVersion === HARDWARE_FORMAT_VERSION && (w.scope === null || w.scope === 'demo-only')))
    const revokeAt = writes.findIndex((w) => w.status === 'revoked')
    assert.ok(revokeAt >= 0, 'a revogação foi gravada')
    assert.equal(writes.filter((w) => w.status === 'revoked').length, 1)
    assert.ok(writes.slice(revokeAt + 1).every((w) => w.status === 'granted'), 'a nova autorização veio depois e prevaleceu')

    // Resultado no disco: formato atual válido, última alteração vale, escopo não ampliado.
    const reopened = make()
    assert.equal((await reopened.init()).state, 'loaded')
    const final = await reopened.getState()
    assert.equal(final.consent.localAnalysis.status, 'granted')
    assert.equal(final.consent.localAnalysis.scope, 'demo-only')
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).formatVersion, HARDWARE_FORMAT_VERSION)
    assert.deepEqual(await files(), ['hardware.json', BACKUP], 'reabrir não cria outro backup')
  })
})

describe('hardware.json: migração do formato 2 para o atual', () => {
  /** Perfil como a v2 gravava: valores completos e `provenance.quality`. */
  const v2Profile = (profile: typeof v1WorkstationProfile | typeof v1PartialProfile, source: 'demo' | 'local-detector' = 'demo') => {
    const { provenance, ...values } = profile
    return { ...values, provenance: { ...provenance, source, quality: uniformQuality(values, source === 'demo' ? 'simulated' : 'detected') } }
  }

  it('perfil demonstrativo da v2 continua simulado; consentimento intacto; original copiado', async () => {
    const original = envelope({ consent: v1Consent(), lastAnalysis: completed(v2Profile(v1WorkstationProfile)) }, 2)
    const { service, status, disk, files, dir } = await open(original)
    assert.equal(status.state, 'migrated')
    const s = await service.getState()
    assert.deepEqual(s.consent, v1Consent())
    assert.ok(s.analysis?.outcome.kind === 'completed')
    assert.equal(s.analysis.outcome.profile.provenance.source, 'demo')
    assert.deepEqual(s.analysis.outcome.profile.provenance.quality, v2Profile(v1WorkstationProfile).provenance.quality)
    assert.equal((await disk()).formatVersion, HARDWARE_FORMAT_VERSION)
    const backup = (await files()).find((f) => f.startsWith('hardware.v2-'))
    assert.ok(backup)
    assert.equal(await readFile(join(dir, backup), 'utf8'), original)
  })

  it('perfil real da v2 é preservado como real (diferente da v1, a v2 registrava a qualidade)', async () => {
    const real = v2Profile(v1WorkstationProfile, 'local-detector')
    const { service, status } = await open(envelope({ consent: v1Consent('device-detection'), lastAnalysis: completed(real, 'real') }, 2))
    assert.equal(status.state, 'migrated')
    const s = await service.getState()
    assert.equal(s.consent.localAnalysis.scope, 'device-detection')
    assert.ok(s.analysis?.outcome.kind === 'completed')
    assert.equal(s.analysis.outcome.profile.provenance.source, 'local-detector')
    assert.equal(s.analysis.outcome.profile.provenance.quality.fields['cpu.model'], 'detected')
  })

  it('`demo-only` da v2 continua sem cobrir leitura real', async () => {
    const { service, disk } = await open(envelope({ consent: v1Consent(), lastAnalysis: null }, 2))
    assert.equal((await service.getState()).consent.localAnalysis.scope, 'demo-only')
    assert.equal((await disk()).data.consent.localAnalysis.scope, 'demo-only')
  })

  it('v2 inválido continua indo para o padrão seguro', async () => {
    const legacy = { localAnalysis: { status: 'granted', decidedAt: DECIDED_AT }, serverSharing: { status: 'not-asked', decidedAt: null } }
    const { service, status } = await open(envelope({ consent: legacy, lastAnalysis: null }, 2))
    assert.equal(status.state, 'recovered')
    assert.equal((await service.getState()).status, 'not-authorized')
  })

  it('falha ao gravar a migração da v2: o arquivo v2 fica intacto e a migração se repete', async () => {
    const original = envelope({ consent: v1Consent(), lastAnalysis: completed(v2Profile(v1PartialProfile)) }, 2)
    const failing = async () => {
      throw new Error('disco cheio (simulado)')
    }
    const { status, filePath, make } = await open(original, { writer: failing })
    assert.equal(status.state, 'migrated')
    assert.equal(await readFile(filePath, 'utf8'), original)
    assert.equal((await make({ writer: undefined }).init()).state, 'migrated')
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).formatVersion, HARDWARE_FORMAT_VERSION)
  })

  it('perfil parcial do formato 3 é gravado e relido sem perder atributos', async () => {
    const values = {
      ...v1WorkstationProfile,
      cpu: { model: null, architecture: 'arm64', physicalCores: null, logicalCores: 10 },
      memory: { totalGb: 16, availableGb: null },
      storage: { freeGb: 42, totalGb: null },
      os: { platform: 'windows', version: null, architecture: 'arm64' }
    }
    const { provenance, ...rest } = values
    const partial = { ...rest, provenance: { ...provenance, source: 'local-detector', quality: uniformQuality(rest, 'detected') } }
    const { service, status, make } = await open(envelope({ consent: v1Consent('device-detection'), lastAnalysis: completed(partial, 'real') }, 3))
    assert.equal(status.state, 'migrated')
    const again = make()
    await again.init()
    for (const s of [await service.getState(), await again.getState()]) {
      assert.ok(s.analysis?.outcome.kind === 'completed')
      const p = s.analysis.outcome.profile
      assert.deepEqual([p.cpu, p.memory, p.storage, p.os], [rest.cpu, rest.memory, rest.storage, rest.os])
    }
  })
})

describe('hardware.json: migração do formato 3 para o 4', () => {
  /** Perfil como a v3 gravava (GPU com modelo e classificação obrigatórios). */
  const v3Profile = (source: 'demo' | 'local-detector' = 'demo') => {
    const { provenance, ...values } = v1WorkstationProfile
    return { ...values, provenance: { ...provenance, source, quality: uniformQuality(values, source === 'demo' ? 'simulated' : 'detected') } }
  }

  it('perfil v3 passa sem alteração; original copiado antes de gravar o formato 4', async () => {
    const original = envelope({ consent: v1Consent(), lastAnalysis: completed(v3Profile()) }, 3)
    const { service, status, disk, files, dir } = await open(original)
    assert.equal(status.state, 'migrated')
    const s = await service.getState()
    assert.ok(s.analysis?.outcome.kind === 'completed')
    assert.deepEqual(s.analysis.outcome.profile, v3Profile())
    const saved = await disk()
    assert.equal(saved.formatVersion, 4)
    assert.deepEqual(saved.data.lastAnalysis.outcome.profile, v3Profile())
    const backup = (await files()).find((f) => f.startsWith('hardware.v3-'))
    assert.ok(backup)
    assert.equal(await readFile(join(dir, backup), 'utf8'), original)
  })

  for (const [label, consent] of [
    ['autorização demo-only', v1Consent('demo-only')],
    ['autorização device-detection', v1Consent('device-detection')],
    ['revogação', v1Consent(null, 'revoked')],
    ['recusa', v1Consent(null, 'denied')]
  ] as const) {
    it(`consentimento preservado na migração: ${label}`, async () => {
      const { service, disk } = await open(envelope({ consent, lastAnalysis: null }, 3))
      assert.deepEqual((await service.getState()).consent, consent)
      assert.deepEqual((await disk()).data.consent, consent)
    })
  }

  it('`demo-only` da v3 continua sem cobrir leitura real', async () => {
    let read = false
    const realDetector: HardwareDetector = {
      id: 'local-futuro',
      source: 'local-detector',
      availability: async () => ({ available: true, reason: null }),
      detect: async () => {
        read = true
        throw new Error('não deveria ser chamado')
      }
    }
    const { service, disk } = await open(envelope({ consent: v1Consent('demo-only'), lastAnalysis: null }, 3), { localDetector: realDetector })
    await assert.rejects(service.analyze({ mode: 'real' }), isCode('invalid-state'))
    assert.equal(read, false)
    assert.equal((await disk()).data.consent.localAnalysis.scope, 'demo-only')
  })

  it('perfil v4 com GPU parcial (sem modelo, classificação desconhecida) é gravado e relido', async () => {
    const { provenance, ...values } = v1WorkstationProfile
    const gpus = [
      { vendor: 'nvidia', model: null, vramGb: 12, sharedMemory: null },
      { vendor: 'intel', model: 'Intel(R) UHD Graphics', vramGb: null, sharedMemory: null }
    ]
    const rest = { ...values, gpus }
    const profile = { ...rest, provenance: { ...provenance, source: 'local-detector', quality: uniformQuality(rest, 'detected') } }
    const { service, status, make } = await open(envelope({ consent: v1Consent('device-detection'), lastAnalysis: completed(profile, 'real') }, 4))
    assert.equal(status.state, 'loaded')
    const again = make()
    assert.equal((await again.init()).state, 'loaded')
    for (const s of [await service.getState(), await again.getState()]) {
      assert.ok(s.analysis?.outcome.kind === 'completed')
      assert.deepEqual(s.analysis.outcome.profile.gpus, gpus)
      assert.deepEqual(s.analysis.outcome.profile.provenance.quality.gpus?.map((q) => [q.model, q.sharedMemory]), [
        ['unavailable', 'unavailable'],
        ['detected', 'unavailable']
      ])
    }
  })

  it('v4 com GPU sem nenhum atributo conhecido vai para o padrão seguro, sem perder o original', async () => {
    const { provenance, ...values } = v1WorkstationProfile
    const rest = { ...values, gpus: [{ vendor: 'unknown', model: null, vramGb: null, sharedMemory: null }] }
    const profile = { ...rest, provenance: { ...provenance, source: 'local-detector', quality: uniformQuality(rest, 'detected') } }
    const original = envelope({ consent: v1Consent('device-detection'), lastAnalysis: completed(profile, 'real') }, 4)
    const { status, files, dir } = await open(original)
    assert.equal(status.state, 'recovered')
    const copy = (await files()).find((f) => f.startsWith('hardware.invalid-'))
    assert.ok(copy)
    assert.equal(await readFile(join(dir, copy), 'utf8'), original)
  })

  it('falha ao gravar a migração da v3: o arquivo v3 fica intacto e a migração se repete', async () => {
    const original = envelope({ consent: v1Consent(), lastAnalysis: completed(v3Profile()) }, 3)
    const failing = async () => {
      throw new Error('disco cheio (simulado)')
    }
    const { status, filePath, make } = await open(original, { writer: failing })
    assert.equal(status.state, 'migrated')
    assert.equal(await readFile(filePath, 'utf8'), original)
    assert.equal((await make({ writer: undefined }).init()).state, 'migrated')
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).formatVersion, 4)
  })
})
