import { useEffect, useRef, useState } from 'react'
import { Bell, Check } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'

// Header toolbar bell for the document-workflow notification feed
// (bim_notifications, notifications/dispatch.py) — same click-outside-to-close
// popover pattern as IfcExportMenu.jsx. Unread count is polled continuously
// (not stopped once caught up, unlike SemanticSearchStatus.jsx's one-shot
// poll — new notifications can arrive at any time) on the same 15-20s
// cadence already established by SemanticSearchStatus.jsx.
export function NotificationBell({ normalizerUrl }) {
    const [open, setOpen] = useState(false)
    const [unreadCount, setUnreadCount] = useState(0)
    const [notifications, setNotifications] = useState([])
    const [loading, setLoading] = useState(false)
    const rootRef = useRef(null)
    const base = (normalizerUrl || '').replace(/\/$/, '')

    useEffect(() => {
        if (!base) return
        let cancelled = false
        const poll = async () => {
            try {
                const res = await fetch(`${base}/notifications/unread-count`, { credentials: 'include' })
                if (!res.ok || cancelled) return
                const data = await res.json()
                if (!cancelled) setUnreadCount(data.count)
            } catch {
                // Transient fetch failure — next tick retries, nothing to show for it.
            }
        }
        poll()
        const timer = setInterval(poll, 20000)
        return () => { cancelled = true; clearInterval(timer) }
    }, [base])

    useEffect(() => {
        if (!open) return
        const onDocClick = (e) => {
            if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDocClick)
        return () => document.removeEventListener('mousedown', onDocClick)
    }, [open])

    const loadNotifications = async () => {
        setLoading(true)
        try {
            const res = await fetch(`${base}/notifications?limit=20`, { credentials: 'include' })
            if (res.ok) setNotifications(await res.json())
        } finally {
            setLoading(false)
        }
    }

    const toggle = () => {
        setOpen(v => {
            const next = !v
            if (next) loadNotifications()
            return next
        })
    }

    const markRead = async (id) => {
        await fetch(`${base}/notifications/${id}/read`, { method: 'POST', credentials: 'include' })
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
        setUnreadCount(c => Math.max(0, c - 1))
    }

    const markAllRead = async () => {
        await fetch(`${base}/notifications/read-all`, { method: 'POST', credentials: 'include' })
        setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at || new Date().toISOString() })))
        setUnreadCount(0)
    }

    return (
        <div ref={rootRef} className="relative">
            <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                onClick={toggle}
                className="glass-card icon-btn hover:bg-white/10 relative"
                title="Notifications"
            >
                <Bell className="w-6 h-6" />
                {unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center leading-none">
                        {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                )}
            </motion.button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: 6, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 6, scale: 0.97 }}
                        transition={{ duration: 0.12 }}
                        className="absolute top-full right-0 mt-2 w-80 max-h-96 glass-card rounded-xl border border-white/10 shadow-2xl z-50 overflow-hidden flex flex-col"
                    >
                        <div className="flex items-center justify-between px-3 py-2 border-b border-white/8 shrink-0">
                            <span className="text-xs font-semibold text-[var(--speckle-foreground)]">Notifications</span>
                            {unreadCount > 0 && (
                                <button onClick={markAllRead} className="text-[10px] text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] flex items-center gap-1">
                                    <Check className="w-3 h-3" /> Mark all read
                                </button>
                            )}
                        </div>
                        <div className="overflow-y-auto flex-1">
                            {loading && (
                                <div className="text-[11px] text-[var(--speckle-foreground-3)] text-center py-6">Loading…</div>
                            )}
                            {!loading && notifications.length === 0 && (
                                <div className="text-[11px] text-[var(--speckle-foreground-3)] text-center py-6">No notifications yet</div>
                            )}
                            {notifications.map(n => (
                                <button
                                    key={n.id}
                                    onClick={() => !n.read_at && markRead(n.id)}
                                    className={`w-full text-left px-3 py-2.5 border-b border-white/5 hover:bg-white/5 transition-colors ${n.read_at ? 'opacity-50' : ''}`}
                                >
                                    <div className="text-[11px] text-[var(--speckle-foreground)]">{n.message}</div>
                                    <div className="text-[9px] text-[var(--speckle-foreground-3)] mt-0.5">{new Date(n.created_at).toLocaleString()}</div>
                                </button>
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
