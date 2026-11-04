import assert from 'node:assert/strict'
import { spawn as realSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, mock } from 'node:test'
import {
  COMMAND_LIMITS,
  CommandRunner,
  defineCommands,
  POWERSHELL_PREFIX,
  resolveSystemDirectory,
  type CommandDefinition,
  type SpawnedProcess,
  type SpawnFn,
  type SpawnOptions
} from '../../src/main/hardware/local/command-runner'

// Nenhum teste aqui executa PowerShell, reg.exe ou consulta o hardware: os
// processos são simulados. Só o último bloco inicia um `node` real (que não lê
// nada) para conferir o encerramento de processos no sistema.

const WINDOWS_ENV = { SystemRoot: 'C:\\Windows', PATH: 'C:\\pasta-do-usuario' }

const ps = (o: Partial<CommandDefinition> = {}): CommandDefinition => ({
  id: 'test.ps',
  executable: 'powershell',
  args: [...POWERSHELL_PREFIX, 'Write-Output 1'],
  timeoutMs: 1_000,
  maxOutputBytes: 1_024,
  ...o
})
const reg = (o: Partial<CommandDefinition> = {}): CommandDefinition => ({
  id: 'test.reg',
  executable: 'reg',
  args: ['query', 'HKLM\\SYSTEM\\Teste', '/s', '/v', 'Valor'],
  timeoutMs: 1_000,
  maxOutputBytes: 1_024,
  ...o
})

/** Processo simulado, controlado pelo teste. */
class FakeProcess extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kills = 0
  /** Se o processo termina ao receber o pedido de encerramento. */
  diesOnKill = true
  kill(): boolean {
    this.kills++
    if (this.diesOnKill) setImmediate(() => this.emit('close', null, 'SIGTERM'))
    return true
  }
  out(text: string | Buffer) {
    this.stdout.emit('data', Buffer.isBuffer(text) ? text : Buffer.from(text))
  }
  err(text: string) {
    this.stderr.emit('data', Buffer.from(text))
  }
  exit(code: number) {
    this.emit('close', code, null)
  }
}

function harness(definitions: CommandDefinition[] = [ps(), reg()], o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; arch?: string; spawnThrows?: Error } = {}) {
  const calls: Array<{ file: string; args: readonly string[]; options: SpawnOptions }> = []
  const processes: FakeProcess[] = []
  const spawn: SpawnFn = (file, args, options) => {
    calls.push({ file, args, options })
    if (o.spawnThrows) throw o.spawnThrows
    const p = new FakeProcess()
    processes.push(p)
    return p
  }
  const runner = new CommandRunner({
    commands: defineCommands(definitions),
    spawn,
    platform: o.platform ?? 'win32',
    arch: o.arch ?? 'x64',
    env: o.env ?? WINDOWS_ENV
  })
  return { runner, calls, processes, last: () => processes.at(-1)! }
}

const tick = () => new Promise<void>((r) => setImmediate(r))
const errno = (code: string) => Object.assign(new Error(code), { code })

