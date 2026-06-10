import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Settings, X, Eye, EyeOff, Type, Maximize2 } from 'lucide-react'

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
                className="glass-card p-2 hover:bg-white/10"
                title="Configure Metrics"
            >
                <Settings className="w-4 h-4" />
            </motion.button>

            {/* Modal */}
            <AnimatePresence>
                {isOpen && (
                    <>
                        {/* Backdrop */}
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setIsOpen(false)}
                            className="fixed inset-0 bg-black/70 z-50"
                        />

                        {/* Modal Content */}
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            className="fixed inset-0 z-50 flex items-center justify-center p-4"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="glass-card w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
                                {/* Header */}
                                <div className="flex items-center justify-between p-4 border-b border-white/10">
                                    <div className="flex items-center gap-2">
                                        <Settings className="w-5 h-5 text-cyan-500" />
                                        <h2 className="text-lg font-bold">Configure Metrics</h2>
                                    </div>
                                    <button
                                        onClick={() => setIsOpen(false)}
                                        className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                                    >
                                        <X className="w-5 h-5" />
                                    </button>
                                </div>

                                {/* Content */}
                                <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                                    <div className="space-y-3">
                                        {metrics.map((metric) => {
                                            const metricConfig = config[metric.key] || {}
                                            const isVisible = metricConfig.visible ?? true
                                            const displayName = metricConfig.displayName || ''
                                            const size = metricConfig.size || 'medium'

                                            return (
                                                <div
                                                    key={metric.key}
                                                    className={`glass-card transition-opacity ${!isVisible ? 'opacity-50' : ''}`}
                                                >
                                                    <div className="flex items-start gap-3">
                                                        {/* Visibility Toggle */}
                                                        <button
                                                            onClick={() => handleToggleVisibility(metric.key)}
                                                            className="p-2 hover:bg-white/10 rounded-lg transition-colors flex-shrink-0 mt-1"
                                                            title={isVisible ? 'Hide' : 'Show'}
                                                        >
                                                            {isVisible ? (
                                                                <Eye className="w-4 h-4 text-cyan-500" />
                                                            ) : (
                                                                <EyeOff className="w-4 h-4 text-zinc-500" />
                                                            )}
                                                        </button>

                                                        <div className="flex-1 min-w-0 space-y-2">
                                                            {/* Metric Name */}
                                                            <div>
                                                                <p className="text-xs text-zinc-500 mb-1">Metric Key</p>
                                                                <p className="text-sm font-mono text-zinc-400 truncate">
                                                                    {metric.key}
                                                                </p>
                                                            </div>

                                                            {/* Custom Display Name */}
                                                            <div>
                                                                <label className="text-xs text-zinc-500 mb-1 flex items-center gap-1">
                                                                    <Type className="w-3 h-3" />
                                                                    Custom Display Name
                                                                </label>
                                                                <input
                                                                    type="text"
                                                                    value={displayName}
                                                                    onChange={(e) => handleDisplayNameChange(metric.key, e.target.value)}
                                                                    placeholder={metric.displayKey || formatMetricName(metric.key)}
                                                                    className="w-full glass px-3 py-1.5 rounded text-sm focus:ring-1 focus:ring-cyan-500/50 transition-all"
                                                                    disabled={!isVisible}
                                                                />
                                                            </div>

                                                            {/* Size Selector */}
                                                            <div>
                                                                <label className="text-xs text-zinc-500 mb-1 flex items-center gap-1">
                                                                    <Maximize2 className="w-3 h-3" />
                                                                    Size
                                                                </label>
                                                                <div className="flex gap-2">
                                                                    {SIZE_OPTIONS.map(option => (
                                                                        <button
                                                                            key={option.value}
                                                                            onClick={() => handleSizeChange(metric.key, option.value)}
                                                                            disabled={!isVisible}
                                                                            className={`px-3 py-1 rounded text-xs font-medium transition-all ${size === option.value
                                                                                    ? 'bg-cyan-500/20 text-cyan-500 ring-1 ring-cyan-500/50'
                                                                                    : 'glass hover:bg-white/10'
                                                                                } ${!isVisible ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                                </div>

                                {/* Footer */}
                                <div className="flex items-center justify-between p-4 border-t border-white/10">
                                    <button
                                        onClick={handleReset}
                                        className="px-4 py-2 rounded-lg text-sm font-medium glass hover:bg-white/10 transition-colors"
                                    >
                                        Reset to Default
                                    </button>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setIsOpen(false)}
                                            className="px-4 py-2 rounded-lg text-sm font-medium glass hover:bg-white/10 transition-colors"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={handleSave}
                                            className="px-4 py-2 rounded-lg text-sm font-medium bg-cyan-500 hover:bg-cyan-600 transition-colors"
                                        >
                                            Save Changes
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    </>
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
