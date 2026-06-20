import { useState, useEffect } from 'react'
import EChart from './EChart'
import { baseOption, categoryAxisStyle, valueAxisStyle } from '../lib/echartsTheme'
import { Loader2, AlertCircle } from 'lucide-react'

const BAR_COLORS = ['#10B981', '#34D399', '#6EE7B7', '#A7F3D0', '#059669', '#047857', '#065F46']
const COVERAGE_COLORS = { high: '#10B981', mid: '#F59E0B', low: '#EF4444' }

// Format a number for display: abbreviates large values, uses locale separators
function fmt(n, decimals = 1) {
    if (n === null || n === undefined) return '—'
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(decimals)}M`
    if (n >= 1_000)     return `${(n / 1_000).toFixed(decimals)}k`
    return n.toFixed(decimals)
}

// Format for hover tooltip — locale-aware with thousands separators
function fmtHover(n, unit) {
    if (n === null || n === undefined) return '—'
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`
}

const METRICS = [
    { id: 'volume_m3', label: 'Volume', unit: 'm³', color: 'text-emerald-400' },
    { id: 'area_m2',   label: 'Area',   unit: 'm²', color: 'text-sky-400'     },
    { id: 'count',     label: 'Count',  unit: 'el', color: 'text-zinc-300'    },
]

function BarChart({ rows, metric, darkMode }) {
    const { id: valueKey, unit, label } = metric

    const sorted = [...rows]
        .filter(r => (r[valueKey] ?? 0) > 0)
        .sort((a, b) => (b[valueKey] ?? 0) - (a[valueKey] ?? 0))
        .slice(0, 20)

    if (!sorted.length) return (
        <div className="flex items-center justify-center h-48 text-zinc-500 text-sm">
            No {label.toLowerCase()} data available for this grouping
        </div>
    )

    const vals   = sorted.map(r => r[valueKey] ?? 0)
    const labels = sorted.map(r => r.group)
    const colors = sorted.map((_, i) => BAR_COLORS[i % BAR_COLORS.length])
    const hovers = vals.map(v => fmtHover(v, unit))
    const labelColor = darkMode ? '#e4e4e7' : '#000000'

    return (
        <EChart
            option={{
                ...baseOption({
                    tooltipFormatter: (params) => `<b>${params.name}</b><br/>${label}: ${hovers[params.dataIndex]}`,
                    darkMode,
                }),
                grid: { left: 10, right: 16, top: 10, bottom: 36, containLabel: true },
                xAxis: valueAxisStyle({ darkMode }),
                yAxis: categoryAxisStyle({ data: labels, darkMode }),
                series: [{
                    type: 'bar',
                    data: vals.map((v, i) => ({ value: v, itemStyle: { color: colors[i] } })),
                    label: { show: true, position: 'right', color: labelColor, formatter: (params) => fmt(params.value) },
                }],
            }}
            style={{ width: '100%', height: 340 }}
        />
    )
}

function CoverageChart({ rows, darkMode }) {
    const sorted = [...rows]
        .filter(r => r.element_count > 0)
        .map(r => ({
            ...r,
            pct: Math.round((r.elements_with_geometry / r.element_count) * 100),
        }))
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 20)

    if (!sorted.length) return (
        <div className="flex items-center justify-center h-48 text-zinc-500 text-sm">
            No coverage data
        </div>
    )

    const colors = sorted.map(r =>
        r.pct >= 80 ? COVERAGE_COLORS.high : r.pct >= 40 ? COVERAGE_COLORS.mid : COVERAGE_COLORS.low
    )
    const labels = sorted.map(r => r.group)
    const hovers = sorted.map(r => `${r.elements_with_geometry} / ${r.element_count} elements`)
    const labelColor = darkMode ? '#e4e4e7' : '#000000'

    return (
        <EChart
            option={{
                ...baseOption({
                    tooltipFormatter: (params) => `<b>${params.name}</b><br/>Coverage: ${params.value}%<br/>${hovers[params.dataIndex]}`,
                    darkMode,
                }),
                grid: { left: 10, right: 16, top: 10, bottom: 36, containLabel: true },
                xAxis: valueAxisStyle({ max: 100, axisLabel: { formatter: '{value}%' }, darkMode }),
                yAxis: categoryAxisStyle({ data: labels, darkMode }),
                series: [{
                    type: 'bar',
                    data: sorted.map((r, i) => ({ value: r.pct, itemStyle: { color: colors[i] } })),
                    label: { show: true, position: 'right', color: labelColor, formatter: '{c}%' },
                }],
            }}
            style={{ width: '100%', height: 340 }}
        />
    )
}

