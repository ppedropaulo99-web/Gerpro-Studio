import { useEffect, useState } from 'react'
import { isTerminalRunState } from '@shared/runs'
import { routes, type RouteDef } from '@renderer/app/routes'
import { useNavigation } from '@renderer/app/navigation'
import { callApi } from '@renderer/lib/api'
import { upsertRun } from '@renderer/lib/runs'

const sections: Array<{ id: RouteDef['section']; label: string }> = [
  { id: 'workspace', label: 'Espaço de trabalho' },
  { id: 'system', label: 'Sistema' }
]

/**
 * Contadores ao lado de alguns itens, sempre a partir de dados do Main
 * (nunca dos exemplos): agentes salvos e execuções simuladas em andamento.
 */
function useBadges(current: RouteDef['id']): Partial<Record<RouteDef['id'], number>> {
  const [agents, setAgents] = useState<number>()
  const [activeRuns, setActiveRuns] = useState<number>()

  // Agentes mudam pela tela Agentes: recontados a cada navegação.
  useEffect(() => {
    let active = true
    void callApi(() => window.gerpro.agents.list()).then((r) => active && setAgents(r.ok ? r.data.length : undefined))
    return () => {
      active = false
    }
  }, [current])

  useEffect(() => {
    let list: Parameters<typeof upsertRun>[0] = []
    const count = () => setActiveRuns(list.filter((r) => !isTerminalRunState(r.state)).length || undefined)
    void callApi(() => window.gerpro.runs.list()).then((r) => {
      if (r.ok) list = r.data.reduce(upsertRun, list)
      count()
    })
    return window.gerpro.runs.onUpdated((run) => {
      list = upsertRun(list, run)
      count()
    })
  }, [])

  return { agents: agents || undefined, runs: activeRuns }
}

export function Sidebar() {
  const { current, navigate } = useNavigation()
  const badges = useBadges(current)

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
