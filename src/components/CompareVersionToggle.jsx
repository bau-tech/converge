import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { GitCompare, Check, Loader2, X } from 'lucide-react'

export function CompareVersionToggle({
    versions = [],
    compareVersionId,
    compareLoading,
    diffResult,
    currentVersionId,
    onCompare,
    onExit,
    disabled,
}) {
    const [open, setOpen] = useState(false)
    const ref = useRef(null)

    useEffect(() => {
        if (!open) return
        const handler = (e) => {
            if (ref.current && !ref.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    const isActive = !!diffResult

    const comparingVersion = versions.find(v => v.id === compareVersionId)

    const selectableVersions = versions.filter(v => v.id !== currentVersionId)

    if (isActive) {
        return (
            <div ref={ref} className="flex items-center gap-1">
                <div
                    className="glass-card icon-btn bg-amber-500/10 border-amber-500/30 text-amber-400"
                    title={comparingVersion
                        ? `Comparing vs ${new Date(comparingVersion.createdAt).toLocaleDateString()}`
                        : 'Comparing'}
                >
                    <GitCompare className="w-6 h-6" />
                </div>
                <button
                    onClick={onExit}
                    className="glass-card icon-btn hover:bg-red-500/10 hover:text-red-400 text-zinc-500 transition-colors"
                    title="Exit compare mode"
                >
                    <X className="w-6 h-6" />
                </button>
            </div>
        )
    }

    return (
        <div ref={ref} className="relative">
            <motion.button
                whileHover={{ scale: disabled ? 1 : 1.05 }}
                whileTap={{ scale: disabled ? 1 : 0.95 }}
                onClick={() => !disabled && !compareLoading && setOpen(v => !v)}
                disabled={disabled || compareLoading || versions.length < 2}
                className={`glass-card icon-btn hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                    ${open ? 'bg-white/10' : ''}`}
                title="Compare versions"
            >
                {compareLoading
                    ? <Loader2 className="w-6 h-6 animate-spin text-amber-400" />
                    : <GitCompare className="w-6 h-6" />
                }
            </motion.button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: -6, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.97 }}
                        transition={{ duration: 0.12 }}
                        className="absolute top-full right-0 mt-1 z-[100] glass-card border border-white/10 shadow-2xl"
                        style={{ minWidth: '260px', maxHeight: '320px', overflowY: 'auto' }}
                    >
                        <div className="p-2">
                            <p className="text-[10px] text-zinc-600 uppercase tracking-wider px-2 pb-1.5">
                                Compare against
                            </p>
                            <div className="space-y-0.5">
                                {selectableVersions.length === 0 ? (
                                    <p className="px-2 py-3 text-xs text-zinc-600 text-center">
                                        Only one version available
                                    </p>
                                ) : selectableVersions.map(v => (
                                    <button
                                        key={v.id}
                                        onClick={() => { onCompare(v.id); setOpen(false) }}
                                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors text-left hover:bg-white/5 text-zinc-300"
                                    >
                                        <span className="w-3 shrink-0" />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs">{new Date(v.createdAt).toLocaleDateString()}</div>
                                            {v.message && (
                                                <div className="text-zinc-600 text-[10px] truncate">{v.message}</div>
                                            )}
                                        </div>
                                        {v.sourceApplication && (
                                            <span className="text-zinc-700 text-[10px] shrink-0">{v.sourceApplication}</span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
