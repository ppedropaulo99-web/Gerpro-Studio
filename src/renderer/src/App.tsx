import { NavigationProvider } from './app/navigation'
import { AppShell } from './components/layout/AppShell'

export function App() {
  return (
    <NavigationProvider initial="home">
      <AppShell />
    </NavigationProvider>
  )
}
