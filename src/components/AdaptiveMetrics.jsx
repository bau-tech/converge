import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Tag } from 'lucide-react'
import { MetricsConfig } from './MetricsConfig'

// ─── Color mapping ────────────────────────────────────────────────────────────
const METRIC_COLORS = {
    total_elements:     { bg: 'bg-green-500/20',   text: 'text-green-400' },
    detected_source:    { bg: 'bg-blue-500/20',    text: 'text-blue-400' },
    total_weight:       { bg: 'bg-orange-500/20',  text: 'text-orange-400' },
    total_volume:       { bg: 'bg-violet-500/20',  text: 'text-violet-400' },
    total_area:         { bg: 'bg-sky-500/20',     text: 'text-sky-400' },
    total_length:       { bg: 'bg-teal-500/20',    text: 'text-teal-400' },
    unique_categories:  { bg: 'bg-cyan-500/20',    text: 'text-cyan-400' },
    unique_levels:      { bg: 'bg-pink-500/20',    text: 'text-pink-400' },
    unique_disciplines: { bg: 'bg-amber-500/20',   text: 'text-amber-400' },
    unique_ifc_types:   { bg: 'bg-indigo-500/20',  text: 'text-indigo-400' },
    geo_coverage:       { bg: 'bg-emerald-500/20', text: 'text-emerald-400' },
    default:            { bg: 'bg-zinc-500/20',    text: 'text-zinc-400' },
}

// ─── Metadata: display names, units, decimal precision ───────────────────────
const METRIC_META = {
    // Scalar totals
    total_elements:     { displayName: 'Elements',      unit: null,  decimals: 0 },
    total_weight:       { displayName: 'Total Weight',  unit: 'kg',  decimals: 0 },
    total_volume:       { displayName: 'Total Volume',  unit: 'm³',  decimals: 2 },
    total_area:         { displayName: 'Total Area',    unit: 'm²',  decimals: 1 },
    total_length:       { displayName: 'Total Length',  unit: 'm',   decimals: 1 },
    // Count metrics
    unique_categories:  { displayName: 'Categories',    unit: null,  decimals: 0 },
    unique_levels:      { displayName: 'Levels',        unit: null,  decimals: 0 },
    unique_disciplines: { displayName: 'Disciplines',   unit: null,  decimals: 0 },
    unique_ifc_types:   { displayName: 'IFC Types',     unit: null,  decimals: 0 },
    // Source identifier
    detected_source:    { displayName: 'Source',        unit: null,  decimals: 0 },
    // Geometry coverage — stored as 0–1 decimal, displayed as percentage
    geo_coverage:       { displayName: 'Geo Coverage',  unit: '%',   decimals: 1, multiplier: 100 },
}

// Maps by_* summary keys → the count metric key they generate
const COUNT_METRIC_MAP = {
    by_category:   'unique_categories',
    by_level:      'unique_levels',
    by_discipline: 'unique_disciplines',
    by_ifc_type:   'unique_ifc_types',
}

// Keys that are chart data objects — never shown as metrics
const CHART_OBJECT_KEYS = new Set([
    'by_category', 'by_discipline', 'by_family', 'by_type', 'by_level',
    'by_material', 'by_phase', 'by_status', 'by_profile', 'by_class', 'by_assembly',
    'by_ifc_type', 'by_grade', 'by_section_class', 'by_workset', 'by_validation_issues',
    'steel_summary', 'data_quality',
])

// Internal / non-display root keys
const EXCLUDE_ROOT_KEYS = new Set([
    'elements', 'success', 'project_id', 'version_id', 'model_name', 'summary',
])

// Display order priority (lower index = shown first)
const DISPLAY_PRIORITY = [
    'total_elements', 'detected_source',
    'total_weight', 'total_length', 'total_volume', 'total_area',
    'geo_coverage',
    'unique_categories', 'unique_levels', 'unique_disciplines', 'unique_ifc_types',
]

