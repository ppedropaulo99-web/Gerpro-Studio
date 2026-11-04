import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { BYTES_PER_GB, type Measured } from '../../src/main/hardware/local/probes/common'
import { cpuToProfile, probeCpu, type CpuApi } from '../../src/main/hardware/local/probes/cpu'
import { memoryToProfile, probeMemory, type MemoryApi } from '../../src/main/hardware/local/probes/memory'
import { osToProfile, probeOs, windowsVersion, type OsApi } from '../../src/main/hardware/local/probes/os'
import { probeStorage, storageToProfile, validateStorageTarget, type StatFsLike, type StorageApi } from '../../src/main/hardware/local/probes/storage'
import { ESTIMATE_RULES } from '../../src/shared/compatibility-evaluator'
import { uniformQuality, validateHardwareProfile, type HardwareProfile } from '../../src/shared/hardware'

// Todas as APIs do sistema são simuladas: nenhum teste lê o hardware deste computador.

const GiB = 1024 ** 3

/** Toda medição: valor ausente ⇔ `unavailable`; nunca `simulated`; nunca zero no lugar de desconhecido. */
function assertCoherent(results: Record<string, Measured<unknown>>) {
  for (const [name, m] of Object.entries(results)) {
    assert.ok(['detected', 'estimated', 'unavailable'].includes(m.quality), `${name}: ${m.quality}`)
    assert.equal(m.value === null, m.quality === 'unavailable', name)
    if (m.quality === 'unavailable') assert.ok(typeof m.reason === 'string' && m.reason.length > 0, name)
  }
}

const reasonOf = (m: Measured<unknown>) => (m.quality === 'unavailable' ? m.reason : null)

const throws = () => {
  throw new Error('C:\\Users\\fulano\\detalhe interno')
}

// ---------------------------------------------------------------------------

describe('sondagem de CPU', () => {
  const cpuList = (model: unknown, n = 8) => Array.from({ length: n }, () => ({ model }))
  const api = (o: Partial<CpuApi> = {}): CpuApi => ({ cpus: () => cpuList('Processador de Teste 8C @ 3.0GHz'), machine: () => 'x86_64', arch: () => 'x64', ...o })

  it('dados completos: modelo, arquitetura e núcleos lógicos detectados', () => {
    const r = probeCpu(api())
    assert.deepEqual(r.model, { value: 'Processador de Teste 8C @ 3.0GHz', quality: 'detected' })
    assert.deepEqual(r.architecture, { value: 'x64', quality: 'detected' })
    assert.deepEqual(r.logicalCores, { value: 8, quality: 'detected' })
    assertCoherent({ ...r })
  })

  it('núcleos físicos: sempre desconhecidos, nunca deduzidos dos lógicos', () => {
    for (const n of [1, 2, 8, 24, 64]) {
      const r = probeCpu(api({ cpus: () => cpuList('CPU de teste', n) }))
      assert.deepEqual(r.physicalCores, { value: null, quality: 'unavailable', reason: 'requires-system-query' })
    }
    const { cpu, quality } = cpuToProfile(probeCpu(api()))
    assert.equal(cpu?.physicalCores, null)
    assert.equal(quality['cpu.physicalCores'], 'unavailable')
    assert.equal(quality['cpu.logicalCores'], 'detected')
  })

  it('arquitetura ARM64', () => {
    for (const m of ['arm64', 'aarch64', 'ARM64']) assert.deepEqual(probeCpu(api({ machine: () => m })).architecture, { value: 'arm64', quality: 'detected' })
  })

  it('sem `machine()`, a arquitetura do processo é só uma estimativa', () => {
    assert.deepEqual(probeCpu(api({ machine: undefined, arch: () => 'arm64' })).architecture, { value: 'arm64', quality: 'estimated' })
    assert.deepEqual(probeCpu(api({ machine: throws, arch: () => 'x64' })).architecture, { value: 'x64', quality: 'estimated' })
    assert.equal(probeCpu(api({ machine: undefined, arch: undefined })).architecture.quality, 'unavailable')
    assert.deepEqual(probeCpu(api({ machine: () => 'riscv64' })).architecture, { value: 'other', quality: 'detected' })
  })

  it('modelo inválido: só o modelo fica indisponível; os demais atributos permanecem', () => {
    for (const model of ['', '   ', 'unknown', null, 42, undefined]) {
      const r = probeCpu(api({ cpus: () => cpuList(model, 4) }))
      assert.equal(r.model.quality, 'unavailable', String(model))
      assert.deepEqual(r.logicalCores, { value: 4, quality: 'detected' })
      assert.equal(r.architecture.quality, 'detected')
      assertCoherent({ ...r })
    }
    // Primeiro modelo válido entre os núcleos.
    assert.equal(probeCpu(api({ cpus: () => [{ model: '' }, { model: 'CPU de teste' }] })).model.value, 'CPU de teste')
  })

  it('modelo é limpo (controle, espaços) e limitado a 200 caracteres', () => {
    assert.equal(probeCpu(api({ cpus: () => cpuList('  CPU\u0000 de\t\tteste \n') })).model.value, 'CPU de teste')
    assert.equal(probeCpu(api({ cpus: () => cpuList('x'.repeat(500)) })).model.value?.length, 200)
  })

  it('sem `os.cpus()`: núcleos lógicos pela paralelização disponível, como estimativa', () => {
    const r = probeCpu(api({ cpus: throws, availableParallelism: () => 6 }))
    assert.deepEqual(r.model, { value: null, quality: 'unavailable', reason: 'api-error' })
    assert.deepEqual(r.logicalCores, { value: 6, quality: 'estimated' })
    const empty = probeCpu(api({ cpus: () => [], availableParallelism: () => 0 }))
    assert.equal(empty.logicalCores.quality, 'unavailable')
    assert.equal(reasonOf(probeCpu(api({ cpus: undefined })).model), 'api-unavailable')
  })

  it('CPU parcial no contrato: sem modelo, arquitetura e núcleos lógicos permanecem', () => {
    const { cpu, quality } = cpuToProfile(probeCpu(api({ cpus: () => cpuList('', 12), machine: () => 'arm64' })))
    assert.deepEqual(cpu, { model: null, architecture: 'arm64', physicalCores: null, logicalCores: 12 })
    assert.deepEqual(quality, { 'cpu.model': 'unavailable', 'cpu.architecture': 'detected', 'cpu.physicalCores': 'unavailable', 'cpu.logicalCores': 'detected' })
  })

  it('CPU sem nenhum atributo conhecido: a seção é `null`', () => {
    const { cpu, quality } = cpuToProfile(probeCpu({ cpus: throws, machine: throws, arch: throws, availableParallelism: throws }))
    assert.equal(cpu, null)
    assert.ok(Object.values(quality).every((q) => q === 'unavailable'))
  })
})

