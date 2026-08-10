import { useState, useRef, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Layers } from 'lucide-react'

// Fixed palette auto-assigned to combined models in selection order — same
// idea as AdaptiveCharts' categorical palettes, just small and stable so a
// given discipline keeps its color for the session instead of shuffling.
const DISCIPLINE_COLORS = ['#4dabf7', '#ff922b', '#69db7c', '#e599f7', '#ffd43b', '#ff6b6b']

export function nextCombineColor(usedCount) {
    return DISCIPLINE_COLORS[usedCount % DISCIPLINE_COLORS.length]
}

// Lets the user pick 1+ more branches ("ARC"/"STR"/"FM" etc.) to federate
// alongside the model already open in the viewer, into one combined 3D
// view for cross-discipline coordination — see FederatedBar.jsx (viewer
// overlay) and FederatedClashPanel.jsx (N-way clash checking across the
// combined set). Reuses the same Map<key, entry> checkbox-toggle shape as
// IdsCheckPanel.jsx/ClashCheckPanel.jsx's `selected` state, since each
// combined model needs more per-entry data (version, color, resolved
// normalizer model id) than a plain string array would hold.
//
// The already-open model is pre-seeded into `combinedModels` by App.jsx
// (so the loading/coloring/hide-show machinery always treats it uniformly
// with anything else combined) but deliberately isn't offered as a
// checkbox here — it's not a choice the user is making, it's already true.
// Showing it as just another row made the count ("Load combined view (3)")
// read as if 3 separate picks had been made when only 1 extra one had.
export function CombineModelsPicker({ models = [], primaryBranchName, combinedModels, onToggleModel, onLoad, onExit, loading, active }) {
    const [open, setOpen] = useState(false)
    const containerRef = useRef(null)

    useEffect(() => {
        if (!open) return
        const handler = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false) }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    const candidateModels = useMemo(
        () => models.filter((m) => m.commits?.totalCount > 0 && m.name !== primaryBranchName),
        [models, primaryBranchName]
    )
    // combinedModels always includes the pre-seeded primary entry once
    // data has loaded — exclude it so the "Load combined view" button's own
    // count/disabled-state reflect only what the user actually chose to add
    // (picking 1 more is the minimum to combine anything).
    const additionalCount = useMemo(
        () => [...combinedModels.keys()].filter((k) => k !== primaryBranchName).length,
        [combinedModels, primaryBranchName]
    )
    // The icon badge is a different signal from the button count above: it
    // reflects how many models are actually loaded in the viewer right now
    // (only meaningful once `active`/combineMode is true), not how many are
    // queued up in an as-yet-unloaded picker selection — so it stays hidden
    // for the single-model default case and shows the real total (2, 3, ...)
    // once combined, instead of an always-off-by-one "+N" of just the extras.
    const loadedCount = active ? combinedModels.size : 0

    return (
        <div ref={containerRef} className="relative">
            <motion.button
                whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                onClick={() => setOpen((v) => !v)}
                className={`glass-card icon-btn hover:bg-white/10 relative ${active ? 'text-amber-400 bg-amber-400/10' : ''}`}
                title="Combine models for federated viewing + cross-discipline clash checking"
            >
                <Layers className="w-6 h-6" />
                {loadedCount >= 2 && (
                    <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-amber-400 text-[9px] font-bold text-black flex items-center justify-center">
                        {loadedCount}
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
                        {primaryBranchName && (
                            <div className="flex items-center gap-2 px-2 py-1.5 mb-1 rounded-md text-sm bg-white/5">
                                <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-[var(--speckle-foreground-3)]" />
                                <span className="flex-1 truncate text-[var(--speckle-foreground-2)]">{primaryBranchName}</span>
                                <span className="text-[var(--speckle-foreground-3)] text-[10px] shrink-0">already open</span>
                            </div>
                        )}
                        <div className="space-y-0.5">
                            {candidateModels.length === 0 ? (
                                <div className="px-2 py-3 text-xs text-[var(--speckle-foreground-3)] text-center">No other models with commits</div>
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
                                    disabled={additionalCount < 1 || loading}
                                    className="flex-1 py-1.5 rounded-md text-xs font-medium bg-amber-400/15 text-amber-400 hover:bg-amber-400/25 disabled:opacity-40 transition-colors"
                                >
                                    {loading ? 'Loading…' : `Load combined view (+${additionalCount})`}
                                </button>
                            )}
                        </div>
                        {additionalCount < 1 && !active && (
                            <p className="text-[10px] text-[var(--speckle-foreground-3)] px-2 pt-1.5">Select at least 1 more model to combine with the one already open.</p>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
