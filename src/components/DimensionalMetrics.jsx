import { motion, AnimatePresence } from 'framer-motion'
import { useMemo, useState, useEffect } from 'react'
import { Ruler, ArrowUpDown, TrendingUp, Hash, ChevronDown, BarChart3 } from 'lucide-react'
import { discoverNumericProperties, aggregateNumericProperty } from '../utils/propertyScanner'
import EChart from './EChart'
import { baseOption, categoryAxisStyle, valueAxisStyle } from '../lib/echartsTheme'
import { MetricsConfig } from './MetricsConfig'

// Format large numbers nicely
function formatNumber(value, decimals = 2) {
    if (value === undefined || value === null || !isFinite(value)) return '—'

    if (Math.abs(value) >= 1000000) {
        return (value / 1000000).toFixed(1) + 'M'
    }
    if (Math.abs(value) >= 1000) {
        return (value / 1000).toFixed(1) + 'K'
    }
    if (Number.isInteger(value)) {
        return value.toLocaleString()
    }
    return value.toFixed(decimals)
}

// Format property name
function formatName(path) {
    const parts = path.split('.')
    const lastName = parts[parts.length - 1]
    return lastName
        .replace(/([A-Z])/g, ' $1')
        .replace(/_/g, ' ')
        .trim()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ')
}

// Individual Dimension Card
function DimensionCard({ property, fullData, index, onExpand, isExpanded, config = {} }) {
    const stats = useMemo(() => {
        return aggregateNumericProperty(fullData, property.path)
    }, [fullData, property.path])

    const icon = property.isDimensional ? Ruler : Hash

    // Get configuration for this property
    const metricConfig = config[property.path] || {}
    const displayName = metricConfig.displayName || property.name
    const size = metricConfig.size || 'medium'

    // Size classes mapping
    const sizeClasses = {
        small: { label: 'text-[10px]', value: 'text-base' },
        medium: { label: 'text-xs', value: 'text-lg' },
        large: { label: 'text-sm', value: 'text-xl' }
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05 }}
            className="glass-card cursor-pointer hover:border-cyan-500/30 transition-all"
            onClick={() => onExpand(property.path)}
        >
            <div className="flex items-start justify-between">
                <div className="flex items-center gap-2 min-w-0">
                    <div className={`w-8 h-8 rounded-lg ${property.isDimensional ? 'bg-cyan-500/20' : 'bg-purple-500/20'} flex items-center justify-center flex-shrink-0`}>
                        {property.isDimensional
                            ? <Ruler className="w-4 h-4 text-cyan-500" />
                            : <Hash className="w-4 h-4 text-purple-500" />
                        }
                    </div>
                    <div className="min-w-0">
                        <p className={`text-zinc-500 truncate ${sizeClasses[size].label}`}>{displayName}</p>
                        <p className={`font-bold ${property.isDimensional ? 'text-cyan-500' : 'text-purple-500'} ${sizeClasses[size].value}`}>
                            {formatNumber(stats.sum)}
                        </p>
                    </div>
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-zinc-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
            </div>

            {/* Expanded Stats */}
            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mt-3 pt-3 border-t border-white/10"
                    >
                        <div className="grid grid-cols-3 gap-2">
                            <div className="text-center">
                                <p className="text-[10px] text-zinc-500">Average</p>
                                <p className="text-xs font-semibold text-green-400">{formatNumber(stats.average)}</p>
                            </div>
                            <div className="text-center">
                                <p className="text-[10px] text-zinc-500">Min</p>
                                <p className="text-xs font-semibold text-blue-400">{formatNumber(stats.min)}</p>
                            </div>
                            <div className="text-center">
                                <p className="text-[10px] text-zinc-500">Max</p>
                                <p className="text-xs font-semibold text-orange-400">{formatNumber(stats.max)}</p>
                            </div>
                        </div>
                        <div className="mt-2 text-center">
                            <p className="text-[10px] text-zinc-600">{stats.count} elements</p>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    )
}

