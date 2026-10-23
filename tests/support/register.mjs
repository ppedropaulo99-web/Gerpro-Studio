// Permite que o Node (com remoção nativa de tipos) rode o código-fonte em TypeScript
// sem bundler: resolve o alias `@shared/*` e imports relativos sem extensão.
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sharedDir = fileURLToPath(new URL('../../src/shared/', import.meta.url))

function withTsExtension(url) {
  const path = fileURLToPath(url)
  for (const candidate of [path, `${path}.ts`, `${path}/index.ts`]) {
    if (existsSync(candidate) && !candidate.endsWith('/') && /\.[cm]?[jt]s$/.test(candidate)) return pathToFileURL(candidate).href
  }
  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      throw new Error('Testes não podem importar "electron": isole o código dependente do Electron.')
    }
    if (specifier.startsWith('@shared/')) {
      const url = withTsExtension(pathToFileURL(sharedDir + specifier.slice('@shared/'.length)))
      if (url) return { url, shortCircuit: true }
    }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.endsWith('.ts')) {
      const url = withTsExtension(new URL(specifier, context.parentURL))
      if (url) return { url, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})
