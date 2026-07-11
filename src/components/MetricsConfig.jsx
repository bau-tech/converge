import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Settings, X, Eye, EyeOff, Type, Maximize2 } from 'lucide-react'
import { settingBtnCls, settingBtnInactive, settingBtnActive, settingInputCls } from './chartSettingsUI'

// Size options for metrics
const SIZE_OPTIONS = [
    { value: 'small', label: 'Small', classes: 'text-sm' },
    { value: 'medium', label: 'Medium', classes: 'text-base' },
    { value: 'large', label: 'Large', classes: 'text-lg' }
]

export function MetricsConfig({ metrics, onConfigChange, currentConfig = {} }) {
    const [isOpen, setIsOpen] = useState(false)
    const [config, setConfig] = useState(currentConfig)

    useEffect(() => {
        setConfig(currentConfig)
    }, [currentConfig])

    const handleToggleVisibility = (metricKey) => {
        const newConfig = {
            ...config,
            [metricKey]: {
                ...config[metricKey],
                visible: !(config[metricKey]?.visible ?? true)
            }
        }
        setConfig(newConfig)
    }

    const handleDisplayNameChange = (metricKey, displayName) => {
        const newConfig = {
            ...config,
            [metricKey]: {
                ...config[metricKey],
                displayName: displayName || undefined
            }
        }
        setConfig(newConfig)
    }

    const handleSizeChange = (metricKey, size) => {
        const newConfig = {
            ...config,
            [metricKey]: {
                ...config[metricKey],
                size: size
            }
        }
        setConfig(newConfig)
    }

    const handleSave = () => {
        onConfigChange(config)
        setIsOpen(false)
    }

    const handleReset = () => {
        setConfig({})
        onConfigChange({})
    }

    return (
        <>
            {/* Settings Button */}
            <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setIsOpen(true)}
                className="glass-card icon-btn hover:bg-[var(--speckle-outline-3)]"
                title="Configure Metrics"
            >
                <Settings className="w-3.5 h-3.5" />
            </motion.button>

            {/* Modal — same structure/tokens as ChartBuilder.jsx's modal for visual consistency */}
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
                        onClick={() => setIsOpen(false)}
                    >
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            className="panel-thin shadow-2xl w-full max-w-md max-h-[70vh] overflow-hidden flex flex-col"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {/* Header */}
                            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--speckle-outline-3)]">
                                <div className="flex items-center gap-1.5">
                                    <Settings className="w-3.5 h-3.5 text-[var(--speckle-outline-1)]" />
                                    <h2 className="text-xs font-medium">Configure Metrics</h2>
                                </div>
                                <button
                                    onClick={() => setIsOpen(false)}
                                    className="p-1 hover:bg-[var(--speckle-outline-3)] rounded transition-colors"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </div>

                            {/* Content */}
                            <div className="flex-1 overflow-y-auto p-2 space-y-1.5 custom-scrollbar">
                                {metrics.map((metric) => {
                                    const metricConfig = config[metric.key] || {}
                                    const isVisible = metricConfig.visible ?? true
                                    const displayName = metricConfig.displayName || ''
                                    const size = metricConfig.size || 'medium'

                                    return (
                                        <div
                                            key={metric.key}
                                            className={`glass rounded-md p-2 transition-opacity ${!isVisible ? 'opacity-50' : ''}`}
                                        >
                                            <div className="flex items-start gap-2">
                                                {/* Visibility Toggle */}
                                                <button
                                                    onClick={() => handleToggleVisibility(metric.key)}
                                                    className="p-1 hover:bg-[var(--speckle-outline-3)] rounded transition-colors flex-shrink-0"
                                                    title={isVisible ? 'Hide' : 'Show'}
                                                >
                                                    {isVisible ? (
                                                        <Eye className="w-3.5 h-3.5 text-[var(--speckle-outline-1)]" />
                                                    ) : (
                                                        <EyeOff className="w-3.5 h-3.5 text-[var(--speckle-foreground-3)]" />
                                                    )}
                                                </button>

                                                <div className="flex-1 min-w-0 space-y-1.5">
                                                    {/* Metric Name */}
                                                    <div>
                                                        <p className="text-[9px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Metric Key</p>
                                                        <p className="text-xs font-mono text-[var(--speckle-foreground-2)] truncate">
                                                            {metric.key}
                                                        </p>
                                                    </div>

                                                    {/* Custom Display Name */}
                                                    <div>
                                                        <label className="text-[9px] text-[var(--speckle-foreground-3)] uppercase tracking-wider mb-0.5 flex items-center gap-1">
                                                            <Type className="w-2.5 h-2.5" />
                                                            Custom Display Name
                                                        </label>
                                                        <input
                                                            type="text"
                                                            value={displayName}
                                                            onChange={(e) => handleDisplayNameChange(metric.key, e.target.value)}
                                                            placeholder={metric.displayKey || formatMetricName(metric.key)}
                                                            className={settingInputCls}
                                                            disabled={!isVisible}
                                                        />
                                                    </div>

                                                    {/* Size Selector */}
                                                    <div>
                                                        <label className="text-[9px] text-[var(--speckle-foreground-3)] uppercase tracking-wider mb-0.5 flex items-center gap-1">
                                                            <Maximize2 className="w-2.5 h-2.5" />
                                                            Size
                                                        </label>
                                                        <div className="flex gap-1">
                                                            {SIZE_OPTIONS.map(option => (
                                                                <button
                                                                    key={option.value}
                                                                    onClick={() => handleSizeChange(metric.key, option.value)}
                                                                    disabled={!isVisible}
                                                                    className={`flex-1 ${settingBtnCls} ${size === option.value ? settingBtnActive : settingBtnInactive} ${!isVisible ? 'opacity-50 cursor-not-allowed' : ''}`}
                                                                >
                                                                    {option.label}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>

                            {/* Footer */}
                            <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-[var(--speckle-outline-3)] bg-[var(--speckle-foundation)]/30">
                                <button
                                    onClick={handleReset}
                                    className="px-2.5 py-1 rounded-md border border-[var(--speckle-outline-3)] hover:bg-[var(--speckle-outline-3)] transition-colors text-[11px]"
                                >
                                    Reset to Default
                                </button>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setIsOpen(false)}
                                        className="px-2.5 py-1 rounded-md border border-[var(--speckle-outline-3)] hover:bg-[var(--speckle-outline-3)] transition-colors text-[11px]"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={handleSave}
                                        className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-[var(--speckle-outline-1)] text-white hover:opacity-90 transition-all"
                                    >
                                        Save Changes
                                    </button>
                                </div>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    )
}

// Helper function to format metric name
function formatMetricName(key) {
    return key
        .replace(/_/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
}
