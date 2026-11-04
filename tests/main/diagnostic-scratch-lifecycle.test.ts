import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  SCRATCH_PREFIX,
  SUPERVISOR_EXIT,
  acceptScratch,
  createScratch,
  formatSupervision,
  removeScratch,
  superviseDiagnostic,
  type ChildExit,
  type ChildHandle,
  type ScratchFs,
  type SuperviseDeps
} from '../../scripts/diagnostics/scratch-lifecycle'

// Ciclo de vida da pasta do diagnóstico (D55): sem Electron e sem hardware.
// Cada teste usa uma raiz temporária própria no lugar da pasta temporária do sistema.

const realFs: ScratchFs = {
  mkdtemp: (prefix) => mkdtempSync(prefix),
  lstat: (path) => lstatSync(path),
  readdir: (path) => readdirSync(path),
  unlink: (path) => unlinkSync(path),
  rmdir: (path) => rmdirSync(path),
  realpath: (path) => realpathSync.native(path)
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Electron simulado: grava "caches" na pasta e sai quando mandado. */
function fakeChild(onKill?: () => void) {
  let finish!: (exit: ChildExit) => void
  const exited = new Promise<ChildExit>((r) => (finish = r))
  const handle: ChildHandle & { killed: number } = {
    exited,
    killed: 0,
    kill() {
      handle.killed++
      onKill?.()
      finish({ code: null, signal: 'SIGTERM' })
    }
  }
  return { handle, exit: (code: number) => finish({ code, signal: null }) }
}

const writeCaches = (dir: string) => {
  mkdirSync(join(dir, 'GPUPersistentCache', 'DawnGraphiteCache'), { recursive: true })
  writeFileSync(join(dir, 'GPUPersistentCache', 'DawnGraphiteCache', 'data_0'), 'x')
  writeFileSync(join(dir, 'Local State'), '{}')
}

let root: string
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'gerpro-test-scratch-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const deps = (o: Partial<SuperviseDeps> & Pick<SuperviseDeps, 'spawnChild'>): SuperviseDeps => ({
  fs: realFs,
  tmpRoot: root,
  onInterrupt: () => () => undefined,
  cleanup: { attempts: 3, sleep: async () => undefined },
  ...o
})

