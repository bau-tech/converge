import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CalendarPlus, Layers, Ruler, ChevronRight, ChevronDown, Loader2, X, AlertTriangle } from 'lucide-react'

function todayAt8am() {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const DEFAULT_OPTIONS = {
    strategy: 'storey',       // 'storey' | 'height'
    startDate: todayAt8am(),
    daysPerGroup: 5,
    order: 'bottom-up',       // 'bottom-up' | 'top-down'
    lagDays: 0,
    linkSequences: true,
    heightBandM: 3.0,
}

function StrategyChoice({ icon, label, description, active, onSelect }) {
    return (
        <button
            type="button"
            onClick={onSelect}
            aria-pressed={active}
            className={`flex items-start gap-2 rounded-lg border p-2.5 text-left transition-colors ${
                active
                    ? 'border-amber-500/60 bg-amber-500/10 text-[var(--speckle-foreground)]'
                    : 'border-[var(--speckle-outline-3)] hover:bg-[var(--speckle-outline-3)]/40 text-[var(--speckle-foreground)]'
            }`}
        >
            <span className={`mt-0.5 ${active ? 'text-amber-400' : 'text-[var(--speckle-foreground-3)]'}`}>{icon}</span>
            <span className="grid gap-0.5">
                <span className="text-xs font-medium">{label}</span>
                <span className="text-[10px] text-[var(--speckle-foreground-3)]">{description}</span>
            </span>
        </button>
    )
}

/**
 * "Generate schedule" — auto-build a 4D schedule from the model's own data
 * instead of importing an IFC/MSPDI file. Modeled on ifc-lite's client-side
 * generator (github.com/LTplus-AG/ifc-lite), but the actual grouping runs
 * server-side (db/schedule.py:generate_schedule) against bim_elements.storey
 * and bim_geometry.centroid_si, which are already populated at ingest — no
 * client-side IFC re-parse or mesh scan needed.
 *
 * The live preview only covers the `storey` strategy (via storeyCounts,
 * already available client-side as data.summary.by_level for charts —
 * adaptNormalizerSummary renames the backend's by_storey to by_level) —
 * `height` has no equivalent client-side source without loading raw
 * geometry into this panel, so its preview is a plain placeholder note.
 * Either way the actual grouping/dates are authoritative from the server
 * response once generated, not from this estimate.
 */
export function GenerateScheduleDialog({ open, onClose, normalizerUrl, normalizerModelId, storeyCounts, onGenerated }) {
    const [options, setOptions] = useState(DEFAULT_OPTIONS)
    const [advancedOpen, setAdvancedOpen] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState(null)
    const base = (normalizerUrl || '').replace(/\/$/, '')

    const handleChange = (key, value) => setOptions(prev => ({ ...prev, [key]: value }))

    const hasStoreyData = !!storeyCounts && Object.keys(storeyCounts).length > 0

    // Cheap client-side estimate for the `storey` strategy only — counts and
    // finish date only depend on group count, not actual per-group order, so
    // this stays accurate without needing the real Z-based ordering the
    // server computes. Deliberately doesn't show first/last task names (that
    // would need real ordering) — see the component doc comment.
    const preview = useMemo(() => {
        if (options.strategy !== 'storey' || !hasStoreyData) return null
        const groupCount = Object.keys(storeyCounts).length
        const productCount = Object.values(storeyCounts).reduce((a, b) => a + b, 0)
        if (groupCount === 0) return null
        const strideDays = options.daysPerGroup + options.lagDays
        const finish = new Date(`${options.startDate}T00:00:00`)
        finish.setDate(finish.getDate() + Math.max(0, groupCount - 1) * strideDays + options.daysPerGroup)
        return { groupCount, productCount, finishDate: finish }
    }, [options.strategy, options.startDate, options.daysPerGroup, options.lagDays, storeyCounts, hasStoreyData])

    const canSubmit = !submitting && options.daysPerGroup > 0 && options.startDate &&
        (options.strategy !== 'storey' || hasStoreyData)

    const handleGenerate = async () => {
        if (!canSubmit || !normalizerModelId) return
        setSubmitting(true)
        setError(null)
        try {
            const res = await fetch(`${base}/models/${normalizerModelId}/schedule/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    strategy: options.strategy,
                    start_date: options.startDate,
                    days_per_group: options.daysPerGroup,
                    lag_days: options.lagDays,
                    order: options.order,
                    link_sequences: options.linkSequences,
                    height_band_m: options.heightBandM,
                }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `HTTP ${res.status}`)
            }
            const result = await res.json()
            await onGenerated?.(result)
            onClose()
        } catch (err) {
            setError(err.message)
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[200000] flex items-center justify-center p-4"
                    style={{ background: 'rgba(0,0,0,0.6)' }}
                    onClick={e => { if (e.target === e.currentTarget && !submitting) onClose() }}
                >
                    <motion.div
                        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="glass-card w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden"
                    >
                        {/* Header */}
                        <div className="flex items-start justify-between px-5 py-4 border-b border-white/10 shrink-0">
                            <div className="flex items-start gap-2.5">
                                <CalendarPlus className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
                                <div>
                                    <h2 className="font-semibold text-sm text-[var(--speckle-foreground)]">Generate schedule</h2>
                                    <p className="text-xs text-[var(--speckle-foreground-3)] mt-0.5">
                                        Creates a work schedule with one task per group and assigns every
                                        element in that group to the task, so the 4D Gantt animation can
                                        reveal them as time advances. Replaces the current schedule.
                                    </p>
                                </div>
                            </div>
                            <button onClick={onClose} disabled={submitting} className="p-1.5 hover:bg-white/10 rounded-lg transition-colors shrink-0 disabled:opacity-40">
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {/* Body */}
                        <div className="overflow-y-auto flex-1 p-4 grid gap-4">
                            {/* Group by */}
                            <div className="grid gap-1.5">
                                <label className="text-xs font-medium text-[var(--speckle-foreground-2)]">Group by</label>
                                <div className="grid grid-cols-2 gap-2">
                                    <StrategyChoice
                                        icon={<Layers className="w-4 h-4" />}
                                        label="Storey"
                                        description="One task per level"
                                        active={options.strategy === 'storey'}
                                        onSelect={() => handleChange('strategy', 'storey')}
                                    />
                                    <StrategyChoice
                                        icon={<Ruler className="w-4 h-4" />}
                                        label="Height"
                                        description="Slice by elevation"
                                        active={options.strategy === 'height'}
                                        onSelect={() => handleChange('strategy', 'height')}
                                    />
                                </div>
                                {options.strategy === 'storey' && !hasStoreyData && (
                                    <p className="flex items-center gap-1.5 text-[11px] text-amber-400">
                                        <AlertTriangle className="w-3 h-3 shrink-0" />
                                        No storey data on this model — try Height instead.
                                    </p>
                                )}
                            </div>

                            {options.strategy === 'height' && (
                                <div className="grid gap-1.5">
                                    <label htmlFor="gen-band" className="text-xs font-medium text-[var(--speckle-foreground-2)]">
                                        Band height (m)
                                    </label>
                                    <input
                                        id="gen-band"
                                        type="number"
                                        min={0.1}
                                        step={0.1}
                                        value={options.heightBandM}
                                        onChange={e => {
                                            const v = parseFloat(e.target.value)
                                            handleChange('heightBandM', Number.isFinite(v) && v > 0 ? v : 3)
                                        }}
                                        className="bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2.5 py-1.5 text-xs text-[var(--speckle-foreground)] focus:outline-none focus:border-amber-500/50"
                                    />
                                    <p className="text-[10px] text-[var(--speckle-foreground-3)]">
                                        Elements are bucketed by their real geometry elevation, ignoring storey
                                        assignment — a rescue path for models where storeys are missing or unreliable.
                                    </p>
                                </div>
                            )}

                            {/* Start date + duration */}
                            <div className="grid grid-cols-2 gap-3">
                                <div className="grid gap-1.5">
                                    <label htmlFor="gen-start" className="text-xs font-medium text-[var(--speckle-foreground-2)]">Start date</label>
                                    <input
                                        id="gen-start"
                                        type="date"
                                        value={options.startDate}
                                        onChange={e => handleChange('startDate', e.target.value || DEFAULT_OPTIONS.startDate)}
                                        className="bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2.5 py-1.5 text-xs text-[var(--speckle-foreground)] focus:outline-none focus:border-amber-500/50"
                                    />
                                </div>
                                <div className="grid gap-1.5">
                                    <label htmlFor="gen-duration" className="text-xs font-medium text-[var(--speckle-foreground-2)]">Days per group</label>
                                    <input
                                        id="gen-duration"
                                        type="number"
                                        min={0.5}
                                        step={0.5}
                                        value={options.daysPerGroup}
                                        onChange={e => {
                                            const v = parseFloat(e.target.value)
                                            handleChange('daysPerGroup', Number.isFinite(v) && v > 0 ? v : 1)
                                        }}
                                        className="bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2.5 py-1.5 text-xs text-[var(--speckle-foreground)] focus:outline-none focus:border-amber-500/50"
                                    />
                                </div>
                            </div>

                            {/* Order */}
                            <div className="grid gap-1.5">
                                <label className="text-xs font-medium text-[var(--speckle-foreground-2)]">Order</label>
                                <div className="grid grid-cols-2 gap-2">
                                    <StrategyChoice
                                        icon={<span className="text-xs font-semibold">↑</span>}
                                        label="Bottom-up"
                                        description="Ground → upper floors"
                                        active={options.order === 'bottom-up'}
                                        onSelect={() => handleChange('order', 'bottom-up')}
                                    />
                                    <StrategyChoice
                                        icon={<span className="text-xs font-semibold">↓</span>}
                                        label="Top-down"
                                        description="Roof → ground"
                                        active={options.order === 'top-down'}
                                        onSelect={() => handleChange('order', 'top-down')}
                                    />
                                </div>
                            </div>

                            {/* Advanced */}
                            <div className="rounded-lg border border-[var(--speckle-outline-3)] overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => setAdvancedOpen(v => !v)}
                                    className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)]/40 transition-colors"
                                >
                                    {advancedOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                    Advanced
                                </button>
                                {advancedOpen && (
                                    <div className="px-3 pb-3 pt-1 grid gap-3 border-t border-[var(--speckle-outline-3)]">
                                        <div className="grid gap-1.5">
                                            <label htmlFor="gen-lag" className="text-xs text-[var(--speckle-foreground-2)]">Lag between groups (days)</label>
                                            <input
                                                id="gen-lag"
                                                type="number"
                                                min={0}
                                                step={0.5}
                                                value={options.lagDays}
                                                onChange={e => {
                                                    const v = parseFloat(e.target.value)
                                                    handleChange('lagDays', Number.isFinite(v) && v >= 0 ? v : 0)
                                                }}
                                                className="bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2.5 py-1.5 text-xs text-[var(--speckle-foreground)] focus:outline-none focus:border-amber-500/50"
                                            />
                                        </div>
                                        <label className="flex items-center gap-2 text-xs text-[var(--speckle-foreground-2)] cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={options.linkSequences}
                                                onChange={e => handleChange('linkSequences', e.target.checked)}
                                                className="accent-amber-500"
                                            />
                                            Link consecutive tasks (Finish-to-Start)
                                        </label>
                                    </div>
                                )}
                            </div>

                            {/* Summary */}
                            <div className="rounded-lg bg-[var(--speckle-outline-3)]/30 p-3 text-xs">
                                {preview ? (
                                    <div className="grid gap-1">
                                        <span className="font-medium text-[var(--speckle-foreground)]">Summary</span>
                                        <p className="text-[var(--speckle-foreground-2)]">
                                            <span className="font-semibold">{preview.groupCount}</span> tasks ·{' '}
                                            <span className="font-semibold">{preview.productCount}</span> elements ·{' '}
                                            finishes <span className="font-mono">{preview.finishDate.toLocaleDateString()}</span>
                                        </p>
                                    </div>
                                ) : (
                                    <p className="text-[var(--speckle-foreground-3)]">
                                        {options.strategy === 'height'
                                            ? 'Group count depends on real element elevation — computed when you generate.'
                                            : 'No storey data available to preview.'}
                                    </p>
                                )}
                            </div>

                            {error && (
                                <p className="text-xs text-red-400">{error}</p>
                            )}
                        </div>

                        {/* Footer */}
                        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-white/10 shrink-0">
                            <button
                                onClick={onClose}
                                disabled={submitting}
                                className="text-xs px-3 py-1.5 rounded-lg text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] transition-colors disabled:opacity-40"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleGenerate}
                                disabled={!canSubmit}
                                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-amber-500 text-black font-medium hover:bg-amber-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CalendarPlus className="w-3.5 h-3.5" />}
                                Generate schedule
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}
