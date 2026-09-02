import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import 'highlight.js/styles/github-dark.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import './styles/theme.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
