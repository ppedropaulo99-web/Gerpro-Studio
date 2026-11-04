import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DXCORE_HELPER_SHA256 } from '../../src/main/hardware/local/bundled-helper'
import { DXCORE_HOST_SHA256 } from '../../src/main/hardware/local/dxcore-host-contract'

// Revisão estática do supervisor dos testes de contenção e da entrada
// Electron de teste (6C.6C.2A). Nada é executado.

const ROOT = join(import.meta.dirname, '../..')
const DIAG = join(ROOT, 'scripts', 'diagnostics')
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8')
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const walk = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []

const FILES = {
  entry: join(DIAG, 'run-host-containment.mjs'),
  electron: join(DIAG, 'host-containment-electron.mjs'),
  battery: join(DIAG, 'host-containment', 'battery.ts'),
  plan: join(DIAG, 'host-containment', 'plan.ts'),
  checks: join(DIAG, 'host-containment', 'system-checks.ts'),
  lockHolder: join(DIAG, 'host-containment', 'lock-holder.ts')
}
const all = () => Object.values(FILES).map((f) => code(readFileSync(f, 'utf8'))).join('\n')

describe('supervisor de contenção: fora do app', () => {
  it('nenhum arquivo do app, do build ou do pacote cita o supervisor ou a entrada de teste', () => {
    const files = [...walk(join(ROOT, 'src')), join(ROOT, 'package.json'), join(ROOT, 'electron.vite.config.ts')]
    for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), /host-containment|run-host-containment|GERPRO_6C6C/, file)
  })

  it('a entrada Electron não abre janela, IPC, rede nem código do app', () => {
    const e = code(read(FILES.electron))
    for (const forbidden of [/BrowserWindow|ipcMain|ipcRenderer|contextBridge|loadURL|loadFile|webContents/, /\bnet\.|session\.|protocol\.|https?:/, /src\/main|src\/preload|src\/renderer|services\/index/, /consent/i]) {
      assert.doesNotMatch(e, forbidden, String(forbidden))
    }
    assert.match(e, /if \(!process\.argv\.includes\(CONFIRM_RUN\)\) return fail/)
    assert.match(e, /scratch\.acceptScratch\(/)
    assert.match(e, /checks\.BATTERY_SCRATCH_PREFIX/)
    assert.match(e, /app\.setPath\('userData', data\)/)
    assert.match(e, /sha256File\(launcher\) !== plan\.APPROVED_ARTIFACTS\.launcher\.sha256 \|\| sha256File\(helper\) !== probe\.sha256/)
  })

  it('nunca o launcher de produção, o auxiliar DXCore real nem resources/', () => {
    assert.doesNotMatch(all(), /gerpro-dxcore-helper|gerpro-helper-host\.exe|'resources'|DXCORE_HELPER_SHA256|DXCORE_HOST_SHA256/)
    assert.deepEqual(DXCORE_HOST_SHA256, { x64: null, arm64: null })
    assert.deepEqual(DXCORE_HELPER_SHA256, { x64: null, arm64: null })
  })
})