describe('CommandRunner: catálogo', () => {
  it('aceita PowerShell com o prefixo obrigatório e reg query em HKLM', () => {
    const catalog = defineCommands([ps(), reg(), reg({ id: 'test.reg2', args: ['query', 'HKLM\\A', '/ve', '/reg:64'] })])
    assert.equal(catalog.size, 3)
  })

  it('recusa executáveis fora da lista', () => {
    for (const executable of ['cmd', 'node', 'C:\\Windows\\System32\\cmd.exe', 'powershell.exe', 'pwsh', '__proto__', 'toString']) {
      assert.throws(() => defineCommands([ps({ executable: executable as 'powershell' })]), /executável não autorizado/, executable)
    }
  })

  it('PowerShell: só o prefixo obrigatório e um único script', () => {
    const bad: string[][] = [
      ['-Command', 'x'],
      [...POWERSHELL_PREFIX],
      [...POWERSHELL_PREFIX, 'x', 'y'],
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', 'eAA='],
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'C:\\script.ps1'],
      ['-ExecutionPolicy', 'Bypass', ...POWERSHELL_PREFIX, 'x'],
      [...POWERSHELL_PREFIX.slice(0, 3), '-NoExit', '-Command', 'x']
    ]
    for (const args of bad) assert.throws(() => defineCommands([ps({ args })]), /PowerShell/, args.join(' '))
  })

  it('reg: só leitura (query), só HKLM, só opções de consulta', () => {
    const bad: string[][] = [
      ['add', 'HKLM\\A', '/v', 'x', '/d', '1'],
      ['delete', 'HKLM\\A', '/f'],
      ['export', 'HKLM\\A', 'C:\\saida.reg'],
      ['query', 'HKCU\\Software'],
      ['query', 'HKLM\\A', '/x'],
      ['query', 'HKLM\\A', '&', 'calc'],
      ['query', 'HKLM\\A"', '/s']
    ]
    for (const args of bad) assert.throws(() => defineCommands([reg({ args })]), /reg/, args.join(' '))
  })

  it('argumentos com caracteres de controle, vazios ou longos demais são recusados', () => {
    assert.throws(() => defineCommands([ps({ args: [...POWERSHELL_PREFIX, 'a\nb'] })]), /caractere de controle/)
    assert.throws(() => defineCommands([ps({ args: [...POWERSHELL_PREFIX, 'a\u0000b'] })]), /caractere de controle/)
    assert.throws(() => defineCommands([ps({ args: [...POWERSHELL_PREFIX, ''] })]), /tamanho/)
    assert.throws(() => defineCommands([ps({ args: [...POWERSHELL_PREFIX, 'x'.repeat(COMMAND_LIMITS.maxArgLength + 1)] })]), /tamanho/)
    assert.throws(() => defineCommands([ps({ args: [] })]), /quantidade/)
  })

  it('limites, prazos e identificadores são validados', () => {
    assert.throws(() => defineCommands([ps({ timeoutMs: 0 })]), /prazo/)
    assert.throws(() => defineCommands([ps({ timeoutMs: COMMAND_LIMITS.maxTimeoutMs + 1 })]), /prazo/)
    assert.throws(() => defineCommands([ps({ maxOutputBytes: COMMAND_LIMITS.maxOutputBytes + 1 })]), /limite de saída/)
    assert.throws(() => defineCommands([ps({ id: 'Com Espaço' })]), /identificador inválido/)
    assert.throws(() => defineCommands([ps(), ps()]), /identificador repetido/)
  })

  it('o catálogo é congelado: alterar a definição original não muda o comando', () => {
    const args = [...POWERSHELL_PREFIX, 'Write-Output 1']
    const catalog = defineCommands([ps({ args })])
    args[4] = 'Remove-Item C:\\ -Recurse'
    assert.equal(catalog.get('test.ps')!.args[4], 'Write-Output 1')
    assert.throws(() => (catalog.get('test.ps')!.args as string[]).push('x'))
  })
})

describe('CommandRunner: resolução dos executáveis', () => {
  it('processo de 64 bits (x64, ARM64 ou x64 emulado no ARM64): System32', () => {
    assert.equal(resolveSystemDirectory({ SystemRoot: 'C:\\Windows' }, 'x64'), 'C:\\Windows\\System32')
    assert.equal(resolveSystemDirectory({ SystemRoot: 'C:\\Windows', PROCESSOR_ARCHITECTURE: 'ARM64' }, 'arm64'), 'C:\\Windows\\System32')
    assert.equal(resolveSystemDirectory({ SystemRoot: 'D:\\WIN' }, 'x64'), 'D:\\WIN\\System32')
  })

  it('processo de 32 bits num Windows de 64 bits: Sysnative (evita o redirecionamento para SysWOW64)', () => {
    assert.equal(resolveSystemDirectory({ SystemRoot: 'C:\\Windows', PROCESSOR_ARCHITEW6432: 'AMD64' }, 'ia32'), 'C:\\Windows\\Sysnative')
    assert.equal(resolveSystemDirectory({ SystemRoot: 'C:\\Windows', PROCESSOR_ARCHITEW6432: 'ARM64' }, 'ia32'), 'C:\\Windows\\Sysnative')
    assert.equal(resolveSystemDirectory({ SystemRoot: 'C:\\Windows' }, 'ia32'), 'C:\\Windows\\System32')
  })

  it('usa windir na falta de SystemRoot; recusa raízes não confiáveis', () => {
    assert.equal(resolveSystemDirectory({ windir: 'C:\\Windows' }, 'x64'), 'C:\\Windows\\System32')
    for (const root of [undefined, '', 'Windows', '\\\\servidor\\share', 'C:\\Windows\\..\\Users\\x', 'C:/Windows', 'C:\\Win;dows', 'C:\\Win"dows', 'C:\\a\\\\b']) {
      assert.equal(resolveSystemDirectory({ SystemRoot: root }, 'x64'), null, String(root))
    }
  })

  it('validação da raiz não sofre retrocesso exponencial', () => {
    const started = performance.now()
    assert.equal(resolveSystemDirectory({ SystemRoot: `C:\\${'a'.repeat(50_000)}*` }, 'x64'), null)
    assert.equal(resolveSystemDirectory({ SystemRoot: `C:\\${'a\\'.repeat(10_000)}\\*` }, 'x64'), null)
    assert.ok(performance.now() - started < 500)
  })
})

