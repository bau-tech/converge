import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Activity, Table, Layout, ShieldCheck, CalendarClock, Boxes, FileText, BarChart3, PieChart, Eye, EyeOff, Video, Filter } from 'lucide-react'
import { BcfLogoIcon } from './BcfLogoIcon'

// Same neutral icon/hover treatment as every other panel's list items
// (BcfTopicPanel's topic list, ChatWidget's message list, etc.) — a single
// consistent style instead of a different accent color per widget type.
const WIDGET_TYPES = [
    { type: 'table',      icon: Table,         label: 'Table' },
    { type: 'pivot',      icon: Layout,        label: 'Pivot' },
    { type: 'filter',     icon: Filter,        label: 'Filter Builder' },
    { type: 'validation', icon: ShieldCheck,   label: 'Validation' },
    { type: 'schedule',   icon: CalendarClock, label: '4D Schedule' },
    { type: 'quantities', icon: Boxes,         label: '5D Quantities' },
    { type: 'chart',      icon: Activity,      label: 'Custom Chart' },
    { type: 'text',       icon: FileText,      label: 'Notes' },
    { type: 'video',      icon: Video,         label: 'PeerTube Video' },
    { type: 'bcf_stats',  icon: BcfLogoIcon,   label: 'BCF Issue Stats' },
]

export function WidgetFAB({
    onAddWidget,
    disabled,
    availableCharts = [],
    visibleChartPanels = [],
    onToggleChart,
}) {
    const [open, setOpen] = useState(false)
    const [tab, setTab] = useState('charts') // 'charts' | 'widgets'

    const hasCharts = availableCharts.length > 0

    return (
        <div className="fixed bottom-6 left-6 z-[100000] flex flex-col items-start gap-3">
            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.92, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.92, y: 10 }}
                        transition={{ duration: 0.15 }}
                        className="panel-thin shadow-2xl overflow-hidden"
                        style={{ width: '240px' }}
                    >
                        {/* Tab bar */}
                        <div className="flex border-b border-[var(--speckle-outline-3)]">
                            <button
                                onClick={() => setTab('charts')}
                                className={`flex-1 text-xs py-2 font-medium transition-colors ${tab === 'charts' ? 'text-[var(--speckle-foreground)] border-b-2 border-[var(--speckle-outline-1)] -mb-px' : 'text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground-2)]'}`}
                            >
                                Charts
                            </button>
                            <button
                                onClick={() => setTab('widgets')}
                                className={`flex-1 text-xs py-2 font-medium transition-colors ${tab === 'widgets' ? 'text-[var(--speckle-foreground)] border-b-2 border-[var(--speckle-outline-1)] -mb-px' : 'text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground-2)]'}`}
                            >
                                Widgets
                            </button>
                        </div>

                        <div className="max-h-72 overflow-y-auto">
                            {tab === 'charts' && (
                                <div>
                                    {!hasCharts ? (
                                        <p className="text-xs text-[var(--speckle-foreground-3)] px-3 py-4 text-center">
                                            Load a model to see available charts
                                        </p>
                                    ) : (
                                        availableCharts.map(chart => {
                                            const isVisible = visibleChartPanels.includes(chart.key)
                                            return (
                                                <button
                                                    key={chart.key}
                                                    onClick={() => onToggleChart?.(chart.key)}
                                                    disabled={disabled}
                                                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition-colors disabled:opacity-40 text-left"
                                                >
                                                    {chart.config.type === 'pie'
                                                        ? <PieChart className="w-3.5 h-3.5 text-[var(--speckle-outline-4)] shrink-0" />
                                                        : <BarChart3 className="w-3.5 h-3.5 text-[var(--speckle-outline-1)] shrink-0" />
                                                    }
                                                    <span className="text-xs text-[var(--speckle-foreground-2)] flex-1 truncate">
                                                        {chart.config.title}
                                                    </span>
                                                    <span className="text-[10px] text-[var(--speckle-foreground-3)] mr-1">
                                                        {chart.entryCount}
                                                    </span>
                                                    {isVisible
                                                        ? <Eye className="w-3.5 h-3.5 text-[var(--speckle-outline-1)] shrink-0" />
                                                        : <EyeOff className="w-3.5 h-3.5 text-[var(--speckle-foreground-3)] shrink-0" />
                                                    }
                                                </button>
                                            )
                                        })
                                    )}
                                </div>
                            )}

                            {tab === 'widgets' && (
                                <div className="grid grid-cols-2 gap-1 p-2">
                                    {WIDGET_TYPES.map(({ type, icon: Icon, label }) => (
                                        <motion.button
                                            key={type}
                                            whileHover={{ scale: 1.02 }}
                                            whileTap={{ scale: 0.97 }}
                                            onClick={() => { onAddWidget(type); setOpen(false) }}
                                            disabled={disabled}
                                            className="flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed text-left border border-[var(--speckle-outline-3)]"
                                        >
                                            <Icon className="w-3.5 h-3.5 text-[var(--speckle-foreground-3)] shrink-0" />
                                            <span className="text-[var(--speckle-foreground-2)] text-xs">{label}</span>
                                        </motion.button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            <motion.button
                whileHover={{ scale: open ? 1 : 1.08 }}
                whileTap={{ scale: 0.94 }}
                onClick={() => setOpen(v => !v)}
                disabled={disabled}
                title={disabled ? 'Load a model first' : 'Add panels'}
                className="w-12 h-12 rounded-full border border-blue-500/40 backdrop-blur-md text-blue-400 shadow-lg hover:bg-blue-500/10 flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
                <motion.div animate={{ rotate: open ? 45 : 0 }} transition={{ duration: 0.18 }}>
                    <Plus className="w-8 h-8" />
                </motion.div>
            </motion.button>
        </div>
    )
}
