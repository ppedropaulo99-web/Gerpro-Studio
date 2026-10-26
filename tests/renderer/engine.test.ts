import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { summarizeEngine } from '../../src/renderer/src/lib/engine'
import type { ProviderOverview, ProviderState } from '../../src/shared/inference'

const overview = (id: string, kind: 'simulated' | 'external', state: ProviderState, models: number | null = 0): ProviderOverview => ({
  info: { id, displayName: id === 'simulado' ? 'Provedor simulado' : 'Motor local', kind },
  status: { providerId: id, state, version: null, checkedAt: null, message: null },
  models:
    models === null
      ? null
      : Array.from({ length: models }, (_, i) => ({
          availability: 'installed' as const,
          model: {
            ref: { providerId: id, modelId: `m${i}` },
            digest: null,
            location: 'local' as const,
            displayName: `m${i}`,
            family: null,
            parameterSize: null,
            quantization: null,
            format: null,
            sizeBytes: null,
            contextLength: null,
            contextBytesPerToken: null,
            capabilities: []
          }
        }))
})

describe('Resumo do motor de IA', () => {
  it('provedor simulado pronto não conta como motor conectado', () => {
    const summary = summarizeEngine([overview('simulado', 'simulated', 'ready', 3)])
    assert.equal(summary.connected, false)
    assert.equal(summary.installedModels, 0)
    assert.equal(summary.label, 'Motor de IA não conectado')
  })

  it('provedor real registrado mas sem responder: desconectado', () => {
    const summary = summarizeEngine([overview('simulado', 'simulated', 'ready'), overview('local', 'external', 'unreachable', null)])
    assert.equal(summary.connected, false)
    assert.equal(summary.real.length, 1)
  })

  it('provedor real pronto: conectado, com os modelos instalados dele', () => {
    const summary = summarizeEngine([overview('simulado', 'simulated', 'ready', 5), overview('local', 'external', 'ready', 2)])
    assert.equal(summary.connected, true)
    assert.equal(summary.installedModels, 2)
    assert.equal(summary.label, 'Motor local conectado')
  })
})