// ---------------------------------------------------------------------------

describe('sondagem de memória', () => {
  const api = (o: Partial<MemoryApi> = {}): MemoryApi => ({ totalmem: () => 16 * GiB, freemem: () => 6.5 * GiB, platform: () => 'win32', ...o })

  it('valores válidos, em GB (2³⁰ bytes): total e disponível são medidas diferentes', () => {
    const r = probeMemory(api())
    assert.deepEqual(r.totalGb, { value: 16, quality: 'detected' })
    assert.deepEqual(r.availableGb, { value: 6.5, quality: 'detected' })
    assert.equal(BYTES_PER_GB, ESTIMATE_RULES.bytesPerGb)
    assert.deepEqual(memoryToProfile(r).memory, { totalGb: 16, availableGb: 6.5 })
  })

  it('disponível acima do total: a disponível é descartada, o total permanece', () => {
    const r = probeMemory(api({ freemem: () => 32 * GiB }))
    assert.deepEqual(r.totalGb, { value: 16, quality: 'detected' })
    assert.deepEqual(r.availableGb, { value: null, quality: 'unavailable', reason: 'inconsistent' })
    // No contrato, o total é mantido e a disponível fica nula.
    assert.deepEqual(memoryToProfile(r), { memory: { totalGb: 16, availableGb: null }, quality: { 'memory.totalGb': 'detected', 'memory.availableGb': 'unavailable' } })
  })

  it('memória parcial: só a disponível conhecida; sem nenhuma, a seção é `null`', () => {
    assert.deepEqual(memoryToProfile(probeMemory(api({ totalmem: throws }))).memory, { totalGb: null, availableGb: 6.5 })
    assert.equal(memoryToProfile(probeMemory(api({ totalmem: throws, freemem: throws }))).memory, null)
  })

  it('valores inválidos nunca viram zero', () => {
    for (const bad of [NaN, Infinity, -1, '16', null, 0, 1024]) {
      const r = probeMemory(api({ totalmem: () => bad as number }))
      assert.equal(r.totalGb.quality, 'unavailable', String(bad))
      assert.equal(r.totalGb.value, null)
    }
    for (const bad of [NaN, -5, undefined]) assert.equal(probeMemory(api({ freemem: () => bad as number })).availableGb.value, null)
    // Zero disponível é um valor real, não um desconhecido.
    assert.deepEqual(probeMemory(api({ freemem: () => 0 })).availableGb, { value: 0, quality: 'detected' })
  })

  it('falha de uma API não elimina a outra', () => {
    const r = probeMemory(api({ freemem: throws }))
    assert.equal(r.totalGb.quality, 'detected')
    assert.deepEqual(r.availableGb, { value: null, quality: 'unavailable', reason: 'api-error' })
    assert.equal(probeMemory(api({ totalmem: undefined })).availableGb.quality, 'detected')
  })

  it('macOS e plataformas não suportadas: disponível é estimativa (semântica diferente de `freemem`)', () => {
    for (const p of ['darwin', 'aix', 'freebsd']) assert.equal(probeMemory(api({ platform: () => p })).availableGb.quality, 'estimated', p)
    assert.equal(probeMemory(api({ platform: () => 'linux' })).availableGb.quality, 'detected')
    assert.equal(probeMemory(api({ platform: throws })).availableGb.quality, 'estimated')
  })
})

