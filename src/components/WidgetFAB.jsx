import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Activity, Table, Layout, ShieldCheck, CalendarClock, Boxes, FileText, BarChart3, PieChart, Eye, EyeOff, Video } from 'lucide-react'

const WIDGET_TYPES = [
    { type: 'table',      icon: Table,         label: 'Table',         color: 'text-zinc-300',    bg: 'hover:bg-white/5' },
    { type: 'pivot',      icon: Layout,        label: 'Pivot',         color: 'text-zinc-300',    bg: 'hover:bg-white/5' },
    { type: 'validation', icon: ShieldCheck,   label: 'Validation',    color: 'text-emerald-400', bg: 'hover:bg-emerald-500/10' },
    { type: 'schedule',   icon: CalendarClock, label: '4D Schedule',   color: 'text-amber-400',   bg: 'hover:bg-amber-500/10' },
    { type: 'quantities', icon: Boxes,         label: '5D Quantities', color: 'text-emerald-400', bg: 'hover:bg-emerald-500/10' },
    { type: 'chart',      icon: Activity,      label: 'Custom Chart',  color: 'text-blue-400',    bg: 'hover:bg-blue-500/10' },
    { type: 'text',       icon: FileText,      label: 'Notes',         color: 'text-zinc-400',    bg: 'hover:bg-white/5' },
    { type: 'video',      icon: Video,         label: 'PeerTube Video',color: 'text-rose-400',    bg: 'hover:bg-rose-500/10' },
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
        <div className="fixed bottom-6 left-6 z-50 flex flex-col items-start gap-3">
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
                                                        ? <PieChart className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                                                        : <BarChart3 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
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
                                    {WIDGET_TYPES.map(({ type, icon: Icon, label, color, bg }) => (
                                        <motion.button
                                            key={type}
                                            whileHover={{ scale: 1.02 }}
                                            whileTap={{ scale: 0.97 }}
                                            onClick={() => { onAddWidget(type); setOpen(false) }}
                                            disabled={disabled}
                                            className={`flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors ${bg} disabled:opacity-40 disabled:cursor-not-allowed text-left border border-[var(--speckle-outline-3)]`}
                                        >
                                            <Icon className={`w-3.5 h-3.5 ${color} shrink-0`} />
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
                className="w-12 h-12 rounded-full shadow-xl flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'linear-gradient(135deg, #136CFF 0%, #4B40C9 100%)' }}
            >
                <motion.div animate={{ rotate: open ? 45 : 0 }} transition={{ duration: 0.18 }}>
                    <Plus className="w-6 h-6 text-white" />
                </motion.div>
            </motion.button>
        </div>
    )
}