describe('supervisor de contenção: encerramento só por identidade', () => {
  it('nenhum encerramento por nome de processo', () => {
    assert.doesNotMatch(all(), /taskkill|Stop-Process|pkill|killall|\/IM\b|Get-Process/i)
  })

  it('nenhum encerramento automático de sobrevivente (nem por PID): só o processo iniciado, pelo próprio identificador', () => {
    assert.doesNotMatch(all(), /process\.kill\(|terminatePid|TerminateProcess|Stop-Process/)
    const b = code(read(FILES.battery))
    assert.match(b, /function reportSurvivors\(/)
    assert.match(b, /NÃO encerrado\. Inspeção manual necessária/)
    assert.match(b, /run\.kill\(\)/)
    // Um no prazo global do Grupo A, um no roteiro do alvo hang (6C.6C.3A) e um no do segurador de
    // travas (6C.6C.3G, só em falha); sempre o processo iniciado.
    assert.equal([...b.matchAll(/\.kill\(/g)].length, 3)
    assert.equal([...b.matchAll(/\brun\.kill\(\)/g)].length, 3)
  })

  it('Electron de teste: censo só de leitura da instância iniciada e dos filhos criados no caso', () => {
    const b = code(read(FILES.battery))
    assert.match(b, /p\.path\.toLowerCase\(\) === own && p\.created !== '0' && filetimeAtLeast\(p\.created, caseStart\)/)
    const entry = code(read(FILES.entry))
    assert.match(entry, /checks\.censusArgs\(\['electron\.exe'\]\)/)
    assert.match(entry, /electronImagePath: electronPath/)
  })

  it('processos iniciados: sem shell, encerrados só pelo próprio identificador', () => {
    const entry = code(read(FILES.entry))
    // Ferramentas do sistema, launcher de testes, Electron de teste e segurador de travas (6C.6C.3G).
    const calls = [...entry.matchAll(/\bspawn(?:Sync)?\(/g)].length
    assert.equal(calls, 4)
    assert.equal([...entry.matchAll(/shell: false/g)].length, calls)
    assert.match(entry, /kill: \(\) => child\.kill\(\)/)
    const electron = code(read(FILES.electron))
    assert.match(electron, /shell: false/)
    assert.doesNotMatch(electron, /process\.kill\(/)
  })

  it('o supervisor real não substitui a conferência dos artefatos', () => {
    assert.doesNotMatch(code(read(FILES.entry)), /\bvalidate\s*:/)
  })
})

describe('supervisor de contenção: execução única e pasta exclusiva', () => {
  it('sem laços de repetição nem nova tentativa; cada caso uma vez (fora do modo restrito de repetição)', () => {
    const b = code(read(FILES.battery))
    assert.doesNotMatch(all(), /retry|attempts?\s*[:=]\s*[2-9]/i)
    // 6C.6C.3C: "repeat" só existe no modo restrito (T-K1.hang/T-T1.hang, até 10× cada), nunca como nova tentativa.
    const repeatUses = all()
      .split('\n')
      .filter((l) => /repeat/i.test(l))
    assert.ok(
      repeatUses.every((l) => /RepeatCaseId|RepeatPlan|RepeatRow|RepeatReport|runHangRepeat|formatRepeatReport|parseRepeatArgs|REPEAT_|mode === 'check-repeat'|mode === 'repeat'|mode: '(check-)?repeat'|repeat\.length|--repeat['=]/.test(l)),
      repeatUses.join('\n')
    )
    assert.match(b, /report\.exitCode = r\.exitCode === BATTERY_EXIT\.ok \? BATTERY_EXIT\.caseFailed : r\.exitCode\s*break outer/)
    assert.equal([...b.matchAll(/for \(const \[index, c\] of cases\.entries\(\)\)/g)].length, 1)
    assert.match(b, /report\.exitCode = BATTERY_EXIT\.caseFailed\s*break/)
  })

  it('trava exclusiva com criação atômica; gravações só com wx (nunca sobrescreve)', () => {
    const entry = code(read(FILES.entry))
    assert.match(entry, /openSync\(lockPath, 'wx'\)/)
    assert.match(entry, /writeFileSync\(path, bytes, \{ flag: 'wx' \}\)/)
    assert.equal([...entry.matchAll(/writeFileSync\(/g)].length, 1)
  })

  it('a bateria grava só dentro da pasta exclusiva e a remove pelas regras da D55', () => {
    const b = code(read(FILES.battery))
    assert.match(b, /createScratch\(deps\.fs, deps\.tmpRoot, BATTERY_SCRATCH_PREFIX\)/)
    assert.match(b, /removeScratch\(deps\.fs, scratch, \{ tmpRoot: deps\.tmpRoot, prefix: BATTERY_SCRATCH_PREFIX \}\)/)
    assert.match(b, /const dir = win32\.join\(scratch, /)
  })
})