// ---------------------------------------------------------------------------

describe('sondagem do sistema operacional', () => {
  const api = (o: Partial<OsApi> = {}): OsApi => ({ platform: () => 'win32', release: () => '10.0.22631', version: () => 'Windows 10 Pro', machine: () => 'x86_64', ...o })

  it('Windows 11 pelo build, mesmo com o nome comercial dizendo "Windows 10"', () => {
    const r = probeOs(api())
    assert.deepEqual(r.platform, { value: 'windows', quality: 'detected' })
    assert.deepEqual(r.version, { value: '11 (build 22631)', quality: 'detected' })
    assert.equal(probeOs(api({ release: () => '10.0.26200' })).version.value, '11 (build 26200)')
  })

  it('Windows 10 pelo build; limite em 22000', () => {
    assert.equal(probeOs(api({ release: () => '10.0.19045', version: () => 'Windows 10 Home' })).version.value, '10 (build 19045)')
    assert.equal(windowsVersion('10.0.21999', false), '10 (build 21999)')
    assert.equal(windowsVersion('10.0.22000', false), '11 (build 22000)')
  })

  it('Windows Server não é confundido com Windows 10 ou 11; versões antigas e formatos inesperados', () => {
    assert.equal(probeOs(api({ release: () => '10.0.20348', version: () => 'Windows Server 2022 Datacenter' })).version.value, 'Server (build 20348)')
    assert.equal(probeOs(api({ release: () => '10.0.26100', version: () => 'Windows Server 2025 Standard' })).version.value, 'Server (build 26100)')
    assert.equal(windowsVersion('6.1.7601', false), 'NT 6.1.7601')
    assert.equal(probeOs(api({ release: () => 'versão estranha' })).version.value, 'versão estranha')
    // Sem o nome do produto, o build decide sozinho.
    assert.equal(probeOs(api({ version: throws })).version.value, '11 (build 22631)')
  })

  it('macOS e Linux informam a versão do kernel, identificada como tal', () => {
    assert.deepEqual(probeOs(api({ platform: () => 'darwin', release: () => '23.4.0' })).version, { value: 'kernel Darwin 23.4.0', quality: 'detected' })
    assert.equal(probeOs(api({ platform: () => 'linux', release: () => '6.8.0-45-generic' })).version.value, 'kernel 6.8.0-45-generic')
    assert.equal(probeOs(api({ platform: () => 'darwin', machine: () => 'arm64' })).architecture.value, 'arm64')
  })

  it('plataforma não suportada: identificada como "other", sem inventar versão', () => {
    const r = probeOs(api({ platform: () => 'aix', release: () => '7.2' }))
    assert.deepEqual(r.platform, { value: 'other', quality: 'detected' })
    assert.equal(r.version.value, 'aix 7.2')
    assertCoherent({ ...r })
  })

  it('falhas por atributo: plataforma, versão e arquitetura independentes', () => {
    const r = probeOs(api({ release: throws }))
    assert.equal(r.platform.quality, 'detected')
    assert.equal(r.version.quality, 'unavailable')
    assert.equal(r.architecture.quality, 'detected')
    assert.deepEqual(osToProfile(r).os, { platform: 'windows', version: null, architecture: 'x64' })
    assert.equal(osToProfile(r).quality['os.version'], 'unavailable')
    assert.equal(osToProfile(probeOs({ platform: throws, release: throws, machine: throws, arch: throws })).os, null)
    assert.equal(probeOs(api({ platform: () => '' })).platform.quality, 'unavailable')
    assert.equal(probeOs(api({ release: () => 'x'.repeat(300), platform: () => 'linux' })).version.value?.length, 100)
  })
})

