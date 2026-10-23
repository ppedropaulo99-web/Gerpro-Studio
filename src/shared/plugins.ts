/**
 * Contrato do futuro sistema de plugins. Um plugin declara um manifesto e
 * contribui ferramentas e/ou motores. Sem carregamento real nesta etapa.
 */

export type PluginPermission = 'network' | 'filesystem:read' | 'filesystem:write' | 'process'

export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  permissions: PluginPermission[]
  contributes: {
    tools?: string[]
    engines?: string[]
  }
}
