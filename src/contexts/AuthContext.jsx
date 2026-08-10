import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { RUNTIME_CONFIG } from '../runtimeConfig'

const NORMALIZER_URL = RUNTIME_CONFIG.NORMALIZER_URL

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

    // Always resolves (never throws) — the backend responds 204 regardless
    // of whether the email matches an account, so there's nothing for a
    // caller to branch on besides the network request itself succeeding.
    const requestPasswordReset = useCallback(async (email) => {
        await fetch(`${NORMALIZER_URL}/auth/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
        })
    }, [])

    // Same response shape as login() and sets the same session cookie
    // server-side, so a successful reset also signs the user in.
    const resetPassword = useCallback(async (token, password) => {
        const res = await fetch(`${NORMALIZER_URL}/auth/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ token, password }),
        })
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.detail || 'Could not reset password')
        }
        setUser(await res.json())
    }, [])

    return (
        <AuthContext.Provider value={{ user, loading, login, logout, requestPasswordReset, resetPassword }}>
            {children}
        </AuthContext.Provider>
    )
}

export function useAuth() {
    const ctx = useContext(AuthContext)
    if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
    return ctx
}
