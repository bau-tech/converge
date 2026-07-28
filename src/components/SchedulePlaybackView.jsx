import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Play, Pause, SkipBack, SkipForward, ChevronsLeft, ChevronsRight,
    Loader2, ChevronDown, BarChart3, CalendarClock, X,
} from 'lucide-react'

const SPEEDS = [0.5, 1, 2, 4]

function fmt(value) {
    const d = parseDate(value)
    if (d) return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    return value
}

function parseDate(value) {
    if (!value) return null
    const d = new Date(value)
    return !isNaN(d.getTime()) && value.length >= 8 ? d : null
}

// 4D build-up playback: fetches date-shaped parameters for a model (planned
// task dates, or any other date parameter — see bim-normalizer's
// db/timeline.py) and scrubs/plays through them, reporting the current
// past/present speckle_id sets up via onPlaybackChange so the host (App.jsx
// -> SpeckleViewer) can isolate/color them in the 3D scene. This component
// owns all of the fetch/scrub state itself — SpeckleViewer has no knowledge
// of the schedule/timeline API, it only ever receives ids to isolate.
//
// Rendered as a compact bar docked to the bottom of the 3D viewer panel
// (not the right-hand Gantt drawer) so it never covers the chart panels.
export function SchedulePlaybackView({ normalizerModelId, normalizerUrl, onPlaybackChange, onClose }) {
    const base = (normalizerUrl || '').replace(/\/$/, '')
    const [loading, setLoading] = useState(false)
    const [params, setParams] = useState([])
    const [selectedParam, setSelectedParam] = useState(null)
    const [data, setData] = useState(null)
    const [step, setStep] = useState(0)
    const [isPlaying, setIsPlaying] = useState(false)
    const [speed, setSpeed] = useState(1)
    const [syncCharts, setSyncCharts] = useState(false)
    const [showParamPicker, setShowParamPicker] = useState(false)

    const abortRef = useRef(null)
    const playRef = useRef(null)
    const onPlaybackChangeRef = useRef(onPlaybackChange)
    useEffect(() => { onPlaybackChangeRef.current = onPlaybackChange }, [onPlaybackChange])

    const loadData = useCallback((paramKey) => {
        if (!normalizerModelId) return
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller
        setLoading(true)
        setSelectedParam(paramKey)
        setStep(0)
        setIsPlaying(false)

        fetch(`${base}/models/${normalizerModelId}/timeline/data?param_key=${encodeURIComponent(paramKey)}`, {
            signal: controller.signal,
        })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
            .then(d => { if (!controller.signal.aborted) { setData(d); setLoading(false) } })
            .catch(err => { if (err.name !== 'AbortError') setLoading(false) })
    }, [normalizerModelId, base])

    useEffect(() => {
        if (!normalizerModelId) return
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller
        setLoading(true)
        setParams([])
        setSelectedParam(null)
        setData(null)
        setStep(0)
        setIsPlaying(false)

        fetch(`${base}/models/${normalizerModelId}/timeline/params`, { signal: controller.signal })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
            .then(p => {
                if (controller.signal.aborted) return
                setParams(p)
                if (p.length > 0) loadData(p[0].key)
                else setLoading(false)
            })
            .catch(err => { if (err.name !== 'AbortError') setLoading(false) })

        return () => controller.abort()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [normalizerModelId, base])

    useEffect(() => () => abortRef.current?.abort(), [])

    useEffect(() => {
        if (!isPlaying || !data?.steps?.length) return
        const interval = Math.max(100, Math.round(speed * 1000))
        playRef.current = setInterval(() => {
            setStep(prev => {
                if (prev >= data.steps.length - 1) { setIsPlaying(false); return prev }
                return prev + 1
            })
        }, interval)
        return () => { if (playRef.current) clearInterval(playRef.current) }
    }, [isPlaying, speed, data])

    // Report the current build-up state up to the host on every change —
    // via a ref rather than a dependency, so an unmemoized inline
    // onPlaybackChange passed by the host doesn't retrigger this on every
    // parent render.
    useEffect(() => {
        if (!data?.steps?.length) {
            onPlaybackChangeRef.current?.(null, null, false)
            return
        }
        const steps = data.steps
        const pastIds = steps.slice(0, step).flatMap(s => s.element_ids || [])
        const currentIds = steps[step]?.element_ids || []
        onPlaybackChangeRef.current?.(pastIds, currentIds, syncCharts)
    }, [data, step, syncCharts])

    // Clear playback isolation in the host when this view goes away (tab
    // switch or panel close) so the 3D viewer doesn't stay ghosted.
    useEffect(() => () => { onPlaybackChangeRef.current?.(null, null, false) }, [])

    if (!normalizerModelId) return null

    const steps = data?.steps || []
    const totalElements = data?.total_elements || 0
    const selectedParamLabel = params.find(p => p.key === selectedParam)?.label || selectedParam
    const current = steps[step]
    const builtCount = current?.cumulative_count ?? 0
    const pct = totalElements > 0 ? Math.round((builtCount / totalElements) * 100) : 0

    return (
        <div className="rounded-xl border border-[var(--speckle-outline-3)] shadow-2xl p-3 flex flex-col gap-2" style={{ backgroundColor: 'var(--speckle-foundation-page)' }}>
            {/* Header row */}
            <div className="flex items-center gap-2 flex-wrap">
                <CalendarClock className="w-4 h-4 text-amber-400 shrink-0" />
                <span className="text-xs font-semibold text-amber-400 shrink-0">Build-up Playback</span>

                {params.length > 1 && (
                    <div className="relative">
                        <button
                            onClick={() => setShowParamPicker(v => !v)}
                            className="flex items-center gap-1 text-xs text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground-2)] bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2 py-1 transition-colors"
                        >
                            <span className="max-w-[160px] truncate">{selectedParamLabel || 'select param'}</span>
                            <ChevronDown className={`w-3 h-3 transition-transform ${showParamPicker ? 'rotate-180' : ''}`} />
                        </button>
                        <AnimatePresence>
                            {showParamPicker && (
                                <motion.div
                                    initial={{ opacity: 0, y: 4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: 4 }}
                                    className="absolute bottom-full mb-1 left-0 min-w-[220px] glass rounded-lg shadow-xl z-30 py-1"
                                >
                                    {params.map(p => (
                                        <button
                                            key={p.key}
                                            onClick={() => { loadData(p.key); setShowParamPicker(false) }}
                                            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--speckle-outline-3)] transition-colors ${p.key === selectedParam ? 'text-amber-400' : 'text-[var(--speckle-foreground-2)]'}`}
                                        >
                                            <span className="font-medium">{p.label || p.key}</span>
                                            <span className="text-[var(--speckle-foreground-3)] ml-1.5">({p.element_count} elements)</span>
                                        </button>
                                    ))}
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                )}

                <div className="flex-1" />

                {steps.length > 0 && (
                    <span className="text-xs text-[var(--speckle-foreground-3)] tabular-nums hidden sm:inline">
                        {builtCount.toLocaleString()} / {totalElements.toLocaleString()} elements
                        <span className={`ml-1.5 font-semibold ${pct === 100 ? 'text-green-400' : 'text-amber-400'}`}>{pct}%</span>
                    </span>
                )}

                <button
                    onClick={() => setSyncCharts(v => !v)}
                    className={`flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors border ${
                        syncCharts
                            ? 'bg-amber-500/25 text-amber-300 border-amber-500/30'
                            : 'text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground-2)] border-transparent'
                    }`}
                    title="Sync charts to the current build-up step"
                >
                    <BarChart3 className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Sync charts</span>
                </button>

                <div className="flex items-center gap-0.5">
                    {SPEEDS.map(s => (
                        <button
                            key={s}
                            onClick={() => setSpeed(s)}
                            className={`text-xs px-2 py-1 rounded transition-colors ${speed === s ? 'bg-amber-500/25 text-amber-300' : 'text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground-2)]'}`}
                        >
                            {s}×
                        </button>
                    ))}
                </div>

                {onClose && (
                    <button
                        onClick={onClose}
                        className="p-1 rounded-lg hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] transition-colors"
                        title="Close playback"
                    >
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>

            {loading ? (
                <div className="flex items-center justify-center gap-2 text-[var(--speckle-foreground-3)] text-sm py-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading timeline…
                </div>
            ) : steps.length === 0 ? (
                <div className="flex items-center justify-center gap-2 text-[var(--speckle-foreground-3)] text-sm py-2">
                    <CalendarClock className="w-4 h-4 text-[var(--speckle-outline-4)]" />
                    No date parameters found in this model.
                </div>
            ) : (
                <div className="flex items-center gap-3">
                    {/* Transport controls */}
                    <div className="flex items-center gap-1 shrink-0">
                        <button
                            onClick={() => { setStep(0); setIsPlaying(false) }}
                            className="p-1.5 rounded-lg hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] transition-colors"
                            title="Jump to start"
                        >
                            <ChevronsLeft className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => { setStep(s => Math.max(0, s - 1)); setIsPlaying(false) }}
                            className="p-1.5 rounded-lg hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] transition-colors"
                            title="Previous step"
                        >
                            <SkipBack className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => {
                                if (step >= steps.length - 1) setStep(0)
                                setIsPlaying(v => !v)
                            }}
                            className="p-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/35 border border-amber-500/30 text-amber-300 hover:text-amber-200 transition-all"
                            title={isPlaying ? 'Pause' : 'Play'}
                        >
                            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 translate-x-px" />}
                        </button>
                        <button
                            onClick={() => { setStep(s => Math.min(steps.length - 1, s + 1)); setIsPlaying(false) }}
                            className="p-1.5 rounded-lg hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] transition-colors"
                            title="Next step"
                        >
                            <SkipForward className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => { setStep(steps.length - 1); setIsPlaying(false) }}
                            className="p-1.5 rounded-lg hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] transition-colors"
                            title="Jump to end"
                        >
                            <ChevronsRight className="w-4 h-4" />
                        </button>
                    </div>

                    <span className="text-xs font-bold text-amber-300 tabular-nums shrink-0 hidden md:inline">{fmt(current?.value)}</span>
                    <span className="text-[10px] text-[var(--speckle-foreground-3)] tabular-nums shrink-0">{fmt(steps[0]?.value)}</span>

                    {/* Scrubber */}
                    <div className="relative flex-1 min-w-0">
                        <div className="h-1.5 rounded-full bg-[var(--speckle-outline-3)] overflow-hidden">
                            <motion.div
                                className="h-full rounded-full bg-gradient-to-r from-green-500 to-amber-400"
                                animate={{ width: `${steps.length > 1 ? (step / (steps.length - 1)) * 100 : 100}%` }}
                                transition={{ duration: 0.15 }}
                            />
                        </div>
                        <input
                            type="range"
                            min={0}
                            max={steps.length - 1}
                            value={step}
                            onChange={e => { setStep(Number(e.target.value)); setIsPlaying(false) }}
                            className="w-full h-1.5 opacity-0 cursor-pointer absolute top-1/2 left-0 -translate-y-1/2"
                        />
                    </div>

                    <span className="text-[10px] text-[var(--speckle-foreground-3)] tabular-nums shrink-0">{fmt(steps[steps.length - 1]?.value)}</span>
                    <span className="text-xs text-[var(--speckle-foreground-3)] tabular-nums shrink-0">step {step + 1}/{steps.length}</span>
                </div>
            )}
        </div>
    )
}
