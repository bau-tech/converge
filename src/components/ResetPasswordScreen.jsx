import { useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'

// Rendered instead of the normal login/dashboard gate whenever the URL
// carries ?resetToken=... (the link emailed by /auth/forgot-password) —
// see App.jsx's _resetTokenSeed. A successful reset also signs the user in
// (resetPassword() sets AuthContext's `user`), so `onDone` just needs to
// clear the token from local state/the URL and let App() fall through to
// its normal authUser branch.
export function ResetPasswordScreen({ token, onDone }) {
    const { resetPassword } = useAuth()
    const [password, setPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [error, setError] = useState(null)
    const [submitting, setSubmitting] = useState(false)

    const handleSubmit = async (e) => {
        e.preventDefault()
        setError(null)
        if (password !== confirmPassword) {
            setError("Passwords don't match")
            return
        }
        setSubmitting(true)
        try {
            await resetPassword(token, password)
            onDone()
        } catch (err) {
            setError(err.message || 'Could not reset password')
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-50 px-4">
            <form
                onSubmit={handleSubmit}
                className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#15161C] p-6 shadow-2xl"
            >
                <div className="flex items-center gap-2 mb-1">
                    <KeyRound className="w-4 h-4 text-primary" />
                    <h1 className="text-sm font-semibold">Set a new password</h1>
                </div>
                <p className="text-xs text-zinc-500 mb-5">
                    Choose a new password for your Converge account.
                </p>

                {error && (
                    <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2 mb-4">
                        {error}
                    </p>
                )}

                <label className="block text-xs text-zinc-400 mb-1.5">New password</label>
                <input
                    type="password"
                    required
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full mb-4 px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-sm text-zinc-100 outline-none focus:border-primary/60"
                />

                <label className="block text-xs text-zinc-400 mb-1.5">Confirm password</label>
                <input
                    type="password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full mb-5 px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-sm text-zinc-100 outline-none focus:border-primary/60"
                />

                <button
                    type="submit"
                    disabled={submitting}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-primary/20 text-primary text-sm font-medium hover:bg-primary/30 transition-colors disabled:opacity-50"
                >
                    {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Set new password
                </button>
            </form>
        </div>
    )
}