// ---------------------------------------------------------------------------

describe('sondagem de armazenamento', () => {
  const stats = (o: Partial<StatFsLike> = {}): StatFsLike => ({ bsize: 4096, blocks: (500 * GiB) / 4096, bavail: (120.5 * GiB) / 4096, ...o })
  const fake = (result: () => Promise<StatFsLike>, platform: NodeJS.Platform = 'win32') => {
    const calls: string[] = []
    const api: StorageApi = {
      platform,
      statfs: (path) => {
        calls.push(path)
        return result()
      }
    }
    return { api, calls }
  }
  const target = { kind: 'models', path: 'D:\\Modelos\\ollama' } as const

  it('espaço disponível: total e livre detectados, volume e caminho identificados, uma única consulta', async () => {
    const { api, calls } = fake(async () => stats())
    const r = await probeStorage(target, api)
    assert.deepEqual(r.target, { kind: 'models', path: 'D:\\Modelos\\ollama', volume: 'D:\\' })
    assert.deepEqual(r.totalGb, { value: 500, quality: 'detected' })
    assert.deepEqual(r.freeGb, { value: 120.5, quality: 'detected' })
    assert.deepEqual(calls, ['D:\\Modelos\\ollama'])
    assert.deepEqual(storageToProfile(r).storage, { freeGb: 120.5, totalGb: 500 })
  })

  it('caminho POSIX', async () => {
    const { api } = fake(async () => stats(), 'linux')
    const r = await probeStorage({ kind: 'app-data', path: '/home/teste/.config/app' }, api)
    assert.equal(r.target?.volume, '/')
    assert.equal(r.totalGb.quality, 'detected')
  })

  it('falha na consulta: motivo por tipo de erro, sem propagar exceção', async () => {
    const err = (code: string) => Object.assign(new Error(`${code}: C:\\Users\\fulano`), { code })
    for (const [code, reason] of [['ENOENT', 'path-not-found'], ['EACCES', 'permission-denied'], ['EPERM', 'permission-denied'], ['EIO', 'query-failed']] as const) {
      const r = await probeStorage(target, fake(() => Promise.reject(err(code))).api)
      assert.deepEqual(r.totalGb, { value: null, quality: 'unavailable', reason }, code)
      assert.equal(r.target?.path, target.path)
      assert.ok(!JSON.stringify(r).includes('fulano'), 'a mensagem do erro não é guardada')
    }
    assert.equal(reasonOf((await probeStorage(target, { platform: 'win32' })).totalGb), 'api-unavailable')
  })

  it('volume que não responde: indisponível após o prazo', async () => {
    const r = await probeStorage(target, fake(() => new Promise(() => undefined)).api, { timeoutMs: 20 })
    assert.equal(reasonOf(r.totalGb), 'timeout')
    assert.equal(r.freeGb.value, null)
  })

  it('valores inválidos ou incoerentes do sistema: indisponível, nunca zero', async () => {
    for (const bad of [stats({ bsize: 0 }), stats({ blocks: NaN }), stats({ bavail: -1 }), stats({ blocks: 1 }), { bsize: 4096 } as StatFsLike]) {
      const r = await probeStorage(target, fake(async () => bad).api)
      assert.equal(r.totalGb.value, null)
      assert.equal(r.totalGb.quality, 'unavailable')
    }
    const r = await probeStorage(target, fake(async () => stats({ bavail: stats().blocks + 1 })).api)
    assert.equal(reasonOf(r.freeGb), 'inconsistent')
    // Disco cheio: zero livre é medida real.
    assert.deepEqual((await probeStorage(target, fake(async () => stats({ bavail: 0 })).api)).freeGb, { value: 0, quality: 'detected' })
  })

  it('armazenamento parcial no contrato: um atributo conhecido basta para manter a seção', () => {
    const base = { target: { kind: 'models' as const, path: 'D:\\M', volume: 'D:\\' } }
    assert.deepEqual(storageToProfile({ ...base, freeGb: { value: 40, quality: 'detected' }, totalGb: { value: null, quality: 'unavailable', reason: 'x' } }), {
      storage: { freeGb: 40, totalGb: null },
      quality: { 'storage.freeGb': 'detected', 'storage.totalGb': 'unavailable' }
    })
    assert.equal(storageToProfile({ ...base, freeGb: { value: null, quality: 'unavailable', reason: 'x' }, totalGb: { value: null, quality: 'unavailable', reason: 'x' } }).storage, null)
  })

  it('alvos recusados antes de qualquer consulta: relativos, de rede, de dispositivo ou malformados', async () => {
    const bad: unknown[] = [
      { kind: 'models', path: 'modelos' },
      { kind: 'models', path: 'C:modelos' },
      { kind: 'models', path: '\\Modelos' },
      { kind: 'models', path: '\\\\servidor\\share\\modelos' },
      { kind: 'models', path: '\\\\?\\C:\\modelos' },
      { kind: 'models', path: '\\\\.\\PhysicalDrive0' },
      { kind: 'models', path: 'C:\\mo\u0000delos' },
      { kind: 'models', path: '' },
      { kind: 'models', path: `C:\\${'a'.repeat(2000)}` },
      { kind: 'qualquer', path: 'C:\\' },
      { path: 'C:\\' },
      'C:\\',
      null
    ]
    for (const t of bad) {
      const { api, calls } = fake(async () => stats())
      const r = await probeStorage(t as never, api)
      assert.equal(r.target, null, JSON.stringify(t))
      assert.equal(reasonOf(r.totalGb), 'invalid-target')
      assert.deepEqual(calls, [])
    }
    assert.equal(validateStorageTarget({ kind: 'models', path: '/abs' }, 'linux')?.path, '/abs')
    assert.equal(validateStorageTarget({ kind: 'models', path: 'C:/Modelos/../Dados' }, 'win32')?.path, 'C:\\Dados')
  })
})

