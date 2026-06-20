import { useState, useMemo, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle, AlertCircle, Plus, Trash2, Settings, Play, ChevronDown, Check, X } from 'lucide-react'
import EChart from './EChart'
import { baseOption } from '../lib/echartsTheme'
import { discoverProperties, discoverNumericProperties } from '../utils/propertyScanner'

const DEFAULT_RULES = [{ id: 1, property: 'category', operator: 'is_defined', value: '' }]

function rulesKey(widgetId) {
    return `validation-rules-${widgetId || 'default'}`
}

function logicKey(widgetId) {
    return `validation-logic-${widgetId || 'default'}`
}


export default function ValidationWidget({ widgetId, fullData, title = "New Validation", onUpdateTitle, onFilterElements, onHighlightElements, darkMode = true }) {
    const [name, setName] = useState(title)
    const [isEditing, setIsEditing] = useState(true)
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

        const stringProps = discoverProperties(fullData)
        const numericProps = discoverNumericProperties(fullData)

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
            {/* Header / Mode Toggle */}
            <div className="flex items-center justify-between p-3 border-b border-white/5 bg-zinc-900/30 shrink-0">
                <div className="flex items-center gap-2 flex-1">
                    <div className={`w-2 h-2 rounded-full ${results.passPct === 100 ? 'bg-[var(--speckle-success)] shadow-[0_0_8px_var(--speckle-success)]' : results.passPct > 80 ? 'bg-amber-500' : 'bg-[var(--speckle-danger)]'}`} />
                    {isEditing ? (
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="bg-transparent border-b border-white/10 text-sm font-medium focus:outline-none focus:border-cyan-500 w-full max-w-[150px]"
                            placeholder="Validation Name"
                        />
                    ) : (
                        <h3 className="text-sm font-medium text-zinc-200 truncate" title={name}>{name}</h3>
                    )}
                </div>
                <button
                    onClick={() => setIsEditing(!isEditing)}
                    className={`p-1.5 rounded transition-colors ${isEditing ? 'bg-cyan-500/20 text-cyan-400' : 'hover:bg-white/5 text-zinc-400'}`}
                    title={isEditing ? "View Results" : "Edit Rules"}
                >
                    {isEditing ? <Play className="w-3.5 h-3.5" fill="currentColor" /> : <Settings className="w-3.5 h-3.5" />}
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-4 custom-scrollbar">
                {isEditing ? (
                    <div className="space-y-3">
                        {rules.map((rule, idx) => (
                            <div key={rule.id} className="glass-card p-3 rounded-lg border border-white/5 space-y-2 relative group">
                                <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                        onClick={() => removeRule(rule.id)}
                                        className="p-1 hover:bg-red-500/20 text-zinc-500 hover:text-red-400 rounded transition-colors"
                                        disabled={rules.length === 1}
                                    >
                                        <Trash2 className="w-3 h-3" />
                                    </button>
                                </div>

                                <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
                                    <span className="font-mono bg-white/5 px-1.5 py-0.5 rounded">Rule #{idx + 1}</span>
                                </div>

                                <div className="grid grid-cols-1 gap-2">
                                    <select
                                        value={rule.property}
                                        onChange={(e) => updateRule(rule.id, 'property', e.target.value)}
                                        className="w-full bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-300"
                                    >
                                        {propertyOptions.map((opt, i) => (
                                            <option key={opt.disabled ? `sep-${i}` : opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</option>
                                        ))}
                                    </select>

                                    <div className="flex gap-2">
                                        <select
                                            value={rule.operator}
                                            onChange={(e) => updateRule(rule.id, 'operator', e.target.value)}
                                            className="flex-1 bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-300"
                                        >
                                            {operatorOptions.map(opt => (
                                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                                            ))}
                                        </select>

                                        {!noValueOperators.has(rule.operator) && (
                                            <input
                                                type={['gt', 'lt'].includes(rule.operator) ? 'number' : 'text'}
                                                value={rule.value}
                                                onChange={(e) => updateRule(rule.id, 'value', e.target.value)}
                                                placeholder="Value..."
                                                className="flex-1 bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-300 focus:border-cyan-500 focus:outline-none"
                                            />
                                        )}
                                    </div>
                                </div>
                            </div>
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
                        {/* Summary Cards — ~20% of the available space, numbers scale with widget size */}
                        <div className="grid grid-cols-2 gap-3 mb-3" style={{ flex: '1 1 0%', minHeight: 0 }}>
                            <div className="glass-card flex flex-col items-center justify-center text-center overflow-hidden">
                                <span className="font-bold text-green-500 leading-none" style={{ fontSize: 'clamp(0.875rem, min(9cqw, 14cqh), 2.5rem)' }}>{results.passed}</span>
                                <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Passed</span>
                            </div>
                            <div className="glass-card flex flex-col items-center justify-center text-center overflow-hidden">
                                <span className={`font-bold leading-none ${results.failed > 0 ? 'text-red-500' : 'text-zinc-500'}`} style={{ fontSize: 'clamp(0.875rem, min(9cqw, 14cqh), 2.5rem)' }}>{results.failed}</span>
                                <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Failed</span>
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