function priorityIndex(key) {
    const i = DISPLAY_PRIORITY.indexOf(key)
    return i === -1 ? 999 : i
}

// ─── Formatter helpers ────────────────────────────────────────────────────────
function formatNumber(value, decimals) {
    return decimals === 0
        ? Math.round(value).toLocaleString()
        : value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function toTitleCase(str) {
    if (!str) return ''
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase()
}

// ─── Metric discovery ─────────────────────────────────────────────────────────
export function discoverMetrics(data) {
    if (!data) return []

    const metrics = []
    const seenKeys = new Set()

    const push = (m) => {
        if (!seenKeys.has(m.key)) {
            seenKeys.add(m.key)
            metrics.push(m)
        }
    }

    // Root-level scalar values (detected_source, etc.)
    for (const [key, value] of Object.entries(data)) {
        if (EXCLUDE_ROOT_KEYS.has(key)) continue
        if (key === 'summary') continue
        if (CHART_OBJECT_KEYS.has(key)) continue
        if (typeof value === 'string' || typeof value === 'number') {
            push({ key, value, source: 'root' })
        }
    }

    // Summary scalars and auto-count from by_* objects
    if (data.summary) {
        for (const [key, value] of Object.entries(data.summary)) {
            if (CHART_OBJECT_KEYS.has(key)) {
                // Generate count metric for selected by_* keys
                const countKey = COUNT_METRIC_MAP[key]
                if (countKey && typeof value === 'object' && value !== null) {
                    const count = Object.keys(value).length
                    if (count > 0) push({ key: countKey, value: count, source: 'calculated' })
                }
                continue
            }

            if (typeof value === 'number') {
                // Skip zero-value totals — meaningless for models without that data type.
                // geo_coverage is always kept (0% is meaningful: no geometry at all).
                if (value === 0 && key.startsWith('total_') && key !== 'total_elements') continue
                push({ key, value, source: 'summary' })
            } else if (typeof value === 'string') {
                push({ key, value, source: 'summary' })
            }
        }
    }

    return metrics.sort((a, b) => priorityIndex(a.key) - priorityIndex(b.key) || a.key.localeCompare(b.key))
}

// ─── Single metric card ───────────────────────────────────────────────────────
function MetricCard({ metricKey, value, index, metric, config = {} }) {
    const colors = METRIC_COLORS[metricKey] || METRIC_COLORS.default
    const meta   = METRIC_META[metricKey]

    const metricConfig  = config[metricKey] || {}
    const displayName   = metricConfig.displayName || metric.displayKey || meta?.displayName || metricKey.replace(/_/g, ' ')
    const unit          = meta?.unit || null

    let formattedValue
    if (typeof value === 'number') {
        const displayValue = meta?.multiplier ? value * meta.multiplier : value
        formattedValue = meta ? formatNumber(displayValue, meta.decimals) : displayValue.toLocaleString()
    } else if (typeof value === 'string') {
        formattedValue = toTitleCase(value)
    } else {
        formattedValue = String(value)
    }

    const isText = typeof value === 'string'

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05 }}
            className="glass-card px-2 py-1"
        >
            <p className="text-[var(--speckle-foreground-2)] text-[10px] truncate leading-none mb-0.5">{displayName}</p>
            <div className="flex items-baseline gap-1 min-w-0">
                <p className={`font-bold ${colors.text} truncate ${isText ? 'text-xs' : 'text-sm'} leading-none`}>
                    {formattedValue}
                </p>
                {unit && (
                    <span className="text-[10px] text-[var(--speckle-foreground-3)] flex-shrink-0">{unit}</span>
                )}
            </div>
        </motion.div>
    )
}

