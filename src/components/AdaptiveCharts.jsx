import Plot from 'react-plotly.js'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Plus, ChevronDown, BarChart3, PieChart, Sparkles, GripVertical, Pencil, Pin, Settings2 } from 'lucide-react'
import { useState, useEffect, useMemo, useRef } from 'react'
import { ChartBuilder } from './ChartBuilder'
import { discoverProperties, aggregateProperty, discoverNumericProperties, aggregateNumericProperty, createHistogramBins } from '../utils/propertyScanner'
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// Color palettes for different chart types (Vibrant/Neon for Dark Mode)
const COLOR_PALETTES = {
    // Speckle Intelligence style: Vibrant Purples, Pinks, Blues
    bar: [
        '#A855F7', // Purple
        '#D946EF', // Pink
        '#EC4899', // Pink-Rose
        '#8B5CF6', // Violet
        '#6366F1', // Indigo
        '#3B82F6', // Blue
        '#0EA5E9', // Sky
    ],
    pie: [
        '#3B82F6', // Blue (Primary)
        '#EC4899', // Pink
        '#F59E0B', // Amber
        '#10B981', // Emerald
        '#8B5CF6', // Violet
        '#0EA5E9', // Sky
        '#F43F5E', // Rose
        '#6366F1'  // Indigo
    ],
    highlight: '#Facc15' // Yellow for selection
}

// ... (CHART_CONFIG remains distinct)
export const CHART_CONFIG = {
    // Core groupings — all sources
    by_category:     { type: 'bar', title: 'Elements by Category',   orientation: 'h', clickable: true, field: 'category' },
    by_ifc_type:     { type: 'bar', title: 'IFC Element Types',      orientation: 'h', clickable: true, field: 'ifc_type' },
    by_discipline:   { type: 'pie', title: 'Discipline Distribution', clickable: true, field: 'discipline' },
    by_level:        { type: 'bar', title: 'Elements by Level',      orientation: 'v', clickable: true, field: 'level' },
    by_family:       { type: 'pie', title: 'Distribution by Family', clickable: true, field: 'family' },
    by_type:         { type: 'pie', title: 'Distribution by Type',   clickable: true, field: 'type' },
    // Material & grade
    by_material:     { type: 'pie', title: 'Materials',              clickable: true, field: 'material' },
    by_grade:        { type: 'bar', title: 'Material Grades',        orientation: 'h', clickable: true, field: 'grade_short' },
    // Steel / structural
    by_profile:      { type: 'bar', title: 'Steel Profiles',         orientation: 'h', clickable: true, field: 'profile_name' },
    by_section_class:{ type: 'pie', title: 'Section Classes',        clickable: true, field: 'profile_type' },
    // Source-specific (appear only when data is present)
    by_phase:        { type: 'bar', title: 'Elements by Phase',      orientation: 'h', clickable: true, field: 'phase' },
    by_workset:      { type: 'bar', title: 'Worksets',               orientation: 'h', clickable: true, field: 'workset' },
    by_status:       { type: 'pie', title: 'Status Distribution',    clickable: true, field: 'status' },
    // Data quality
    by_validation_issues: { type: 'bar', title: 'Data Quality Issues', orientation: 'h', clickable: false, field: null },
    // 5D quantity charts — volume/area instead of count
    by_ifc_class_vol:  { type: 'bar', title: 'Volume by IFC Class (m³)',  orientation: 'h', clickable: true, field: 'ifc_type',  unit: 'm³' },
    by_storey_vol:     { type: 'bar', title: 'Volume by Storey (m³)',      orientation: 'h', clickable: true, field: 'level',    unit: 'm³' },
    by_category_area:  { type: 'bar', title: 'Area by Category (m²)',      orientation: 'h', clickable: true, field: 'category', unit: 'm²' },
}

// Default config for unknown fields
const DEFAULT_CONFIG = { type: 'bar', orientation: 'h', clickable: false }

// Plotly layout base with animations and Dark Theme
const getPlotlyLayout = (height = 300, darkMode = true) => ({
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: darkMode ? '#e4e4e7' : '#18181b', size: 11, family: 'Inter, system-ui, sans-serif' },
    margin: { l: 60, r: 20, t: 30, b: 40 },
    hoverlabel: {
        bgcolor: darkMode ? '#18181b' : '#ffffff',
        bordercolor: darkMode ? '#3f3f46' : '#e4e4e7',
        font: { color: darkMode ? '#fafafa' : '#18181b', family: 'monospace' }
    },
    height,
    autosize: true,
    xaxis: {
        gridcolor: darkMode ? '#27272a' : '#e4e4e7',
        zerolinecolor: darkMode ? '#3f3f46' : '#d4d4d8',
        tickfont: { color: darkMode ? '#e4e4e7' : '#18181b' }
    },
    yaxis: {
        gridcolor: darkMode ? '#27272a' : '#e4e4e7',
        zerolinecolor: darkMode ? '#3f3f46' : '#d4d4d8',
        tickfont: { color: darkMode ? '#e4e4e7' : '#18181b' }
    },
    transition: {
        duration: 650,
        easing: 'cubic-in-out',
        ordering: 'traces first',
    },
})

// ... (discoverChartFields and formatFieldName remain the same)
export function discoverChartFields(summary) {
    if (!summary) return []

    const fields = []

    for (const [key, value] of Object.entries(summary)) {
        if (typeof value !== 'object' || value === null) continue
        if (key === 'total_elements' || key === 'totals') continue

        const entries = Object.entries(value)
        if (entries.length > 0 && entries.every(([k, v]) => typeof v === 'number')) {
            const config = CHART_CONFIG[key] || {
                ...DEFAULT_CONFIG,
                title: formatFieldName(key),
                field: typeof key === 'string' ? key.replace('by_', '') : key
            }

            fields.push({
                key,
                data: value,
                config,
                entryCount: entries.length
            })
        }
    }

    return fields.sort((a, b) => b.entryCount - a.entryCount)
}

