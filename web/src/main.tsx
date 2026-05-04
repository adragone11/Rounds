import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import { ProfileProvider } from './lib/profile'
import { CurrencyProvider } from './lib/currency'
import { LanguageProvider } from './lib/language'
import { ThemeProvider } from './lib/theme'
import { StoreProvider } from './store'
import { ToastProvider } from './lib/toast'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <LanguageProvider>
        <BrowserRouter>
          <AuthProvider>
            <ProfileProvider>
              <CurrencyProvider>
                <StoreProvider>
                  <ToastProvider>
                    <App />
                  </ToastProvider>
                </StoreProvider>
              </CurrencyProvider>
            </ProfileProvider>
          </AuthProvider>
        </BrowserRouter>
      </LanguageProvider>
    </ThemeProvider>
  </StrictMode>,
)
