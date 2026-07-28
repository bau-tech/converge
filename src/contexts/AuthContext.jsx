import { createContext, useCallback, useContext, useEffect, useState } from 'react'

// Mirrors App.jsx's own CONFIG.normalizerUrl resolution — kept separate
// (not imported from App.jsx) to avoid a circular import, since App.jsx is
// itself the consumer of useAuth() below.
const NORMALIZER_URL = import.meta.env.VITE_NORMALIZER_URL || 'http://localhost:8002'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null)
    const [loading, setLoading] = useState(true)

    const refresh = useCallback(async () => {
        try {
            const res = await fetch(`${NORMALIZER_URL}/auth/me`, { credentials: 'include' })
            setUser(res.ok ? await res.json() : null)
        } catch {
            setUser(null)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { refresh() }, [refresh])

    const login = useCallback(async (email, password) => {
        const res = await fetch(`${NORMALIZER_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, password }),
        })
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.detail || 'Login failed')
        }
        setUser(await res.json())
    }, [])

    const logout = useCallback(async () => {
        try {
            await fetch(`${NORMALIZER_URL}/auth/logout`, { method: 'POST', credentials: 'include' })
        } finally {
            setUser(null)
        }
    }, [])

    return (
        <AuthContext.Provider value={{ user, loading, login, logout }}>
            {children}
        </AuthContext.Provider>
    )
}

export function useAuth() {
    const ctx = useContext(AuthContext)
    if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
    return ctx
}
