import { useState } from 'react'
import { Loader2, Lock } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'

export function LoginScreen({ layout = 'fullscreen', className = '' }) {
    const { login } = useAuth()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState(null)
    const [submitting, setSubmitting] = useState(false)

    const handleSubmit = async (e) => {
        e.preventDefault()
        setError(null)
        setSubmitting(true)
        try {
            await login(email, password)
        } catch (err) {
            setError(err.message || 'Login failed')
        } finally {
            setSubmitting(false)
        }
    }

    const form = (
        <form
            onSubmit={handleSubmit}
            className={`w-full max-w-sm rounded-3xl border border-white/10 bg-[#15161C] p-6 shadow-2xl ${className}`}
        >
            <div className="flex items-center gap-2 mb-1">
                <Lock className="w-4 h-4 text-primary" />
                <h1 className="text-sm font-semibold">Sign in</h1>
            </div>
            <p className="text-xs text-zinc-500 mb-5">
                Converge access requires an account — the same credentials used for BCF client login.
            </p>

            {error && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2 mb-4">
                    {error}
                </p>
            )}

            <label className="block text-xs text-zinc-400 mb-1.5">Email</label>
            <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full mb-4 px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-sm text-zinc-100 outline-none focus:border-primary/60"
            />

            <label className="block text-xs text-zinc-400 mb-1.5">Password</label>
            <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full mb-5 px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-sm text-zinc-100 outline-none focus:border-primary/60"
            />

            <button
                type="submit"
                disabled={submitting}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-primary/20 text-primary text-sm font-medium hover:bg-primary/30 transition-colors disabled:opacity-50"
            >
                {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Sign in
            </button>
        </form>
    )

    if (layout === 'panel') {
        return form
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-50 px-4">
            {form}
        </div>
    )
}
