import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Layers } from 'lucide-react'

// Fixed palette auto-assigned to combined models in selection order — same
// idea as AdaptiveCharts' categorical palettes, just small and stable so a
// given discipline keeps its color for the session instead of shuffling.
const DISCIPLINE_COLORS = ['#4dabf7', '#ff922b', '#69db7c', '#e599f7', '#ffd43b', '#ff6b6b']

export function nextCombineColor(usedCount) {
    return DISCIPLINE_COLORS[usedCount % DISCIPLINE_COLORS.length]
}

// Lets the user pick 2+ branches ("ARC"/"STR"/"FM" etc.) within the current
// project to federate into one 3D view for cross-discipline coordination —
// see FederatedBar.jsx (viewer overlay) and FederatedClashPanel.jsx (N-way
// clash checking across the combined set). Reuses the same Map<key, entry>
// checkbox-toggle shape as IdsCheckPanel.jsx/ClashCheckPanel.jsx's `selected`
// state, since each combined model needs more per-entry data (version,
// color, resolved normalizer model id) than a plain string array would hold.
export function CombineModelsPicker({ models = [], combinedModels, onToggleModel, onLoad, onExit, loading, active }) {
    const [open, setOpen] = useState(false)
    const containerRef = useRef(null)

    useEffect(() => {
        if (!open) return
        const handler = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false) }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    const candidateModels = models.filter((m) => m.commits?.totalCount > 0)
    const count = combinedModels.size

    return (
        <div ref={containerRef} className="relative">
            <motion.button
                whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                onClick={() => setOpen((v) => !v)}
                className={`glass-card icon-btn hover:bg-white/10 relative ${active ? 'text-amber-400 bg-amber-400/10' : ''}`}
                title="Combine models for federated viewing + cross-discipline clash checking"
            >
                <Layers className="w-6 h-6" />
                {count > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-amber-400 text-[9px] font-bold text-black flex items-center justify-center">
                        {count}
                    </span>
                )}
            </motion.button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: -6, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.97 }}
                        transition={{ duration: 0.12 }}
                        className="absolute top-full right-0 mt-1 z-[100] glass-card shadow-2xl p-2"
                        style={{ width: '280px', maxHeight: '360px', overflowY: 'auto' }}
                    >
                        <p className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider px-2 pb-1.5">
                            Combine models
                        </p>
                        <div className="space-y-0.5">
                            {candidateModels.length === 0 ? (
                                <div className="px-2 py-3 text-xs text-[var(--speckle-foreground-3)] text-center">No models with commits</div>
                            ) : candidateModels.map((m) => {
                                const entry = combinedModels.get(m.name)
                                return (
                                    <label
                                        key={m.name}
                                        className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/5 cursor-pointer"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={!!entry}
                                            onChange={() => onToggleModel(m)}
                                            className="shrink-0"
                                        />
                                        {entry
                                            ? <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
                                            : <span className="w-2.5 h-2.5 shrink-0" />
                                        }
                                        <span className="flex-1 truncate text-[var(--speckle-foreground-2)]">{m.name}</span>
                                        <span className="text-[var(--speckle-foreground-3)] text-[10px] shrink-0">{m.commits.totalCount}v</span>
                                    </label>
                                )
                            })}
                        </div>
                        <div className="border-t border-white/5 mt-2 pt-2 flex gap-2 px-1">
                            {active ? (
                                <button
                                    onClick={() => { onExit(); setOpen(false) }}
                                    className="flex-1 py-1.5 rounded-md text-xs font-medium bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-2)] transition-colors"
                                >
                                    Exit combined view
                                </button>
                            ) : (
                                <button
                                    onClick={() => { onLoad(); setOpen(false) }}
                                    disabled={count < 2 || loading}
                                    className="flex-1 py-1.5 rounded-md text-xs font-medium bg-amber-400/15 text-amber-400 hover:bg-amber-400/25 disabled:opacity-40 transition-colors"
                                >
                                    {loading ? 'Loading…' : `Load combined view (${count})`}
                                </button>
                            )}
                        </div>
                        {count < 2 && !active && (
                            <p className="text-[10px] text-[var(--speckle-foreground-3)] px-2 pt-1.5">Select at least 2 models to combine.</p>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
