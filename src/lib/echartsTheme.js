// Shared dark-theme building blocks for ECharts options, mirroring the
// Plotly dark theme (transparent backgrounds, zinc grid colors, Inter font,
// monospace hover tooltips) so migrated charts look like-for-like.

const GRID_LINE_COLOR = '#27272a'
const AXIS_LINE_COLOR = '#3f3f46'
const TEXT_COLOR = '#e4e4e7'
const TICK_COLOR = '#a1a1aa'

// Top-level option fragments shared by every chart: transparent background,
// font, update-transition animation, and tooltip styling.
export function baseOption({ fontSize = 11, tooltipFormatter } = {}) {
    return {
        backgroundColor: 'transparent',
        textStyle: { color: TEXT_COLOR, fontSize, fontFamily: 'Inter, system-ui, sans-serif' },
        animationDurationUpdate: 650,
        animationEasingUpdate: 'cubicInOut',
        tooltip: {
            backgroundColor: '#18181b',
            borderColor: AXIS_LINE_COLOR,
            textStyle: { color: '#fafafa', fontFamily: 'monospace', fontSize: 11 },
            ...(tooltipFormatter ? { formatter: tooltipFormatter } : {}),
        },
    }
}

// Category axis (e.g. the label axis of a horizontal bar chart).
export function categoryAxisStyle({ axisLabel, ...extra } = {}) {
    return {
        type: 'category',
        axisLine: { lineStyle: { color: AXIS_LINE_COLOR } },
        axisTick: { show: false },
        axisLabel: { color: TICK_COLOR, ...axisLabel },
        splitLine: { show: false },
        ...extra,
    }
}

// Value axis (e.g. the numeric axis of a horizontal bar chart).
export function valueAxisStyle({ axisLabel, ...extra } = {}) {
    return {
        type: 'value',
        axisLine: { show: false },
        axisLabel: { color: TICK_COLOR, ...axisLabel },
        splitLine: { lineStyle: { color: GRID_LINE_COLOR } },
        ...extra,
    }
}
