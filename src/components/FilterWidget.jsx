import { useState, useMemo, useEffect, useRef } from 'react'
import { Plus, Trash2, X, ChevronDown } from 'lucide-react'
import { discoverProperties, discoverNumericProperties, aggregateProperty, getNestedValue } from '../utils/propertyScanner'
import PropertySelect from './PropertySelect'
import {
    OPERATOR_OPTIONS,
    NO_VALUE_OPERATORS,
    MULTI_VALUE_OPERATORS,
    evaluateGroups,
    evaluateCondition,
    hasActiveConditions,
    isConditionActive,
} from '../utils/filterRules'

function groupsKey(widgetId) {
    return `filter-groups-${widgetId || 'default'}`
}

function enabledKey(widgetId) {
    return `filter-enabled-${widgetId || 'default'}`
}

let uidCounter = 0
function uid() {
    uidCounter += 1
    return `${Date.now()}-${uidCounter}`
}

function defaultGroups() {
    return [{ id: uid(), conditions: [{ id: uid(), property: 'category', operator: 'equals', value: '' }] }]
}

// Dropdown with checkboxes for picking multiple values of a field
// (used by the "Is Any Of" / "Is None Of" operators).
function MultiValueInput({ value = [], onChange, options }) {
    const [open, setOpen] = useState(false)
    const ref = useRef(null)

    useEffect(() => {
        if (!open) return
        const onClickOutside = (e) => {
            if (ref.current && !ref.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onClickOutside)
        return () => document.removeEventListener('mousedown', onClickOutside)
    }, [open])

    const toggleValue = (v) => {
        onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v])
    }

    return (
        <div className="relative flex-1 min-w-[110px]" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center justify-between gap-1 bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-300 text-left"
            >
                <span className="truncate">
                    {value.length === 0 ? 'Select values…' : value.join(', ')}
                </span>
                <ChevronDown className="w-3 h-3 shrink-0 text-zinc-500" />
            </button>
            {open && (
                <div className="absolute z-20 mt-1 w-full max-h-48 overflow-auto bg-zinc-900 border border-white/10 rounded shadow-xl">
                    {options.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-zinc-500">No values found</div>
                    ) : options.map(opt => (
                        <label key={opt.value} className="flex items-center gap-2 px-2 py-1.5 text-xs text-zinc-300 hover:bg-white/5 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={value.includes(opt.value)}
                                onChange={() => toggleValue(opt.value)}
                                className="accent-cyan-500"
                            />
                            <span className="flex-1 truncate">{opt.value}</span>
                            <span className="text-zinc-600">{opt.count}</span>
                        </label>
                    ))}
                </div>
            )}
        </div>
    )
}

