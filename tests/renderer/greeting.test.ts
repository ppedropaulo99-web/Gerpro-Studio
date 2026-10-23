import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { NavigationController } from '../../src/renderer/src/app/navigation-guard'
import { dayPeriod, greeting, nextPeriodChange } from '../../src/renderer/src/lib/greeting'
import { formFromSettings, patchFromForm, type SettingsFormValues } from '../../src/renderer/src/lib/settings-form'
import { applySettingsPatch, DEFAULT_SETTINGS, DISPLAY_NAME_MAX, normalizeDisplayName, type AppSettings } from '../../src/shared/settings'

const SRC = join(import.meta.dirname, '../../src/renderer/src')
/** Horário local de 23/10/2026. */
const at = (hour: number, minute = 0, second = 0, day = 23) => new Date(2026, 9, day, hour, minute, second)

describe('saudação: períodos do dia', () => {
  it('manhã das 5h às 11h59', () => {
    for (const d of [at(5), at(8, 30), at(11, 59, 59)]) assert.equal(greeting(d), 'Bom dia!')
  })

  it('tarde das 12h às 17h59', () => {
    for (const d of [at(12), at(15), at(17, 59, 59)]) assert.equal(greeting(d), 'Boa tarde!')
  })

  it('noite das 18h às 4h59, inclusive depois da meia-noite', () => {
    for (const d of [at(18), at(23, 59), at(0), at(4, 59, 59)]) assert.equal(greeting(d), 'Boa noite!')
  })
})

describe('saudação: nome de exibição', () => {
  it('com nome configurado', () => {
    assert.equal(greeting(at(9), 'Ana'), 'Bom dia, Ana!')
    assert.equal(greeting(at(14), 'Ana Maria'), 'Boa tarde, Ana Maria!')
    assert.equal(greeting(at(21), 'Ana'), 'Boa noite, Ana!')
  })

  it('sem nome: só a saudação, sem vírgula, "undefined" ou "null"', () => {
    for (const name of [undefined, null, '', '   ']) {
      const text = greeting(at(14), name)
      assert.equal(text, 'Boa tarde!')
      assert.doesNotMatch(text, /undefined|null|,/)
    }
  })

  it('nenhum nome fixo no código: o Início usa o nome das configurações', () => {
    const home = readFileSync(join(SRC, 'pages/HomePage.tsx'), 'utf8')
    assert.match(home, /useGreeting\(/)
    assert.match(home, /profile\.displayName/)
    assert.doesNotMatch(home, /BrandLogo/, 'o logo fica só na barra lateral')
  })
})

describe('saudação: troca de período com o app aberto', () => {
  it('próxima troca no mesmo dia', () => {
    assert.deepEqual(nextPeriodChange(at(2)), at(5))
    assert.deepEqual(nextPeriodChange(at(10, 30)), at(12))
    assert.deepEqual(nextPeriodChange(at(12)), at(18))
    assert.deepEqual(nextPeriodChange(at(17, 59, 59)), at(18))
  })

  it('depois das 18h, a próxima troca é às 5h do dia seguinte (inclusive na virada do mês)', () => {
    assert.deepEqual(nextPeriodChange(at(18)), at(5, 0, 0, 24))
    assert.deepEqual(nextPeriodChange(new Date(2026, 9, 31, 23, 30)), new Date(2026, 10, 1, 5))
  })

  it('no instante da troca, a saudação muda de período', () => {
    for (const start of [at(4, 59), at(11), at(17, 30), at(23)]) {
      const change = nextPeriodChange(start)
      assert.notEqual(dayPeriod(change), dayPeriod(start))
      assert.equal(dayPeriod(new Date(change.getTime() - 1)), dayPeriod(start))
    }
  })

  it('um temporizador por troca, não por minuto', () => {
    const hook = readFileSync(join(SRC, 'lib/use-greeting.ts'), 'utf8')
    assert.doesNotMatch(hook, /setInterval/)
    assert.match(hook, /nextPeriodChange\(/)
  })
})

describe('nome de exibição no formulário de Configurações', () => {
  const saved: AppSettings = structuredClone(DEFAULT_SETTINGS)
  const withName = (s: AppSettings, displayName: string): SettingsFormValues => ({ ...formFromSettings(s), displayName })
  const isDirty = (s: AppSettings, form: SettingsFormValues) => {
    const pending = patchFromForm(s, form)
    return !pending.ok || pending.changed
  }

  it('digitar um nome cria alteração pendente só no perfil, gravada sem espaços extras', () => {
    const pending = patchFromForm(saved, withName(saved, '  Ana   Maria '))
    assert.ok(pending.ok && pending.changed)
    assert.deepEqual(pending.ok && pending.patch, { profile: { displayName: 'Ana Maria' } })
  })

  it('só espaços equivale a nenhum nome: nada pendente', () => {
    assert.equal(isDirty(saved, withName(saved, '   ')), false)
  })

  it('apagar o nome salvo volta à saudação sem nome', () => {
    const named = applySettingsPatch(saved, { profile: { displayName: 'Ana' } })
    const pending = patchFromForm(named, withName(named, ''))
    assert.ok(pending.ok)
    assert.deepEqual(pending.patch, { profile: { displayName: '' } })
    assert.equal(greeting(at(9), applySettingsPatch(named, pending.patch).profile.displayName), 'Bom dia!')
  })

  it('nome longo demais aparece como erro do campo', () => {
    const pending = patchFromForm(saved, withName(saved, 'a'.repeat(DISPLAY_NAME_MAX + 1)))
    assert.ok(!pending.ok)
    assert.ok(pending.errors.displayName)
  })

  it('nome não salvo bloqueia a navegação; depois de salvo, a saudação usa o novo nome', () => {
    const form = withName(saved, 'Ana')
    const nav = new NavigationController<'settings' | 'home'>('settings')
    const guard = nav.register('nas configurações')
    nav.setDirty(guard, isDirty(saved, form))
    assert.equal(nav.request('home'), 'blocked')
    nav.keepEditing()

    const pending = patchFromForm(saved, form)
    assert.ok(pending.ok)
    const afterSave = applySettingsPatch(saved, pending.patch)
    nav.setDirty(guard, isDirty(afterSave, formFromSettings(afterSave)))
    assert.equal(nav.request('home'), 'navigated')
    assert.equal(greeting(at(9), afterSave.profile.displayName), 'Bom dia, Ana!')
  })

  it('normalização: espaços internos repetidos viram um, pontas aparadas', () => {
    assert.equal(normalizeDisplayName('\t Ana \n  Maria  '), 'Ana Maria')
    assert.equal(normalizeDisplayName('   '), '')
  })
})
