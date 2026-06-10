import { useState, useMemo, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle, AlertCircle, Plus, Trash2, Settings, Play, ChevronDown, Check, X } from 'lucide-react'
import Plot from 'react-plotly.js'
import { discoverProperties, discoverNumericProperties } from '../utils/propertyScanner'

const DEFAULT_RULES = [{ id: 1, property: 'category', operator: 'is_defined', value: '' }]

function rulesKey(widgetId) {
    return `validation-rules-${widgetId || 'default'}`
}

export default function ValidationWidget({ widgetId, fullData, title = "New Validation", onUpdateTitle }) {
    const [name, setName] = useState(title)
    const [isEditing, setIsEditing] = useState(true)
    const [rules, setRules] = useState(() => {
        try {
            const saved = localStorage.getItem(rulesKey(widgetId))
            return saved ? JSON.parse(saved) : DEFAULT_RULES
        } catch { return DEFAULT_RULES }
    })

    // Persist rules whenever they change
    useEffect(() => {
        try { localStorage.setItem(rulesKey(widgetId), JSON.stringify(rules)) } catch {}
    }, [rules, widgetId])

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
        if (!fullData?.elements) return { passed: 0, failed: 0, total: 0, passPct: 0 }

        let passed = 0
        let failed = 0

        fullData.elements.forEach(el => {
            // AND Logic: Must pass ALL rules
            const allPassed = rules.every(rule => {
                const val = getNested(el, rule.property)
                return checkRule(val, rule)
            })

            if (allPassed) passed++
            else failed++
        })

        const total = passed + failed
        return {
            passed,
            failed,
            total,
            passPct: total > 0 ? (passed / total) * 100 : 0
        }
    }, [fullData, rules])

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
                    <div className={`w-2 h-2 rounded-full ${results.passPct === 100 ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : results.passPct > 80 ? 'bg-amber-500' : 'bg-red-500'}`} />
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
                                        {propertyOptions.map(opt => (
                                            <option key={opt.value} value={opt.value}>{opt.label}</option>
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
                            <Plus className="w-3 h-3" /> Add Rule (AND)
                        </button>
                    </div>
                ) : (
                    <div className="h-full flex flex-col">
                        {/* Summary Cards */}
                        <div className="grid grid-cols-2 gap-3 mb-4 shrink-0">
                            <div className="glass-card p-3 flex flex-col items-center justify-center text-center">
                                <span className="text-2xl font-bold text-green-500">{results.passed}</span>
                                <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Passed</span>
                            </div>
                            <div className="glass-card p-3 flex flex-col items-center justify-center text-center">
                                <span className={`text-2xl font-bold ${results.failed > 0 ? 'text-red-500' : 'text-zinc-500'}`}>{results.failed}</span>
                                <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Failed</span>
                            </div>
                        </div>

                        {/* Chart */}
                        <div className="flex-1 min-h-0 relative">
                            {results.total === 0 ? (
                                <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
                                    No elements to validate
                                </div>
                            ) : (
                                <>
                                    <Plot
                                        data={[{
                                            values: [results.passed, results.failed],
                                            labels: ['Passed', 'Failed'],
                                            type: 'pie',
                                            hole: 0.6,
                                            marker: { colors: ['#22c55e', '#ef4444'] },
                                            textinfo: 'percent',
                                            textposition: 'inside',
                                            hoverinfo: 'label+value',
                                            showlegend: false,
                                            automargin: false,
                                        }]}
                                        layout={{
                                            showlegend: false,
                                            margin: { t: 0, b: 0, l: 0, r: 0 },
                                            paper_bgcolor: 'rgba(0,0,0,0)',
                                            plot_bgcolor: 'rgba(0,0,0,0)',
                                            font: { family: 'system-ui', color: '#a1a1aa' },
                                            autosize: true,
                                        }}
                                        useResizeHandler
                                        style={{ width: '100%', height: '100%' }}
                                        config={{ displayModeBar: false, responsive: true }}
                                    />
                                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                        <div className="text-center">
                                            <div className="text-2xl font-bold text-white">{results.passPct.toFixed(0)}%</div>
                                            <div className="text-[10px] text-zinc-500 uppercase">Success</div>
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>

                        {/* Rules Summary List */}
                        <div className="mt-4 pt-3 border-t border-white/5 shrink-0">
                            <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">Active Rules</div>
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
