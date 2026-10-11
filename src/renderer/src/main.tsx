import { createRoot } from 'react-dom/client'
import App from './App'
import { initSettings } from './settings'
import './styles.css'

// Preferences (theme, scale, behaviour) are loaded before the first paint to avoid a flash.
initSettings()
  .catch((err) => console.error('settings', err))
  .finally(() => createRoot(document.getElementById('root')!).render(<App />))
