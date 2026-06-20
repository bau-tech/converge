import EChart from './EChart'
import { baseOption, categoryAxisStyle, valueAxisStyle, legendStyle } from '../lib/echartsTheme'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Plus, ChevronDown, BarChart3, PieChart, Sparkles, GripVertical, Pencil, Pin, Settings2 } from 'lucide-react'
import { useState, useEffect, useMemo, useRef } from 'react'
import { ChartBuilder } from './ChartBuilder'
import { discoverProperties, aggregateProperty, discoverNumericProperties, aggregateNumericProperty } from '../utils/propertyScanner'
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
        speckle: ['#136CFF','#276FE5','#4B40C9','#34D399','#FBBF24','#F87171','#B8C0CC'],
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

// Build a complete ECharts option for a (horizontal or vertical) bar chart
function prepareBarOption(data, config, highlightedValue, { darkMode = true, standalone = false, isResizing = false } = {}) {
    const minCount = config.minCount || 0
    const entries = Object.entries(data).filter(([key]) => !isEmptyKey(key) && (minCount === 0 || Number(data[key]) >= minCount))
    const sorted = sortEntries(entries, config.sortOrder).slice(0, config.maxItems || 15)

    const isHorizontal = config.orientation !== 'v'
    const unit = config.unit || null
    const valueLabel = unit === 'm³' ? 'Volume' : unit === 'm²' ? 'Area' : 'Count'
    const decimals = config.decimals ?? (unit ? 2 : 0)
    const useThousands = config.thousandsSeparator !== false
    const formatVal = v => {
        const num = Number(v)
        if (Number.isNaN(num)) return v
        return useThousands
            ? num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
            : num.toFixed(decimals)
    }
    const palette = resolveColors(config.colorScheme)
    const showLabels = config.showLabels !== false

    const tickFontSize   = config.tickFontSize   || 11
    const tickFontColor  = config.tickFontColor  || (darkMode ? '#e4e4e7' : '#000000')
    const tickAngle      = config.tickAngle      ?? (isHorizontal ? 0 : -45)
    const valueFontSize  = config.valueFontSize  || 11
    const valueFontColor = config.valueFontColor || (darkMode ? '#e4e4e7' : '#000000')
    const showGridLines  = config.showGridLines  !== false
    const showLegend     = config.showLegend     === true

    const seriesData = sorted.map((d, idx) => {
        const base = palette[idx % palette.length]
        const isHighlighted = d[0] === highlightedValue
        const color = !highlightedValue ? base : isHighlighted ? COLOR_PALETTES.highlight : hexToRgba(base, 0.25)
        return {
            name: d[0],
            value: d[1],
            itemStyle: {
                color,
                borderColor: isHighlighted ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.1)',
                borderWidth: isHighlighted ? 2 : 1,
            },
        }
    })

    const categoryAxisOpt = categoryAxisStyle({
        data: sorted.map(d => d[0]),
        darkMode,
        axisLabel: { color: tickFontColor, fontSize: tickFontSize, rotate: tickAngle },
    })
    const valueAxisOpt = valueAxisStyle({
        darkMode, showGridLines,
        min: config.axisMin != null && config.axisMin !== '' ? Number(config.axisMin) : undefined,
        max: config.axisMax != null && config.axisMax !== '' ? Number(config.axisMax) : undefined,
        axisLabel: { formatter: formatVal },
    })

    const grid = standalone
        ? (isHorizontal
            ? { left: 50, right: 8, top: showLegend ? 28 : 8, bottom: 28, containLabel: true }
            : { left: 40, right: 8, top: showLegend ? 28 : 8, bottom: 70, containLabel: true })
        : (isHorizontal
            ? { left: 60, right: 20, top: showLegend ? 50 : 30, bottom: 40, containLabel: true }
            : { left: 40, right: 20, top: showLegend ? 50 : 30, bottom: tickAngle === 0 ? 40 : Math.abs(tickAngle) >= 45 ? 80 : 60, containLabel: true })

    return {
        ...baseOption({
            darkMode,
            tooltipFormatter: (params) => {
                const p = Array.isArray(params) ? params[0] : params
                return `<b>${p.name}</b><br/>${valueLabel}: ${formatVal(p.value)}${unit ? ' ' + unit : ''}`
            },
        }),
        animationDurationUpdate: isResizing ? 0 : 650,
        legend: legendStyle({ show: showLegend, darkMode, top: 4, left: 'center', data: [valueLabel] }),
        grid,
        xAxis: isHorizontal ? valueAxisOpt : categoryAxisOpt,
        yAxis: isHorizontal ? categoryAxisOpt : valueAxisOpt,
        series: [{
            type: 'bar',
            name: valueLabel,
            data: seriesData,
            label: {
                show: showLabels,
                position: isHorizontal ? 'right' : 'top',
                color: valueFontColor,
                fontSize: valueFontSize,
                formatter: (params) => unit ? `${formatVal(params.value)} ${unit}` : formatVal(params.value),
            },
        }],
    }
}