// ---------------------------------------------------------------------------

describe('sondagens: perfil no contrato', () => {
  async function assemble(o: { cpu?: Partial<CpuApi>; memory?: Partial<MemoryApi>; os?: Partial<OsApi>; statfs?: StorageApi['statfs'] } = {}): Promise<HardwareProfile> {
    const cpu = cpuToProfile(probeCpu({ cpus: () => [{ model: 'CPU de teste' }, { model: 'CPU de teste' }], machine: () => 'arm64', ...o.cpu }))
    const memory = memoryToProfile(probeMemory({ totalmem: () => 8 * GiB, freemem: () => 3 * GiB, platform: () => 'win32', ...o.memory }))
    const os = osToProfile(probeOs({ platform: () => 'win32', release: () => '10.0.19045', machine: () => 'arm64', ...o.os }))
    const storage = storageToProfile(
      await probeStorage({ kind: 'app-data', path: 'C:\\Dados' }, { platform: 'win32', statfs: o.statfs ?? (async () => ({ bsize: 512, blocks: (256 * GiB) / 512, bavail: GiB / 512 })) })
    )
    // GPU e aceleração ainda não são sondadas: indisponíveis.
    const quality = uniformQuality({ gpus: null, acceleration: null }, 'detected')
    return {
      cpu: cpu.cpu,
      memory: memory.memory,
      gpus: null,
      storage: storage.storage,
      os: os.os,
      acceleration: null,
      provenance: {
        source: 'local-detector',
        detectorId: 'probes-test',
        collectedAt: '2026-11-03T12:00:00.000Z',
        confidence: 'medium',
        quality: { fields: { ...quality.fields, ...cpu.quality, ...memory.quality, ...os.quality, ...storage.quality }, gpus: null }
      }
    }
  }

  it('perfil completo das quatro sondagens é válido no contrato, sem `simulated`', async () => {
    const p = await assemble()
    const r = validateHardwareProfile(p)
    assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.issues))
    assert.ok(Object.values(p.provenance.quality.fields).every((q) => q !== 'simulated'))
    assert.equal(p.provenance.quality.fields['cpu.physicalCores'], 'unavailable')
    assert.equal(p.provenance.quality.fields.gpus, 'unavailable')
  })

  it('perfil parcial continua válido e mantém o que foi identificado', async () => {
    const p = await assemble({
      cpu: { cpus: () => [{ model: '' }] },
      memory: { freemem: () => 64 * GiB },
      statfs: async () => {
        throw Object.assign(new Error('x'), { code: 'EACCES' })
      }
    })
    const r = validateHardwareProfile(p)
    assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.issues))
    assert.deepEqual(p.cpu, { model: null, architecture: 'arm64', physicalCores: null, logicalCores: 1 })
    assert.deepEqual(p.memory, { totalGb: 8, availableGb: null })
    assert.equal(p.storage, null, 'sem nenhum atributo, a seção é nula')
    assert.deepEqual(p.os, { platform: 'windows', version: '10 (build 19045)', architecture: 'arm64' })
    const q = p.provenance.quality.fields
    assert.deepEqual([q['cpu.model'], q['cpu.logicalCores'], q['memory.totalGb'], q['memory.availableGb'], q['storage.freeGb']], ['unavailable', 'detected', 'detected', 'unavailable', 'unavailable'])
  })

  it('arquitetura estimada continua marcada como estimada no perfil', async () => {
    const p = await assemble({ cpu: { machine: undefined, arch: () => 'x64' } })
    assert.ok(validateHardwareProfile(p).ok)
    assert.equal(p.provenance.quality.fields['cpu.architecture'], 'estimated')
  })
})

