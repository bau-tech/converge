// Shared theme building blocks for ECharts options, mirroring the previous
// Plotly themes (transparent backgrounds, zinc grid colors in dark mode,
// Inter font, monospace hover tooltips) so migrated charts look like-for-like.

const DARK = {
    gridLine: '#27272a',
    axisLine: '#3f3f46',
    text: '#e4e4e7',
    tick: '#a1a1aa',
    tooltipBg: '#18181b',
    tooltipBorder: '#3f3f46',
    tooltipText: '#fafafa',
}

const LIGHT = {
    gridLine: '#e4e4e7',
    axisLine: '#d4d4d8',
    text: '#18181b',
    tick: '#52525b',
    tooltipBg: '#ffffff',
    tooltipBorder: '#e4e4e7',
    tooltipText: '#18181b',
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
export function valueAxisStyle({ axisLabel, darkMode = true, ...extra } = {}) {
    const c = darkMode ? DARK : LIGHT
    return {
        type: 'value',
        axisLine: { show: false },
        axisLabel: { color: c.tick, ...axisLabel },
        splitLine: { lineStyle: { color: c.gridLine } },
        ...extra,
    }
}