function formatFieldName(key) {
    if (!key || typeof key !== 'string') return String(key ?? '')
    return key
        .replace(/^by_/, '')
        .replace(/_/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r},${g},${b},${alpha})`
}

// Prepare data for bar chart
// Values that add no information — skip in every chart
const EMPTY_KEYS = new Set(['Unknown', '', 'null', 'None', 'undefined', '-', 'N/A'])
const isEmptyKey = (k) => EMPTY_KEYS.has(k) || (typeof k === 'string' && k.trim() === '')

// Resolve color palette from scheme name or fall back to default
function resolveColors(scheme) {
    const palettes = {
        default: COLOR_PALETTES.bar,
        emerald: ['#10B981','#34D399','#6EE7B7','#059669','#047857','#065F46','#064E3B'],
        blue:    ['#3B82F6','#60A5FA','#93C5FD','#2563EB','#1D4ED8','#1E40AF','#1E3A8A'],
        amber:   ['#F59E0B','#FBBF24','#FCD34D','#D97706','#B45309','#92400E','#78350F'],
        rose:    ['#F43F5E','#FB7185','#FDA4AF','#E11D48','#BE123C','#9F1239','#881337'],
    }
    return palettes[scheme] || COLOR_PALETTES.bar
}

function sortEntries(entries, sortOrder) {
    switch (sortOrder) {
        case 'asc':  return [...entries].sort((a, b) => a[1] - b[1])
        case 'az':   return [...entries].sort((a, b) => a[0].localeCompare(b[0]))
        case 'za':   return [...entries].sort((a, b) => b[0].localeCompare(a[0]))
        default:     return [...entries].sort((a, b) => b[1] - a[1])  // desc
    }
}

function prepareBarData(data, config, highlightedValue) {
    const minCount = config.minCount || 0
    const entries = Object.entries(data).filter(([key]) => !isEmptyKey(key) && (minCount === 0 || Number(data[key]) >= minCount))
    const sorted = sortEntries(entries, config.sortOrder).slice(0, config.maxItems || 15)

    const isHorizontal = config.orientation !== 'v'
    const unit = config.unit || null
    const valueLabel = unit === 'm³' ? 'Volume' : unit === 'm²' ? 'Area' : 'Count'
    const formatVal = v => unit ? v.toFixed(2) : v
    const palette = resolveColors(config.colorScheme)
    const showLabels = config.showLabels !== false

    return {
        type: 'bar',
        x: isHorizontal ? sorted.map(d => d[1]) : sorted.map(d => d[0]),
        y: isHorizontal ? sorted.map(d => d[0]) : sorted.map(d => d[1]),
        orientation: isHorizontal ? 'h' : 'v',
        marker: {
            color: sorted.map((d, idx) => {
                const base = palette[idx % palette.length]
                if (!highlightedValue) return base
                if (d[0] === highlightedValue) return COLOR_PALETTES.highlight
                return hexToRgba(base, 0.25)
            }),
            line: {
                color: sorted.map(d => d[0] === highlightedValue ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.1)'),
                width: sorted.map(d => d[0] === highlightedValue ? 2 : 1)
            }
        },
        text: showLabels ? sorted.map(d => unit ? `${formatVal(d[1])} ${unit}` : d[1]) : [],
        textposition: showLabels ? 'auto' : 'none',
        textfont: { size: config.valueFontSize || 11, color: config.valueFontColor || '#e4e4e7' },
        hovertemplate: isHorizontal
            ? `<b>%{y}</b><br>${valueLabel}: %{x}${unit ? ' ' + unit : ''}<extra></extra>`
            : `<b>%{x}</b><br>${valueLabel}: %{y}${unit ? ' ' + unit : ''}<extra></extra>`
    }
}

// Prepare data for pie chart
function preparePieData(data, config, highlightedValue) {
    const minCount = config.minCount || 0
    const entries = Object.entries(data).filter(([key]) => !isEmptyKey(key) && (minCount === 0 || Number(data[key]) >= minCount))
    const sorted = sortEntries(entries, config.sortOrder).slice(0, config.maxItems || 8)
    const palette = resolveColors(config.colorScheme)
    const showLabels = config.showLabels !== false
    const donut = config.donut !== false  // default true (donut style)

    return {
        type: 'pie',
        labels: sorted.map(d => d[0]),
        values: sorted.map(d => d[1]),
        marker: {
            colors: sorted.map((d, idx) => {
                const base = palette[idx % palette.length]
                if (!highlightedValue) return base
                if (d[0] === highlightedValue) return COLOR_PALETTES.highlight
                return hexToRgba(base, 0.35)
            }),
            line: { color: '#18181b', width: 2 }
        },
        pull: sorted.map(d => d[0] === highlightedValue ? 0.2 : 0),
        hole: donut ? 0.5 : 0,
        textposition: showLabels ? 'outside' : 'none',
        textinfo: showLabels ? 'label+percent' : 'none',
        textfont: { size: config.labelFontSize || 11, color: config.labelFontColor || '#e4e4e7' },
        automargin: true,
        hovertemplate: '<b>%{label}</b><br>Count: %{value}<br>%{percent}<extra></extra>'
    }
}

// ... (Rest of data prep functions mostly same)
function getRawValues(fullData, path) {
    if (!fullData?.elements) return []
    const values = []

    // Helper to get nested value
    const getVal = (obj, p) => {
        const parts = p.split('.')
        let current = obj
        for (const part of parts) {
            if (current === null || current === undefined) return undefined
            current = current[part]
        }
        return current
    }

    fullData.elements.forEach(el => {
        const val = getVal(el, path)
        if (typeof val === 'number') values.push(val)
    })
    return values
}

function prepareHierarchicalData(data, config, highlightedValue) {
    const entries = Object.entries(data)
        .filter(([key]) => !isEmptyKey(key))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)

    return {
        type: config.type,
        labels: entries.map(d => d[0]),
        parents: entries.map(() => ''),
        values: entries.map(d => d[1]),
        textinfo: 'label+value',
        branchvalues: 'total',
        marker: {
            colors: entries.map((d, idx) =>
                d[0] === highlightedValue ? COLOR_PALETTES.highlight : COLOR_PALETTES.pie[idx % COLOR_PALETTES.pie.length]
            )
        },
        hovertemplate: '<b>%{label}</b><br>Count: %{value}<extra></extra>'
    }
}

function prepareHistogramData(data, config) {
    return {
        type: 'histogram',
        x: data,
        marker: {
            color: COLOR_PALETTES.bar[0],
            line: {
                color: 'rgba(255,255,255,0.2)',
                width: 1
            }
        },
        opacity: 0.8,
        hovertemplate: 'Range: %{x}<br>Count: %{y}<extra></extra>'
    }
}

function prepareStatisticalData(data, config) {
    return {
        type: config.type,
        y: data,
        boxpoints: 'all',
        jitter: 0.3,
        pointpos: -1.8,
        marker: { color: COLOR_PALETTES.pie[1], size: 2 },
        line: { color: COLOR_PALETTES.pie[1] },
        fillcolor: COLOR_PALETTES.pie[1] + '33',
        hovertemplate: 'Value: %{y}<extra></extra>'
    }
}

// Returns zero-valued version of chart data for the fill-up animation start frame
function buildZeroData(chartData, config) {
    if (!chartData) return chartData
    if (config.type === 'bar') {
        const valueKey = config.orientation === 'h' ? 'x' : 'y'
        return {
            ...chartData,
            [valueKey]: Array.isArray(chartData[valueKey]) ? chartData[valueKey].map(() => 0) : 0,
            text: chartData.text?.map?.(() => ''),
        }
    }
    if (config.type === 'pie') {
        return {
            ...chartData,
            values: chartData.values?.map(() => 1) ?? [],
            pull: chartData.pull?.map(() => 0) ?? [],
        }
    }
    if (config.type === 'sunburst' || config.type === 'treemap') {
        return { ...chartData, values: chartData.values?.map(() => 0) ?? [] }
    }
    return chartData
}

// Dynamic Chart Component with Remove Button
export function DynamicChart({
    fieldKey,
    data,
    config,
    highlightedValue,
    viewerSelectedElement,
    onValueClick,
    fullDataReady,
    onRemove,
    onEdit,
    dragHandleProps,
    isPinned = false,
    onTogglePin,
    height,
    span,
    onResize,
    // Standalone panel mode: thin header as drag handle, bar/pie toggle always visible
    standalone = false,
    onHide,
    darkMode = true,
}) {
    // Chart type is now controlled entirely by the config prop.
    // In standalone mode DashboardGrid passes an updated config when the user
    // clicks a chart-type toggle button — no internal state needed.
    const effectiveConfig = config

    // Derive a highlight from the viewer-selected element for this chart's specific field.
    // Chart filter (highlightedValue) takes priority; viewer selection is secondary.
    const viewerDerivedValue = (!highlightedValue && viewerSelectedElement && effectiveConfig.field)
        ? (viewerSelectedElement[effectiveConfig.field] != null ? String(viewerSelectedElement[effectiveConfig.field]) : null)
        : null
    const effectiveHighlightedValue = highlightedValue || viewerDerivedValue

    // Fill-up animation: revision drives Plotly.react(); filled controls zero→real data swap.
    const [filled, setFilled] = useState(false)
    const [rev, setRev] = useState(0)

    useEffect(() => {
        setFilled(false)
        setRev(r => r + 1)
        // Double-RAF guarantees the browser painted the zero state before animating
        let raf1, raf2
        raf1 = requestAnimationFrame(() => {
            raf2 = requestAnimationFrame(() => {
                setFilled(true)
                setRev(r => r + 1)
            })
        })
        return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2) }
    }, [fieldKey])

    // Bump revision when highlight changes so Plotly transitions the colour swap
    useEffect(() => {
        if (filled) setRev(r => r + 1)
    }, [effectiveHighlightedValue])


    let chartData
    let layoutHeight = height || 250 // Use passed height or default
    const [isResizing, setIsResizing] = useState(false)

    switch (effectiveConfig.type) {
        case 'pie':
            chartData = preparePieData(data, effectiveConfig, effectiveHighlightedValue)
            layoutHeight = 300
            break
        case 'sunburst':
        case 'treemap':
            chartData = prepareHierarchicalData(data, effectiveConfig, effectiveHighlightedValue)
            layoutHeight = 300
            break
        case 'histogram':
            chartData = prepareHistogramData(data, effectiveConfig)
            break
        case 'box':
        case 'violin':
            chartData = prepareStatisticalData(data, effectiveConfig)
            break
        case 'bar':
        default:
            chartData = prepareBarData(data, effectiveConfig, effectiveHighlightedValue)
            break
    }

    const isPieLike    = ['pie', 'sunburst', 'treemap'].includes(effectiveConfig.type)
    const isStatistical= ['box', 'violin', 'histogram'].includes(effectiveConfig.type)
    const isVerticalBar= effectiveConfig.type === 'bar' && effectiveConfig.orientation === 'v'

    // Typography settings from chart properties panel
    const tickFontSize   = effectiveConfig.tickFontSize   || 11
    const tickFontColor  = effectiveConfig.tickFontColor  || (darkMode ? '#e4e4e7' : '#18181b')
    const tickAngle      = effectiveConfig.tickAngle      ?? (isVerticalBar ? -45 : 0)
    const valueFontSize  = effectiveConfig.valueFontSize  || 11
    const valueFontColor = effectiveConfig.valueFontColor || (darkMode ? '#e4e4e7' : '#18181b')
    const labelFontSize  = effectiveConfig.labelFontSize  || 11
    const labelFontColor = effectiveConfig.labelFontColor || (darkMode ? '#e4e4e7' : '#18181b')

    const tickFont = { color: tickFontColor, size: tickFontSize }

    const layout = {
        ...getPlotlyLayout(layoutHeight, darkMode),
        margin: isVerticalBar
            ? { l: 40, r: 20, t: 30, b: tickAngle === 0 ? 40 : tickAngle <= -45 ? 80 : 60 }
            : { l: 60, r: 20, t: 30, b: 40 },
        showlegend: false,
        xaxis: isPieLike ? {} : {
            ...getPlotlyLayout(300, darkMode).xaxis,
            title: '',
            tickangle: isVerticalBar ? tickAngle : 0,
            automargin: isVerticalBar,
            tickfont: tickFont,
        },
        yaxis: isPieLike ? {} : {
            ...getPlotlyLayout(300, darkMode).yaxis,
            title: '',
            automargin: true,
            tickfont: tickFont,
        },
        // Pie slice label font
        ...(isPieLike ? { legend: { font: { size: labelFontSize } } } : {}),
        uniformtext: isPieLike ? { mode: 'hide', minsize: labelFontSize } : undefined,
        transition: isResizing ? { duration: 0 } : getPlotlyLayout(300, darkMode).transition
    }

    // Cleanup ref for any active resize drag — called on unmount to prevent
    // orphaned document-level listeners if the panel is removed mid-drag.
    const resizeCleanupRef = useRef(null)
    useEffect(() => () => resizeCleanupRef.current?.(), [])

    const handleResizeStart = (e) => {
        e.preventDefault()
        e.stopPropagation() // Prevent drag-and-drop sort
        setIsResizing(true)

        const startY = e.clientY
        const startX = e.clientX
        const startHeight = layoutHeight
        const startSpan = span || 1

        const SPAN_THRESHOLD = 80
        let currentSpan = startSpan

        const cleanup = () => {
            document.removeEventListener('mousemove', handleMouseMove)
            document.removeEventListener('mouseup', handleMouseUp)
            resizeCleanupRef.current = null
        }

        const handleMouseMove = (moveEvent) => {
            const deltaY = moveEvent.clientY - startY
            const newHeight = Math.max(150, startHeight + deltaY)

            const deltaX = moveEvent.clientX - startX
            if (currentSpan === 1 && deltaX > SPAN_THRESHOLD) currentSpan = 2
            else if (currentSpan === 2 && deltaX < -SPAN_THRESHOLD) currentSpan = 1

            if (onResize) onResize(newHeight, currentSpan)
        }

        const handleMouseUp = () => {
            setIsResizing(false)
            cleanup()
        }

        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', handleMouseUp)
        resizeCleanupRef.current = cleanup
    }

    const handleClick = (plotData) => {
        if (!effectiveConfig.clickable || !fullDataReady || !onValueClick || isStatistical) return

        const point = plotData.points[0]
        const value = isPieLike
            ? point.label
            : effectiveConfig.orientation === 'h' ? point.y : point.x

        onValueClick(effectiveConfig.field, value)
    }

    // ── Standalone panel mode (individual grid panel) ──────────────────
    if (standalone) {
        // Strip the fixed `height` value so autosize:true actually fills the container.
        // Keeping an explicit height overrides autosize and pins the chart at 250px.
        const { height: _fixedH, ...layoutWithoutHeight } = layout
        const standaloneLayout = {
            ...layoutWithoutHeight,
            autosize: true,
            height: undefined,
            margin: isPieLike
                ? { l: 10, r: 10, t: 10, b: 10 }
                : isVerticalBar
                    ? { l: 40, r: 8, t: 8, b: 70 }   // vertical: less left, more bottom for rotated labels
                    : { l: 50, r: 8, t: 8, b: 28 },   // horizontal: more left for category labels
        }

        // Pie charts: use inside text to avoid auto-margin thrashing
        const standaloneChartData = (filled ? chartData : buildZeroData(chartData, effectiveConfig))
        const standaloneTrace = isPieLike
            ? { ...standaloneChartData, textposition: 'inside', textinfo: 'percent', automargin: false }
            : standaloneChartData

        return (
            <div className="h-full flex flex-col relative">
                {/* drag-zone title row — pr reserves space for DashboardGrid's close button */}
                <div className="panel-header" style={{ paddingRight: 24 }}>
                    <div className="drag-zone flex items-center gap-1.5 min-w-0 flex-1 cursor-move overflow-hidden">
                        {effectiveConfig.type === 'pie'
                            ? <PieChart className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                            : <BarChart3 className={`w-3.5 h-3.5 text-cyan-400 shrink-0 ${isVerticalBar ? 'rotate-90' : ''}`} />
                        }
                        <span className="text-xs font-medium truncate text-[var(--speckle-foreground-2)]">
                            {effectiveConfig.title}
                        </span>
                        {effectiveConfig.clickable && !fullDataReady && (
                            <span className="text-[10px] text-yellow-500 shrink-0">Loading…</span>
                        )}
                    </div>
                    {onEdit && (
                        <button
                            onMouseDown={e => e.stopPropagation()}
                            onClick={e => { e.stopPropagation(); onEdit() }}
                            className="ml-1 p-0.5 hover:bg-white/10 rounded shrink-0"
                            title="Configure chart"
                        >
                            <Settings2 size={11} className="text-zinc-400" />
                        </button>
                    )}
                </div>
                {/* Chart fills remaining container height.
                    No revision prop here — react-plotly.js must re-render on every
                    data/layout prop change so that switching chart type is instant. */}
                <div className="flex-1 min-h-0">
                    <Plot
                        data={[standaloneTrace]}
                        layout={standaloneLayout}
                        config={{ displayModeBar: false, responsive: true }}
                        useResizeHandler
                        onClick={handleClick}
                        style={{
                            width: '100%',
                            height: '100%',
                            cursor: (effectiveConfig.clickable && fullDataReady && !isStatistical) ? 'pointer' : 'default'
                        }}
                    />
                </div>
            </div>
        )
    }

    // ── Legacy embedded mode (inside AdaptiveCharts container) ──────────
    return (
        <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, height: 0 }}
            className="glass-card relative group"
        >
            <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                    {effectiveConfig.type === 'pie' && <PieChart className="w-4 h-4 text-purple-500" />}
                    {effectiveConfig.type === 'bar' && <BarChart3 className="w-4 h-4 text-cyan-500" />}
                    {effectiveConfig.type === 'sunburst' && <Sparkles className="w-4 h-4 text-orange-500" />}
                    {effectiveConfig.type === 'treemap' && <Sparkles className="w-4 h-4 text-green-500" />}
                    {effectiveConfig.type === 'histogram' && <BarChart3 className="w-4 h-4 text-cyan-500" />}
                    {(effectiveConfig.type === 'box' || effectiveConfig.type === 'violin') && <BarChart3 className="w-4 h-4 text-blue-500" />}

                    {effectiveConfig.title}
                    {effectiveConfig.clickable && !fullDataReady && (
                        <span className="text-xs text-yellow-500 font-normal">(Loading...)</span>
                    )}
                </h3>
                <div className="flex items-center gap-1">
                    {onTogglePin && (
                        <button
                            onClick={() => onTogglePin(fieldKey)}
                            className={`${isPinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} p-1.5 hover:bg-white/10 rounded-lg transition-all`}
                            title={isPinned ? "Unpin chart" : "Pin chart"}
                        >
                            <Pin className={`w-4 h-4 ${isPinned ? 'text-cyan-400 fill-cyan-400' : 'text-zinc-400'}`} />
                        </button>
                    )}
                    {onEdit && (
                        <button
                            onClick={() => onEdit()}
                            className={`${isPinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} p-1.5 hover:bg-white/10 rounded-lg transition-all`}
                            title="Edit chart"
                        >
                            <Pencil className="w-4 h-4 text-cyan-400" />
                        </button>
                    )}
                    {dragHandleProps && (
                        <div
                            {...dragHandleProps}
                            className={`${isPinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} p-1.5 hover:bg-white/10 rounded-lg transition-all cursor-grab active:cursor-grabbing`}
                            title="Drag to reorder"
                        >
                            <GripVertical className="w-4 h-4 text-zinc-400" />
                        </div>
                    )}
                    {onRemove && (
                        <button
                            onClick={() => onRemove(fieldKey)}
                            className={`${isPinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} p-1.5 rounded-lg transition-opacity`}
                            title="Remove chart"
                        >
                            <X className="w-4 h-4 text-zinc-500 hover:text-red-400 transition-colors" />
                        </button>
                    )}
                </div>
            </div>
            <Plot
                data={[filled ? chartData : buildZeroData(chartData, effectiveConfig)]}
                layout={layout}
                config={{ displayModeBar: false, responsive: true }}
                useResizeHandler={true}
                className="w-full"
                onClick={handleClick}
                style={{ width: '100%', height: '100%', cursor: (effectiveConfig.clickable && fullDataReady && !isStatistical) ? 'pointer' : 'default' }}
                revision={rev}
            />

            {/* Resize Handle */}
            <div
                className="absolute bottom-0 right-0 w-6 h-6 cursor-nwse-resize flex items-end justify-end p-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 hover:bg-white/5 rounded-tl-lg"
                onPointerDown={handleResizeStart}
                title="Drag to resize (Down for height, Right for width)"
            >
                <div className="w-2 h-2 border-r-2 border-b-2 mb-1 mr-1" style={{ borderColor: '#136CFF' }} />
            </div>
        </motion.div>
    )
}

// Sortable wrapper for DynamicChart
function SortableChartWrapper({ id, children, ...chartProps }) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id })

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 100 : 'auto',
        gridColumn: (chartProps.isPinned || chartProps.span === 2) ? 'span 2' : 'span 1'
    }

    return (
        <div ref={setNodeRef} style={style}>
            <DynamicChart
                {...chartProps}
                dragHandleProps={{ ...attributes, ...listeners }}
            />
        </div>
    )
}

// Add Chart Button with Dropdown
function AddChartButton({ availableCharts, onAdd }) {
    const [isOpen, setIsOpen] = useState(false)

    if (availableCharts.length === 0) return null

    return (
        <div className="relative">
            <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setIsOpen(!isOpen)}
                className="w-full glass-card flex items-center justify-center gap-2 py-3 hover:border-cyan-500/50 transition-colors"
            >
                <Plus className="w-4 h-4 text-cyan-500" />
                <span className="text-sm font-medium">Add Chart</span>
                <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </motion.button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="absolute z-20 w-full mt-2 glass-card border border-white/10 shadow-xl max-h-60 overflow-y-auto"
                    >
                        {availableCharts.map(chart => (
                            <button
                                key={chart.key}
                                onClick={() => {
                                    onAdd(chart.key)
                                    setIsOpen(false)
                                }}
                                className="w-full text-left px-4 py-2.5 hover:bg-white/10 transition-colors flex items-center gap-2"
                            >
                                {chart.config.type === 'pie'
                                    ? <PieChart className="w-4 h-4 text-purple-500" />
                                    : <BarChart3 className="w-4 h-4 text-cyan-500" />
                                }
                                <span className="text-sm">{chart.config.title}</span>
                                <span className="text-xs text-zinc-500 ml-auto">{chart.entryCount} items</span>
                            </button>
                        ))}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

// Local storage keys
const STORAGE_KEY = 'dashboard-visible-charts'
const CUSTOM_CHARTS_KEY = 'dashboard-custom-charts'

// Charts Container Component with Add/Remove
export function AdaptiveCharts({
    summary,
    highlightedField,
    highlightedValue,
    onValueClick,
    fullDataReady,
    fullData,
    viewerSelectedElement,
    persistenceId = 'default' // ID for scoping localStorage
}) {
    // Generate scoped keys (preserve backward compatibility for 'default')
    const storageKey = persistenceId === 'default'
        ? 'dashboard-visible-charts'
        : `dashboard-visible-charts-${persistenceId}`

    const customChartsKey = persistenceId === 'default'
        ? 'dashboard-custom-charts'
        : `dashboard-custom-charts-${persistenceId}`

    const chartOrderKey = persistenceId === 'default'
        ? 'dashboard-chart-order'
        : `dashboard-chart-order-${persistenceId}`

    const chartHeightsKey = persistenceId === 'default'
        ? 'dashboard-chart-sizes'
        : `dashboard-chart-sizes-${persistenceId}`

    const allChartFields = discoverChartFields(summary)

    // Discover properties from fullData
    const discoveredProperties = useMemo(() => {
        if (!fullData) return []
        return discoverProperties(fullData)
    }, [fullData])

    // Discover numeric properties (width, height, length, etc.)
    const numericProperties = useMemo(() => {
        if (!fullData) return []
        return discoverNumericProperties(fullData)
    }, [fullData])

    // Combine summary fields and discovered properties for chart builder
    const allAvailableFields = useMemo(() => {
        const summaryFields = allChartFields.map(f => ({
            ...f,
            isDiscovered: false,
            source: 'Summary'
        }))

        const discoveredFields = discoveredProperties.map(prop => ({
            key: `discovered_${prop.path}`,
            config: {
                type: 'bar',
                title: prop.name,
                orientation: 'h',
                clickable: true,
                field: prop.path,
                isDiscovered: true
            },
            entryCount: prop.uniqueValues,
            coverage: prop.coverage,
            path: prop.path,
            isDiscovered: true,
            source: 'Element Properties'
        }))

        // Numeric properties (width, height, length, etc.) - for distribution charts
        const numericFields = numericProperties.map(prop => ({
            key: `numeric_${prop.path}`,
            config: {
                type: 'bar',
                title: `Elements by ${prop.name}`,
                orientation: 'v',
                clickable: false,
                field: prop.path,
                isDiscovered: true,
                isNumeric: true,
                aggregationType: 'histogram'
            },
            entryCount: prop.elementCount,
            coverage: prop.coverage,
            path: prop.path,
            isDiscovered: true,
            isNumeric: true,
            isDimensional: prop.isDimensional,
            stats: {
                sum: prop.sum,
                average: prop.average,
                min: prop.min,
                max: prop.max
            },
            source: prop.isDimensional ? 'Dimensions' : 'Numeric Properties'
        }))

        return [...summaryFields, ...discoveredFields, ...numericFields]
    }, [allChartFields, discoveredProperties, numericProperties])

    // State for visible charts (persisted to localStorage)
    const [visibleCharts, setVisibleCharts] = useState(() => {
        const stored = localStorage.getItem(storageKey)
        if (stored) {
            try {
                return JSON.parse(stored)
            } catch {
                return null
            }
        }
        return null
    })

    // Initialize with all charts if no stored preference
    useEffect(() => {
        if (visibleCharts === null && allChartFields.length > 0) {
            setVisibleCharts(allChartFields.map(c => c.key))
        }
    }, [allChartFields, visibleCharts])

    // Save to localStorage when visible charts change
    useEffect(() => {
        if (visibleCharts !== null) {
            localStorage.setItem(storageKey, JSON.stringify(visibleCharts))
        }
    }, [visibleCharts, storageKey])

    // Filter to only visible charts that exist in current data
    const displayedCharts = useMemo(() => {
        const visible = allChartFields.filter(
            c => visibleCharts === null || visibleCharts.includes(c.key)
        )

        // If we have full raw data, re-aggregate standard charts to ensure accuracy
        // (This avoids any server-side normalization/correction of values)
        if (fullData?.elements) {
            return visible.map(chart => {
                // Only re-aggregate standard summary charts (discovered ones are already raw)
                if (chart.source === 'Summary' && chart.config.field) {
                    const rawData = aggregateProperty(fullData, chart.config.field)
                    if (Object.keys(rawData).length > 0) {
                        return {
                            ...chart,
                            data: rawData,
                            entryCount: Object.keys(rawData).length
                        }
                    }
                }
                return chart
            })
        }

        return visible
    }, [allChartFields, visibleCharts, fullData])

    // Available charts to add (not currently visible)
    const hiddenCharts = allChartFields.filter(
        c => visibleCharts !== null && !visibleCharts.includes(c.key)
    )

    const handleRemove = (key) => {
        setVisibleCharts(prev => (prev || []).filter(k => k !== key))
    }

    const handleAdd = (key) => {
        setVisibleCharts(prev => [...(prev || []), key])
    }

    // Custom charts state (persisted to localStorage)
    const [customCharts, setCustomCharts] = useState(() => {
        const stored = localStorage.getItem(customChartsKey)
        if (stored) {
            try {
                return JSON.parse(stored)
            } catch {
                return []
            }
        }
        return []
    })

    // Chart builder dialog state
    const [showChartBuilder, setShowChartBuilder] = useState(false)
    const [editingChart, setEditingChart] = useState(null)
    const [showAddDropdown, setShowAddDropdown] = useState(false)

    // Pinned charts state (persisted in localStorage)
    const pinnedChartsKey = persistenceId === 'default'
        ? 'dashboard-pinned-charts'
        : `dashboard-pinned-charts-${persistenceId}`
    const [pinnedCharts, setPinnedCharts] = useState(() => {
        const stored = localStorage.getItem(pinnedChartsKey)
        if (stored) {
            try {
                return new Set(JSON.parse(stored))
            } catch {
                return new Set()
            }
        }
        return new Set()
    })

    // Save pinned charts to localStorage
    useEffect(() => {
        localStorage.setItem(pinnedChartsKey, JSON.stringify([...pinnedCharts]))
    }, [pinnedCharts, pinnedChartsKey])

    // Toggle pin state for a chart
    const handleTogglePin = (chartKey) => {
        setPinnedCharts(prev => {
            const newSet = new Set(prev)
            if (newSet.has(chartKey)) {
                newSet.delete(chartKey)
            } else {
                newSet.add(chartKey)
            }
            return newSet
        })
    }

    // Save custom charts to localStorage when they change
    useEffect(() => {
        localStorage.setItem(customChartsKey, JSON.stringify(customCharts))
    }, [customCharts, customChartsKey])

    // Create or Update custom chart
    const handleCreateCustomChart = (newChart) => {
        setCustomCharts(prev => {
            const exists = prev.some(c => c.key === newChart.key)
            if (exists) {
                // Update existing
                return prev.map(c => c.key === newChart.key ? newChart : c)
            }
            // Add new
            return [...prev, newChart]
        })
        setEditingChart(null) // Reset edit mode
    }

    // Remove custom chart
    const handleRemoveCustomChart = (key) => {
        setCustomCharts(prev => prev.filter(c => c.key !== key))
    }

    // Handle Edit Request
    const handleEditChart = (chart) => {
        setEditingChart(chart)
        setShowChartBuilder(true)
    }

    // Chart order state (persisted to localStorage)
    const [chartOrder, setChartOrder] = useState(() => {
        const stored = localStorage.getItem(chartOrderKey)
        if (stored) {
            try {
                return JSON.parse(stored)
            } catch {
                return null
            }
        }
        return null
    })

    // Save chart order to localStorage
    useEffect(() => {
        if (chartOrder) {
            localStorage.setItem(chartOrderKey, JSON.stringify(chartOrder))
        }
    }, [chartOrder, chartOrderKey])

    // Chart sizes state (persisted to localStorage)
    // Format: { [key]: { height: number, span: 1 | 2 } }
    const [chartSizes, setChartSizes] = useState(() => {
        const stored = localStorage.getItem(chartHeightsKey)
        if (stored) {
            try {
                // Migration: If legacy format (key -> height number), convert to new object
                const parsed = JSON.parse(stored)
                const newFormat = {}
                for (const [k, v] of Object.entries(parsed)) {
                    if (typeof v === 'number') {
                        newFormat[k] = { height: v, span: 1 }
                    } else {
                        newFormat[k] = v // Assume already correct
                    }
                }
                return newFormat
            } catch {
                return {}
            }
        }
        return {}
    })

    // Save chart sizes to localStorage
    useEffect(() => {
        localStorage.setItem(chartHeightsKey, JSON.stringify(chartSizes))
    }, [chartSizes, chartHeightsKey])

    const handleChartResize = (key, height, span) => {
        setChartSizes(prev => ({
            ...prev,
            [key]: {
                height: height !== undefined ? height : (prev[key]?.height || 250),
                span: span !== undefined ? span : (prev[key]?.span || 1)
            }
        }))
    }

    // Sensor definitions for Drag and Drop
    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates
        })
    )

    const handleDragEnd = (event) => {
        const { active, over } = event
        // over is null when the drag is released outside any droppable area
        if (!over || active.id === over.id) return

        setChartOrder(prev => {
            // Build the initial order from all currently visible charts if none saved yet
            const base = prev || allActiveChartsRef.current.map(c => c.key)
            const oldIndex = base.indexOf(active.id)
            const newIndex = base.indexOf(over.id)
            if (oldIndex === -1 || newIndex === -1) return base
            return arrayMove(base, oldIndex, newIndex)
        })
    }

    // Merge displayed and custom charts — memoized so sortedCharts useMemo
    // only recalculates when the underlying data actually changes.
    const allActiveCharts = useMemo(
        () => [...displayedCharts, ...customCharts],
        [displayedCharts, customCharts]
    )
    // Stable ref for use inside setChartOrder functional updater to avoid
    // capturing a stale allActiveCharts closure.
    const allActiveChartsRef = useRef(allActiveCharts)
    allActiveChartsRef.current = allActiveCharts

    // Sort charts based on saved order
    const sortedCharts = useMemo(() => {
        if (!chartOrder) return allActiveCharts

        const chartsMap = new Map(allActiveCharts.map(c => [c.key, c]))
        const sorted = []
        chartOrder.forEach(key => {
            if (chartsMap.has(key)) {
                sorted.push(chartsMap.get(key))
                chartsMap.delete(key)
            }
        })
        // Charts added after the order was saved appear at the end
        chartsMap.forEach(chart => sorted.push(chart))
        return sorted
    }, [allActiveCharts, chartOrder])


    if (allChartFields.length === 0 && customCharts.length === 0) {
        return (
            <div className="glass-card text-center py-8">
                <p className="text-zinc-500">No chart data available</p>
            </div>
        )
    }

    return (
        <div className="space-y-4">
            <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
            >
                <SortableContext
                    items={sortedCharts.map(c => c.key)}
                    strategy={verticalListSortingStrategy}
                >
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <AnimatePresence>
                            {sortedCharts.map(chart => {
                                // For custom charts, we need to calculate 'data' on the fly if it's not present
                                let data = chart.data

                                // Aggregate data for custom charts if needed
                                if (!data && chart.config.isCustom && fullData) {
                                    if (chart.config.isNumeric) {
                                        // Numeric aggregation (histogram)
                                        const rawValues = getRawValues(fullData, chart.config.field)
                                        if (chart.config.aggregationType === 'histogram') {
                                            // Histogram expects raw array
                                            data = rawValues
                                        } else {
                                            // Other numeric types
                                            data = rawValues
                                        }
                                    } else {
                                        // Categorical aggregation
                                        data = aggregateProperty(fullData, chart.config.field)
                                    }
                                }

                                return (
                                    <div
                                        key={chart.key}
                                        className={
                                            // Prioritize explicit span from resize, otherwise fall back to defaults
                                            (chartSizes[chart.key]?.span !== undefined
                                                ? chartSizes[chart.key]?.span === 2
                                                : (chart.config.orientation === 'h' || chart.config.type === 'treemap')
                                            ) ? 'md:col-span-2' : ''
                                        }
                                    >
                                        <SortableChartWrapper
                                            id={chart.key}
                                            fieldKey={chart.key}
                                            config={chart.config}
                                            data={data || {}}
                                            highlightedValue={highlightedField === chart.config.field ? highlightedValue : null}
                                            viewerSelectedElement={viewerSelectedElement}
                                            onValueClick={onValueClick}
                                            fullDataReady={fullDataReady || !!data}
                                            onRemove={chart.config.isCustom ? () => handleRemoveCustomChart(chart.key) : () => handleRemove(chart.key)}
                                            onEdit={() => handleEditChart(chart)}
                                            isPinned={pinnedCharts.has(chart.key)}
                                            onTogglePin={handleTogglePin}
                                            height={chartSizes[chart.key]?.height}
                                            span={chartSizes[chart.key]?.span}
                                            onResize={(h, s) => handleChartResize(chart.key, h, s)}
                                        />
                                    </div>
                                )
                            })}
                        </AnimatePresence>
                    </div>
                </SortableContext >
            </DndContext >

            {/* Add Chart Buttons - Full Width Icons */}
            < div className="flex gap-2" >
                {
                    hiddenCharts.length > 0 && (
                        <div className="relative flex-1">
                            <motion.button
                                whileHover={{ scale: 1.02 }}
                                whileTap={{ scale: 0.98 }}
                                onClick={() => setShowAddDropdown(!showAddDropdown)}
                                className="w-full p-2 glass-card hover:border-cyan-500/50 transition-colors rounded-lg flex items-center justify-center"
                                title="Add existing chart"
                            >
                                <Plus className="w-4 h-4 text-cyan-500" />
                            </motion.button>
                            <AnimatePresence>
                                {showAddDropdown && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -10 }}
                                        className="absolute left-0 right-0 z-20 mt-2 glass-card border border-white/10 shadow-xl max-h-60 overflow-y-auto"
                                    >
                                        {hiddenCharts.map(chart => (
                                            <button
                                                key={chart.key}
                                                onClick={() => {
                                                    handleAdd(chart.key)
                                                    setShowAddDropdown(false)
                                                }}
                                                className="w-full text-left px-3 py-2 hover:bg-white/10 transition-colors flex items-center gap-2 text-sm"
                                            >
                                                {chart.config.type === 'pie'
                                                    ? <PieChart className="w-3 h-3 text-purple-500" />
                                                    : <BarChart3 className="w-3 h-3 text-cyan-500" />
                                                }
                                                <span className="truncate">{chart.config.title}</span>
                                            </button>
                                        ))}
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    )
                }
                < motion.button
                    whileHover={{ scale: 1.02 }
                    }
                    whileTap={{ scale: 0.98 }}
                    onClick={() => {
                        setEditingChart(null)
                        setShowChartBuilder(true)
                    }}
                    className={`${hiddenCharts.length > 0 ? 'flex-1' : 'w-full'} p-2 glass-card border border-dashed border-white/20 hover:border-cyan-500/50 hover:bg-cyan-500/5 transition-all text-zinc-400 hover:text-cyan-400 rounded-lg flex items-center justify-center`}
                    title="Create custom chart"
                >
                    <Sparkles className="w-4 h-4" />
                </motion.button >
            </div >

            {/* Chart Builder Modal */}
            < ChartBuilder
                isOpen={showChartBuilder}
                onClose={() => {
                    setShowChartBuilder(false)
                    setEditingChart(null)
                }}
                availableFields={allAvailableFields}
                onCreateChart={handleCreateCustomChart}
                fullData={fullData}
                initialConfig={editingChart}
            />
        </div >
    )
}