// ---------------------------------------------------------------------------

describe('sondagens: sem efeitos colaterais e sem uso pelo app', () => {
  const ROOT = join(import.meta.dirname, '../..')
  const PROBES = join('src', 'main', 'hardware', 'local', 'probes')
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))

  it('só leem: sem processos, sem gravação, sem percorrer pastas, sem log', () => {
    for (const file of walk(PROBES)) {
      const src = read(file)
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])
      const allowed = ['node:os', 'node:fs/promises', 'node:path', '@shared/hardware', './common']
      // GPU: o tipo do resultado do executor e os identificadores do catálogo; o executor em si é injetado.
      if (file.endsWith('gpu.ts')) allowed.push('../command-runner', '../commands')
      assert.ok(imports.every((i) => allowed.includes(i!)), `${file}: ${imports.join(', ')}`)
      assert.ok(!/child_process|writeFile|appendFile|mkdir|readdir|opendir|readFile|unlink|\brm\(|\brename|console\./.test(src), file)
    }
    assert.match(read(join(PROBES, 'storage.ts')), /import \{ statfs \} from 'node:fs\/promises'/)
  })

  it('as sondagens só chamam as APIs recebidas, uma vez cada', () => {
    const calls: string[] = []
    const spy = <T>(name: string, value: T) => () => (calls.push(name), value)
    probeCpu({ cpus: spy('cpus', [{ model: 'x' }]), machine: spy('machine', 'x64'), arch: spy('arch', 'x64'), availableParallelism: spy('ap', 1) })
    probeMemory({ totalmem: spy('totalmem', GiB), freemem: spy('freemem', 1), platform: spy('platform', 'win32') })
    probeOs({ platform: spy('os.platform', 'win32'), release: spy('release', '10.0.1'), version: spy('version', 'x'), machine: spy('os.machine', 'x64') })
    assert.deepEqual(calls, ['cpus', 'machine', 'totalmem', 'freemem', 'platform', 'os.platform', 'release', 'version', 'os.machine'])
  })

  it('nada no app usa as sondagens nesta etapa, exceto o detector local isolado (serviço, inicialização, IPC, Preload, Renderer)', () => {
    // O detector local isolado e o diagnóstico manual (só executado pelo script, com confirmação).
    // Os módulos DXCore (regras, seleção e a captura das fontes da sondagem de GPU, usada pelo
    // detector local e pelo diagnóstico manual); nenhum deles é usado pelo serviço.
    const ALLOWED = ['local-hardware-detector.ts', 'diagnostic.ts', 'dxcore/rules.ts', 'dxcore/selection.ts', 'dxcore/capture.ts'].map((f) => join('src', 'main', 'hardware', 'local', ...f.split('/')))
    const users = [...walk('src/main'), ...walk('src/preload'), ...walk('src/renderer'), ...walk('src/shared')]
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith(PROBES) && !ALLOWED.includes(f))
      .filter((f) => /probes\//.test(read(f)) || /probe(Cpu|Memory|Os|Storage|Gpus)/.test(read(f)))
    assert.deepEqual(users, [])
  })
})
