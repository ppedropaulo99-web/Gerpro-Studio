import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'
import { NavigationController } from '../../src/renderer/src/app/navigation-guard'
import { agentFormChanged, emptyAgentForm, formFromDefinition } from '../../src/renderer/src/lib/agent-form'
import { formFromSettings, inactivePreference, patchFromForm } from '../../src/renderer/src/lib/settings-form'
import { agentDraft } from '../support/fixtures'

type Route = 'home' | 'agents' | 'settings'

function controller() {
  const nav = new NavigationController<Route>('agents')
  let notified = 0
  nav.subscribe(() => notified++)
  return { nav, notifications: () => notified }
}

describe('navegação com alterações não salvas', () => {
  it('sem alterações pendentes: navega direto, sem confirmação', () => {
    const { nav } = controller()
    const form = nav.register('no agente em edição')
    nav.setDirty(form, false)
    assert.equal(nav.request('home'), 'navigated')
    assert.deepEqual(nav.getSnapshot(), { current: 'home', pending: null, blockedBy: null })
  })

  it('com alterações pendentes: retém a navegação e pede confirmação', () => {
    const { nav, notifications } = controller()
    nav.setDirty(nav.register('no agente em edição'), true)
    assert.equal(nav.request('home'), 'blocked')
    assert.deepEqual(nav.getSnapshot(), { current: 'agents', pending: 'home', blockedBy: 'no agente em edição' })
    assert.equal(notifications(), 1)
  })

  it('"Continuar editando" cancela o descarte: permanece na tela e mantém a pendência', () => {
    const { nav } = controller()
    const form = nav.register('nas configurações')
    nav.setDirty(form, true)
    nav.request('home')
    nav.keepEditing()
    assert.deepEqual(nav.getSnapshot(), { current: 'agents', pending: null, blockedBy: null })
    assert.equal(nav.hasUnsavedChanges(), true, 'as alterações continuam lá')
    assert.equal(nav.request('settings'), 'blocked', 'nova tentativa pede confirmação de novo')
  })

  it('"Descartar alterações" segue para o destino retido', () => {
    const { nav } = controller()
    nav.setDirty(nav.register('no agente em edição'), true)
    nav.request('settings')
    assert.equal(nav.confirmDiscard(), 'settings')
    assert.deepEqual(nav.getSnapshot(), { current: 'settings', pending: null, blockedBy: null })
    assert.equal(nav.hasUnsavedChanges(), false)
  })

  it('salvar antes de navegar libera a navegação', () => {
    const { nav } = controller()
    const form = nav.register('nas configurações')
    nav.setDirty(form, true)
    assert.equal(nav.request('home'), 'blocked')
    nav.keepEditing()
    nav.setDirty(form, false) // salvo: o formulário volta a coincidir com o gravado
    assert.equal(nav.request('home'), 'navigated')
  })

  it('formulário desmontado (Salvar ou Cancelar) deixa de bloquear', () => {
    const { nav } = controller()
    const form = nav.register('no novo agente')
    nav.setDirty(form, true)
    nav.unregister(form)
    assert.equal(nav.request('home'), 'navigated')
  })

  it('ir para a tela atual não pede confirmação nem muda nada', () => {
    const { nav, notifications } = controller()
    nav.setDirty(nav.register('no agente em edição'), true)
    const before = nav.getSnapshot()
    assert.equal(nav.request('agents'), 'unchanged')
    assert.equal(nav.getSnapshot(), before, 'mesmo objeto de estado')
    assert.equal(notifications(), 0)
  })

  it('confirmar ou cancelar sem pedido pendente não faz nada', () => {
    const { nav, notifications } = controller()
    assert.equal(nav.confirmDiscard(), null)
    nav.keepEditing()
    assert.equal(nav.getSnapshot().current, 'agents')
    assert.equal(notifications(), 0)
  })
})

describe('detecção de alterações nos formulários', () => {
  it('agente: compara com o estado de partida; a ordem das ferramentas não conta', () => {
    const initial = formFromDefinition(agentDraft({ tools: ['calculator', 'web-search'] }))
    assert.equal(agentFormChanged(initial, { ...initial }), false)
    assert.equal(agentFormChanged(initial, { ...initial, tools: ['web-search', 'calculator'] }), false)
    assert.equal(agentFormChanged(initial, { ...initial, name: 'Outro nome' }), true)
    assert.equal(agentFormChanged(initial, { ...initial, tools: ['calculator'] }), true)
    assert.equal(agentFormChanged(emptyAgentForm(), emptyAgentForm()), false, 'novo agente intocado não pede confirmação')
  })

  it('configurações: alteração pendente até salvar; depois de salvar, nada pendente', () => {
    const saved: AppSettings = structuredClone(DEFAULT_SETTINGS)
    const form = { ...formFromSettings(saved), maxRamGb: '64' }
    const pending = patchFromForm(saved, form)
    assert.ok(pending.ok && pending.changed)
    const afterSave: AppSettings = { ...saved, models: { ...saved.models, maxRamGb: 64 } }
    const clean = patchFromForm(afterSave, formFromSettings(afterSave))
    assert.ok(clean.ok && !clean.changed)
  })
})

describe('preferências de privacidade inativas na tela', () => {
  it('ficam fora do formulário: nenhuma alteração da tela as inclui', () => {
    const form = formFromSettings(DEFAULT_SETTINGS)
    assert.equal('telemetry' in form, false)
    assert.equal('confirmSensitiveTools' in form, false)
    const pending = patchFromForm(DEFAULT_SETTINGS, { ...form, language: 'es' })
    assert.ok(pending.ok)
    assert.equal(pending.ok && pending.patch.privacy, undefined)
  })

  it('exibem sempre o valor seguro e avisam quando há outra escolha gravada', () => {
    assert.deepEqual(inactivePreference(DEFAULT_SETTINGS, 'telemetry'), { shown: false, storedDiffers: false })
    assert.deepEqual(inactivePreference(DEFAULT_SETTINGS, 'confirmSensitiveTools'), { shown: true, storedDiffers: false })
    const old: AppSettings = { ...DEFAULT_SETTINGS, privacy: { confirmSensitiveTools: false, telemetry: true } }
    assert.deepEqual(inactivePreference(old, 'telemetry'), { shown: false, storedDiffers: true })
    assert.deepEqual(inactivePreference(old, 'confirmSensitiveTools'), { shown: true, storedDiffers: true })
  })
})
