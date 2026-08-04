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
import { createPortal } from 'react-dom'
import { settingBtnCls, settingBtnActive, settingBtnInactive, settingInputCls } from './chartSettingsUI'

const CATEGORICAL_TYPES = [
    { type: 'bar', label: 'Bar', icon: BarChart3 },
    { type: 'pie', label: 'Pie', icon: PieChart },
    { type: 'sunburst', label: 'Sunburst', icon: Target },
    { type: 'treemap', label: 'Treemap', icon: LayoutDashboard },
]

const NUMERIC_TYPES = [
    { type: 'histogram', label: 'Histogram', icon: BarChart2 },
    { type: 'box', label: 'Box Plot', icon: Box },
    { type: 'violin', label: 'Violin Plot', icon: Activity },
]

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

    if (!isOpen) return null

    return createPortal(
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
                    className="glass-card shadow-2xl w-[290px] overflow-hidden max-h-[85vh] flex flex-col gap-2.5 text-[var(--speckle-foreground)]"
                    onClick={e => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-3 pt-2.5">
                        <div className="flex items-center gap-1.5">
                            <Sparkles className="w-3.5 h-3.5 text-[var(--speckle-outline-1)]" />
                            <span className="text-[11px] font-semibold text-[var(--speckle-foreground-2)] uppercase tracking-wider">
                                {initialConfig ? 'Edit Custom Chart' : 'Create Custom Chart'}
                            </span>
                        </div>
                        <button
                            onClick={onClose}
                            className="text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] transition-colors"
                        >
                            <X size={13} />
                        </button>
                    </div>

                    {/* Body - Scrollable */}
                    <div className="px-3 pb-1 space-y-2.5 overflow-y-auto flex-1">
                        {/* Search (if many fields) */}
                        {availableFields.length > 10 && (
                            <div className="relative">
                                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--speckle-foreground-3)]" />
                                <input
                                    type="text"
                                    value={searchTerm}
                                    onChange={e => setSearchTerm(e.target.value)}
                                    placeholder="Search properties..."
                                    className={`${settingInputCls} pl-6`}
                                />
                            </div>
                        )}

                        {/* Field Selection - Grouped */}
                        <div className="flex flex-col gap-1">
                            <span className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Data Field</span>
                            <div className="glass rounded-md max-h-36 overflow-y-auto">
                                {/* Summary Fields */}
                                {filteredFields.summaryFields.length > 0 && (
                                    <div>
                                        <div className="px-2 py-1 text-[10px] font-medium text-[var(--speckle-outline-1)] bg-[var(--speckle-outline-1)]/10 sticky top-0 flex items-center gap-1">
                                            <Database className="w-2.5 h-2.5" />
                                            Summary
                                        </div>
                                        {filteredFields.summaryFields.map(field => (
                                            <button
                                                key={field.key}
                                                onClick={() => setSelectedField(field.key)}
                                                className={`w-full text-left px-2 py-1.5 text-[11px] hover:bg-[var(--speckle-outline-3)] transition-colors flex items-center justify-between ${selectedField === field.key ? 'bg-[var(--speckle-outline-1)]/20' : ''
                                                    }`}
                                            >
                                                <span className="truncate">{field.config.title}</span>
                                                <span className="text-[10px] text-[var(--speckle-foreground-3)] shrink-0 ml-1">{field.entryCount}</span>
                                            </button>
                                        ))}
                                    </div>
                                )}

                                {/* Dimensions (Numeric Properties) - Distribution Charts */}
                                {filteredFields.numericFields?.length > 0 && (
                                    <div>
                                        <div className="px-2 py-1 text-[10px] font-medium text-[var(--speckle-outline-1)] bg-[var(--speckle-outline-1)]/10 sticky top-0">
                                            📊 Elements by Dimension
                                        </div>
                                        {filteredFields.numericFields.map(field => (
                                            <button
                                                key={field.key}
                                                onClick={() => setSelectedField(field.key)}
                                                className={`w-full text-left px-2 py-1.5 text-[11px] hover:bg-[var(--speckle-outline-3)] transition-colors ${selectedField === field.key ? 'bg-[var(--speckle-outline-1)]/20' : ''
                                                    }`}
                                            >
                                                <div className="flex items-center justify-between">
                                                    <span className="truncate">{field.config.title}</span>
                                                    <span className="text-[10px] text-[var(--speckle-foreground-3)] shrink-0 ml-1">{field.entryCount}</span>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}

                                {/* Discovered Properties */}
                                {filteredFields.discoveredFields.length > 0 && (
                                    <div>
                                        <div className="px-2 py-1 text-[10px] font-medium text-[var(--speckle-outline-1)] bg-[var(--speckle-outline-1)]/10 sticky top-0 flex items-center gap-1">
                                            <Search className="w-2.5 h-2.5" />
                                            Discovered {!fullData && '(Loading...)'}
                                        </div>
                                        {filteredFields.discoveredFields.map(field => (
                                            <button
                                                key={field.key}
                                                onClick={() => setSelectedField(field.key)}
                                                className={`w-full text-left px-2 py-1.5 text-[11px] hover:bg-[var(--speckle-outline-3)] transition-colors ${selectedField === field.key ? 'bg-[var(--speckle-outline-1)]/20' : ''
                                                    }`}
                                            >
                                                <div className="flex items-center justify-between">
                                                    <span className="truncate">{field.config.title}</span>
                                                    <span className="text-[10px] text-[var(--speckle-foreground-3)] shrink-0 ml-1">{field.entryCount}</span>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}

                                {/* No results */}
                                {filteredFields.summaryFields.length === 0 && filteredFields.discoveredFields.length === 0 && (filteredFields.numericFields?.length || 0) === 0 && (
                                    <div className="px-2 py-4 text-center text-[var(--speckle-foreground-3)] text-[11px]">
                                        No fields found
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Chart Type Selection */}
                        <div className="flex flex-col gap-1">
                            <span className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Chart Type</span>
                            <div className="flex gap-1 flex-wrap">
                                {(selectedFieldData?.isNumeric ? NUMERIC_TYPES : CATEGORICAL_TYPES).map(({ type, label, icon: Icon }) => (
                                    <button
                                        key={type}
                                        onClick={() => setChartType(type)}
                                        className={`${settingBtnCls} flex items-center gap-1 ${chartType === type ? settingBtnActive : settingBtnInactive}`}
                                    >
                                        <Icon className="w-3 h-3" />
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Orientation (only for bar charts) */}
                        {chartType === 'bar' && (
                            <div className="flex flex-col gap-1">
                                <span className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Orientation</span>
                                <div className="flex gap-1">
                                    <button
                                        onClick={() => setOrientation('h')}
                                        className={`flex-1 ${settingBtnCls} flex items-center justify-center gap-1 ${orientation === 'h' ? settingBtnActive : settingBtnInactive}`}
                                    >
                                        <BarChart3 className="w-3 h-3" />
                                        Horizontal
                                    </button>
                                    <button
                                        onClick={() => setOrientation('v')}
                                        className={`flex-1 ${settingBtnCls} flex items-center justify-center gap-1 ${orientation === 'v' ? settingBtnActive : settingBtnInactive}`}
                                    >
                                        <BarChart3 className="w-3 h-3 rotate-90" />
                                        Vertical
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Custom Title */}
                        <div className="flex flex-col gap-1">
                            <span className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider flex items-center gap-1">
                                <Type className="w-2.5 h-2.5" />
                                Custom Title (optional)
                            </span>
                            <input
                                type="text"
                                value={customTitle}
                                onChange={e => setCustomTitle(e.target.value)}
                                placeholder={selectedFieldData?.config.title || 'Enter chart title...'}
                                className={settingInputCls}
                            />
                        </div>

                        {/* Preview indicator */}
                        {selectedField && (
                            <div className="glass rounded-md p-2">
                                <p className="text-[10px] text-[var(--speckle-foreground-3)] mb-1">Preview</p>
                                <div className="flex items-center gap-1.5">
                                    {chartType === 'pie'
                                        ? <PieChart className="w-3 h-3 text-[var(--speckle-outline-1)]" />
                                        : <BarChart3 className={`w-3 h-3 text-[var(--speckle-outline-1)] ${orientation === 'v' ? 'rotate-90' : ''}`} />
                                    }
                                    <span className="text-[11px] font-medium truncate">
                                        {customTitle || selectedFieldData?.config.title}
                                    </span>
                                    {selectedFieldData?.isDiscovered && (
                                        <span className="text-[10px] px-1 py-0.5 bg-[var(--speckle-outline-1)]/20 text-[var(--speckle-outline-1)] rounded shrink-0">
                                            Discovered
                                        </span>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex gap-2 px-3 pb-2.5 pt-1">
                        <button
                            onClick={onClose}
                            className={`flex-1 ${settingBtnCls} ${settingBtnInactive} justify-center`}
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleCreate}
                            disabled={!selectedField}
                            className={`flex-1 px-1.5 py-1 rounded-md text-[11px] font-medium transition-colors border flex items-center justify-center gap-1 ${selectedField
                                ? 'border-[var(--speckle-outline-1)] bg-[var(--speckle-outline-1)] text-white hover:opacity-90 cursor-pointer'
                                : 'border-[var(--speckle-outline-3)] bg-[var(--speckle-foundation)] text-[var(--speckle-foreground-3)] cursor-not-allowed'
                                }`}
                        >
                            <Check className="w-3 h-3" />
                            {initialConfig ? 'Update Chart' : 'Create Chart'}
                        </button>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>,
        document.body
    )
}