function StatBadge({ label, value, unit, color }) {
    return (
        <div className="rounded-lg px-3 py-2 bg-white/5 border border-white/10">
            <div className="text-xs text-zinc-400">{label}</div>
            <div className={`text-base font-semibold ${color}`}>
                {fmt(value)} <span className="text-xs font-normal text-zinc-400">{unit}</span>
            </div>
        </div>
    )
}

const TABS = [
    { id: 'type',     label: 'By Type'  },
    { id: 'floor',    label: 'By Floor' },
    { id: 'coverage', label: 'Coverage' },
]

export default function QuantityWidget({ normalizerModelId, normalizerUrl, darkMode = true }) {
    const [tab, setTab]         = useState('type')
    const [metric, setMetric]   = useState(METRICS[0])   // volume by default
    const [byType, setByType]   = useState(null)
    const [byFloor, setByFloor] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError]     = useState(null)

    const base = (normalizerUrl || '').replace(/\/$/, '')

    useEffect(() => {
        if (!normalizerModelId) return

        // Reset stale data immediately so the old model's numbers aren't
        // briefly visible while the new model fetches.
        setByType(null)
        setByFloor(null)
        setError(null)
        setLoading(true)

        const ctrl = new AbortController()
        const { signal } = ctrl

        Promise.all([
            fetch(`${base}/models/${normalizerModelId}/quantities?group_by=ifc_class`, { signal })
                .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)),
            fetch(`${base}/models/${normalizerModelId}/quantities?group_by=storey`, { signal })
                .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)),
        ])
            .then(([t, f]) => { setByType(t); setByFloor(f) })
            .catch(e => {
                if (e?.name === 'AbortError') return
                setError(e instanceof Error ? e.message : String(e))
            })
            .finally(() => setLoading(false))

        return () => ctrl.abort()
    }, [normalizerModelId, base])

    if (!normalizerModelId) return (
        <div className="flex items-center justify-center h-40 text-zinc-500 text-sm">
            Load a model to see quantities.
        </div>
    )

    if (loading) return (
        <div className="flex items-center justify-center h-40 gap-2 text-zinc-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading quantities…</span>
        </div>
    )

    if (error) return (
        <div className="flex items-center gap-2 p-4 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
        </div>
    )

    if (!byType) return null

    return (
        <div className="flex flex-col gap-3 p-3">
            {/* KPI row */}
            <div className="grid grid-cols-3 gap-2">
                <StatBadge label="Elements" value={byType.total_elements}  unit="total" color="text-zinc-100" />
                <StatBadge label="Volume"   value={byType.total_volume_m3} unit="m³"    color="text-emerald-400" />
                <StatBadge label="Area"     value={byType.total_area_m2}   unit="m²"    color="text-sky-400" />
            </div>

            {/* Tab bar + metric selector */}
            <div className="flex items-end justify-between border-b border-white/10">
                <div className="flex gap-1">
                    {TABS.map(t => (
                        <button
                            key={t.id}
                            onClick={() => setTab(t.id)}
                            className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                                tab === t.id
                                    ? 'bg-white/10 text-[var(--speckle-foreground)] border-b-2 border-emerald-400'
                                    : 'text-zinc-400 hover:text-zinc-200'
                            }`}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>

                {/* Metric toggle — only visible for data tabs (not coverage) */}
                {tab !== 'coverage' && (
                    <div className="flex gap-1 pb-1">
                        {METRICS.map(m => (
                            <button
                                key={m.id}
                                onClick={() => setMetric(m)}
                                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                                    metric.id === m.id
                                        ? `${m.color} bg-white/10`
                                        : 'text-zinc-600 hover:text-zinc-400'
                                }`}
                            >
                                {m.unit}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Chart area */}
            {tab === 'type' && (
                <BarChart rows={byType.rows || []} metric={metric} darkMode={darkMode} />
            )}
            {tab === 'floor' && (
                <BarChart rows={byFloor?.rows || []} metric={metric} darkMode={darkMode} />
            )}
            {tab === 'coverage' && (
                <>
                    <CoverageChart rows={byType.rows || []} darkMode={darkMode} />
                    <div className="flex gap-3 text-xs text-zinc-500 px-1">
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500 inline-block" /> ≥ 80%</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500 inline-block" /> 40–79%</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500 inline-block" /> &lt; 40%</span>
                        <span className="ml-auto text-zinc-600">Hover for element counts</span>
                    </div>
                </>
            )}
        </div>
    )
}
