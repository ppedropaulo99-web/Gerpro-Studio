import { useEffect, useState } from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { routeById } from '@renderer/app/routes'
import { useNavigation } from '@renderer/app/navigation'
import { Button, ConfirmDialog } from '@renderer/components/ui'
import { cx } from '@renderer/lib/cx'
import { TourLauncher } from '@renderer/tour/TourLauncher'
import { useTour } from '@renderer/tour/TourProvider'
import { Sidebar } from './Sidebar'

const COLLAPSE_BREAKPOINT = 1100

export function AppShell() {
  const { current, pending, blockedBy, keepEditing, confirmDiscard } = useNavigation()
  const tour = useTour()
  const route = routeById[current]
  const Page = route.component

  // Recolhe automaticamente em janelas estreitas; o usuário pode alternar manualmente.
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < COLLAPSE_BREAKPOINT)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${COLLAPSE_BREAKPOINT - 1}px)`)
    const onChange = (e: MediaQueryListEvent) => setCollapsed(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return (
    // Na apresentação, o app fica inerte (somente leitura) e cede uma coluna à direita para o painel explicativo.
    <div className={cx('shell', collapsed && 'shell--collapsed', tour.active && 'shell--touring')} inert={tour.active}>
      <header className="titlebar">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={collapsed ? 'Expandir barra lateral' : 'Recolher barra lateral'}
          icon={collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          onClick={() => setCollapsed((v) => !v)}
        />
        <div className="brand">Gerpro Studio</div>
        <span className="titlebar__crumb">/ {route.label}</span>
        <div className="titlebar__spacer" />
        <TourLauncher />
      </header>

      <Sidebar />

      <main className="main">
        <Page key={route.id} />
      </main>

      <ConfirmDialog
        open={pending !== null}
        title="Descartar alterações?"
        cancelLabel="Continuar editando"
        confirmLabel="Descartar alterações"
        onCancel={keepEditing}
        onConfirm={confirmDiscard}
      >
        Há alterações não salvas {blockedBy ?? 'nesta tela'}. Se você sair agora, elas serão perdidas.
      </ConfirmDialog>
    </div>
  )
}
