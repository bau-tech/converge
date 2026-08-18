import { useState, useMemo, useEffect, useRef } from 'react'
import { ChevronDown, Search } from 'lucide-react'

// Select constrained to one of `options` (unlike a free-typed combobox) with
// a search box to filter a long, dynamically discovered property list — a
// model's BIM parameters can run into the hundreds, and a plain <select>
// gives no way to find one by typing. Shared by ValidationWidget,
// FilterWidget, and PivotTableWidget so the picker behaves identically
// everywhere a user chooses a property/parameter to work with.
//
// options: [{ label, value, disabled?, coverage? }] — coverage (0-100) is
// optional; only options that carry it participate in the high-coverage
// filter below (fixed/structural fields with no coverage concept, e.g.
// FIXED_GROUP_OPTIONS, always stay visible). defaultShowAll controls the
// picker's initial state per caller, so adding this filter never hides
// options a widget was already showing by default (Validation/Filter show
// everything today; Pivot already hid low-coverage params by default).
export default function PropertySelect({
    options,
    value,
    onChange,
    coverageThreshold = 10,
    defaultShowAll = true,
    placeholder = 'Select property...',
}) {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [showAll, setShowAll] = useState(defaultShowAll)
    const containerRef = useRef(null)

    // Divider rows (disabled, used to group the plain <select> this replaces)
    // don't make sense as clickable search results — drop them here.
    const selectableOptions = useMemo(() => options.filter(o => !o.disabled), [options])
    const selected = selectableOptions.find(o => o.value === value)

    const hasCoverageData = useMemo(
        () => selectableOptions.some(o => typeof o.coverage === 'number'),
        [selectableOptions]
    )

    const coverageFiltered = useMemo(() => {
        if (!hasCoverageData || showAll) return selectableOptions
        return selectableOptions.filter(o => typeof o.coverage !== 'number' || o.coverage >= coverageThreshold)
    }, [selectableOptions, showAll, hasCoverageData, coverageThreshold])

    const filtered = useMemo(() => {
        if (!query.trim()) return coverageFiltered
        const needle = query.toLowerCase()
        return coverageFiltered.filter(o =>
            o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle)
        )
    }, [coverageFiltered, query])

    useEffect(() => {
        if (!open) return
        const handleOutside = (e) => {
            if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', handleOutside)
        return () => document.removeEventListener('mousedown', handleOutside)
    }, [open])

    const commit = (opt) => {
        onChange(opt.value)
        setOpen(false)
        setQuery('')
    }

    return (
        <div className="relative w-full" ref={containerRef}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center justify-between gap-2 bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-300 hover:border-white/20 transition-colors"
            >
                <span className="truncate">{selected?.label || placeholder}</span>
                <ChevronDown className={`w-3 h-3 text-zinc-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div className="absolute z-20 mt-1 w-full min-w-[220px] rounded-lg border border-white/10 bg-zinc-900 shadow-xl overflow-hidden">
                    <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-white/5">
                        <Search className="w-3 h-3 text-zinc-500 shrink-0" />
                        <input
                            autoFocus
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Escape') setOpen(false)
                                if (e.key === 'Enter' && filtered[0]) commit(filtered[0])
                            }}
                            placeholder="Search properties..."
                            className="w-full bg-transparent text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none"
                        />
                    </div>
                    {hasCoverageData && (
                        <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-white/5 text-[10px] text-zinc-500">
                            <span>{coverageFiltered.length} of {selectableOptions.length} shown</span>
                            <button
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => setShowAll(v => !v)}
                                className="text-emerald-400 hover:text-emerald-300 underline shrink-0"
                            >
                                {showAll ? `Show high-coverage only (≥${coverageThreshold}%)` : 'Show all parameters'}
                            </button>
                        </div>
                    )}
                    <div className="max-h-48 overflow-y-auto custom-scrollbar">
                        {filtered.length === 0 ? (
                            <div className="px-2 py-2 text-[11px] text-zinc-500 text-center">No matches</div>
                        ) : (
                            filtered.map(opt => (
                                <div
                                    key={opt.value}
                                    onMouseDown={(e) => { e.preventDefault(); commit(opt) }}
                                    className={`px-2 py-1.5 text-xs cursor-pointer flex items-center justify-between gap-2 ${
                                        opt.value === value ? 'bg-cyan-500/20 text-cyan-400' : 'text-zinc-300 hover:bg-white/5'
                                    }`}
                                >
                                    <span className="truncate">{opt.label}</span>
                                    {typeof opt.coverage === 'number' && (
                                        <span className="text-[10px] text-zinc-500 shrink-0">{opt.coverage}%</span>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