// Dimension Distribution Chart
function DimensionChart({ property, fullData }) {
    const chartData = useMemo(() => {
        // Group by category for the chart
        const grouped = aggregateNumericProperty(fullData, property.path, 'category')

        const entries = Object.entries(grouped)
            .filter(([key]) => key !== 'Unknown' && key !== 'null')
            .sort((a, b) => b[1].sum - a[1].sum)
            .slice(0, 8)

        return {
            labels: entries.map(([key]) => key),
            values: entries.map(([, val]) => val.sum)
        }
    }, [fullData, property.path])

    if (chartData.labels.length === 0) return null

    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="glass-card"
        >
            <h4 className="text-xs font-semibold flex items-center gap-1.5 mb-2">
                <BarChart3 className="w-3.5 h-3.5 text-cyan-500" />
                {property.name} by Category
            </h4>
            <EChart
                option={{
                    ...baseOption({
                        fontSize: 10,
                        tooltipFormatter: (params) => `<b>${params.name}</b><br/>Total: ${params.value.toFixed(2)}`,
                    }),
                    textStyle: { color: '#a1a1aa', fontSize: 10, fontFamily: 'system-ui' },
                    grid: { left: 80, right: 10, top: 5, bottom: 25 },
                    xAxis: valueAxisStyle(),
                    yAxis: categoryAxisStyle({ data: chartData.labels }),
                    series: [{
                        type: 'bar',
                        data: chartData.values,
                        itemStyle: { color: '#0ea5e9' },
                    }],
                }}
                className="w-full"
                style={{ width: '100%', height: 180 }}
            />
        </motion.div>
    )
}

// Main Component
export function DimensionalMetrics({ fullData }) {
    const [expandedPath, setExpandedPath] = useState(null)
    const [showChart, setShowChart] = useState(null)

    // Configuration state with localStorage persistence
    const [metricsConfig, setMetricsConfig] = useState(() => {
        try {
            const stored = localStorage.getItem('dashboard-dimensional-metrics-config')
            return stored ? JSON.parse(stored) : {}
        } catch {
            return {}
        }
    })

    // Save configuration to localStorage
    useEffect(() => {
        localStorage.setItem('dashboard-dimensional-metrics-config', JSON.stringify(metricsConfig))
    }, [metricsConfig])

    // Discover numeric properties
    const allNumericProperties = useMemo(() => {
        if (!fullData) return []
        return discoverNumericProperties(fullData).slice(0, 12) // Limit to top 12
    }, [fullData])

    // Filter visible properties based on configuration
    const numericProperties = useMemo(() => {
        return allNumericProperties.filter(p => {
            const config = metricsConfig[p.path]
            return config?.visible !== false // Show by default
        })
    }, [allNumericProperties, metricsConfig])

    const handleConfigChange = (newConfig) => {
        setMetricsConfig(newConfig)
    }

    const handleExpand = (path) => {
        if (expandedPath === path) {
            setExpandedPath(null)
            setShowChart(null)
        } else {
            setExpandedPath(path)
            // Show chart for dimensional properties
            const prop = numericProperties.find(p => p.path === path)
            if (prop?.isDimensional) {
                setShowChart(path)
            } else {
                setShowChart(null)
            }
        }
    }

    if (!fullData || allNumericProperties.length === 0) {
        return null
    }

    // Separate dimensional and other numeric properties
    const dimensional = numericProperties.filter(p => p.isDimensional)
    const other = numericProperties.filter(p => !p.isDimensional)

    return (
        <div className="space-y-4">
            {/* Configuration Button */}
            <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-zinc-400">Dimensional Metrics</h3>
                <MetricsConfig
                    metrics={allNumericProperties.map(p => ({
                        key: p.path,
                        displayKey: p.name,
                        value: aggregateNumericProperty(fullData, p.path).sum
                    }))}
                    currentConfig={metricsConfig}
                    onConfigChange={handleConfigChange}
                />
            </div>

            {/* Dimensional Properties (Width, Height, Length, etc.) */}
            {dimensional.length > 0 && (
                <div>
                    <h3 className="text-xs font-semibold text-zinc-400 mb-2 flex items-center gap-1.5">
                        <Ruler className="w-3.5 h-3.5 text-cyan-500" />
                        Dimensions
                    </h3>
                    <div className="space-y-2">
                        {dimensional.map((prop, idx) => (
                            <DimensionCard
                                key={prop.path}
                                property={prop}
                                fullData={fullData}
                                index={idx}
                                onExpand={handleExpand}
                                isExpanded={expandedPath === prop.path}
                                config={metricsConfig}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* Chart for expanded dimensional property */}
            <AnimatePresence>
                {showChart && (
                    <DimensionChart
                        property={numericProperties.find(p => p.path === showChart)}
                        fullData={fullData}
                    />
                )}
            </AnimatePresence>

            {/* Other Numeric Properties */}
            {other.length > 0 && (
                <div>
                    <h3 className="text-xs font-semibold text-zinc-400 mb-2 flex items-center gap-1.5">
                        <TrendingUp className="w-3.5 h-3.5 text-purple-500" />
                        Other Measurements
                    </h3>
                    <div className="space-y-2">
                        {other.slice(0, 6).map((prop, idx) => (
                            <DimensionCard
                                key={prop.path}
                                property={prop}
                                fullData={fullData}
                                index={idx}
                                onExpand={handleExpand}
                                isExpanded={expandedPath === prop.path}
                                config={metricsConfig}
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}

export default DimensionalMetrics