// ─── Main component ───────────────────────────────────────────────────────────
export function AdaptiveMetrics({ data, horizontal = false, strip = false }) {
    const [metricsConfig, setMetricsConfig] = useState(() => {
        try {
            const stored = localStorage.getItem('dashboard-metrics-config')
            return stored ? JSON.parse(stored) : {}
        } catch {
            return {}
        }
    })

    useEffect(() => {
        localStorage.setItem('dashboard-metrics-config', JSON.stringify(metricsConfig))
    }, [metricsConfig])

    const allMetrics = discoverMetrics(data)

    const visibleMetrics = allMetrics.filter(m => {
        const cfg = metricsConfig[m.key]
        return cfg?.visible !== false
    })

    if (allMetrics.length === 0) return null

    if (strip) {
        return (
            <div className="flex items-center gap-x-5 gap-y-0 flex-wrap">
                {visibleMetrics.map((metric) => {
                    const colors = METRIC_COLORS[metric.key] || METRIC_COLORS.default
                    const meta   = METRIC_META[metric.key]
                    const metricConfig = metricsConfig[metric.key] || {}
                    const displayName  = metricConfig.displayName || meta?.displayName || metric.key.replace(/_/g, ' ')
                    const unit = meta?.unit || null
                    let formattedValue
                    if (typeof metric.value === 'number') {
                        const displayValue = meta?.multiplier ? metric.value * meta.multiplier : metric.value
                        formattedValue = meta ? formatNumber(displayValue, meta.decimals) : displayValue.toLocaleString()
                    } else {
                        formattedValue = toTitleCase(String(metric.value))
                    }
                    return (
                        <div key={metric.key} className="flex flex-col leading-none">
                            <span className="text-[9px] text-[var(--speckle-foreground-2)] uppercase tracking-wide whitespace-nowrap">{displayName}</span>
                            <div className="flex items-baseline gap-0.5 mt-0.5">
                                <span className={`text-lg font-bold ${colors.text} leading-none`}>{formattedValue}</span>
                                {unit && <span className="text-[10px] text-[var(--speckle-foreground-3)]">{unit}</span>}
                            </div>
                        </div>
                    )
                })}
                <MetricsConfig
                    metrics={allMetrics}
                    currentConfig={metricsConfig}
                    onConfigChange={setMetricsConfig}
                />
            </div>
        )
    }

    if (horizontal) {
        return (
            <div className="flex items-center gap-1.5 flex-wrap pb-1.5">
                {visibleMetrics.map((metric, index) => (
                    <MetricCard
                        key={metric.key}
                        metricKey={metric.key}
                        metric={metric}
                        value={metric.value}
                        index={index}
                        config={metricsConfig}
                    />
                ))}
                <MetricsConfig
                    metrics={allMetrics}
                    currentConfig={metricsConfig}
                    onConfigChange={setMetricsConfig}
                />
            </div>
        )
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-zinc-400">Metrics</h3>
                <MetricsConfig
                    metrics={allMetrics}
                    currentConfig={metricsConfig}
                    onConfigChange={setMetricsConfig}
                />
            </div>

            <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
                {visibleMetrics.map((metric, index) => (
                    <MetricCard
                        key={metric.key}
                        metricKey={metric.key}
                        metric={metric}
                        value={metric.value}
                        index={index}
                        config={metricsConfig}
                    />
                ))}
            </div>
        </div>
    )
}

// ─── Active filter indicator ──────────────────────────────────────────────────
export function HighlightIndicator({ field, value, onClear }) {
    if (!field || !value) return null

    const label = field.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="glass-card border-cyan-500/50"
        >
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-cyan-500/20 flex items-center justify-center flex-shrink-0">
                        <Tag className="w-5 h-5 text-cyan-500" />
                    </div>
                    <div className="min-w-0">
                        <p className="text-xs text-zinc-500">Filtering by {label}</p>
                        <p className="text-sm font-bold text-cyan-500 truncate">{value}</p>
                    </div>
                </div>
                {onClear && (
                    <button
                        onClick={onClear}
                        className="text-xs text-zinc-500 hover:text-white px-2 py-1 rounded hover:bg-white/10"
                    >
                        Clear
                    </button>
                )}
            </div>
        </motion.div>
    )
}
