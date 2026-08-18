import { useState, useMemo, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Table, Settings } from 'lucide-react'
import PropertySelect from './PropertySelect'

// Fixed structural fields always available from the normalizer
const FIXED_GROUP_OPTIONS = [
    { label: 'Category',      value: 'category' },
    { label: 'IFC Class',     value: 'ifc_class' },
    { label: 'Storey / Level', value: 'storey' },
    { label: 'Material',      value: 'material' },
    { label: 'Profile',       value: 'profile' },
    { label: 'Grade',         value: 'grade' },
    { label: 'Speckle Type',  value: 'speckle_type' },
]

const VALUE_OPTIONS = [
    { label: 'Count',          value: 'count' },
    { label: 'Volume (m³)',    value: 'volume_m3' },
    { label: 'Area (m²)',      value: 'area_m2' },
]

// Read a field from an element.  Supports:
//   'category'        → el.category
//   'param:KEY'       → el.params?.['KEY']
function getField(el, field) {
    if (field.startsWith('param:')) {
        const key = field.slice(6)
        return el.params?.[key] ?? null
    }
    return el[field] ?? null
}

export default function PivotTableWidget({ fullData, paramKeys = [] }) {
    const [rowField, setRowField]       = useState('category')
    const [valueField, setValueField]   = useState('count')
    const [showControls, setShowControls] = useState(false)
    // The Controls panel needs overflow-hidden while framer-motion animates
    // its height (0 -> auto), otherwise content flashes outside its bounds
    // mid-animation. But left on permanently, it also clips the Group By
    // PropertySelect's own dropdown, which must render below the panel's
    // fixed height once expanded — no dropdown ever became visible. Switch
    // to visible only once the expand animation has actually finished, and
    // back to hidden immediately on collapse so the collapse animation still
    // looks clean.
    const [controlsExpanded, setControlsExpanded] = useState(false)
    useEffect(() => {
        if (!showControls) setControlsExpanded(false)
    }, [showControls])

    // Dynamic param options derived from backend key discovery. The
    // high-coverage/show-all filter and search live inside PropertySelect
    // itself now, so this is just the full list, unfiltered.
    const paramOptions = useMemo(() => paramKeys.map(p => ({
        label: p.key,
        value: `param:${p.key}`,
        coverage: p.coverage_pct,
    })), [paramKeys])

    // Memoized so useEffect below can use it as a stable dep
    const groupOptions = useMemo(
        () => [...FIXED_GROUP_OPTIONS, ...paramOptions],
        [paramOptions]
    )

    // Reset rowField to a safe default if the selected option no longer
    // exists at all (e.g. a different model was loaded).
    useEffect(() => {
        if (!groupOptions.some(o => o.value === rowField)) {
            setRowField('category')
        }
    }, [groupOptions, rowField])

    const pivotData = useMemo(() => {
        if (!fullData?.elements) return []
        const groups = {}
        for (const el of fullData.elements) {
            let key = getField(el, rowField)
            if (key === null || key === undefined || key === '') key = 'Unknown'
            if (typeof key !== 'string') key = String(key)

            if (!groups[key]) groups[key] = { name: key, count: 0, value: 0, hasValue: false }
            groups[key].count += 1

            if (valueField !== 'count') {
                const v = el[valueField]
                if (typeof v === 'number' && v > 0) {
                    groups[key].value += v
                    groups[key].hasValue = true
                }
            }
        }

        return Object.values(groups).sort((a, b) => {
            const va = valueField === 'count' ? a.count : a.value
            const vb = valueField === 'count' ? b.count : b.value
            return vb - va
        })
    }, [fullData, rowField, valueField])

    const totalValue = useMemo(
        () => pivotData.reduce((s, r) => s + (valueField === 'count' ? r.count : r.value), 0),
        [pivotData, valueField]
    )

    // True when the selected value field has no data in the model at all
    const noValueData = valueField !== 'count' && pivotData.length > 0 && !pivotData.some(r => r.hasValue)

    const fmt = (val) =>
        valueField === 'count'
            ? val.toLocaleString()
            : val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    const currentGroupLabel = groupOptions.find(o => o.value === rowField)?.label ?? rowField
    const currentValueLabel = VALUE_OPTIONS.find(o => o.value === valueField)?.label ?? valueField

    if (!fullData) {
        return (
            <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
                Waiting for data…
            </div>
        )
    }

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Toolbar */}
            <div className="flex items-center justify-between p-3 border-b border-white/5 bg-zinc-900/30">
                <div className="flex items-center gap-2 min-w-0">
                    <Table className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span className="text-xs font-medium text-zinc-200 truncate">
                        {currentGroupLabel} · {currentValueLabel}
                    </span>
                </div>
                <button
                    onClick={() => setShowControls(!showControls)}
                    aria-label={showControls ? 'Hide pivot configuration' : 'Configure pivot table'}
                    aria-expanded={showControls}
                    className={`p-1.5 rounded transition-colors shrink-0 ${showControls ? 'bg-emerald-500/20 text-emerald-400' : 'hover:bg-white/5 text-zinc-400'}`}
                    title="Configure Pivot"
                >
                    <Settings className="w-4 h-4" />
                </button>
            </div>

            {/* Controls */}
            <AnimatePresence>
                {showControls && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        onAnimationComplete={() => { if (showControls) setControlsExpanded(true) }}
                        className="border-b border-white/5 bg-zinc-800/50"
                        style={{ overflow: controlsExpanded ? 'visible' : 'hidden' }}
                    >
                        <div className="p-3 space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1 block">Group By</label>
                                    <PropertySelect
                                        options={groupOptions}
                                        value={rowField}
                                        onChange={setRowField}
                                        defaultShowAll={false}
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1 block">Value</label>
                                    <select
                                        value={valueField}
                                        onChange={e => setValueField(e.target.value)}
                                        className="w-full bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-emerald-500"
                                    >
                                        {VALUE_OPTIONS.map(o => (
                                            <option key={o.value} value={o.value}>{o.label}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Table */}
            <div className="flex-1 overflow-auto">
                <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-zinc-900 z-10 text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                        <tr>
                            <th className="px-4 py-2 border-b border-white/10">Group</th>
                            <th className="px-4 py-2 border-b border-white/10 text-right">{currentValueLabel}</th>
                            <th className="px-4 py-2 border-b border-white/10 text-right w-16">%</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                        {pivotData.map((row) => {
                            const val = valueField === 'count' ? row.count : row.value
                            const pct = totalValue > 0 ? (val / totalValue) * 100 : 0
                            return (
                                <tr key={row.name} className="hover:bg-white/5 transition-colors">
                                    <td className="px-4 py-2 text-zinc-300 truncate max-w-[160px]" title={row.name}>
                                        {row.name}
                                    </td>
                                    <td className="px-4 py-2 text-right font-mono text-zinc-400">
                                        {noValueData
                                            ? <span className="text-zinc-600 text-xs">N/A</span>
                                            : fmt(val)
                                        }
                                    </td>
                                    <td className="px-4 py-2 text-right text-xs text-zinc-500">
                                        {noValueData ? '—' : `${pct.toFixed(1)}%`}
                                    </td>
                                </tr>
                            )
                        })}
                        {pivotData.length === 0 && (
                            <tr>
                                <td colSpan={3} className="px-4 py-8 text-center text-zinc-500 italic">
                                    No data for this grouping
                                </td>
                            </tr>
                        )}
                    </tbody>
                    <tfoot className="sticky bottom-0 bg-zinc-900 border-t border-white/10 text-xs font-medium">
                        <tr>
                            <td className="px-4 py-2 text-zinc-400">Total · {pivotData.length} groups</td>
                            <td className="px-4 py-2 text-right text-emerald-500 font-mono">
                                {noValueData
                                    ? <span className="text-zinc-600">No {currentValueLabel} data</span>
                                    : fmt(totalValue)
                                }
                            </td>
                            <td />
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    )
}
