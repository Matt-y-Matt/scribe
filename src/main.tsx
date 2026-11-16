import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { queryClient } from './lib/query-client'
import { initTheme } from './lib/theme'
import './styles/app.css'

void initTheme()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
)