describe('supervisor do diagnóstico: ciclo de vida da pasta', () => {
  it('execução normal: pasta exclusiva, usada pelo processo e removida só depois do encerramento', async () => {
    let scratch = ''
    const child = fakeChild()
    const run = superviseDiagnostic(
      deps({
        spawnChild(path) {
          scratch = path
          writeCaches(path)
          return child.handle
        }
      })
    )
    await delay(5)
    assert.ok(existsSync(scratch), 'a pasta existe enquanto o Electron roda')
    assert.ok(scratch.startsWith(join(root, SCRATCH_PREFIX)))
    child.exit(0)
    const r = await run
    assert.deepEqual([r.outcome, r.exitCode, r.childExitCode, r.cleanup?.removed], ['completed', 0, 0, true])
    assert.ok(!existsSync(scratch))
    assert.deepEqual(readdirSync(root), [])
  })

  it('falha ao iniciar o Electron (exceção ou erro de processo): pasta removida, código próprio', async () => {
    const thrown = await superviseDiagnostic(
      deps({
        spawnChild() {
          throw Object.assign(new Error(`não achou ${root}`), { code: 'ENOENT' })
        }
      })
    )
    assert.deepEqual([thrown.outcome, thrown.exitCode, thrown.errorCode, thrown.cleanup?.removed], ['spawn-failed', SUPERVISOR_EXIT.spawnFailed, 'ENOENT', true])
    assert.ok(!formatSupervision(thrown).includes(root))

    const viaEvent = await superviseDiagnostic(deps({ spawnChild: () => ({ exited: Promise.resolve({ code: null, signal: null, spawnError: 'EACCES' }), kill() {} }) }))
    assert.deepEqual([viaEvent.outcome, viaEvent.errorCode, viaEvent.cleanup?.removed], ['spawn-failed', 'EACCES', true])
    assert.deepEqual(readdirSync(root), [])
  })

  it('encerramento com erro: código do Electron preservado e pasta removida', async () => {
    const child = fakeChild()
    const run = superviseDiagnostic(deps({ spawnChild: (p) => (writeCaches(p), child.handle) }))
    child.exit(1)
    const r = await run
    assert.deepEqual([r.outcome, r.exitCode, r.childExitCode, r.cleanup?.removed], ['child-failed', 1, 1, true])
    assert.deepEqual(readdirSync(root), [])
  })

  it('cancelamento: Electron sai sozinho dentro do prazo; sem encerramento forçado; pasta removida', async () => {
    let interrupt!: () => void
    const child = fakeChild()
    const run = superviseDiagnostic(
      deps({
        spawnChild: (p) => (writeCaches(p), child.handle),
        onInterrupt: (h) => ((interrupt = h), () => undefined),
        killGraceMs: 5_000
      })
    )
    await delay(1)
    interrupt()
    await delay(5)
    child.exit(130)
    const r = await run
    assert.deepEqual([r.outcome, r.exitCode, child.handle.killed, r.cleanup?.removed], ['interrupted', 130, 0, true])
  })

  it('processo que demora a encerrar: nada é removido antes da saída; ignorando a interrupção, é forçado após o prazo', async () => {
    const events: string[] = []
    const spyFs: ScratchFs = { ...realFs, rmdir: (p) => (events.push('rmdir'), realFs.rmdir(p)), unlink: (p) => (events.push('unlink'), realFs.unlink(p)) }

    const slow = fakeChild()
    const run = superviseDiagnostic(deps({ fs: spyFs, spawnChild: (p) => (writeCaches(p), slow.handle) }))
    await delay(60)
    assert.equal(events.length, 0, 'nenhuma remoção com o processo ainda rodando')
    events.push('exit')
    slow.exit(0)
    assert.equal((await run).cleanup?.removed, true)
    assert.equal(events[0], 'exit')

    let interrupt!: () => void
    const stubborn = fakeChild(() => events.push('kill'))
    const forced = superviseDiagnostic(
      deps({ spawnChild: (p) => (writeCaches(p), stubborn.handle), onInterrupt: (h) => ((interrupt = h), () => undefined), killGraceMs: 20 })
    )
    await delay(1)
    interrupt()
    const r = await forced
    assert.deepEqual([r.outcome, r.exitCode, stubborn.handle.killed, r.cleanup?.removed], ['killed', 130, 1, true])
    // Segunda interrupção força na hora.
    const again = fakeChild()
    const twice = superviseDiagnostic(deps({ spawnChild: () => again.handle, onInterrupt: (h) => ((interrupt = h), () => undefined), killGraceMs: 60_000 }))
    await delay(1)
    interrupt()
    interrupt()
    assert.equal((await twice).outcome, 'killed')
    assert.deepEqual(readdirSync(root), [])
  })

  it('falha ao remover: informada sem caminho; diagnóstico bem-sucedido sai com código próprio', async () => {
    let scratch = ''
    const busyFs: ScratchFs = {
      ...realFs,
      rmdir: (p) => {
        if (p === scratch) throw Object.assign(new Error(`EBUSY ${p}`), { code: 'EBUSY' })
        realFs.rmdir(p)
      }
    }
    const sleeps: number[] = []
    const child = fakeChild()
    const run = superviseDiagnostic(
      deps({
        fs: busyFs,
        spawnChild: (p) => ((scratch = p), writeCaches(p), child.handle),
        cleanup: { attempts: 3, delayMs: 10, sleep: async (ms) => void sleeps.push(ms) }
      })
    )
    child.exit(0)
    const r = await run
    assert.deepEqual(r.cleanup, { removed: false, attempts: 3, reason: 'io-error', code: 'EBUSY' })
    assert.deepEqual(sleeps, [10, 20])
    assert.equal(r.exitCode, SUPERVISOR_EXIT.cleanupFailed)
    const text = formatSupervision(r)
    assert.match(text, /NÃO removida: io-error \(EBUSY\)/)
    assert.ok(!text.includes(root) && !text.includes(scratch))
  })

  it('duas execuções simultâneas: pastas distintas; uma não remove a da outra', async () => {
    const a = fakeChild()
    const b = fakeChild()
    const paths: string[] = []
    const runA = superviseDiagnostic(deps({ spawnChild: (p) => (paths.push(p), writeCaches(p), a.handle) }))
    const runB = superviseDiagnostic(deps({ spawnChild: (p) => (paths.push(p), writeCaches(p), b.handle) }))
    await delay(1)
    assert.equal(new Set(paths).size, 2)
    a.exit(0)
    assert.equal((await runA).cleanup?.removed, true)
    const pathB = paths.find((p) => existsSync(p))
    assert.ok(pathB, 'a pasta da execução B continua enquanto B roda')
    assert.ok(existsSync(join(pathB, 'Local State')))
    b.exit(0)
    assert.equal((await runB).cleanup?.removed, true)
    assert.deepEqual(readdirSync(root), [])
  })

  it('pasta de outra execução (mesmo prefixo) nunca é tocada; identidade conferida', async () => {
    const other = join(root, `${SCRATCH_PREFIX}outra`)
    mkdirSync(other)
    writeFileSync(join(other, 'Local State'), '{}')
    const child = fakeChild()
    const run = superviseDiagnostic(deps({ spawnChild: (p) => (writeCaches(p), child.handle) }))
    child.exit(0)
    await run
    assert.deepEqual(readdirSync(root), [`${SCRATCH_PREFIX}outra`])
    assert.ok(existsSync(join(other, 'Local State')))

    // Uma referência forjada à pasta da outra execução (outro inode) é recusada.
    const mine = createScratch(realFs, root)
    const forged = { ...mine, path: other }
    assert.deepEqual(await removeScratch(realFs, forged, { tmpRoot: root }), { removed: false, attempts: 1, reason: 'not-owned', code: null })
    assert.ok(existsSync(join(other, 'Local State')))
    // Fora da raiz temporária controlada: recusada sem nenhuma operação.
    const outside = { ...mine, path: join(root, 'sub', `${SCRATCH_PREFIX}x`) }
    assert.deepEqual(await removeScratch(realFs, outside, { tmpRoot: root }), { removed: false, attempts: 0, reason: 'outside-temp', code: null })
    assert.equal((await removeScratch(realFs, mine, { tmpRoot: root })).removed, true)
  })

  it('links dentro da pasta são removidos sem seguir o destino (junção real)', async () => {
    const target = join(root, 'alvo-externo')
    mkdirSync(target)
    writeFileSync(join(target, 'importante.txt'), 'não apagar')
    const child = fakeChild()
    const run = superviseDiagnostic(
      deps({
        spawnChild(p) {
          writeCaches(p)
          symlinkSync(target, join(p, 'link-para-fora'), process.platform === 'win32' ? 'junction' : 'dir')
          return child.handle
        }
      })
    )
    child.exit(0)
    assert.equal((await run).cleanup?.removed, true)
    assert.ok(existsSync(join(target, 'importante.txt')), 'o destino do link continua intacto')
    assert.deepEqual(readdirSync(root), ['alvo-externo'])
  })

  it('link de arquivo e raiz trocada por link: sem percorrer, sem apagar o destino', async () => {
    // Sistema de arquivos simulado: a pasta tem um link; readdir nunca é chamado nele.
    const calls: string[] = []
    const scratch = { path: join(root, `${SCRATCH_PREFIX}sim`), dev: 1, ino: 2 }
    const stat = (dir: boolean, link: boolean, ino = 2) => ({ isDirectory: () => dir, isSymbolicLink: () => link, dev: 1, ino })
    const fake: ScratchFs = {
      ...realFs,
      lstat: (p) => (p === scratch.path ? stat(true, false) : stat(false, true, 9)),
      readdir: (p) => (calls.push(`readdir ${p === scratch.path ? 'raiz' : 'link'}`), ['link']),
      unlink: (p) => {
        calls.push('unlink link')
        throw Object.assign(new Error(p), { code: 'EPERM' })
      },
      rmdir: (p) => void calls.push(`rmdir ${p === scratch.path ? 'raiz' : 'link'}`)
    }
    assert.equal((await removeScratch(fake, scratch, { tmpRoot: root })).removed, true)
    assert.deepEqual(calls, ['readdir raiz', 'unlink link', 'rmdir link', 'rmdir raiz'])

    const swapped: ScratchFs = { ...fake, lstat: () => stat(false, true) }
    assert.deepEqual(await removeScratch(swapped, scratch, { tmpRoot: root }), { removed: false, attempts: 1, reason: 'is-link', code: null })
  })

  it('falha ao criar a pasta: nada iniciado', async () => {
    let spawned = false
    const r = await superviseDiagnostic(
      deps({
        fs: {
          ...realFs,
          mkdtemp: () => {
            throw Object.assign(new Error('x'), { code: 'EACCES' })
          }
        },
        spawnChild: () => ((spawned = true), fakeChild().handle)
      })
    )
    assert.deepEqual([r.outcome, r.exitCode, r.cleanup, r.errorCode, spawned], ['scratch-failed', SUPERVISOR_EXIT.scratchFailed, null, 'EACCES', false])
  })
})

describe('parte Electron: aceita só a pasta do supervisor', () => {
  it('absoluta, direto na raiz temporária, com o prefixo, diretório real', () => {
    const mine = createScratch(realFs, root)
    assert.equal(acceptScratch(realFs, mine.path, root), mine.path)
    const nested = join(root, 'sub')
    mkdirSync(nested)
    const deeper = realpathSync.native(mkdtempSync(join(nested, SCRATCH_PREFIX)))
    const wrongPrefix = join(root, 'outra-coisa')
    mkdirSync(wrongPrefix)
    const link = join(root, `${SCRATCH_PREFIX}link`)
    symlinkSync(mine.path, link, process.platform === 'win32' ? 'junction' : 'dir')
    for (const bad of [undefined, '', 'gerpro-hwdiag-x', deeper, wrongPrefix, link, join(root, `${SCRATCH_PREFIX}inexistente`)]) {
      assert.equal(acceptScratch(realFs, bad, root), null, String(bad))
    }
  })
})
