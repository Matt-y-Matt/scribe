import ReactDOM from 'react-dom/client'
import App from './App'
import { initTheme } from './lib/theme'
import './styles/app.css'

void initTheme()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <App />
)
