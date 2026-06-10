import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, GitCompare, ChevronDown } from 'lucide-react'

export function DiffBar({ diffResult, onExit, onIsolateAdded, onIsolateUnchanged, onShowAll }) {
    const [showCategories, setShowCategories] = useState(false)
    const [activeFilter, setActiveFilter] = useState(null) // 'added' | 'unchanged' | null

    const {
        added_count = 0,
        removed_count = 0,
        current_total = 0,
        other_total = 0,
        total_delta = 0,
        category_changes = [],
    } = diffResult

    const unchanged_count = Math.max(0, current_total - added_count)

    const handleAddedClick = () => {
        if (activeFilter === 'added') {
            setActiveFilter(null)
            onShowAll()
        } else {
            setActiveFilter('added')
            onIsolateAdded(diffResult.element_ids || [])
        }
    }

    const handleUnchangedClick = () => {
        if (activeFilter === 'unchanged') {
            setActiveFilter(null)
            onShowAll()
        } else {
            setActiveFilter('unchanged')
            onIsolateUnchanged()
        }
    }

    const significantChanges = category_changes
        .filter(c => Math.abs(c.delta) > 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 8)

    return (
        <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="absolute top-3 left-3 right-3 z-20"
        >
            {/* Main bar */}
            <div className="rounded-xl border border-purple-500/20 bg-zinc-900 shadow-2xl p-2 flex items-center gap-2 flex-wrap">

                {/* Mode label */}
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-purple-400 pr-1">
                    <GitCompare className="w-3.5 h-3.5" />
                    Diff Mode
                </div>

                <div className="w-px h-4 bg-white/10 flex-shrink-0" />

                {/* Added pill */}
                <button
                    onClick={handleAddedClick}
                    title="Click to isolate added elements in 3D"
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all ${
                        activeFilter === 'added'
                            ? 'bg-green-500/30 border border-green-400/60 text-green-300 shadow-[0_0_8px_rgba(34,197,94,0.3)]'
                            : 'bg-green-500/10 border border-green-500/25 text-green-400 hover:bg-green-500/20 hover:border-green-400/40'
                    }`}
                >
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
                    +{added_count.toLocaleString()} Added
                </button>

                {/* Unchanged pill */}
                <button
                    onClick={handleUnchangedClick}
                    title="Click to isolate unchanged elements in 3D"
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all ${
                        activeFilter === 'unchanged'
                            ? 'bg-zinc-500/30 border border-zinc-400/60 text-zinc-200 shadow-[0_0_8px_rgba(161,161,170,0.25)]'
                            : 'bg-zinc-700/30 border border-white/8 text-zinc-400 hover:bg-zinc-700/50 hover:text-zinc-300'
                    }`}
                >
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 flex-shrink-0" />
                    ~{unchanged_count.toLocaleString()} Unchanged
                </button>

                {/* Removed pill — read-only, previous version */}
                <div
                    title="These elements existed in the previous version but are not in the current model"
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-red-500/10 border border-red-500/20 text-red-400 cursor-default"
                >
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />
                    -{removed_count.toLocaleString()} Removed
                    <span className="text-[9px] text-red-400/50 ml-0.5 hidden sm:inline">prev. ver.</span>
                </div>

                {/* Net delta badge */}
                {total_delta !== 0 && (
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                        total_delta > 0 ? 'text-green-400 bg-green-400/10' : 'text-red-400 bg-red-400/10'
                    }`}>
                        {total_delta > 0 ? '▲' : '▼'} {Math.abs(total_delta).toLocaleString()} net
                    </span>
                )}

                <div className="w-px h-4 bg-white/10 flex-shrink-0" />

                {/* Category changes toggle */}
                {significantChanges.length > 0 && (
                    <button
                        onClick={() => setShowCategories(v => !v)}
                        className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                        {significantChanges.length} categories changed
                        <ChevronDown className={`w-3 h-3 transition-transform ${showCategories ? 'rotate-180' : ''}`} />
                    </button>
                )}

                <div className="flex-1" />

                {/* Exit */}
                <button
                    onClick={onExit}
                    title="Exit diff mode"
                    className="p-1 rounded-lg hover:bg-white/10 text-zinc-500 hover:text-white transition-colors flex-shrink-0"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            {/* Category breakdown dropdown */}
            <AnimatePresence>
                {showCategories && significantChanges.length > 0 && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mt-1.5 rounded-xl border border-white/10 bg-zinc-900 overflow-hidden"
                    >
                        <div className="p-2 grid grid-cols-2 gap-x-4 gap-y-0.5">
                            {significantChanges.map(c => (
                                <div key={c.category} className="flex items-center gap-2 py-1 border-b border-white/5 last:border-0">
                                    <span className="text-[11px] text-zinc-300 truncate flex-1">{c.category}</span>
                                    <span className="text-[10px] text-zinc-500 tabular-nums">{c.other_count} → {c.current_count}</span>
                                    <span className={`text-[11px] font-semibold tabular-nums w-8 text-right ${c.delta > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                        {c.delta > 0 ? '+' : ''}{c.delta}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    )
}
