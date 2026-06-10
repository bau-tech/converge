import { motion, AnimatePresence } from 'framer-motion'
import {
    X,
    BarChart3,
    PieChart,
    Sparkles,
    Type,
    Check,
    Database,
    Search,
    Target, // Sunburst
    LayoutDashboard, // Treemap
    Activity, // Violin
    Box, // Box Plot
    BarChart2 // Histogram
} from 'lucide-react'
import { useState, useMemo, useEffect } from 'react'

export function ChartBuilder({
    isOpen,
    onClose,
    availableFields,
    onCreateChart,
    initialConfig,
    fullData
}) {
    // State
    const [selectedField, setSelectedField] = useState('')
    const [chartType, setChartType] = useState('bar')
    const [customTitle, setCustomTitle] = useState('')
    const [orientation, setOrientation] = useState('h')
    const [searchTerm, setSearchTerm] = useState('')

    // Initialize state when opening or config changes
    // Initialize state when opening or config changes
    useEffect(() => {
        if (isOpen) {
            if (initialConfig) {
                setSelectedField(initialConfig.sourceField || '')
                setChartType(initialConfig.config?.type || 'bar')
                setCustomTitle(initialConfig.config?.title || '')
                setOrientation(initialConfig.config?.orientation || 'h')
            } else {
                // Reset to defaults
                setSelectedField('')
                setChartType('bar')
                setCustomTitle('')
                setOrientation('h')
                setSearchTerm('')
            }
        }
    }, [initialConfig, isOpen])


    // Group fields by source
    const groupedFields = useMemo(() => {
        const summaryFields = availableFields.filter(f => !f.isDiscovered)
        const discoveredFields = availableFields.filter(f => f.isDiscovered && !f.isNumeric)
        const numericFields = availableFields.filter(f => f.isNumeric)
        return { summaryFields, discoveredFields, numericFields }
    }, [availableFields])

    // Filter fields based on search
    const filteredFields = useMemo(() => {
        if (!searchTerm) return groupedFields
        const term = searchTerm.toLowerCase()
        return {
            summaryFields: groupedFields.summaryFields.filter(f =>
                f.config.title.toLowerCase().includes(term)
            ),
            discoveredFields: groupedFields.discoveredFields.filter(f =>
                f.config.title.toLowerCase().includes(term) ||
                (f.path && f.path.toLowerCase().includes(term))
            ),
            numericFields: groupedFields.numericFields.filter(f =>
                f.config.title.toLowerCase().includes(term) ||
                (f.path && f.path.toLowerCase().includes(term))
            )
        }
    }, [groupedFields, searchTerm])

    const handleCreate = () => {
        if (!selectedField) return

        const fieldData = availableFields.find(f => f.key === selectedField)
        if (!fieldData) return

        const newChart = {
            key: initialConfig ? initialConfig.key : `custom_${Date.now()}`, // Keep ID if editing
            sourceField: selectedField,
            config: {
                type: chartType,
                title: customTitle || fieldData.config.title,
                orientation: chartType === 'bar' ? orientation : undefined,
                clickable: true,
                field: fieldData.config.field,
                isCustom: true,
                isDiscovered: fieldData.isDiscovered || false,
                isNumeric: fieldData.isNumeric || false,
                propertyPath: fieldData.path || null
            }
        }

        onCreateChart(newChart)

        // Reset form if just creating (if editing, parent closes)
        if (!initialConfig) {
            setSelectedField('')
            setChartType('bar')
            setCustomTitle('')
            setOrientation('h')
            setSearchTerm('')
        }
        onClose()
    }

    const selectedFieldData = availableFields.find(f => f.key === selectedField)
    const hasDiscoveredFields = groupedFields.discoveredFields.length > 0

    if (!isOpen) return null

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
                onClick={onClose}
            >
                <motion.div
                    initial={{ opacity: 0, scale: 0.9, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.9, y: 20 }}
                    className="bg-zinc-900 border border-white/10 rounded-xl shadow-2xl w-full max-w-md overflow-hidden max-h-[90vh] flex flex-col"
                    onClick={e => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 bg-gradient-to-r from-cyan-500/10 to-purple-500/10">
                        <div className="flex items-center gap-2">
                            <Sparkles className="w-5 h-5 text-cyan-500" />
                            <h2 className="text-lg font-semibold">
                                {initialConfig ? 'Edit Custom Chart' : 'Create Custom Chart'}
                            </h2>
                        </div>
                        <button
                            onClick={onClose}
                            className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Body - Scrollable */}
                    <div className="p-5 space-y-5 overflow-y-auto flex-1">
                        {/* Search (if many fields) */}
                        {availableFields.length > 10 && (
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                                <input
                                    type="text"
                                    value={searchTerm}
                                    onChange={e => setSearchTerm(e.target.value)}
                                    placeholder="Search properties..."
                                    className="w-full bg-zinc-800 border border-white/10 rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-cyan-500 transition-colors placeholder:text-zinc-600"
                                />
                            </div>
                        )}

                        {/* Field Selection - Grouped */}
                        <div>
                            <label className="text-sm text-zinc-400 mb-2 block">Data Field</label>
                            <div className="bg-zinc-800 border border-white/10 rounded-lg max-h-48 overflow-y-auto">
                                {/* Summary Fields */}
                                {filteredFields.summaryFields.length > 0 && (
                                    <div>
                                        <div className="px-3 py-2 text-xs font-medium text-cyan-500 bg-cyan-500/10 sticky top-0 flex items-center gap-2">
                                            <Database className="w-3 h-3" />
                                            Summary
                                        </div>
                                        {filteredFields.summaryFields.map(field => (
                                            <button
                                                key={field.key}
                                                onClick={() => setSelectedField(field.key)}
                                                className={`w-full text-left px-3 py-2.5 text-sm hover:bg-white/5 transition-colors flex items-center justify-between ${selectedField === field.key ? 'bg-cyan-500/20' : ''
                                                    }`}
                                            >
                                                <span>{field.config.title}</span>
                                                <span className="text-xs text-zinc-500">{field.entryCount} items</span>
                                            </button>
                                        ))}
                                    </div>
                                )}

                                {/* Dimensions (Numeric Properties) - Distribution Charts */}
                                {filteredFields.numericFields?.length > 0 && (
                                    <div>
                                        <div className="px-3 py-2 text-xs font-medium text-green-500 bg-green-500/10 sticky top-0 flex items-center gap-2">
                                            📊 Elements by Dimension (Distribution)
                                        </div>
                                        {filteredFields.numericFields.map(field => (
                                            <button
                                                key={field.key}
                                                onClick={() => setSelectedField(field.key)}
                                                className={`w-full text-left px-3 py-2.5 text-sm hover:bg-white/5 transition-colors ${selectedField === field.key ? 'bg-green-500/20' : ''
                                                    }`}
                                            >
                                                <div className="flex items-center justify-between">
                                                    <span>{field.config.title}</span>
                                                    <span className="text-xs text-zinc-500">{field.entryCount} elements</span>
                                                </div>
                                                {field.stats && (
                                                    <div className="text-xs text-zinc-600 mt-0.5 flex gap-3">
                                                        <span>range: {field.stats.min?.toFixed(1)} - {field.stats.max?.toFixed(1)}</span>
                                                    </div>
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                )}

                                {/* Discovered Properties */}
                                {filteredFields.discoveredFields.length > 0 && (
                                    <div>
                                        <div className="px-3 py-2 text-xs font-medium text-purple-500 bg-purple-500/10 sticky top-0 flex items-center gap-2">
                                            <Search className="w-3 h-3" />
                                            Discovered Properties {!fullData && '(Loading...)'}
                                        </div>
                                        {filteredFields.discoveredFields.map(field => (
                                            <button
                                                key={field.key}
                                                onClick={() => setSelectedField(field.key)}
                                                className={`w-full text-left px-3 py-2.5 text-sm hover:bg-white/5 transition-colors ${selectedField === field.key ? 'bg-purple-500/20' : ''
                                                    }`}
                                            >
                                                <div className="flex items-center justify-between">
                                                    <span>{field.config.title}</span>
                                                    <span className="text-xs text-zinc-500">{field.entryCount} values</span>
                                                </div>
                                                <div className="text-xs text-zinc-600 mt-0.5 truncate">
                                                    {field.path}
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}

                                {/* No results */}
                                {filteredFields.summaryFields.length === 0 && filteredFields.discoveredFields.length === 0 && (filteredFields.numericFields?.length || 0) === 0 && (
                                    <div className="px-3 py-6 text-center text-zinc-500 text-sm">
                                        No fields found
                                    </div>
                                )}
                            </div>
                            {(groupedFields.discoveredFields.length > 0 || groupedFields.numericFields?.length > 0) && (
                                <p className="text-xs text-zinc-600 mt-2">
                                    💡 Properties are scanned from your model's elements
                                </p>
                            )}
                        </div>

                        {/* Chart Type Selection */}
                        <div>
                            <label className="text-sm text-zinc-400 mb-2 block">Chart Type</label>
                            <div className="grid grid-cols-2 gap-3">
                                {/* Basic Types (Always Available for Categorical) */}
                                {(!selectedFieldData?.isNumeric) && (
                                    <>
                                        <button
                                            onClick={() => setChartType('bar')}
                                            className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border transition-all ${chartType === 'bar'
                                                ? 'border-cyan-500 bg-cyan-500/20 text-cyan-400'
                                                : 'border-white/10 hover:border-white/20'
                                                }`}
                                        >
                                            <BarChart3 className="w-5 h-5" />
                                            <span>Bar Chart</span>
                                        </button>
                                        <button
                                            onClick={() => setChartType('pie')}
                                            className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border transition-all ${chartType === 'pie'
                                                ? 'border-purple-500 bg-purple-500/20 text-purple-400'
                                                : 'border-white/10 hover:border-white/20'
                                                }`}
                                        >
                                            <PieChart className="w-5 h-5" />
                                            <span>Pie Chart</span>
                                        </button>
                                        <button
                                            onClick={() => setChartType('sunburst')}
                                            className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border transition-all ${chartType === 'sunburst'
                                                ? 'border-orange-500 bg-orange-500/20 text-orange-400'
                                                : 'border-white/10 hover:border-white/20'
                                                }`}
                                        >
                                            <Target className="w-5 h-5" />
                                            <span>Sunburst</span>
                                        </button>
                                        <button
                                            onClick={() => setChartType('treemap')}
                                            className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border transition-all ${chartType === 'treemap'
                                                ? 'border-green-500 bg-green-500/20 text-green-400'
                                                : 'border-white/10 hover:border-white/20'
                                                }`}
                                        >
                                            <LayoutDashboard className="w-5 h-5" />
                                            <span>Treemap</span>
                                        </button>
                                    </>
                                )}

                                {/* Numeric Types */}
                                {(selectedFieldData?.isNumeric) && (
                                    <>
                                        <button
                                            onClick={() => setChartType('histogram')}
                                            className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border transition-all ${chartType === 'histogram'
                                                ? 'border-cyan-500 bg-cyan-500/20 text-cyan-400'
                                                : 'border-white/10 hover:border-white/20'
                                                }`}
                                        >
                                            <BarChart2 className="w-5 h-5" />
                                            <span>Histogram</span>
                                        </button>
                                        <button
                                            onClick={() => setChartType('box')}
                                            className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border transition-all ${chartType === 'box'
                                                ? 'border-blue-500 bg-blue-500/20 text-blue-400'
                                                : 'border-white/10 hover:border-white/20'
                                                }`}
                                        >
                                            <Box className="w-5 h-5" />
                                            <span>Box Plot</span>
                                        </button>
                                        <button
                                            onClick={() => setChartType('violin')}
                                            className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border transition-all ${chartType === 'violin'
                                                ? 'border-purple-500 bg-purple-500/20 text-purple-400'
                                                : 'border-white/10 hover:border-white/20'
                                                }`}
                                        >
                                            <Activity className="w-5 h-5" />
                                            <span>Violin Plot</span>
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Orientation (only for bar charts) */}
                        {chartType === 'bar' && (
                            <div>
                                <label className="text-sm text-zinc-400 mb-2 block">Orientation</label>
                                <div className="grid grid-cols-2 gap-3">
                                    <button
                                        onClick={() => setOrientation('h')}
                                        className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border text-sm transition-all ${orientation === 'h'
                                            ? 'border-cyan-500 bg-cyan-500/10'
                                            : 'border-white/10 hover:border-white/20'
                                            }`}
                                    >
                                        <BarChart3 className="w-4 h-4" />
                                        Horizontal
                                    </button>
                                    <button
                                        onClick={() => setOrientation('v')}
                                        className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border text-sm transition-all ${orientation === 'v'
                                            ? 'border-cyan-500 bg-cyan-500/10'
                                            : 'border-white/10 hover:border-white/20'
                                            }`}
                                    >
                                        <BarChart3 className="w-4 h-4 rotate-90" />
                                        Vertical
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Custom Title */}
                        <div>
                            <label className="text-sm text-zinc-400 mb-2 block flex items-center gap-2">
                                <Type className="w-4 h-4" />
                                Custom Title (optional)
                            </label>
                            <input
                                type="text"
                                value={customTitle}
                                onChange={e => setCustomTitle(e.target.value)}
                                placeholder={selectedFieldData?.config.title || 'Enter chart title...'}
                                className="w-full bg-zinc-800 border border-white/10 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-cyan-500 transition-colors placeholder:text-zinc-600"
                            />
                        </div>

                        {/* Preview indicator */}
                        {selectedField && (
                            <div className="bg-zinc-800/50 rounded-lg p-4 border border-white/5">
                                <p className="text-xs text-zinc-500 mb-1">Preview</p>
                                <div className="flex items-center gap-2">
                                    {chartType === 'pie'
                                        ? <PieChart className="w-4 h-4 text-purple-500" />
                                        : <BarChart3 className={`w-4 h-4 text-cyan-500 ${orientation === 'v' ? 'rotate-90' : ''}`} />
                                    }
                                    <span className="text-sm font-medium">
                                        {customTitle || selectedFieldData?.config.title}
                                    </span>
                                    {selectedFieldData?.isDiscovered && (
                                        <span className="text-xs px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded">
                                            Discovered
                                        </span>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex gap-3 px-5 py-4 border-t border-white/10 bg-zinc-800/30">
                        <button
                            onClick={onClose}
                            className="flex-1 px-4 py-2.5 rounded-lg border border-white/10 hover:bg-white/5 transition-colors text-sm"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleCreate}
                            disabled={!selectedField}
                            className={`flex-1 px-4 py-2.5 rounded-lg flex items-center justify-center gap-2 text-sm font-medium transition-all ${selectedField
                                ? 'bg-gradient-to-r from-cyan-500 to-purple-500 hover:opacity-90'
                                : 'bg-zinc-700 text-zinc-500 cursor-not-allowed'
                                }`}
                        >
                            <Check className="w-4 h-4" />
                            {initialConfig ? 'Update Chart' : 'Create Chart'}
                        </button>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )
}