// Build a complete ECharts option for a donut/pie chart
function preparePieOption(data, config, highlightedValue, { darkMode = true, standalone = false, isResizing = false } = {}) {
    const minCount = config.minCount || 0
    const entries = Object.entries(data).filter(([key]) => !isEmptyKey(key) && (minCount === 0 || Number(data[key]) >= minCount))
    const sorted = sortEntries(entries, config.sortOrder).slice(0, config.maxItems || 8)
    const palette = resolveColors(config.colorScheme)
    const showLabels = config.showLabels !== false
    const donut = config.donut !== false  // default true (donut style)
    const labelFontSize = config.labelFontSize || 11
    const labelFontColor = config.labelFontColor || (darkMode ? '#e4e4e7' : '#000000')
    const showLegend = config.showLegend === true
    const unit = config.unit || null
    const decimals = config.decimals ?? (unit ? 2 : 0)
    const useThousands = config.thousandsSeparator !== false
    const formatVal = v => {
        const num = Number(v)
        if (Number.isNaN(num)) return v
        return useThousands
            ? num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
            : num.toFixed(decimals)
    }
    const showLabelName = config.pieLabelName !== false
    const showLabelValue = config.pieLabelValue !== false
    const showLabelPercent = config.pieLabelPercent !== false
    const showLeaderLine = config.pieLeaderLine !== false
    const formatLabel = (params) => {
        const parts = []
        if (showLabelValue) parts.push(`${formatVal(params.value)}${unit ? ' ' + unit : ''}`)
        if (showLabelPercent) parts.push(`(${params.percent}%)`)
        const tail = parts.join(' ')
        if (showLabelName && tail) return `${params.name}: ${tail}`
        if (showLabelName) return params.name
        return tail || params.name
    }

    const seriesData = sorted.map((d, idx) => {
        const base = palette[idx % palette.length]
        const isHighlighted = d[0] === highlightedValue
        const color = !highlightedValue ? base : isHighlighted ? COLOR_PALETTES.highlight : hexToRgba(base, 0.35)
        return {
            name: d[0],
            value: d[1],
            itemStyle: {
                color,
                borderColor: isHighlighted ? '#fff' : (darkMode ? '#18181b' : '#ffffff'),
                borderWidth: isHighlighted ? 3 : 2,
            },
        }
    })

    return {
        ...baseOption({
            darkMode,
            tooltipFormatter: (params) => `<b>${params.name}</b><br/>Count: ${formatVal(params.value)}${unit ? ' ' + unit : ''}<br/>${params.percent}%`,
        }),
        animationDurationUpdate: isResizing ? 0 : 650,
        legend: legendStyle({
            show: showLegend, darkMode,
            orient: 'vertical', right: 4, top: 'center', type: 'scroll',
            itemWidth: 12, itemHeight: 12,
            data: seriesData.map(d => d.name),
        }),
        series: [{
            type: 'pie',
            radius: donut ? ['50%', '75%'] : '75%',
            center: showLegend ? ['38%', '50%'] : ['50%', '50%'],
            data: seriesData,
            // Outside labels + leader lines for every slice — name, value and
            // percent together, so the chart reads on its own without needing
            // the legend or a tooltip hover.
            label: {
                show: showLabels,
                position: 'outside',
                formatter: formatLabel,
                fontSize: labelFontSize,
                color: labelFontColor,
            },
            labelLine: { show: showLabels && showLeaderLine },
        }],
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

// Build a complete ECharts option for a sunburst/treemap chart. Both source
// fields are flat (no real hierarchy), so a single-level `series.data` array
// renders the same "ring of slices" / "grid of tiles" Plotly produced with
// `parents: ''` for every entry.
function prepareHierarchicalOption(data, config, highlightedValue, { darkMode = true } = {}) {
    const entries = Object.entries(data)
        .filter(([key]) => !isEmptyKey(key))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)

    const showLegend = config.showLegend === true

    const seriesData = entries.map((d, idx) => ({
        name: d[0],
        value: d[1],
        itemStyle: {
            color: d[0] === highlightedValue ? COLOR_PALETTES.highlight : COLOR_PALETTES.pie[idx % COLOR_PALETTES.pie.length],
        },
    }))

    const option = {
        ...baseOption({
            darkMode,
            tooltipFormatter: (params) => `<b>${params.name}</b><br/>Count: ${params.value}`,
        }),
        legend: legendStyle({
            show: showLegend, darkMode,
            orient: 'vertical', right: 4, top: 'center', type: 'scroll',
            itemWidth: 12, itemHeight: 12,
            data: seriesData.map(d => d.name),
        }),
    }

    if (config.type === 'sunburst') {
        return {
            ...option,
            series: [{
                type: 'sunburst',
                radius: ['0%', '85%'],
                center: showLegend ? ['38%', '50%'] : ['50%', '50%'],
                data: seriesData,
                label: { color: darkMode ? '#e4e4e7' : '#000000' },
            }],
        }
    }

    return {
        ...option,
        series: [{
            type: 'treemap',
            data: seriesData,
            roam: false,
            left: 0,
            right: showLegend ? '22%' : 0,
            top: 0,
            bottom: 0,
            breadcrumb: { show: false },
            upperLabel: { show: false },
            label: { color: '#fff' },
            itemStyle: { borderColor: darkMode ? '#18181b' : '#ffffff', borderWidth: 2, gapWidth: 2 },
        }],
    }
}

// Bin a flat array of numeric values into `numBins` equal-width buckets,
// mirroring Plotly's automatic histogram binning.
function binValues(values, numBins = 10) {
    const finite = (values || []).filter(v => typeof v === 'number' && isFinite(v))
    if (finite.length === 0) return { labels: [], counts: [] }

    const min = Math.min(...finite)
    const max = Math.max(...finite)
    if (min === max) return { labels: [min.toFixed(1)], counts: [finite.length] }

    const binSize = (max - min) / numBins
    const counts = new Array(numBins).fill(0)
    finite.forEach(v => {
        let idx = Math.floor((v - min) / binSize)
        if (idx >= numBins) idx = numBins - 1
        counts[idx]++
    })

    const labels = counts.map((_, i) => {
        const start = min + i * binSize
        const end = min + (i + 1) * binSize
        return `${start.toFixed(1)}–${end.toFixed(1)}`
    })

    return { labels, counts }
}

// Build a complete ECharts option for a histogram (pre-binned bar chart) —
// ECharts has no native histogram series.
function prepareHistogramOption(values, config, { darkMode = true, standalone = false, isResizing = false } = {}) {
    const { labels, counts } = binValues(values)

    return {
        ...baseOption({
            darkMode,
            tooltipFormatter: (params) => {
                const p = Array.isArray(params) ? params[0] : params
                return `Range: ${p.name}<br/>Count: ${p.value}`
            },
        }),
        animationDurationUpdate: isResizing ? 0 : 650,
        grid: standalone
            ? { left: 50, right: 8, top: 8, bottom: 50, containLabel: true }
            : { left: 40, right: 20, top: 30, bottom: 70, containLabel: true },
        xAxis: categoryAxisStyle({ data: labels, darkMode, axisLabel: { rotate: -45, fontSize: 10 } }),
        yAxis: valueAxisStyle({ darkMode }),
        series: [{
            type: 'bar',
            data: counts,
            barWidth: '99%',
            itemStyle: {
                color: COLOR_PALETTES.bar[0],
                borderColor: 'rgba(255,255,255,0.2)',
                borderWidth: 1,
            },
        }],
    }
}

// Compute [min, Q1, median, Q3, max] for ECharts' boxplot series format.
function computeBoxStats(values) {
    const sorted = (values || []).filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b)
    if (sorted.length === 0) return [0, 0, 0, 0, 0]

    const quantile = (q) => {
        const pos = (sorted.length - 1) * q
        const base = Math.floor(pos)
        const rest = pos - base
        return sorted[base + 1] !== undefined
            ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
            : sorted[base]
    }

    return [sorted[0], quantile(0.25), quantile(0.5), quantile(0.75), sorted[sorted.length - 1]]
}

