import { Presentation } from 'lucide-react'
import { Button } from '@renderer/components/ui'
import { TOUR_LAUNCHER_ID, useTour } from './TourProvider'

/** Botão discreto na barra de título para iniciar a Apresentação Guiada. */
export function TourLauncher() {
  const { active, start, notice, dismissNotice } = useTour()
  return (
    <div className="tour-launcher">
      <Button
        id={TOUR_LAUNCHER_ID}
        variant="ghost"
        size="sm"
        icon={<Presentation size={15} />}
        disabled={active}
        title="Apresentação guiada pelas telas do Gerpro Studio"
        onClick={start}
      >
        Apresentação
      </Button>
      {notice && (
        <div className="tour-launcher__notice" role="status">
          <span>{notice}</span>
          <Button variant="ghost" size="sm" onClick={dismissNotice}>
            OK
          </Button>
        </div>
      )}
    </div>
  )
}