describe('CommandRunner: execução', () => {
  it('execução permitida: caminho absoluto do sistema, sem shell, argumentos intactos', async () => {
    const h = harness()
    const pending = h.runner.run('test.ps')
    await tick()
    h.last().out('linha 1\n')
    h.last().out('linha 2\n')
    h.last().exit(0)
    const r = await pending
    assert.equal(r.kind, 'success')
    assert.equal(r.kind === 'success' && r.stdout, 'linha 1\nlinha 2\n')
    assert.equal(r.processExited, true)

    assert.equal(h.calls.length, 1)
    const { file, args, options } = h.calls[0]!
    assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.deepEqual(args, [...POWERSHELL_PREFIX, 'Write-Output 1'])
    assert.equal(options.shell, false)
    assert.equal(options.windowsVerbatimArguments, false)
    assert.equal(options.windowsHide, true)
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(options.cwd, 'C:\\Windows\\System32')
    assert.equal(options.env['PSModulePath'], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules')
  })

  it('reg.exe também vem da pasta do sistema, nunca do PATH', async () => {
    const h = harness()
    const pending = h.runner.run('test.reg')
    await tick()
    h.last().exit(0)
    await pending
    assert.equal(h.calls[0]!.file, 'C:\\Windows\\System32\\reg.exe')
    assert.ok(!h.calls[0]!.file.includes('pasta-do-usuario'))
  })

  it('texto em UTF-8 dividido entre blocos é reconstituído', async () => {
    const h = harness()
    const pending = h.runner.run('test.ps')
    await tick()
    const bytes = Buffer.from('GPU Ação ✓', 'utf8')
    h.last().out(bytes.subarray(0, 6))
    h.last().out(bytes.subarray(6))
    h.last().exit(0)
    const r = await pending
    assert.equal(r.kind === 'success' && r.stdout, 'GPU Ação ✓')
  })

  it('comando fora do catálogo: recusado sem iniciar processo', async () => {
    const h = harness()
    for (const id of ['inexistente', 'powershell', 'cmd', '__proto__', 'test.ps; calc']) {
      const r = await h.runner.run(id)
      assert.deepEqual({ kind: r.kind, reason: r.kind === 'failed' && r.reason }, { kind: 'failed', reason: 'unknown-command' }, id)
    }
    assert.equal(h.calls.length, 0)
  })

  it('fora do Windows ou sem pasta do sistema confiável: indisponível, sem iniciar processo', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const h = harness(undefined, { platform })
      const r = await h.runner.run('test.ps')
      assert.equal(r.kind === 'unavailable' && r.reason, 'unsupported-platform')
      assert.equal(h.calls.length, 0)
    }
    const h = harness(undefined, { env: { SystemRoot: 'Windows' } })
    const r = await h.runner.run('test.ps')
    assert.equal(r.kind === 'unavailable' && r.reason, 'system-directory-unknown')
    assert.equal(h.calls.length, 0)
  })

  it('falha de inicialização: ausente, sem permissão ou outro erro', async () => {
    const cases = [
      ['ENOENT', { kind: 'unavailable', reason: 'not-found' }],
      ['EACCES', { kind: 'unavailable', reason: 'permission-denied' }],
      ['EPERM', { kind: 'unavailable', reason: 'permission-denied' }],
      ['EMFILE', { kind: 'failed', reason: 'spawn-error' }]
    ] as const
    for (const [code, expected] of cases) {
      const h = harness()
      const pending = h.runner.run('test.ps')
      await tick()
      h.last().emit('error', errno(code))
      const r = await pending
      assert.deepEqual({ kind: r.kind, reason: 'reason' in r ? r.reason : null }, expected, code)
      assert.equal(h.last().kills, 0)
    }
    // `spawn` que lança de forma síncrona também vira resultado, não exceção.
    const thrown = await harness(undefined, { spawnThrows: errno('ENOENT') }).runner.run('test.ps')
    assert.equal(thrown.kind === 'unavailable' && thrown.reason, 'not-found')
  })

  it('código de saída diferente de zero: falha, sem devolver a saída', async () => {
    const h = harness()
    const pending = h.runner.run('test.ps')
    await tick()
    h.last().out('parcial')
    h.last().err('Acesso negado a C:\\Users\\fulano\\segredo')
    h.last().exit(5)
    const r = await pending
    assert.deepEqual(r, { kind: 'failed', reason: 'exit-code', exitCode: 5, commandId: 'test.ps', processExited: true })
  })

  it('a saída de erro nunca aparece no resultado', async () => {
    const h = harness()
    const pending = h.runner.run('test.ps')
    await tick()
    h.last().err('SEGREDO-DO-SISTEMA')
    h.last().out('ok')
    h.last().exit(0)
    assert.ok(!JSON.stringify(await pending).includes('SEGREDO'))
  })

  it('saída acima do limite: processo encerrado e nada devolvido', async () => {
    for (const stream of ['out', 'err'] as const) {
      const h = harness([ps({ maxOutputBytes: 10 })])
      const pending = h.runner.run('test.ps')
      await tick()
      h.last()[stream]('12345')
      h.last()[stream]('678901')
      const r = await pending
      assert.deepEqual({ kind: r.kind, reason: r.kind === 'failed' && r.reason, exited: r.processExited }, { kind: 'failed', reason: 'output-limit', exited: true }, stream)
      assert.equal(h.last().kills, 1)
      assert.ok(!('stdout' in r))
    }
  })

  it('timeout: processo encerrado e o resultado só chega depois que ele termina', async () => {
    const h = harness([ps({ timeoutMs: 100 })])
    const started = Date.now()
    const r = await h.runner.run('test.ps')
    assert.equal(r.kind, 'timeout')
    assert.equal(r.processExited, true)
    assert.equal(h.last().kills, 1)
    assert.ok(Date.now() - started >= 90)
  })

  it('cancelamento: encerra o processo; sinal já cancelado nem inicia', async () => {
    const h = harness()
    const controller = new AbortController()
    const pending = h.runner.run('test.ps', controller.signal)
    await tick()
    controller.abort()
    const r = await pending
    assert.equal(r.kind, 'cancelled')
    assert.equal(r.processExited, true)
    assert.equal(h.last().kills, 1)

    const before = h.calls.length
    assert.equal((await h.runner.run('test.ps', AbortSignal.abort())).kind, 'cancelled')
    assert.equal(h.calls.length, before)
  })

  it('processo que não termina ao ser encerrado: resultado devolvido após a tolerância, sinalizado', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = harness([ps({ timeoutMs: 100 })])
    const pending = h.runner.run('test.ps')
    await tick()
    h.last().diesOnKill = false
    t.mock.timers.tick(100)
    assert.equal(h.last().kills, 1)
    t.mock.timers.tick(COMMAND_LIMITS.killGraceMs)
    const r = await pending
    assert.equal(r.kind, 'timeout')
    assert.equal(r.processExited, false)
  })

  it('depois de concluído, cancelar ou o prazo vencer não afeta mais nada', async () => {
    const h = harness([ps({ timeoutMs: 100 })])
    const controller = new AbortController()
    const pending = h.runner.run('test.ps', controller.signal)
    await tick()
    h.last().exit(0)
    assert.equal((await pending).kind, 'success')
    controller.abort()
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(h.last().kills, 0)
  })

  it('não grava nada em log', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => mock.method(console, m, () => undefined))
    try {
      const h = harness([ps({ maxOutputBytes: 5 })])
      for (const finish of [(p: FakeProcess) => p.exit(0), (p: FakeProcess) => p.exit(1), (p: FakeProcess) => p.out('muito texto'), (p: FakeProcess) => p.emit('error', errno('ENOENT'))]) {
        const pending = h.runner.run('test.ps')
        await tick()
        h.last().err('erro sensível')
        finish(h.last())
        await pending
      }
      assert.ok(spies.every((s) => s.mock.callCount() === 0))
    } finally {
      spies.forEach((s) => s.mock.restore())
    }
  })
})

