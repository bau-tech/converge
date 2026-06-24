import { useMemo } from 'react'
import EChart from './EChart'
import { baseOption, legendStyle } from '../lib/echartsTheme'
import { COLUMNS, COLUMN_HEX, topicToColumn, PRIORITY_COLOR, isOverdue } from '../utils/bcfWorkflow'

function Tile({ label, value, warn }) {
    return (
        <div className="rounded-lg bg-[var(--speckle-outline-3)] px-2 py-2 text-center">
            <div className={`text-lg font-bold ${warn ? 'text-red-400' : 'text-[var(--speckle-foreground)]'}`}>{value}</div>
            <div className="text-[9px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">{label}</div>
        </div>
    )
}

// Statistics over the same BCF topics shown in BcfTopicPanel/BcfKanbanBoard
// — no separate fetch, just a different view over `bcfTopics`.
export function BcfStatsWidget({ topics = [], darkMode = true, displayOptions = {} }) {
    const showLegend = displayOptions.showLegend ?? true
    const showLabels = displayOptions.showLabels ?? true
    const donut = displayOptions.donut ?? true
    const labelFontSize = displayOptions.labelFontSize || 10
    const labelFontColor = displayOptions.labelFontColor || (darkMode ? '#e4e4e7' : '#000000')
    const showLabelName = displayOptions.pieLabelName !== false
    const showLabelValue = displayOptions.pieLabelValue !== false
    const showLabelPercent = displayOptions.pieLabelPercent !== false
    const showLeaderLine = displayOptions.pieLeaderLine !== false
    const showSummaryTiles = displayOptions.showSummaryTiles ?? true
    const showPriorityChips = displayOptions.showPriorityChips ?? true

    const formatLabel = (params) => {
        const parts = []
        if (showLabelValue) parts.push(`${params.value}`)
        if (showLabelPercent) parts.push(`(${params.percent}%)`)
        const tail = parts.join(' ')
        if (showLabelName && tail) return `${params.name}: ${tail}`
        if (showLabelName) return params.name
        return tail || params.name
    }

    const stats = useMemo(() => {
        const byColumn = {}
        COLUMNS.forEach(c => { byColumn[c] = 0 })
        const byPriority = {}
        let overdue = 0
        topics.forEach(t => {
            const col = topicToColumn(t)
            byColumn[col] += 1
            const p = t.priority || 'Unset'
            byPriority[p] = (byPriority[p] || 0) + 1
            if (isOverdue(t)) overdue += 1
        })
        return {
            total: topics.length,
            done: byColumn.Done,
            open: topics.length - byColumn.Done,
            overdue,
            byColumn,
            byPriority,
        }
    }, [topics])

    const chartOption = useMemo(() => ({
        ...baseOption({ darkMode, tooltipFormatter: '{b}: {c} ({d}%)' }),
        legend: legendStyle({ show: showLegend, darkMode, bottom: 0, itemWidth: 10, itemHeight: 10 }),
        series: [{
            type: 'pie',
            radius: donut ? ['42%', '70%'] : '70%',
            center: ['50%', '42%'],
            avoidLabelOverlap: true,
            label: {
                show: showLabels,
                position: 'outside',
                formatter: formatLabel,
                fontSize: labelFontSize,
                color: labelFontColor,
            },
            labelLine: { show: showLabels && showLeaderLine },
            data: COLUMNS
                .filter(c => stats.byColumn[c] > 0)
                .map(c => ({ name: c, value: stats.byColumn[c], itemStyle: { color: COLUMN_HEX[c] } })),
        }],
    }), [stats, darkMode, showLegend, donut, showLabels, showLeaderLine, labelFontSize, labelFontColor, showLabelName, showLabelValue, showLabelPercent])

    if (topics.length === 0) {
        return (
            <div className="h-full flex items-center justify-center text-xs text-[var(--speckle-foreground-3)]">
                No BCF issues yet
            </div>
        )
    }

    return (
        <div className="h-full flex flex-col gap-3">
            {showSummaryTiles && (
                <div className="grid grid-cols-4 gap-2 shrink-0">
                    <Tile label="Total" value={stats.total} />
                    <Tile label="Open" value={stats.open} />
                    <Tile label="Done" value={stats.done} />
                    <Tile label="Overdue" value={stats.overdue} warn={stats.overdue > 0} />
                </div>
            )}
            <div className="flex-1 min-h-0">
                <EChart option={chartOption} />
            </div>
            {showPriorityChips && (
                <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                    {Object.entries(stats.byPriority).map(([p, count]) => (
                        <span key={p} className={`text-[10px] px-1.5 py-0.5 rounded ${PRIORITY_COLOR[p] || 'bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]'}`}>
                            {p}: {count}
                        </span>
                    ))}
                </div>
            )}
        </div>
    )
}
