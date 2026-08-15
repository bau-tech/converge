import { useState, useMemo, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle, AlertCircle, Plus, Trash2, Settings, Play, ChevronDown, Check, X, Search } from 'lucide-react'
import EChart from './EChart'
import { baseOption } from '../lib/echartsTheme'
import { discoverProperties, discoverNumericProperties, aggregateProperty } from '../utils/propertyScanner'

const DEFAULT_RULES = [{ id: 1, property: 'category', operator: 'is_defined', value: '' }]

function rulesKey(widgetId) {
    return `validation-rules-${widgetId || 'default'}`
}

function logicKey(widgetId) {
    return `validation-logic-${widgetId || 'default'}`
}

// Select constrained to one of `options` (unlike SearchableCombobox, which
// allows free-typed values) with a search box to filter a long, dynamically
// discovered property list — propertyOptions below can run into the dozens
// once numeric/string properties from the actual model are included, and a
// plain <select> gives no way to find one by typing.
function PropertySelect({ options, value, onChange }) {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const containerRef = useRef(null)

    // Divider rows (disabled, used to group the plain <select> this replaces)
    // don't make sense as clickable search results — drop them here.
    const selectableOptions = useMemo(() => options.filter(o => !o.disabled), [options])
    const selected = selectableOptions.find(o => o.value === value)

    const filtered = useMemo(() => {
        if (!query.trim()) return selectableOptions
        const needle = query.toLowerCase()
        return selectableOptions.filter(o =>
            o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle)
        )
    }, [selectableOptions, query])

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
        <div className="relative" ref={containerRef}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center justify-between gap-2 bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-300 hover:border-white/20 transition-colors"
            >
                <span className="truncate">{selected?.label || 'Select property...'}</span>
                <ChevronDown className={`w-3 h-3 text-zinc-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div className="absolute z-20 mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 shadow-xl overflow-hidden">
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
                    <div className="max-h-48 overflow-y-auto custom-scrollbar">
                        {filtered.length === 0 ? (
                            <div className="px-2 py-2 text-[11px] text-zinc-500 text-center">No matches</div>
                        ) : (
                            filtered.map(opt => (
                                <div
                                    key={opt.value}
                                    onMouseDown={(e) => { e.preventDefault(); commit(opt) }}
                                    className={`px-2 py-1.5 text-xs cursor-pointer truncate ${
                                        opt.value === value ? 'bg-cyan-500/20 text-cyan-400' : 'text-zinc-300 hover:bg-white/5'
                                    }`}
                                >
                                    {opt.label}
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}


// Value input for equals/not_equals/contains — still a free-typed input
// (some properties have more unique values than are worth listing, and a
// typo-tolerant "contains" search benefits from typing anyway) but backed by
// a dropdown of every value actually present in the model for the currently
// selected property, so the common case is "pick from a list" instead of
// guessing spelling/casing blind. Sourced from aggregateProperty, which scans
// every element (unlike discoverProperties' 500-element sample), so rare
// values used by only a handful of elements still show up.
function ValueCombobox({ options, value, onChange, placeholder }) {
    const [open, setOpen] = useState(false)
    const containerRef = useRef(null)

    const filtered = useMemo(() => {
        if (!value) return options
        const needle = value.toLowerCase()
        return options.filter(o => o.label.toLowerCase().includes(needle))
    }, [options, value])

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
    }

    return (
        <div className="relative flex-1" ref={containerRef}>
            <input
                type="text"
                value={value}
                onChange={(e) => { onChange(e.target.value); setOpen(true) }}
                onFocus={() => setOpen(true)}
                placeholder={placeholder}
                className="w-full bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-300 focus:border-cyan-500 focus:outline-none"
            />
            {open && options.length > 0 && (
                <div className="absolute z-20 mt-1 w-full max-h-48 overflow-y-auto custom-scrollbar rounded-lg border border-white/10 bg-zinc-900 shadow-xl">
                    {filtered.length === 0 ? (
                        <div className="px-2 py-2 text-[11px] text-zinc-500 text-center truncate">No matches — using "{value}"</div>
                    ) : (
                        filtered.map(opt => (
                            <div
                                key={opt.value}
                                onMouseDown={(e) => { e.preventDefault(); commit(opt) }}
                                className={`px-2 py-1.5 text-xs cursor-pointer truncate flex items-center justify-between gap-2 ${
                                    opt.value === value ? 'bg-cyan-500/20 text-cyan-400' : 'text-zinc-300 hover:bg-white/5'
                                }`}
                            >
                                <span className="truncate">{opt.label}</span>
                                <span className="text-[10px] text-zinc-500 shrink-0">{opt.count}</span>
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    )
}

// One rule's editor row — its own component (rather than inlined in the
// rules.map() below) so its value-options useMemo can key off just this
// rule's property/operator without violating hooks-must-run-unconditionally
// when the rules array itself changes length.
function RuleRow({ rule, idx, fullData, propertyOptions, operatorOptions, noValueOperators, canRemove, onUpdate, onRemove }) {
    // Only worth computing/showing for the operators that compare against a
    // discrete value — gt/lt already use a plain number input, and is_defined/
    // is_not_defined have no value field at all.
    const valueOptions = useMemo(() => {
        if (!['equals', 'not_equals', 'contains'].includes(rule.operator)) return []
        const counts = aggregateProperty(fullData, rule.property)
        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 200)
            .map(([val, count]) => ({ label: val, value: val, count }))
    }, [fullData, rule.property, rule.operator])

    return (
        <div className="glass-card p-3 rounded-lg border border-white/5 space-y-2 relative group">
            <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                    onClick={onRemove}
                    className="p-1 hover:bg-red-500/20 text-zinc-500 hover:text-red-400 rounded transition-colors"
                    disabled={!canRemove}
                >
                    <Trash2 className="w-3 h-3" />
                </button>
            </div>

            <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
                <span className="font-mono bg-white/5 px-1.5 py-0.5 rounded">Rule #{idx + 1}</span>
            </div>

            <div className="grid grid-cols-1 gap-2">
                <PropertySelect
                    options={propertyOptions}
                    value={rule.property}
                    onChange={(val) => onUpdate('property', val)}
                />

                <div className="flex gap-2">
                    <select
                        value={rule.operator}
                        onChange={(e) => onUpdate('operator', e.target.value)}
                        className="flex-1 bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-300"
                    >
                        {operatorOptions.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                    </select>

                    {!noValueOperators.has(rule.operator) && (
                        valueOptions.length > 0 ? (
                            <ValueCombobox
                                options={valueOptions}
                                value={rule.value}
                                onChange={(val) => onUpdate('value', val)}
                                placeholder="Value..."
                            />
                        ) : (
                            <input
                                type={['gt', 'lt'].includes(rule.operator) ? 'number' : 'text'}
                                value={rule.value}
                                onChange={(e) => onUpdate('value', e.target.value)}
                                placeholder="Value..."
                                className="flex-1 bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-300 focus:border-cyan-500 focus:outline-none"
                            />
                        )
                    )}
                </div>
            </div>
        </div>
    )
}

// Edit-rules / view-results toggle — rendered by the caller (App.jsx) inside
// the panel's own title bar via GridPanel's headerActions, alongside the
// panel's close button, instead of ValidationWidget drawing a second header
// row just to hold this one button. isEditing/onToggleEditing are lifted to
// the caller (see App.jsx's resultsViewWidgets) so this can be rendered
// outside ValidationWidget's own component tree while still controlling it.
export function ValidationModeToggle({ isEditing, onToggleEditing }) {
    return (
        <button
            onClick={onToggleEditing}
            className={`p-1.5 rounded transition-colors ${isEditing ? 'bg-cyan-500/20 text-cyan-400' : 'hover:bg-white/5 text-zinc-400'}`}
            title={isEditing ? "View Results" : "Edit Rules"}
        >
            {isEditing ? <Play className="w-3.5 h-3.5" fill="currentColor" /> : <Settings className="w-3.5 h-3.5" />}
        </button>
    )
}

export default function ValidationWidget({ widgetId, fullData, title = "New Validation", onUpdateTitle, isEditing, onToggleEditing, onFilterElements, onHighlightElements, darkMode = true }) {
    const [name, setName] = useState(title)
    const [rules, setRules] = useState(() => {
        try {
            const saved = localStorage.getItem(rulesKey(widgetId))
            return saved ? JSON.parse(saved) : DEFAULT_RULES
        } catch { return DEFAULT_RULES }
    })
    const [logicMode, setLogicMode] = useState(() => {
        try {
            return localStorage.getItem(logicKey(widgetId)) === 'OR' ? 'OR' : 'AND'
        } catch { return 'AND' }
    })
    const [activeSlice, setActiveSlice] = useState(null)

    // Persist rules whenever they change
    useEffect(() => {
        try { localStorage.setItem(rulesKey(widgetId), JSON.stringify(rules)) } catch {}
    }, [rules, widgetId])

    // Persist AND/OR mode whenever it changes
    useEffect(() => {
        try { localStorage.setItem(logicKey(widgetId), logicMode) } catch {}
    }, [logicMode, widgetId])

    // Update parent title when local name changes
    useEffect(() => {
        if (onUpdateTitle && name !== title) {
            onUpdateTitle(name)
        }
    }, [name, onUpdateTitle, title])

    // Discover properties dynamically
    const propertyOptions = useMemo(() => {
        if (!fullData) return []

        // minUniqueValues/minCount: 1, not the chart-oriented default of 2 —
        // a validation rule like "fire_rating is_defined" is exactly as
        // useful when every element that has the property shares one value
        // (e.g. every fire-rated wall being the same "F 120" class) as when
        // values vary, unlike a chart grouping which needs variation to mean
        // anything. Without this, such properties don't appear as an option
        // at all, even though the underlying data is real.
        const stringProps = discoverProperties(fullData, { minUniqueValues: 1 })
        const numericProps = discoverNumericProperties(fullData, { minCount: 1 })

        // Combine and format for select options
        const options = [
            // Standard/Common Fields
            { label: 'Category', value: 'category' },
            { label: 'Family', value: 'family' },
            { label: 'Type', value: 'type' },
            { label: 'Level', value: 'level.name' },
            { label: 'Speckle Type', value: 'speckle_type' },

            // Divider
            { label: '--- Dimensions ---', value: '', disabled: true },

            // Numeric Properties
            ...numericProps.map(p => ({
                label: p.name,
                value: p.path
            })),

            // Divider
            { label: '--- Attributes ---', value: '', disabled: true },

            // String Properties
            ...stringProps.map(p => ({
                label: p.name,
                value: p.path
            }))
        ]

        // Keep disabled separator rows; deduplicate real options by value
        return options.filter((opt, index, self) =>
            opt.disabled ||
            (opt.value && index === self.findIndex(t => t.value === opt.value))
        )
    }, [fullData])


    const operatorOptions = [
        { label: 'Is Defined',     value: 'is_defined'     },
        { label: 'Is Not Defined', value: 'is_not_defined'  },
        { label: 'Equals',         value: 'equals'          },
        { label: 'Not Equals',     value: 'not_equals'      },
        { label: 'Contains',       value: 'contains'        },
        { label: 'Greater Than',   value: 'gt'              },
        { label: 'Less Than',      value: 'lt'              },
    ]

    // Value input not needed for these operators
    const noValueOperators = new Set(['is_defined', 'is_not_defined'])

    // Helper to get nested property safely
    const getNested = (obj, path) => {
        if (!path) return undefined
        return path.split('.').reduce((acc, part) => acc && acc[part], obj)
    }

    const checkRule = (val, rule) => {
        const missing = val === undefined || val === null || val === ''
        switch (rule.operator) {
            case 'is_defined':     return !missing
            case 'is_not_defined': return missing
            // All remaining operators require a defined value
            default: {
                if (missing) return false
                switch (rule.operator) {
                    case 'equals':
                        return String(val) === String(rule.value)
                    case 'not_equals':
                        return String(val) !== String(rule.value)
                    case 'contains':
                        // Empty filter value → skip (matches nothing meaningful)
                        if (!rule.value) return false
                        return String(val).toLowerCase().includes(String(rule.value).toLowerCase())
                    case 'gt':
                        return Number(val) > Number(rule.value)
                    case 'lt':
                        return Number(val) < Number(rule.value)
                    default:
                        return false
                }
            }
        }
    }

    const results = useMemo(() => {
        if (!fullData?.elements) return { passed: 0, failed: 0, total: 0, passPct: 0, passedIds: [], failedIds: [] }

        let passed = 0
        let failed = 0
        const passedIds = []
        const failedIds = []

        fullData.elements.forEach(el => {
            const ruleResults = rules.map(rule => checkRule(getNested(el, rule.property), rule))
            // AND: must pass every rule. OR: must pass at least one rule.
            const elementPassed = logicMode === 'OR' ? ruleResults.some(Boolean) : ruleResults.every(Boolean)
            const id = el.speckle_id || el.id

            if (elementPassed) {
                passed++
                if (id) passedIds.push(id)
            } else {
                failed++
                if (id) failedIds.push(id)
            }
        })

        const total = passed + failed
        return {
            passed,
            failed,
            total,
            passPct: total > 0 ? (passed / total) * 100 : 0,
            passedIds,
            failedIds,
        }
    }, [fullData, rules, logicMode])

    // Rules changed — if a slice filter was active, its element IDs are now stale, clear it.
    // Skip on initial mount so this widget doesn't clobber another widget's active filter.
    const activeSliceRef = useRef(null)
    useEffect(() => { activeSliceRef.current = activeSlice }, [activeSlice])
    useEffect(() => {
        if (activeSliceRef.current) {
            setActiveSlice(null)
            onFilterElements?.(null)
        }
    }, [fullData, rules, logicMode])

    const handlePieClick = (params) => {
        const name = params?.name
        if (!name) return

        if (activeSlice === name) {
            setActiveSlice(null)
            onFilterElements?.(null)
            return
        }

        const ids = name === 'Passed' ? results.passedIds : results.failedIds
        setActiveSlice(name)
        onFilterElements?.(ids.length > 0 ? ids : null)
    }

    const handlePieMouseOver = (params) => {
        if (!params?.name || !onHighlightElements) return
        const ids = params.name === 'Passed' ? results.passedIds : results.failedIds
        if (ids.length) onHighlightElements(ids)
    }

    const handlePieMouseOut = () => {
        onHighlightElements?.(null)
    }

    const addRule = () => {
        setRules([...rules, { id: Date.now(), property: 'category', operator: 'equals', value: '' }])
    }

    const updateRule = (id, field, val) => {
        setRules(rules.map(r => r.id === id ? { ...r, [field]: val } : r))
    }

    const removeRule = (id) => {
        setRules(rules.filter(r => r.id !== id))
    }

    if (!fullData) {
        return (
            <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
                Waiting for data...
            </div>
        )
    }

    return (
        <div className="flex flex-col h-full overflow-hidden relative">
            {/* Header — rename field, editing mode only. Results view already shows
                the name in the panel's own outer title bar (see GridPanel/App.jsx),
                so this second copy is dropped there entirely to give the summary
                cards and chart the extra row of space instead. */}
            {isEditing && (
                <div className="flex items-center gap-2 p-3 border-b border-white/5 bg-zinc-900/30 shrink-0">
                    <div className={`w-2 h-2 rounded-full ${results.passPct === 100 ? 'bg-[var(--speckle-success)] shadow-[0_0_8px_var(--speckle-success)]' : results.passPct > 80 ? 'bg-amber-500' : 'bg-[var(--speckle-danger)]'}`} />
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="bg-transparent border-b border-white/10 text-sm font-medium focus:outline-none focus:border-cyan-500 w-full max-w-[150px]"
                        placeholder="Validation Name"
                    />
                </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-auto p-4 custom-scrollbar">
                {isEditing ? (
                    <div className="space-y-3">
                        {rules.map((rule, idx) => (
                            <RuleRow
                                key={rule.id}
                                rule={rule}
                                idx={idx}
                                fullData={fullData}
                                propertyOptions={propertyOptions}
                                operatorOptions={operatorOptions}
                                noValueOperators={noValueOperators}
                                canRemove={rules.length > 1}
                                onUpdate={(field, val) => updateRule(rule.id, field, val)}
                                onRemove={() => removeRule(rule.id)}
                            />
                        ))}

                        <button
                            onClick={addRule}
                            className="w-full py-2 border border-dashed border-white/10 rounded-lg text-zinc-500 hover:text-zinc-300 hover:border-white/20 hover:bg-white/5 text-xs flex items-center justify-center gap-2 transition-all"
                        >
                            <Plus className="w-3 h-3" /> Add Rule
                        </button>

                        {rules.length > 1 && (
                            <div className="flex items-center justify-center gap-2 pt-1">
                                <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Match</span>
                                <div className="flex rounded-md border border-white/10 overflow-hidden text-xs">
                                    <button
                                        onClick={() => setLogicMode('AND')}
                                        className={`px-3 py-1 transition-colors ${logicMode === 'AND' ? 'bg-cyan-500/20 text-cyan-400' : 'text-zinc-500 hover:bg-white/5'}`}
                                    >
                                        ALL (AND)
                                    </button>
                                    <button
                                        onClick={() => setLogicMode('OR')}
                                        className={`px-3 py-1 transition-colors ${logicMode === 'OR' ? 'bg-cyan-500/20 text-cyan-400' : 'text-zinc-500 hover:bg-white/5'}`}
                                    >
                                        ANY (OR)
                                    </button>
                                </div>
                                <span className="text-[10px] text-zinc-500 uppercase tracking-wider">rules</span>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="h-full flex flex-col" style={{ containerType: 'size' }}>
                        {/* Summary Cards — ~20% of the available space. Each card is its own
                            container-query context (rather than querying the whole widget, as
                            before) so the number scales off the space it actually has — at the
                            default single-slot widget size this row is only ~36px tall, and
                            querying the full widget's cqh there sized the number (and the fixed
                            16px .glass-card padding) well past what the row could hold, spilling
                            the "Passed"/"Failed" caption below the card into the pie chart's own
                            label underneath it. Padding is a small fixed value instead of the
                            shared .glass-card 16px for the same reason — at this row height 16px
                            of padding alone consumes nearly the whole box. */}
                        <div className="grid grid-cols-2 gap-3 mb-3" style={{ flex: '1 1 0%', minHeight: 0 }}>
                            <div className="glass-card flex flex-col items-center justify-center text-center overflow-hidden" style={{ padding: '6px', containerType: 'size' }}>
                                <span className="font-bold text-green-500 leading-none" style={{ fontSize: 'clamp(0.6875rem, min(11cqw, 42cqh), 2rem)' }}>{results.passed}</span>
                                <span className="text-zinc-500 uppercase tracking-wider leading-none mt-0.5" style={{ fontSize: 'clamp(0.5rem, 16cqh, 0.625rem)' }}>Passed</span>
                            </div>
                            <div className="glass-card flex flex-col items-center justify-center text-center overflow-hidden" style={{ padding: '6px', containerType: 'size' }}>
                                <span className={`font-bold leading-none ${results.failed > 0 ? 'text-red-500' : 'text-zinc-500'}`} style={{ fontSize: 'clamp(0.6875rem, min(11cqw, 42cqh), 2rem)' }}>{results.failed}</span>
                                <span className="text-zinc-500 uppercase tracking-wider leading-none mt-0.5" style={{ fontSize: 'clamp(0.5rem, 16cqh, 0.625rem)' }}>Failed</span>
                            </div>
                        </div>

                        {/* Chart — ~80% of the available space, auto-sizes with the widget */}
                        <div className="relative" style={{ flex: '4 1 0%', minHeight: 0 }}>
                            {results.total === 0 ? (
                                <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
                                    No elements to validate
                                </div>
                            ) : (
                                <>
                                    <EChart
                                        option={{
                                            ...baseOption({
                                                tooltipFormatter: (params) => `${params.name}: ${params.value}`,
                                                darkMode,
                                            }),
                                            textStyle: { fontFamily: 'system-ui' },
                                            series: [{
                                                type: 'pie',
                                                radius: ['60%', '80%'],
                                                data: [
                                                    { name: 'Passed', value: results.passed, itemStyle: { color: '#22c55e' } },
                                                    { name: 'Failed', value: results.failed, itemStyle: { color: '#ef4444' } },
                                                ],
                                                label: {
                                                    show: true,
                                                    position: 'outside',
                                                    formatter: (params) => `${params.name}: ${params.value} (${params.percent}%)`,
                                                    color: darkMode ? '#e4e4e7' : '#000000',
                                                },
                                                labelLine: { show: true },
                                            }],
                                        }}
                                        onEvents={{ click: handlePieClick, mouseover: handlePieMouseOver, mouseout: handlePieMouseOut }}
                                        style={{ width: '100%', height: '100%', cursor: 'pointer' }}
                                    />
                                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                        <div className="text-center">
                                            <div className="text-2xl font-bold text-[var(--speckle-foreground)]">{results.passPct.toFixed(0)}%</div>
                                            <div className="text-[10px] text-zinc-500 uppercase">Success</div>
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>

                        {activeSlice && (
                            <div className="mt-2 flex items-center justify-center gap-2 text-[10px] text-cyan-400 shrink-0">
                                <span>Filtering viewer: {activeSlice}</span>
                                <button
                                    onClick={() => { setActiveSlice(null); onFilterElements?.(null) }}
                                    className="p-0.5 rounded hover:bg-white/10"
                                    title="Clear filter"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                        )}

                        {/* Rules Summary List */}
                        <div className="mt-4 pt-3 border-t border-white/5 shrink-0">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Active Rules</span>
                                {rules.length > 1 && (
                                    <span className="text-[10px] text-cyan-400 font-mono bg-white/5 px-1.5 py-0.5 rounded">
                                        Match {logicMode === 'OR' ? 'ANY' : 'ALL'}
                                    </span>
                                )}
                            </div>
                            <div className="space-y-1">
                                {rules.map((r, i) => {
                                    const opLabel = operatorOptions.find(o => o.value === r.operator)?.label ?? r.operator
                                    return (
                                        <div key={i} className="flex items-center gap-2 text-xs text-zinc-400">
                                            <Check className="w-3 h-3 text-cyan-500" />
                                            <span className="font-mono text-zinc-300">{r.property}</span>
                                            <span className="text-zinc-600">{opLabel}</span>
                                            {!noValueOperators.has(r.operator) && r.value && (
                                                <span className="text-zinc-300 font-mono bg-white/5 px-1 rounded">{r.value}</span>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