function ConditionRow({ condition, propertyOptions, getValueOptions, matchCount, onUpdate, onRemove }) {
    const isMultiValue = MULTI_VALUE_OPERATORS.has(condition.operator)
    const isNoValue = NO_VALUE_OPERATORS.has(condition.operator)
    const isNumericOperator = ['gt', 'lt'].includes(condition.operator)

    return (
        <div className="flex items-center gap-1.5">
            <div className="flex-1 min-w-[110px]">
                <PropertySelect
                    options={propertyOptions}
                    value={condition.property}
                    onChange={val => onUpdate({ property: val })}
                />
            </div>

            <select
                value={condition.operator}
                onChange={e => {
                    const operator = e.target.value
                    onUpdate({ operator, value: MULTI_VALUE_OPERATORS.has(operator) ? [] : '' })
                }}
                className="w-28 shrink-0 bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-300"
            >
                {OPERATOR_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
            </select>

            {!isNoValue && (
                isMultiValue ? (
                    <MultiValueInput
                        value={Array.isArray(condition.value) ? condition.value : []}
                        onChange={v => onUpdate({ value: v })}
                        options={getValueOptions(condition.property)}
                    />
                ) : (
                    <>
                        <input
                            type={isNumericOperator ? 'number' : 'text'}
                            value={condition.value}
                            onChange={e => onUpdate({ value: e.target.value })}
                            placeholder="Value…"
                            list={isNumericOperator ? undefined : `filter-values-${condition.id}`}
                            className="flex-1 min-w-[80px] bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-300 focus:border-cyan-500 focus:outline-none"
                        />
                        {!isNumericOperator && (
                            <datalist id={`filter-values-${condition.id}`}>
                                {getValueOptions(condition.property).map(opt => (
                                    <option key={opt.value} value={opt.value} />
                                ))}
                            </datalist>
                        )}
                    </>
                )
            )}

            {matchCount !== undefined && (
                <span
                    className="shrink-0 text-[10px] text-zinc-500 bg-white/5 rounded px-1.5 py-1 tabular-nums"
                    title="Elements matching this condition alone, ignoring AND/OR grouping"
                >
                    {matchCount}
                </span>
            )}

            <button
                onClick={onRemove}
                className="p-1 hover:bg-red-500/20 text-zinc-500 hover:text-red-400 rounded transition-colors shrink-0"
                title="Remove condition"
            >
                <X className="w-3.5 h-3.5" />
            </button>
        </div>
    )
}

export default function FilterWidget({ widgetId, fullData, paramKeys = [], title = 'Filter Builder', onUpdateTitle, onFilterElements }) {
    const [name, setName] = useState(title)
    const [groups, setGroups] = useState(() => {
        try {
            const saved = localStorage.getItem(groupsKey(widgetId))
            return saved ? JSON.parse(saved) : defaultGroups()
        } catch { return defaultGroups() }
    })
    const [enabled, setEnabled] = useState(() => {
        try {
            const saved = localStorage.getItem(enabledKey(widgetId))
            return saved === null ? true : saved === 'true'
        } catch { return true }
    })

    // Persist groups / enabled state
    useEffect(() => {
        try { localStorage.setItem(groupsKey(widgetId), JSON.stringify(groups)) } catch {}
    }, [groups, widgetId])

    useEffect(() => {
        try { localStorage.setItem(enabledKey(widgetId), String(enabled)) } catch {}
    }, [enabled, widgetId])

    // Update parent title when local name changes
    useEffect(() => {
        if (onUpdateTitle && name !== title) onUpdateTitle(name)
    }, [name, onUpdateTitle, title])

    // Discover available fields — same set as ValidationWidget's rule builder
    const propertyOptions = useMemo(() => {
        if (!fullData) return []

        const stringProps = discoverProperties(fullData)
        const numericProps = discoverNumericProperties(fullData)

        const options = [
            { label: 'Category', value: 'category' },
            { label: 'Family', value: 'family' },
            { label: 'Type', value: 'type' },
            { label: 'Level', value: 'level' },
            { label: 'Speckle Type', value: 'speckle_type' },

            { label: '--- Dimensions ---', value: '', disabled: true },
            ...numericProps.map(p => ({ label: p.name, value: p.path, coverage: p.coverage })),

            { label: '--- Attributes ---', value: '', disabled: true },
            ...stringProps.map(p => ({ label: p.name, value: p.path, coverage: p.coverage })),

            // Divider — backend-derived parameters, see ValidationWidget's
            // matching comment: discoverProperties/discoverNumericProperties
            // only sample the first 500 elements and can miss a real but
            // rare/unevenly-distributed parameter entirely; paramKeys comes
            // from the backend, which aggregates over every element.
            { label: '--- BIM Parameters ---', value: '', disabled: true },
            ...paramKeys.map(p => ({ label: p.key, value: `params.${p.key}`, coverage: p.coverage_pct })),
        ]

        return options.filter((opt, index, self) =>
            opt.disabled ||
            (opt.value && index === self.findIndex(t => t.value === opt.value))
        )
    }, [fullData, paramKeys])

    // Cache distinct values per property (for "Is Any Of" / autocomplete)
    const valueOptionsCache = useRef(new Map())
    useEffect(() => { valueOptionsCache.current = new Map() }, [fullData])

    const getValueOptions = (path) => {
        if (!fullData || !path) return []
        if (!valueOptionsCache.current.has(path)) {
            const counts = aggregateProperty(fullData, path)
            const options = Object.entries(counts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 50)
                .map(([value, count]) => ({ value, count }))
            valueOptionsCache.current.set(path, options)
        }
        return valueOptionsCache.current.get(path)
    }

    const updateCondition = (groupId, conditionId, updates) => {
        setGroups(prev => prev.map(g => g.id !== groupId ? g : {
            ...g,
            conditions: g.conditions.map(c => c.id !== conditionId ? c : { ...c, ...updates })
        }))
    }

    const addCondition = (groupId) => {
        setGroups(prev => prev.map(g => g.id !== groupId ? g : {
            ...g,
            conditions: [...g.conditions, { id: uid(), property: 'category', operator: 'equals', value: '' }]
        }))
    }

    const removeCondition = (groupId, conditionId) => {
        setGroups(prev => prev.map(g => g.id !== groupId ? g : {
            ...g,
            conditions: g.conditions.filter(c => c.id !== conditionId)
        }))
    }

    const addGroup = () => {
        setGroups(prev => [...prev, { id: uid(), conditions: [{ id: uid(), property: 'category', operator: 'equals', value: '' }] }])
    }

    const removeGroup = (groupId) => {
        setGroups(prev => prev.filter(g => g.id !== groupId))
    }

    const clearAll = () => {
        setGroups(defaultGroups())
        setEnabled(true)
    }

    // matchedIds === null means "no active conditions configured" (don't filter)
    const matchedIds = useMemo(() => {
        if (!fullData?.elements) return null
        if (!hasActiveConditions(groups)) return null
        return fullData.elements
            .filter(el => evaluateGroups(el, groups, getNestedValue))
            .map(el => el.speckle_id || el.id)
            .filter(Boolean)
    }, [fullData, groups])

    // How many elements each individual condition matches on its own,
    // independent of AND/OR grouping — helps explain "0 match" results
    // caused by conditions that don't co-occur on the same elements.
    const conditionCounts = useMemo(() => {
        if (!fullData?.elements) return {}
        const counts = {}
        for (const group of groups) {
            for (const condition of group.conditions) {
                if (!isConditionActive(condition)) continue
                counts[condition.id] = fullData.elements.reduce((acc, el) =>
                    evaluateCondition(getNestedValue(el, condition.property), condition) ? acc + 1 : acc
                , 0)
            }
        }
        return counts
    }, [fullData, groups])

    // Push matched IDs to the viewer/table whenever the filter changes.
    // Only fires onFilterElements(null) when transitioning *away* from an
    // active filter, mirroring ElementTable's own-filter guard so this
    // widget doesn't fight other filter sources on every render.
    const wasActiveRef = useRef(false)
    useEffect(() => {
        if (!onFilterElements) return
        if (enabled && matchedIds !== null) {
            wasActiveRef.current = true
            onFilterElements(matchedIds.length > 0 ? matchedIds : null)
        } else if (wasActiveRef.current) {
            wasActiveRef.current = false
            onFilterElements(null)
        }
    }, [matchedIds, enabled, onFilterElements])

    // Clear this widget's filter from the viewer when it's removed
    useEffect(() => {
        return () => {
            if (wasActiveRef.current) onFilterElements?.(null)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    if (!fullData) {
        return (
            <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
                Waiting for data...
            </div>
        )
    }

    const total = fullData.elements?.length || 0

    return (
        <div className="flex flex-col h-full overflow-hidden relative">
            {/* Header */}
            <div className="flex items-center justify-between gap-2 p-3 border-b border-white/5 bg-zinc-900/30 shrink-0">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${enabled && matchedIds !== null ? 'bg-cyan-500 shadow-[0_0_8px_rgba(34,211,238,0.5)]' : 'bg-zinc-600'}`} />
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="bg-transparent border-b border-white/10 text-sm font-medium focus:outline-none focus:border-cyan-500 w-full max-w-[180px]"
                        placeholder="Filter Name"
                    />
                </div>
                <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer select-none shrink-0">
                    <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => setEnabled(e.target.checked)}
                        className="accent-cyan-500"
                    />
                    Enabled
                </label>
            </div>

            {/* Groups */}
            <div className="flex-1 overflow-auto p-4 custom-scrollbar space-y-2">
                {groups.map((group, gIdx) => (
                    <div key={group.id}>
                        {gIdx > 0 && (
                            <div className="flex items-center gap-2 py-1">
                                <div className="flex-1 h-px bg-white/10" />
                                <span className="text-[10px] text-purple-400 font-semibold uppercase tracking-wider">Or</span>
                                <div className="flex-1 h-px bg-white/10" />
                            </div>
                        )}
                        <div className="glass-card p-3 rounded-lg border border-white/5 space-y-2 relative group">
                            {groups.length > 1 && (
                                <button
                                    onClick={() => removeGroup(group.id)}
                                    className="absolute right-2 top-2 p-1 hover:bg-red-500/20 text-zinc-500 hover:text-red-400 rounded transition-colors opacity-0 group-hover:opacity-100"
                                    title="Remove group"
                                >
                                    <Trash2 className="w-3 h-3" />
                                </button>
                            )}
                            <div className="text-[10px] text-zinc-500 uppercase tracking-wider">
                                Group {gIdx + 1}
                            </div>

                            {group.conditions.map((condition, cIdx) => (
                                <div key={condition.id}>
                                    {cIdx > 0 && (
                                        <div className="text-center text-[10px] text-cyan-400/70 font-semibold uppercase tracking-wider py-0.5">
                                            And
                                        </div>
                                    )}
                                    <ConditionRow
                                        condition={condition}
                                        propertyOptions={propertyOptions}
                                        getValueOptions={getValueOptions}
                                        matchCount={conditionCounts[condition.id]}
                                        onUpdate={updates => updateCondition(group.id, condition.id, updates)}
                                        onRemove={() => removeCondition(group.id, condition.id)}
                                    />
                                </div>
                            ))}

                            <button
                                onClick={() => addCondition(group.id)}
                                className="w-full py-1.5 border border-dashed border-white/10 rounded-lg text-zinc-500 hover:text-zinc-300 hover:border-white/20 hover:bg-white/5 text-xs flex items-center justify-center gap-2 transition-all"
                            >
                                <Plus className="w-3 h-3" /> Add Condition
                            </button>
                        </div>
                    </div>
                ))}

                <button
                    onClick={addGroup}
                    className="w-full py-2 border border-dashed border-purple-500/20 rounded-lg text-purple-400/70 hover:text-purple-300 hover:border-purple-500/40 hover:bg-purple-500/5 text-xs flex items-center justify-center gap-2 transition-all"
                >
                    <Plus className="w-3 h-3" /> Add OR Group
                </button>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-2 p-3 border-t border-white/5 bg-zinc-900/30 text-xs shrink-0">
                <span className="text-zinc-400">
                    {matchedIds === null
                        ? `${total} element${total !== 1 ? 's' : ''} (no filter)`
                        : `${matchedIds.length} of ${total} element${total !== 1 ? 's' : ''} match`}
                </span>
                <button
                    onClick={clearAll}
                    className="text-zinc-500 hover:text-red-400 transition-colors flex items-center gap-1"
                >
                    <X className="w-3 h-3" /> Clear all
                </button>
            </div>
        </div>
    )
}
