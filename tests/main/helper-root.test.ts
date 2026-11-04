import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveHelperResourcesRoot } from '../../src/main/hardware/local/helper-root'

// Raiz de recursos do auxiliar: função pura, só com valores passados pelo Main.

const PACKAGED = 'C:\\Program Files\\Gerpro Studio\\resources'
const APP = 'C:\\dev\\gerpro-studio'

describe('resolveHelperResourcesRoot', () => {
  it('empacotado: a pasta de recursos do processo; o caminho do app não conta', () => {
    assert.equal(resolveHelperResourcesRoot({ isPackaged: true, resourcesPath: PACKAGED, appPath: 'relativo' }), PACKAGED)
    assert.equal(resolveHelperResourcesRoot({ isPackaged: true, resourcesPath: `${PACKAGED}\\`, appPath: APP }), PACKAGED)
  })

  it('desenvolvimento: `resources` dentro do caminho do app; a pasta de recursos do processo não conta', () => {
    assert.equal(resolveHelperResourcesRoot({ isPackaged: false, appPath: APP, resourcesPath: PACKAGED }), `${APP}\\resources`)
    assert.equal(resolveHelperResourcesRoot({ isPackaged: false, appPath: `${APP}\\`, resourcesPath: 'x' }), `${APP}\\resources`)
  })

  it('caminhos recusados viram null, sem trocar de fonte', () => {
    const bad: unknown[] = [
      '',
      'resources',
      '.\\resources',
      'C:resources',
      'C:\\app\\..\\Windows',
      'C:\\app\\.\\resources',
      '\\\\servidor\\compartilhamento\\resources',
      '\\\\?\\C:\\app\\resources',
      '\\\\.\\C:\\app',
      'C:/app/resources',
      'C:\\app\\re:sources',
      'C:\\app\\"x"',
      `C:\\${'a'.repeat(300)}`,
      null,
      undefined,
      42
    ]
    for (const path of bad) {
      assert.equal(resolveHelperResourcesRoot({ isPackaged: true, resourcesPath: path as string, appPath: APP }), null, String(path))
      assert.equal(resolveHelperResourcesRoot({ isPackaged: false, appPath: path as string, resourcesPath: PACKAGED }), null, String(path))
    }
  })

  it('não lê ambiente, argumentos nem o sistema de arquivos: mesmo resultado sempre', () => {
    const paths = { isPackaged: false, appPath: APP, resourcesPath: PACKAGED }
    const before = { ...process.env }
    process.env['GERPRO_HELPER_ROOT'] = 'D:\\outro'
    try {
      assert.equal(resolveHelperResourcesRoot(paths), `${APP}\\resources`)
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]
    }
  })
})
