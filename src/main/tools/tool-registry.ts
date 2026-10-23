import type { ToolCatalogEntry } from '@shared/tools'
import type { CatalogItem } from './catalog'

/**
 * Catálogo de ferramentas do Main. Combina as declarações com as
 * preferências do usuário. Nenhuma ferramenta tem executor nesta etapa, então
 * `implemented` começa vazio e todas aparecem como `not-implemented`.
 */
export class ToolRegistry {
  private readonly items: ReadonlyMap<string, CatalogItem>
  private readonly implemented: ReadonlySet<string>

  constructor(items: readonly CatalogItem[], implemented: ReadonlySet<string> = new Set()) {
    this.items = new Map(items.map((item) => [item.definition.id, item]))
    this.implemented = implemented
  }

  has(id: string): boolean {
    return this.items.has(id)
  }

  list(enabledPrefs: Readonly<Record<string, boolean>>): ToolCatalogEntry[] {
    return [...this.items.values()].map(({ definition, enabledByDefault }) => {
      const enabled = enabledPrefs[definition.id] ?? enabledByDefault
      return {
        definition,
        enabled,
        availability: !this.implemented.has(definition.id) ? 'not-implemented' : enabled ? 'available' : 'disabled'
      }
    })
  }
}