describe('CommandRunner: sem execução automática e sem acesso pelo Renderer', () => {
  const ROOT = join(import.meta.dirname, '../..')
  const source = (path: string) => readFileSync(join(ROOT, path), 'utf8')
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))

  it('construir o executor não inicia processos', () => {
    const h = harness()
    assert.equal(h.calls.length, 0)
  })

  it('nada fora da pasta de detecção local usa o executor ou o catálogo (nem a inicialização, nem o IPC, nem o Renderer)', () => {
    const LOCAL = join('src', 'main', 'hardware', 'local')
    const users = [...walk('src/main'), ...walk('src/preload'), ...walk('src/renderer'), ...walk('src/shared')]
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith(LOCAL))
      .filter((f) => /command-runner|CommandRunner|HARDWARE_COMMANDS|hardware\/local/.test(source(f)))
    assert.deepEqual(users, [])
    // Dentro da pasta: o catálogo, a sondagem de GPU (que só recebe `run` por injeção)
    // o detector local (que monta o executor com o catálogo, sem conexão com o app) e o
    // diagnóstico manual (só executado pelo script, com confirmação) e o executor
    // do auxiliar empacotado (D56), que só reaproveita a supervisão do processo.
    const inside = walk(LOCAL)
      .filter((f) => !f.endsWith('command-runner.ts'))
      .filter((f) => /command-runner/.test(source(f)))
    // A captura das fontes da GPU (DXCore) também está aqui, mas só com o TIPO do resultado:
    // ela recebe `runCommand` pronto e não monta executor nem conhece o catálogo de comandos.
    assert.deepEqual(inside.sort(), [
      join(LOCAL, 'bundled-helper.ts'),
      join(LOCAL, 'commands.ts'),
      join(LOCAL, 'diagnostic.ts'),
      join(LOCAL, 'dxcore', 'capture.ts'),
      join(LOCAL, 'local-hardware-detector.ts'),
      join(LOCAL, 'probes', 'gpu.ts')
    ])
    const capture = source(join(LOCAL, 'dxcore', 'capture.ts'))
    assert.match(capture, /^import type \{ CommandResult \} from '\.\.\/command-runner'$/m)
    assert.doesNotMatch(capture, /new CommandRunner|HARDWARE_COMMANDS|defineCommands|superviseProcess|spawn/)
    // O detector continua sendo o único lugar que monta o executor com o catálogo.
    const builders = walk(LOCAL).filter((f) => /new CommandRunner\(/.test(source(f)))
    assert.deepEqual(builders.sort(), [join(LOCAL, 'diagnostic.ts'), join(LOCAL, 'local-hardware-detector.ts')])
    // O executor do auxiliar não usa o `CommandRunner` nem o catálogo: só a supervisão e a pasta do sistema.
    assert.match(source(join(LOCAL, 'bundled-helper.ts')), /import \{ resolveSystemDirectory, superviseProcess, type CommandOutcome, type CommandResult, type ProcessTermination, type SpawnFn, type SpawnOptions \} from '\.\/command-runner'/)
    assert.doesNotMatch(source(join(LOCAL, 'bundled-helper.ts')), /new CommandRunner|HARDWARE_COMMANDS|from '\.\/commands'/)
    assert.match(source(join(LOCAL, 'probes', 'gpu.ts')), /import type \{ CommandResult \} from '\.\.\/command-runner'/)
  })

  it('só o executor inicia processos no Main, e sem shell', () => {
    const spawners = walk('src/main')
      .filter((f) => /\.ts$/.test(f))
      .filter((f) => /child_process/.test(source(f)))
    assert.deepEqual(spawners, [join('src', 'main', 'hardware', 'local', 'command-runner.ts')])
    for (const file of ['command-runner.ts', 'bundled-helper.ts']) {
      const code = source(join('src', 'main', 'hardware', 'local', file))
      assert.ok(!/shell:\s*true/.test(code), file)
      assert.ok(!/\bexec\(|execSync|spawnSync|execFile/.test(code), file)
    }
  })
})

describe('CommandRunner: encerramento de um processo real', () => {
  // Processo `node` que só espera; nenhum comando do sistema é executado.
  const nodeSpawn = (pids: number[]): SpawnFn => (_file, _args, options) => {
    const child = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, cwd: process.cwd(), env: process.env })
    if (child.pid) pids.push(child.pid)
    return child
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  for (const [label, trigger] of [
    ['timeout', null],
    ['cancelamento', 50]
  ] as const) {
    it(`${label}: o processo não continua ativo`, async () => {
      const pids: number[] = []
      const runner = new CommandRunner({
        commands: defineCommands([ps({ timeoutMs: 300 })]),
        spawn: nodeSpawn(pids),
        platform: 'win32',
        arch: process.arch,
        env: { SystemRoot: 'C:\\Windows' }
      })
      const controller = new AbortController()
      if (trigger !== null) setTimeout(() => controller.abort(), trigger)
      const r = await runner.run('test.ps', controller.signal)
      assert.equal(r.kind, trigger === null ? 'timeout' : 'cancelled')
      assert.equal(r.processExited, true)
      assert.equal(pids.length, 1)
      assert.equal(alive(pids[0]!), false)
    })
  }
})
