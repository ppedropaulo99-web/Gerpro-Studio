import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { NavigationController } from '../../src/renderer/src/app/navigation-guard'
import { formFromSettings, patchFromForm } from '../../src/renderer/src/lib/settings-form'
import { applyTheme, currentTheme, themeOptions, themePatch, type ThemeRoot } from '../../src/renderer/src/lib/theme'
import { applySettingsPatch, DEFAULT_SETTINGS, validateSettingsPatch, type AppSettings } from '../../src/shared/settings'

const SRC = join(import.meta.dirname, '../../src')
const STYLES = join(SRC, 'renderer/src/styles')
const read = (...p: string[]) => readFileSync(join(...p), 'utf8')

const fakeRoot = (): ThemeRoot => ({ dataset: {} })

/** Tokens declarados em um bloco CSS: nome → valor. */
function tokensIn(block: string): Map<string, string> {
  return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]))
}

function themeBlocks() {
  const css = read(STYLES, 'tokens.css')
  const dark = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
  const lightStart = css.indexOf(":root[data-theme='light'] {")
  const light = css.slice(lightStart, css.indexOf('}', lightStart))
  return { dark: tokensIn(dark), light: tokensIn(light) }
}

const isColor = (v: string) => /^#|^rgba?\(|^0 12px/.test(v)

describe('tema na interface', () => {
  it('nenhum tema aplicado até a primeira aplicação; depois alterna', () => {
    const root = fakeRoot()
    assert.equal(currentTheme(root), null)
    applyTheme(root, 'light')
    assert.equal(root.dataset['theme'], 'light')
    applyTheme(root, 'dark')
    assert.equal(currentTheme(root), 'dark')
  })

  it('opções em português, escuro primeiro', () => {
    assert.deepEqual(themeOptions, [
      { value: 'dark', label: 'Escuro' },
      { value: 'light', label: 'Claro' }
    ])
  })

  it('a alteração grava só o tema e é aceita pelo contrato', () => {
    const result = validateSettingsPatch(themePatch('light'))
    assert.ok(result.ok)
    assert.deepEqual(result.value, { appearance: { theme: 'light' } })
  })
})

describe('tema e alterações não salvas em Configurações', () => {
  const saved: AppSettings = structuredClone(DEFAULT_SETTINGS)

  it('o tema não faz parte do formulário nem do que "Salvar" grava', () => {
    const form = { ...formFromSettings(saved), maxRamGb: '48' }
    assert.ok(!('theme' in form))
    const pending = patchFromForm(saved, form)
    assert.ok(pending.ok && pending.changed)
    assert.equal(pending.ok && 'appearance' in pending.patch, false)
  })

  it('trocar o tema com edições pendentes mantém as edições pendentes', () => {
    const form = { ...formFromSettings(saved), maxRamGb: '48', density: 'compact' as const }
    const afterTheme = applySettingsPatch(saved, themePatch('light'))
    const pending = patchFromForm(afterTheme, form)
    assert.ok(pending.ok)
    assert.deepEqual(pending.ok && pending.patch, { general: { density: 'compact' }, models: { maxRamGb: 48 } })
  })

  it('trocar o tema sem outras edições não cria alteração pendente', () => {
    const afterTheme = applySettingsPatch(saved, themePatch('light'))
    const pending = patchFromForm(afterTheme, formFromSettings(saved))
    assert.ok(pending.ok && !pending.changed)
  })

  it('descartar ou cancelar volta o formulário ao salvo, sem reverter o tema já gravado', () => {
    const afterTheme = applySettingsPatch(saved, themePatch('light'))
    const discarded = formFromSettings(afterTheme)
    assert.ok(patchFromForm(afterTheme, discarded).ok)
    assert.equal(afterTheme.appearance.theme, 'light')

    // Sair da tela com edições pendentes pede confirmação; o tema não interfere.
    const nav = new NavigationController<'settings' | 'home'>('settings')
    const form = nav.register('nas configurações')
    nav.setDirty(form, true)
    assert.equal(nav.request('home'), 'blocked')
    nav.confirmDiscard()
    assert.equal(nav.getSnapshot().current, 'home')
    assert.equal(afterTheme.appearance.theme, 'light')
  })
})

describe('tokens dos temas', () => {
  it('o tema claro redefine todas as cores do escuro, e só cores', () => {
    const { dark, light } = themeBlocks()
    const darkColors = [...dark].filter(([, v]) => isColor(v)).map(([k]) => k)
    assert.ok(darkColors.length >= 25)
    for (const name of darkColors) assert.ok(light.has(name), `${name} sem valor no tema claro`)
    for (const name of light.keys()) assert.ok(dark.has(name), `${name} não existe no tema escuro`)
    assert.ok(![...light.keys()].some((k) => /^--(space|radius|text-(xs|sm|md|lg|xl|2xl)|font|titlebar|sidebar)/.test(k)))
  })

  it('o tema escuro mantém a identidade grafite e âmbar', () => {
    const { dark } = themeBlocks()
    assert.equal(dark.get('--bg'), '#0d0f14')
    assert.equal(dark.get('--accent'), '#f5a524')
    assert.equal(dark.get('--text'), '#e7eaf1')
    assert.equal(dark.get('--text-heading'), 'var(--text)')
  })

  it('nenhuma cor fixa fora de tokens.css', () => {
    const files = ['styles', 'components', 'pages', 'app', 'lib'].flatMap((dir) => {
      const base = join(SRC, 'renderer/src', dir)
      return readdirSync(base, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && /\.(css|tsx?)$/.test(e.name) && e.name !== 'tokens.css')
        .map((e) => join(e.parentPath, e.name))
    })
    for (const file of files) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /#[0-9a-f]{3,8}\b|rgba?\(/i, file)
    }
  })

  it('as cores nativas da janela acompanham os tokens de cada tema', () => {
    const { dark, light } = themeBlocks()
    const window = read(SRC, 'main/window.ts')
    for (const [theme, tokens] of [['dark', dark], ['light', light]] as const) {
      const line = window.match(new RegExp(`${theme}: \\{ background: '(#[0-9a-f]+)', symbols: '(#[0-9a-f]+)' \\}`))
      assert.ok(line, `cores da janela para ${theme}`)
      assert.equal(line[1], tokens.get('--bg'))
      assert.equal(line[2], tokens.get('--text-muted'))
    }
  })

  it('antes de o tema ser aplicado, nada é pintado (sem piscar o tema errado)', () => {
    assert.match(read(STYLES, 'base.css'), /:root:not\(\[data-theme\]\) body \{\s*visibility: hidden;/)
  })
})
