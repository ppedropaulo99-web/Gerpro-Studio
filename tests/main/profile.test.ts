import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AppError } from '../../src/main/errors'
import { SETTINGS_FORMAT_VERSION, SettingsService } from '../../src/main/services/settings-service'
import { DEFAULT_SETTINGS, DISPLAY_NAME_MAX } from '../../src/shared/settings'
import { tempDir } from '../support/fixtures'

async function open(file: string) {
  const settings = new SettingsService(file)
  const status = await settings.init()
  return { settings, status }
}

/** settings.json no formato 2 (com tema, sem perfil), com escolhas diferentes dos padrões. */
const V2_DATA = {
  appearance: { theme: 'light' },
  general: { language: 'es', density: 'compact', startOnLogin: true },
  models: { directory: 'D:\\Modelos', maxRamGb: 48 },
  privacy: { confirmSensitiveTools: false, telemetry: true },
  tools: { enabled: { 'web-search': false } }
}

async function v2File() {
  const file = join(await tempDir(), 'settings.json')
  await writeFile(file, JSON.stringify({ format: 'gerpro.settings', formatVersion: 2, savedAt: '2026-10-22T10:00:00.000Z', data: V2_DATA }))
  return file
}

const isValidation = (e: unknown) => e instanceof AppError && e.code === 'validation'

describe('perfil: nome de exibição', () => {
  it('instalação nova: formato 3 e nome vazio', async () => {
    const { settings } = await open(join(await tempDir(), 'settings.json'))
    assert.equal(SETTINGS_FORMAT_VERSION, 3)
    assert.equal(DEFAULT_SETTINGS.profile.displayName, '')
    assert.equal(settings.get().profile.displayName, '')
  })

  it('persiste o nome e o restaura ao reabrir', async () => {
    const file = join(await tempDir(), 'settings.json')
    const { settings } = await open(file)
    await settings.update({ profile: { displayName: 'Ana Maria' } })
    const { settings: reopened } = await open(file)
    assert.equal(reopened.get().profile.displayName, 'Ana Maria')
    const disk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(disk.formatVersion, 3)
    assert.equal(disk.data.profile.displayName, 'Ana Maria')
  })

  it('gravar o nome não altera as demais preferências', async () => {
    const { settings } = await open(join(await tempDir(), 'settings.json'))
    await settings.update({ appearance: { theme: 'light' }, general: { density: 'compact' } })
    const after = await settings.update({ profile: { displayName: 'Ana' } })
    assert.deepEqual(after, {
      ...DEFAULT_SETTINGS,
      appearance: { theme: 'light' },
      profile: { displayName: 'Ana' },
      general: { ...DEFAULT_SETTINGS.general, density: 'compact' }
    })
  })

  it('o Main valida o nome: tamanho, quebras de linha, espaços nas pontas, tipo e campos extras', async () => {
    const { settings } = await open(join(await tempDir(), 'settings.json'))
    let notified = 0
    settings.onChange(() => notified++)
    for (const profile of [
      { displayName: 'a'.repeat(DISPLAY_NAME_MAX + 1) },
      { displayName: 'Ana\nMaria' },
      { displayName: ' Ana' },
      { displayName: 'Ana\u0007' },
      { displayName: 42 },
      { displayName: null },
      { displayName: 'Ana', email: 'x' },
      'Ana'
    ]) {
      await assert.rejects(settings.update({ profile }), isValidation)
    }
    assert.equal(settings.get().profile.displayName, '')
    assert.equal(notified, 0)
  })

  it('o nome rejeitado não aparece no erro devolvido', async () => {
    const { settings } = await open(join(await tempDir(), 'settings.json'))
    const error = await settings.update({ profile: { displayName: 'Segredo\n' } }).catch((e: unknown) => e)
    assert.ok(isValidation(error))
    assert.doesNotMatch(JSON.stringify(error), /Segredo/)
    assert.doesNotMatch((error as AppError).message, /Segredo/)
  })
})

describe('perfil: migração das configurações', () => {
  it('formato 2: migrado com nome vazio, sem perder nenhuma escolha', async () => {
    const { settings, status } = await open(await v2File())
    assert.equal(status.state, 'migrated')
    assert.deepEqual(settings.get(), { ...V2_DATA, profile: { displayName: '' } })
  })

  it('a próxima gravação leva o arquivo ao formato 3 preservando tudo', async () => {
    const file = await v2File()
    const { settings } = await open(file)
    await settings.update({ profile: { displayName: 'Ana' } })
    const disk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(disk.formatVersion, 3)
    assert.deepEqual(disk.data, { ...V2_DATA, profile: { displayName: 'Ana' } })
  })

  it('formato 1 passa pelas duas migrações (tema e perfil)', async () => {
    const file = join(await tempDir(), 'settings.json')
    const { appearance: _a, ...v1 } = V2_DATA
    await writeFile(file, JSON.stringify({ format: 'gerpro.settings', formatVersion: 1, savedAt: '2026-10-20T10:00:00.000Z', data: v1 }))
    const { settings, status } = await open(file)
    assert.equal(status.state, 'migrated')
    assert.deepEqual(settings.get(), { ...v1, appearance: { theme: 'dark' }, profile: { displayName: '' } })
  })
})
