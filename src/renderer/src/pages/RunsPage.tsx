import { useMemo, useState } from 'react'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import { Card, Segmented, StatusBadge } from '@renderer/components/ui'
import { agentById } from '@renderer/data/agents'
import { modelById } from '@renderer/data/models'
import { runs } from '@renderer/data/runs'
import type { RunStatus } from '@renderer/data/types'
import { formatDateTime, formatDuration, formatNumber } from '@renderer/lib/format'
import { runStatus } from '@renderer/lib/status'

type Filter = 'all' | RunStatus

const filters: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Todas' },
  { value: 'running', label: 'Em execução' },
  { value: 'succeeded', label: 'Concluídas' },
  { value: 'failed', label: 'Falhas' },
  { value: 'queued', label: 'Na fila' }
]

export function RunsPage() {
  const [filter, setFilter] = useState<Filter>('all')
  const visible = useMemo(() => runs.filter((r) => filter === 'all' || r.status === filter), [filter])

  return (
    <div className="page">
      <PageHeader title="Execuções" description="Histórico de execuções de agentes (dados simulados)." />

      <div className="toolbar">
        <Segmented label="Filtrar por status" value={filter} onChange={setFilter} options={filters} />
        <span className="subtle">{visible.length} resultado(s)</span>
      </div>

      <Card>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Agente</th>
                <th>Modelo</th>
                <th>Origem</th>
                <th>Início</th>
                <th>Duração</th>
                <th style={{ textAlign: 'right' }}>Tokens</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const meta = runStatus[r.status]
                return (
                  <tr key={r.id}>
                    <td className="mono subtle">{r.id}</td>
                    <td>{agentById[r.agentId]?.name}</td>
                    <td className="muted">{modelById[r.modelId]?.name}</td>
                    <td className="muted">{r.trigger}</td>
                    <td className="muted">{formatDateTime(r.startedAt)}</td>
                    <td className="mono">{formatDuration(r.durationSec)}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {formatNumber(r.tokens)}
                    </td>
                    <td>
                      <StatusBadge tone={meta.tone} pulse={meta.pulse}>
                        {meta.label}
                      </StatusBadge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
