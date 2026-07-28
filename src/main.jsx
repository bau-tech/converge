import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { AuthProvider } from './contexts/AuthContext.jsx'

// Seed localStorage from ?layout= param before React state initializes
;(() => {
    const param = new URLSearchParams(window.location.search).get('layout')
    if (!param) return
    try {
        const raw = atob(param)
        const bytes = Uint8Array.from(raw, c => c.charCodeAt(0))
        const payload = JSON.parse(new TextDecoder().decode(bytes))
        if (typeof payload !== 'object' || payload === null) return
        // v1 format: localStorage keys are nested under payload.ls
        // legacy format: keys were at the root
        const ls = (payload.v === 1 && payload.ls) ? payload.ls : payload
        Object.entries(ls).forEach(([k, v]) => {
            try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)) }
            catch { /* quota or invalid */ }
        })
    } catch { /* malformed param — ignore */ }
    const url = new URL(window.location.href)
    url.searchParams.delete('layout')
    window.history.replaceState({}, '', url)
})()

createRoot(document.getElementById('root')).render(
    <StrictMode>
        <AuthProvider>
            <App />
        </AuthProvider>
    </StrictMode>,
)
