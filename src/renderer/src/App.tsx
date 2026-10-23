import { NavigationProvider } from './app/navigation'
import { AppShell } from './components/layout/AppShell'
import { TourProvider } from './tour/TourProvider'

export function App() {
  return (
    <NavigationProvider initial="home">
      <TourProvider>
        <AppShell />
      </TourProvider>
    </NavigationProvider>
  )
}
