import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { describe, it } from 'node:test'
import { BundledHelperRunner, DXCORE_HELPER, type HelperFs } from '../../src/main/hardware/local/bundled-helper'
import type { SpawnFn } from '../../src/main/hardware/local/command-runner'
import { resolveHelperResourcesRoot } from '../../src/main/hardware/local/helper-root'

// Raiz resolvida → executor do auxiliar, com arquivos SIMULADOS e um `spawn`
// que só registra: nenhum executável é lido do disco nem iniciado.

const PACKAGED = 'C:\\Program Files\\Gerpro Studio\\resources'
const APP = 'C:\\dev\\gerpro-studio'
const CONTENT = Buffer.alloc(4_096, 0x4d)

type FakeFile = { symlink?: boolean; realpath?: string }

/** Executor de verdade sobre a raiz resolvida, com o hash embutido (hoje `null`). */
function runnerFor(root: string, o: { files?: Record<string, FakeFile>; arch?: string } = {}) {
  const files = o.files ?? {}
  const find = (path: string) => Object.entries(files).find(([k]) => k.toLowerCase() === path.toLowerCase())?.[1]
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const reads: string[] = []
  const fs: HelperFs = {
    async lstat(path) {
      reads.push(path)
      const f = find(path)
      if (!f) throw enoent()
      return { isFile: () => !f.symlink, isSymbolicLink: () => Boolean(f.symlink), size: CONTENT.length, dev: 1, ino: 2, mtimeMs: 3 }
    },
    async realpath(path) {
      const f = find(path)
      if (!f) throw enoent()
      return f.realpath ?? path
    },
    readFile: async () => CONTENT
  }
  let spawns = 0
  const spawn: SpawnFn = () => {
    spawns++
    throw new Error('não deveria iniciar processo')
  }
  const runner = new BundledHelperRunner({ resourcesRoot: root, fs, spawn, platform: 'win32', arch: o.arch ?? 'x64', env: { SystemRoot: 'C:\\Windows' } })
  return { runner, spawns: () => spawns, reads }
}
const helperIn = (root: string, arch = 'x64') => win32.join(root, DXCORE_HELPER.directory, `win32-${arch}`, DXCORE_HELPER.fileName)
const summary = (r: Awaited<ReturnType<BundledHelperRunner['run']>>) => [r.kind, 'reason' in r ? r.reason : null, r.process]