// Build a complete ECharts option for a box plot. Violin charts render as a
// box plot too — ECharts has no native violin series (documented UI change).
function prepareStatisticalOption(values, config, { darkMode = true, standalone = false, isResizing = false } = {}) {
    const stats = computeBoxStats(values)
    const color = COLOR_PALETTES.pie[1]

    return {
        ...baseOption({ darkMode }),
        animationDurationUpdate: isResizing ? 0 : 650,
        grid: standalone
            ? { left: 50, right: 8, top: 8, bottom: 28, containLabel: true }
            : { left: 50, right: 20, top: 30, bottom: 30, containLabel: true },
        xAxis: categoryAxisStyle({ data: [config.title || 'Value'], darkMode }),
        yAxis: valueAxisStyle({ darkMode }),
        series: [{
            type: 'boxplot',
            data: [stats],
            itemStyle: { color: hexToRgba(color, 0.2), borderColor: color },
        }],
    }
}

// Dynamic Chart Component with Remove Button
export function DynamicChart({
    fieldKey,
    data,
    config,
    highlightedValue,
    viewerSelectedElement,
    onValueClick,
    onHoverValue,  // (field, value) => void  — called when pointer enters a chart segment
    onHoverEnd,    // () => void               — called when pointer leaves the chart
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

    const isPieLike    = ['pie', 'sunburst', 'treemap'].includes(effectiveConfig.type)
    const isStatistical= ['box', 'violin', 'histogram'].includes(effectiveConfig.type)
    const isVerticalBar= effectiveConfig.type === 'bar' && effectiveConfig.orientation === 'v'

    const layoutHeight = height || (isPieLike ? 300 : 250)
    const [isResizing, setIsResizing] = useState(false)

    const optionContext = { darkMode, standalone, isResizing }

    let option
    switch (effectiveConfig.type) {
        case 'pie':
            option = preparePieOption(data, effectiveConfig, effectiveHighlightedValue, optionContext)
            break
        case 'sunburst':
        case 'treemap':
            option = prepareHierarchicalOption(data, effectiveConfig, effectiveHighlightedValue, optionContext)
            break
        case 'histogram':
            option = prepareHistogramOption(data, effectiveConfig, optionContext)
            break
        case 'box':
        case 'violin':
            option = prepareStatisticalOption(data, effectiveConfig, optionContext)
            break
        case 'bar':
        default:
            option = prepareBarOption(data, effectiveConfig, effectiveHighlightedValue, optionContext)
            break
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

    const handleClick = (params) => {
        if (!effectiveConfig.clickable || !fullDataReady || !onValueClick || isStatistical) return
        onValueClick(effectiveConfig.field, params.name)
    }

    const handleMouseOver = (params) => {
        if (!onHoverValue || !effectiveConfig.field || !params.name || isStatistical) return
        onHoverValue(effectiveConfig.field, params.name)
    }

    const handleMouseOut = () => {
        if (onHoverEnd) onHoverEnd()
    }

    const onEvents = {
        click: handleClick,
        mouseover: handleMouseOver,
        mouseout: handleMouseOut,
    }
    const cursor = (effectiveConfig.clickable && fullDataReady && !isStatistical) ? 'pointer' : 'default'

    // ── Standalone panel mode (individual grid panel) ──────────────────
    if (standalone) {
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
                {/* Chart fills remaining container height. */}
                <div className="flex-1 min-h-0" style={{ cursor }}>
                    <EChart option={option} onEvents={onEvents} />
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
            <div style={{ width: '100%', height: layoutHeight, cursor }}>
                <EChart option={option} onEvents={onEvents} />
            </div>

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
