import { useState, useMemo } from 'react'
import { BarChart3 } from 'lucide-react'
import { DynamicChart, discoverChartFields } from './AdaptiveCharts'
import { ChartBuilder } from './ChartBuilder'
import { discoverProperties, discoverNumericProperties, aggregateProperty } from '../utils/propertyScanner'

export function StandaloneChartWidget({
    widget,
    onUpdateWidget,
    chartSummary,
    fullData,
    contextElements,
    displayOptions,
    fullDataReady,
    highlightedField,
    highlightedValue,
    onValueClick,
    onHoverValue,
    onHoverEnd,
    viewerSelectedElement,
    darkMode = true,
}) {
    // Auto-open builder if widget has no configuration yet
    const [showBuilder, setShowBuilder] = useState(!widget.chartConfig)

    const allAvailableFields = useMemo(() => {
        const summaryFields = chartSummary
            ? discoverChartFields(chartSummary).map(f => ({ ...f, isDiscovered: false, source: 'Summary' }))
            : []

        if (!fullData) return summaryFields

        const discoveredFields = discoverProperties(fullData).map(prop => ({
            key: `discovered_${prop.path}`,
            config: { type: 'bar', title: prop.name, orientation: 'h', clickable: true, field: prop.path, isDiscovered: true },
            entryCount: prop.uniqueValues,
            coverage: prop.coverage,
            path: prop.path,
            isDiscovered: true,
            source: 'Element Properties',
        }))

        const numericFields = discoverNumericProperties(fullData).map(prop => ({
            key: `numeric_${prop.path}`,
            config: {
                type: 'bar', title: `Elements by ${prop.name}`, orientation: 'v',
                clickable: false, field: prop.path, isDiscovered: true,
                isNumeric: true, aggregationType: 'histogram',
            },
            entryCount: prop.elementCount,
            coverage: prop.coverage,
            path: prop.path,
            isDiscovered: true,
            isNumeric: true,
            stats: { sum: prop.sum, average: prop.average, min: prop.min, max: prop.max },
            source: prop.isDimensional ? 'Dimensions' : 'Numeric Properties',
        }))

        return [...summaryFields, ...discoveredFields, ...numericFields]
    }, [chartSummary, fullData])

    const chartData = useMemo(() => {
        if (!widget.chartConfig?.config) return {}
        const { sourceField, config: cfg } = widget.chartConfig

        // Summary field (pre-aggregated, already filter/selection-aware via chartSummary)
        if (!cfg.isDiscovered && chartSummary?.[sourceField]) {
            return chartSummary[sourceField]
        }

        // For discovered/numeric fields use the context-filtered element set so
        // chart filters and viewer selection are reflected here too.
        const elements = contextElements || fullData?.elements
        if (!elements) return {}

        if (cfg.isNumeric) {
            const vals = []
            for (const el of elements) {
                const parts = cfg.field.split('.')
                let v = el
                for (const p of parts) { if (v == null) break; v = v[p] }
                if (typeof v === 'number' && isFinite(v)) vals.push(v)
            }
            return vals
        }

        return aggregateProperty({ ...fullData, elements }, cfg.field)
    }, [widget.chartConfig, chartSummary, contextElements, fullData])

    const handleConfigure = (chartDef) => {
        onUpdateWidget({ chartConfig: chartDef, title: chartDef.config.title })
        setShowBuilder(false)
    }

    const cfg = widget.chartConfig?.config
    const effectiveHighlight = (cfg && highlightedField === cfg.field) ? highlightedValue : null

    // Merge display settings from DashboardGrid's properties popover into config.
    // Type/orientation stay under ChartBuilder's control; only visual settings are applied.
    const effectiveCfg = cfg && displayOptions ? {
        ...cfg,
        title:          widget.title || cfg.title,
        maxItems:       displayOptions.maxItems     ?? cfg.maxItems,
        colorScheme:    displayOptions.colorScheme  ?? cfg.colorScheme  ?? 'default',
        sortOrder:      displayOptions.sortOrder    ?? cfg.sortOrder    ?? 'desc',
        minCount:       displayOptions.minCount     ?? 0,
        showLabels:     displayOptions.showLabels   ?? true,
        donut:          displayOptions.donut        ?? true,
        showLegend:     displayOptions.showLegend   ?? false,
        showGridLines:  displayOptions.showGridLines ?? true,
        tickFontSize:   displayOptions.tickFontSize   ?? 11,
        tickFontColor:  displayOptions.tickFontColor  ?? (darkMode ? '#e4e4e7' : '#000000'),
        tickAngle:      displayOptions.tickAngle      ?? (cfg.orientation === 'v' ? -45 : 0),
        valueFontSize:  displayOptions.valueFontSize  ?? 11,
        valueFontColor: displayOptions.valueFontColor ?? (darkMode ? '#e4e4e7' : '#000000'),
        labelFontSize:  displayOptions.labelFontSize  ?? 11,
        labelFontColor: displayOptions.labelFontColor ?? (darkMode ? '#e4e4e7' : '#000000'),
        unit:               displayOptions.unit               ?? cfg.unit ?? null,
        decimals:           displayOptions.decimals           ?? null,
        thousandsSeparator: displayOptions.thousandsSeparator  ?? true,
        axisMin:            displayOptions.axisMin             ?? null,
        axisMax:            displayOptions.axisMax             ?? null,
        pieLabelName:       displayOptions.pieLabelName        ?? true,
        pieLabelValue:      displayOptions.pieLabelValue       ?? true,
        pieLabelPercent:    displayOptions.pieLabelPercent     ?? true,
        pieLeaderLine:      displayOptions.pieLeaderLine       ?? true,
    } : cfg ? { ...cfg, title: widget.title || cfg.title } : null

    return (
        <div className="h-full flex flex-col">
            {effectiveCfg ? (
                <DynamicChart
                    standalone
                    fieldKey={widget.id}
                    data={chartData}
                    config={effectiveCfg}
                    highlightedValue={effectiveHighlight}
                    viewerSelectedElement={viewerSelectedElement}
                    onValueClick={effectiveCfg.clickable ? onValueClick : undefined}
                    onHoverValue={onHoverValue}
                    onHoverEnd={onHoverEnd}
                    fullDataReady={fullDataReady}
                    onEdit={() => setShowBuilder(true)}
                    darkMode={darkMode}
                />
            ) : (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-zinc-500">
                    <BarChart3 className="w-7 h-7 opacity-20" />
                    <p className="text-xs opacity-60">No chart configured</p>
                    <button
                        onClick={() => setShowBuilder(true)}
                        className="text-xs px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-zinc-300"
                    >
                        Configure Chart
                    </button>
                </div>
            )}

            <ChartBuilder
                isOpen={showBuilder}
                onClose={() => setShowBuilder(false)}
                availableFields={allAvailableFields}
                onCreateChart={handleConfigure}
                fullData={fullData}
                initialConfig={widget.chartConfig}
            />
        </div>
    )
}