describe('resolveHelperResourcesRoot + executor: caminhos de recursos', () => {
  const dev = resolveHelperResourcesRoot({ isPackaged: false, appPath: APP, resourcesPath: PACKAGED })!
  const packaged = resolveHelperResourcesRoot({ isPackaged: true, appPath: `${PACKAGED}\\app.asar`, resourcesPath: PACKAGED })!

  it('o executor procura só `<raiz>\\helpers\\win32-<arquitetura>\\gerpro-dxcore-helper.exe`, nos dois modos', () => {
    assert.equal(helperIn(dev), `${APP}\\resources\\helpers\\win32-x64\\gerpro-dxcore-helper.exe`)
    assert.equal(helperIn(packaged), `${PACKAGED}\\helpers\\win32-x64\\gerpro-dxcore-helper.exe`)
    // Empacotado: fora do asar, mesmo com o caminho do app dentro dele.
    assert.ok(!packaged.includes('app.asar'))
  })

  it('caminho inexistente: indisponível, sem iniciar processo', async () => {
    for (const root of [dev, packaged]) {
      const h = runnerFor(root)
      assert.deepEqual(await h.runner.run(), { kind: 'unavailable', reason: 'not-found', commandId: DXCORE_HELPER.id, processExited: true, process: 'not-started' })
      assert.deepEqual(h.reads, [helperIn(root)])
      assert.equal(h.spawns(), 0)
    }
  })

  it('link simbólico no arquivo ou junção em qualquer pasta do caminho (inclusive a raiz): recusado', async () => {
    for (const root of [dev, packaged]) {
      const path = helperIn(root)
      const cases: Array<[FakeFile, string]> = [
        [{ symlink: true }, 'symlink'],
        // Junção na própria raiz (`resources` → outra pasta) ou numa subpasta: o caminho real muda.
        [{ realpath: path.replace(root, 'D:\\outro') }, 'redirected'],
        [{ realpath: path.replace('\\helpers\\', '\\outra-pasta\\') }, 'redirected']
      ]
      for (const [file, reason] of cases) {
        const h = runnerFor(root, { files: { [path]: file } })
        assert.deepEqual(summary(await h.runner.run()), ['rejected', reason, 'not-started'])
        assert.equal(h.spawns(), 0)
      }
    }
  })

  it('arquivo presente com o hash de produção null: recusado sem executar (dev e empacotado)', async () => {
    for (const root of [dev, packaged]) {
      const h = runnerFor(root, { files: { [helperIn(root)]: {} } })
      assert.deepEqual(summary(await h.runner.run()), ['rejected', 'integrity-unknown', 'not-started'])
      assert.equal(h.spawns(), 0)
    }
  })

  it('arquiteturas: x64 e arm64 têm pasta própria (ambas sem hash); as demais são recusadas antes de qualquer leitura', async () => {
    const arm = runnerFor(dev, { arch: 'arm64', files: { [helperIn(dev, 'arm64')]: {} } })
    assert.deepEqual(summary(await arm.runner.run()), ['rejected', 'integrity-unknown', 'not-started'])
    assert.deepEqual(arm.reads, [helperIn(dev, 'arm64')])
    for (const arch of ['ia32', 'arm', 'loong64', '']) {
      const h = runnerFor(dev, { arch, files: { [helperIn(dev, arch)]: {} } })
      assert.deepEqual(summary(await h.runner.run()), ['rejected', 'unsupported-arch', 'not-started'], arch)
      assert.deepEqual(h.reads, [])
      assert.equal(h.spawns(), 0)
    }
  })

  it('raiz não confiável que chegue ao executor sem passar pela resolução: recusada pela localização', async () => {
    for (const root of ['resources', '\\\\servidor\\c\\resources', 'C:\\a\\..\\b', '\\\\?\\C:\\app']) {
      const h = runnerFor(root)
      assert.deepEqual(summary(await h.runner.run()), ['rejected', 'location-invalid', 'not-started'], root)
      assert.deepEqual(h.reads, [])
    }
  })
})

describe('resolveHelperResourcesRoot: compatibilidade com o electron-vite e o build do auxiliar', () => {
  const ROOT = join(import.meta.dirname, '../..')
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

  it('desenvolvimento: `app.getAppPath()` é a raiz do projeto (main em `out/`, sem raiz própria no electron-vite)', () => {
    const pkg = JSON.parse(read('package.json')) as { main: string; scripts: Record<string, string> }
    // Com `main` dentro do projeto, o Electron usa a pasta do package.json como caminho do app.
    assert.equal(pkg.main, './out/main/index.js')
    assert.equal(pkg.scripts['dev'], 'electron-vite dev')
    // Nenhuma raiz, saída ou pasta pública alternativa que mude o caminho do app.
    assert.doesNotMatch(read('electron.vite.config.ts'), /\broot\s*:|outDir|publicDir/)
  })

  it('o build do auxiliar grava exatamente onde a resolução de desenvolvimento procura, e a pasta não é versionada', () => {
    const script = read('scripts/native/build-dxcore-helper.mjs')
    assert.match(script, /const OUTPUT_DIR = join\(ROOT, 'resources', 'helpers', 'win32-x64'\)/)
    assert.ok(script.includes(`const HELPER_NAME = '${DXCORE_HELPER.fileName}'`))
    assert.equal(DXCORE_HELPER.directory, 'helpers')
    assert.match(read('.gitignore'), /^\/resources\/helpers\/$/m)
  })

  it('a resolução só usa `node:path` e a validação do executor: sem sistema de arquivos, ambiente ou Electron', () => {
    const imports = [...read('src/main/hardware/local/helper-root.ts').matchAll(/^import .* from '(.+)'$/gm)].map((m) => m[1])
    assert.deepEqual(imports, ['node:path', './bundled-helper'])
  })
})
