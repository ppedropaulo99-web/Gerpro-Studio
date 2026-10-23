import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { callApi } from './lib/api'
import { applyTheme } from './lib/theme'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/layout.css'
import './styles/pages.css'
import './styles/tour.css'

// O tema salvo é aplicado antes do primeiro render; até lá, `tokens.css` não pinta nada
// e a janela mostra o próprio fundo, que o Main já criou no tema certo.
const root = document.documentElement
applyTheme(root, window.gerpro.app.initialTheme)
// O argumento reflete o tema de quando a janela abriu; se a página recarregar depois de
// uma troca, a preferência gravada prevalece.
void callApi(() => window.gerpro.settings.get()).then((r) => r.ok && applyTheme(root, r.data.appearance.theme))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
