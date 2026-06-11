import { useEffect, useRef } from 'react'
import echarts from '../lib/echarts'

// Thin wrapper around echarts/core: creates one chart instance per
// container, applies `option` on change, and resizes with the container
// (mirrors react-plotly.js's `useResizeHandler` behavior).
export default function EChart({ option, onEvents, style, className, notMerge = true }) {
    const containerRef = useRef(null)
    const chartRef = useRef(null)

    useEffect(() => {
        if (!containerRef.current) return

        const chart = echarts.init(containerRef.current, null, { renderer: 'canvas' })
        chartRef.current = chart

        const resizeObserver = new ResizeObserver(() => chart.resize())
        resizeObserver.observe(containerRef.current)

        return () => {
            resizeObserver.disconnect()
            chart.dispose()
            chartRef.current = null
        }
    }, [])

    useEffect(() => {
        if (!chartRef.current || !option) return
        chartRef.current.setOption(option, { notMerge })
    }, [option, notMerge])

    useEffect(() => {
        const chart = chartRef.current
        if (!chart || !onEvents) return

        Object.entries(onEvents).forEach(([event, handler]) => chart.on(event, handler))
        return () => {
            Object.entries(onEvents).forEach(([event, handler]) => chart.off(event, handler))
        }
    }, [onEvents])

    return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%', ...style }} />
}
