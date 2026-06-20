// Shared theme building blocks for ECharts options. Colors are taken from
// Speckle's own design tokens (--speckle-* in src/index.css, mirrored from
// @speckle/tailwind-theme) so charts match the rest of the dashboard chrome
// instead of the generic zinc palette left over from the Plotly era.

const DARK = {
    gridLine: '#282833',    // --speckle-outline-3
    axisLine: '#2E313F',    // --speckle-outline-2
    text: '#B0B1B5',        // --speckle-foreground-2
    tick: '#7E7F82',        // --speckle-foreground-3
    tooltipBg: '#191A22',   // --speckle-foundation-2
    tooltipBorder: '#2E313F', // --speckle-outline-2
    tooltipText: '#ffffff', // --speckle-foreground
}

const LIGHT = {
    gridLine: '#C4C4C4',    // --speckle-outline-5 — bumped from outline-3 (#E2E8F0), which was
                            // nearly invisible against a white panel background
    axisLine: '#DFDFDF',    // --speckle-outline-2
    text: '#1A1A1A',        // --speckle-foreground
    tick: '#1A1A1A',        // --speckle-foreground
    tooltipBg: '#FFFFFF',   // --speckle-foundation
    tooltipBorder: '#E2E8F0', // --speckle-outline-3
    tooltipText: '#1A1A1A', // --speckle-foreground
}

// Top-level option fragments shared by every chart: transparent background,
// font, update-transition animation, and tooltip styling.
export function baseOption({ fontSize = 11, tooltipFormatter, darkMode = true } = {}) {
    const c = darkMode ? DARK : LIGHT
    return {
        backgroundColor: 'transparent',
        textStyle: { color: c.text, fontSize, fontFamily: 'Inter, system-ui, sans-serif' },
        animationDurationUpdate: 650,
        animationEasingUpdate: 'cubicInOut',
        tooltip: {
            backgroundColor: c.tooltipBg,
            borderColor: c.tooltipBorder,
            textStyle: { color: c.tooltipText, fontFamily: 'monospace', fontSize: 11 },
            ...(tooltipFormatter ? { formatter: tooltipFormatter } : {}),
        },
    }
}

// Category axis (e.g. the label axis of a horizontal bar chart).
export function categoryAxisStyle({ axisLabel, darkMode = true, ...extra } = {}) {
    const c = darkMode ? DARK : LIGHT
    return {
        type: 'category',
        axisLine: { lineStyle: { color: c.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: c.tick, ...axisLabel },
        splitLine: { show: false },
        ...extra,
    }
}

// Value axis (e.g. the numeric axis of a horizontal bar chart).
export function valueAxisStyle({ axisLabel, darkMode = true, showGridLines = true, ...extra } = {}) {
    const c = darkMode ? DARK : LIGHT
    return {
        type: 'value',
        axisLine: { show: false },
        axisLabel: { color: c.tick, ...axisLabel },
        splitLine: { show: showGridLines, lineStyle: { color: c.gridLine } },
        ...extra,
    }
}

// Legend — used by pie/sunburst/treemap to list categories with their colors.
export function legendStyle({ show = false, darkMode = true, ...extra } = {}) {
    const c = darkMode ? DARK : LIGHT
    return {
        show,
        textStyle: { color: c.text, fontSize: 11 },
        ...extra,
    }
}
