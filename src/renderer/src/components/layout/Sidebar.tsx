import { routes, type RouteDef } from '@renderer/app/routes'
import { useNavigation } from '@renderer/app/navigation'
import { agents } from '@renderer/data/agents'
import { runs } from '@renderer/data/runs'

const sections: Array<{ id: RouteDef['section']; label: string }> = [
  { id: 'workspace', label: 'Espaço de trabalho' },
  { id: 'system', label: 'Sistema' }
]

/** Contadores exibidos ao lado de alguns itens (dados simulados). */
const badges: Partial<Record<RouteDef['id'], number>> = {
  agents: agents.length,
  runs: runs.filter((r) => r.status === 'running').length || undefined
}

export function Sidebar() {
  const { current, navigate } = useNavigation()

  return (
    <nav className="sidebar" aria-label="Navegação principal">
      {sections.map((section) => (
        <div key={section.id} className="stack" style={{ gap: 2 }}>
          <div className="sidebar__section">{section.label}</div>
          {routes
            .filter((r) => r.section === section.id)
            .map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className="nav-item"
                aria-current={current === id ? 'page' : undefined}
                title={label}
                onClick={() => navigate(id)}
              >
                <Icon size={17} />
                <span className="nav-item__label">{label}</span>
                {badges[id] !== undefined && <span className="nav-item__badge">{badges[id]}</span>}
              </button>
            ))}
        </div>
      ))}

      <div className="sidebar__footer">
        <div className="engine-pill" title="Motor de IA: não conectado (protótipo)">
          <span className="status tone-neutral" style={{ padding: 0, background: 'none' }}>
            <span className="status__dot" />
          </span>
          <span className="engine-pill__label">Motor de IA não conectado</span>
        </div>
      </div>
    </nav>
  )
}
