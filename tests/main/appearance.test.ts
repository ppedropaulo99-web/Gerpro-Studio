import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AppError } from '../../src/main/errors'
import { SETTINGS_FORMAT_VERSION, SettingsService } from '../../src/main/services/settings-service'
import { DEFAULT_SETTINGS, effectivePrivacy, themeArgument, themeFromArguments, type AppSettings } from '../../src/shared/settings'
import { tempDir } from '../support/fixtures'

const isCode = (code: string) => (e: unknown) => e instanceof AppError && e.code === code

async function open(file: string) {
  const settings = new SettingsService(file)
  await settings.init()
  return settings
}

/** settings.json no formato 1, de antes do tema: sem a seção `appearance`. */
async function legacyFile(overrides: Partial<Omit<AppSettings, 'appearance'>> = {}) {
  const dir = await tempDir()
  const file = join(dir, 'settings.json')
  const { appearance: _a, ...v1 } = structuredClone(DEFAULT_SETTINGS)
  await writeFile(file, JSON.stringify({ format: 'gerpro.settings', formatVersion: 1, savedAt: '2026-10-20T10:00:00.000Z', data: { ...v1, ...overrides } }))
  return file
}

describe('aparência: tema', () => {
  it('padrão é o escuro em instalação nova', async () => {
    const settings = await open(join(await tempDir(), 'settings.json'))
    assert.equal(DEFAULT_SETTINGS.appearance.theme, 'dark')
    assert.equal(settings.get().appearance.theme, 'dark')
  })

  it('alterna entre claro e escuro e avisa a cada gravação', async () => {
    const settings = await open(join(await tempDir(), 'settings.json'))
    const seen: string[] = []
    const stop = settings.onChange((s) => seen.push(s.appearance.theme))
    assert.equal((await settings.update({ appearance: { theme: 'light' } })).appearance.theme, 'light')
    assert.equal((await settings.update({ appearance: { theme: 'dark' } })).appearance.theme, 'dark')
    stop()
    await settings.update({ appearance: { theme: 'light' } })
    assert.deepEqual(seen, ['light', 'dark'])
  })

  it('persiste a escolha e a restaura ao reabrir', async () => {
    const file = join(await tempDir(), 'settings.json')
    const settings = await open(file)
    await settings.update({ appearance: { theme: 'light' } })
    const reopened = await open(file)
    assert.equal(reopened.get().appearance.theme, 'light')
    const disk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(disk.formatVersion, SETTINGS_FORMAT_VERSION)
    assert.equal(disk.data.appearance.theme, 'light')
  })

  it('trocar o tema não altera as demais preferências', async () => {
    const settings = await open(join(await tempDir(), 'settings.json'))
    await settings.update({ general: { density: 'compact' }, models: { maxRamGb: 48 } })
    const after = await settings.update({ appearance: { theme: 'light' } })
    assert.deepEqual({ ...after, appearance: DEFAULT_SETTINGS.appearance }, { ...DEFAULT_SETTINGS, general: { ...DEFAULT_SETTINGS.general, density: 'compact' }, models: { ...DEFAULT_SETTINGS.models, maxRamGb: 48 } })
  })

  it('rejeita tema desconhecido e campos extras, sem gravar nem avisar', async () => {
    const settings = await open(join(await tempDir(), 'settings.json'))
    let notified = 0
    settings.onChange(() => notified++)
    for (const appearance of [{ theme: 'neon' }, { theme: null }, { theme: 'light', accent: 'red' }, 'light']) {
      await assert.rejects(settings.update({ appearance }), isCode('validation'))
    }
    assert.equal(settings.get().appearance.theme, 'dark')
    assert.equal(notified, 0)
  })

  it('configurações antigas sem tema: migradas para o escuro, sem perder nada', async () => {
    const file = await legacyFile({ general: { language: 'es', density: 'compact', startOnLogin: true } })
    const settings = new SettingsService(file)
    const status = await settings.init()
    assert.equal(status.state, 'migrated')
    assert.equal(settings.get().appearance.theme, 'dark')
    assert.deepEqual(settings.get().general, { language: 'es', density: 'compact', startOnLogin: true })
    await settings.update({ appearance: { theme: 'light' } })
    const disk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(disk.formatVersion, 2)
    assert.equal(disk.data.general.language, 'es')
  })

  it('migração preserva escolhas de privacidade antigas, que continuam sem efeito e bloqueadas', async () => {
    const file = await legacyFile({ privacy: { confirmSensitiveTools: false, telemetry: true } })
    const settings = await open(file)
    assert.deepEqual(settings.get().privacy, { confirmSensitiveTools: false, telemetry: true })
    assert.deepEqual(effectivePrivacy(settings.get()), { confirmSensitiveTools: true, telemetry: false })
    await assert.rejects(settings.update({ appearance: { theme: 'light' }, privacy: { telemetry: true } }), isCode('invalid-state'))
    assert.equal(settings.get().appearance.theme, 'dark', 'nada gravado quando o pedido inclui preferência inativa')
  })
})

describe('aparência: tema inicial da janela', () => {
  it('ida e volta pelo argumento de linha de comando', () => {
    assert.equal(themeFromArguments(['electron', '.', themeArgument('light')]), 'light')
    assert.equal(themeFromArguments([themeArgument('dark')]), 'dark')
  })

  it('argumento ausente ou adulterado vira o tema padrão', () => {
    assert.equal(themeFromArguments([]), 'dark')
    assert.equal(themeFromArguments(['--gerpro-theme=neon']), 'dark')
    assert.equal(themeFromArguments(['--gerpro-theme=']), 'dark')
    assert.equal(themeFromArguments(['--gerpro-theme=light;x']), 'dark')
  })
})
