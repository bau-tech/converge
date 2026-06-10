import { motion, AnimatePresence } from 'framer-motion'
import {
    Play, Pause, SkipBack, SkipForward, ChevronsLeft, ChevronsRight,
    X, Clock, Loader2, ChevronDown, BarChart3
} from 'lucide-react'
import { useState } from 'react'

const SPEEDS = [0.5, 1, 2, 4]

function fmt(value) {
    // Try to display a date value nicely
    const d = parseDate(value)
    if (d) {
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    }
    return value
}

function parseDate(value) {
    if (!value) return null
    for (const fmt of ['%Y-%m-%d', '%d.%m.%Y', '%d/%m/%Y', '%m/%d/%Y']) {
        // JS date parse: try ISO first
        const d = new Date(value)
        if (!isNaN(d.getTime()) && value.length >= 8) return d
    }
    return null
}

export function TimelinePlayer({
    steps = [],
    currentStep = 0,
    isPlaying = false,
    totalElements = 0,
    speed = 1,
    loading = false,
    params = [],
    selectedParam = null,
    syncCharts = false,
    onToggleSync,
    onStepChange,
    onTogglePlay,
    onClose,
    onSpeedChange,
    onParamSelect,
}) {
    const [showParamPicker, setShowParamPicker] = useState(false)
    const step = steps[currentStep]
    const builtCount = step?.cumulative_count ?? 0
    const pct = totalElements > 0 ? Math.round((builtCount / totalElements) * 100) : 0

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.2 }}
            className="relative w-full z-20"
        >
            <div className="rounded-xl border border-amber-500/20 bg-zinc-900 shadow-2xl p-3">

                {/* Header row */}
                <div className="flex items-center gap-2 mb-2">
                    <Clock className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                    <span className="text-[11px] font-semibold text-amber-400">4D Timeline</span>

                    {/* Param selector */}
                    {params.length > 1 && (
                        <div className="relative">
                            <button
                                onClick={() => setShowParamPicker(v => !v)}
                                className="flex items-center gap-1 text-[10px] text-zinc-400 hover:text-zinc-200 bg-white/5 border border-white/10 rounded px-1.5 py-0.5 transition-colors"
                            >
                                <span className="max-w-[120px] truncate">{selectedParam || 'select param'}</span>
                                <ChevronDown className={`w-3 h-3 transition-transform ${showParamPicker ? 'rotate-180' : ''}`} />
                            </button>
                            <AnimatePresence>
                                {showParamPicker && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -4 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -4 }}
                                        className="absolute bottom-full mb-1 left-0 min-w-[180px] rounded-lg border border-white/10 bg-zinc-900 shadow-xl z-30 py-1"
                                    >
                                        {params.map(p => (
                                            <button
                                                key={p.key}
                                                onClick={() => { onParamSelect(p.key); setShowParamPicker(false) }}
                                                className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-white/10 transition-colors ${p.key === selectedParam ? 'text-amber-400' : 'text-zinc-300'}`}
                                            >
                                                <span className="font-medium">{p.key}</span>
                                                <span className="text-zinc-500 ml-1.5">({p.element_count} elements)</span>
                                            </button>
                                        ))}
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    )}

                    <div className="flex-1" />

                    {/* Sync charts */}
                    <button
                        onClick={onToggleSync}
                        className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors border ${
                            syncCharts
                                ? 'bg-amber-500/25 text-amber-300 border-amber-500/30'
                                : 'text-zinc-500 hover:text-zinc-300 border-transparent'
                        }`}
                        title="Sync charts to the current timeline step"
                    >
                        <BarChart3 className="w-3 h-3" />
                        Sync charts
                    </button>

                    {/* Speed */}
                    <div className="flex items-center gap-0.5">
                        {SPEEDS.map(s => (
                            <button
                                key={s}
                                onClick={() => onSpeedChange(s)}
                                className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${speed === s ? 'bg-amber-500/25 text-amber-300' : 'text-zinc-500 hover:text-zinc-300'}`}
                            >
                                {s}×
                            </button>
                        ))}
                    </div>

                    <button
                        onClick={onClose}
                        className="p-1 rounded-lg hover:bg-white/10 text-zinc-500 hover:text-white transition-colors flex-shrink-0"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center h-10 gap-2 text-zinc-500 text-[11px]">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Loading timeline…
                    </div>
                ) : steps.length === 0 ? (
                    <div className="text-center text-[11px] text-zinc-500 py-2">
                        No date parameters found in this model.
                    </div>
                ) : (
                    <>
                        {/* Current step info */}
                        <div className="flex items-baseline gap-2 mb-2">
                            <span className="text-base font-bold text-amber-300 tabular-nums">
                                {fmt(step?.value)}
                            </span>
                            <span className="text-[11px] text-zinc-500">
                                step {currentStep + 1} / {steps.length}
                            </span>
                            <div className="flex-1" />
                            <span className="text-[11px] text-zinc-400 tabular-nums">
                                {builtCount.toLocaleString()} / {totalElements.toLocaleString()} elements
                            </span>
                            <span className={`text-[11px] font-semibold tabular-nums ${pct === 100 ? 'text-green-400' : 'text-amber-400'}`}>
                                {pct}%
                            </span>
                        </div>

                        {/* Scrubber */}
                        <div className="relative mb-2 px-0.5">
                            {/* Progress fill */}
                            <div className="h-1 rounded-full bg-white/10 overflow-hidden mb-1">
                                <motion.div
                                    className="h-full rounded-full bg-gradient-to-r from-green-500 to-amber-400"
                                    animate={{ width: `${steps.length > 1 ? (currentStep / (steps.length - 1)) * 100 : 100}%` }}
                                    transition={{ duration: 0.15 }}
                                />
                            </div>
                            <input
                                type="range"
                                min={0}
                                max={steps.length - 1}
                                value={currentStep}
                                onChange={e => onStepChange(Number(e.target.value))}
                                className="w-full h-1 opacity-0 cursor-pointer absolute top-0 left-0"
                            />
                        </div>

                        {/* Step labels (first / last) */}
                        <div className="flex justify-between text-[9px] text-zinc-600 mb-2 px-0.5">
                            <span>{fmt(steps[0]?.value)}</span>
                            <span>{fmt(steps[steps.length - 1]?.value)}</span>
                        </div>

                        {/* Controls */}
                        <div className="flex items-center justify-center gap-2">
                            <button
                                onClick={() => onStepChange(0)}
                                className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                                title="Jump to start"
                            >
                                <ChevronsLeft className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => onStepChange(Math.max(0, currentStep - 1))}
                                className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                                title="Previous step"
                            >
                                <SkipBack className="w-4 h-4" />
                            </button>

                            <button
                                onClick={onTogglePlay}
                                className="p-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/35 border border-amber-500/30 text-amber-300 hover:text-amber-200 transition-all"
                                title={isPlaying ? 'Pause' : 'Play'}
                            >
                                {isPlaying
                                    ? <Pause className="w-4 h-4" />
                                    : <Play className="w-4 h-4 translate-x-px" />
                                }
                            </button>

                            <button
                                onClick={() => onStepChange(Math.min(steps.length - 1, currentStep + 1))}
                                className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                                title="Next step"
                            >
                                <SkipForward className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => onStepChange(steps.length - 1)}
                                className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                                title="Jump to end"
                            >
                                <ChevronsRight className="w-4 h-4" />
                            </button>
                        </div>

                        {/* Color legend */}
                        <div className="flex items-center justify-center gap-4 mt-2">
                            <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                                <span className="w-2 h-2 rounded-full bg-green-400 inline-block" /> Built
                            </span>
                            <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                                <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> Current step
                            </span>
                            <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                                <span className="w-2 h-2 rounded-full bg-zinc-600 inline-block" /> Not yet built
                            </span>
                        </div>
                    </>
                )}
            </div>
        </motion.div>
    )
}
