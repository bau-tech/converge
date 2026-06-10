import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import GridLayout from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { Pin } from 'lucide-react'

const LAYOUT_KEY_WITH_VIEWER = 'dashboard-layout-with-viewer-v5'
const LAYOUT_KEY_NO_VIEWER = 'dashboard-layout-no-viewer-v5'
const MANUAL_RESIZED_KEY = 'dashboard-manual-resized'
const GRID_COLS = 48
const ROW_HEIGHT = 8

// 2-column layout (center: 36, right: 12) - 48-col grid
const DEFAULT_LAYOUT_WITH_VIEWER = [
    { i: 'center', x: 0,  y: 0, w: 36, h: 30, minW: 6, minH: 6 },
    { i: 'right',  x: 36, y: 0, w: 12, h: 30, minW: 4, minH: 6 },
]

// Layout without center panel — right fills full width
const DEFAULT_LAYOUT_NO_VIEWER = [
    { i: 'right', x: 0, y: 0, w: 48, h: 30, minW: 8, minH: 6 },
]

function loadLayout(key, defaultLayout) {
    try {
        const saved = localStorage.getItem(key)
        if (saved) return JSON.parse(saved)
    } catch (e) {
        console.warn('Failed to load layout:', e)
    }
    return defaultLayout
}

export function ResizableLayout({
    widgets,
    showCenter = true,
    className = '',
    onPanelResize
}) {
    const containerRef = useRef(null)
    const [containerWidth, setContainerWidth] = useState(1200)
    const [viewerKey, setViewerKey] = useState(0)
    const [autoSizeHeights, setAutoSizeHeights] = useState({})

    // Persisted: once a user manually resizes a widget, auto-size no longer overrides it
    const [manualResized, setManualResized] = useState(() => {
        try {
            const saved = localStorage.getItem(MANUAL_RESIZED_KEY)
            return saved ? new Set(JSON.parse(saved)) : new Set()
        } catch { return new Set() }
    })

    const [layoutWithViewer, setLayoutWithViewer] = useState(() =>
        loadLayout(LAYOUT_KEY_WITH_VIEWER, DEFAULT_LAYOUT_WITH_VIEWER)
    )
    const [layoutNoViewer, setLayoutNoViewer] = useState(() =>
        loadLayout(LAYOUT_KEY_NO_VIEWER, DEFAULT_LAYOUT_NO_VIEWER)
    )

    // Keep localStorage in sync with state (handleLayoutChange updates state but not localStorage)
    useEffect(() => {
        localStorage.setItem(LAYOUT_KEY_WITH_VIEWER, JSON.stringify(layoutWithViewer))
    }, [layoutWithViewer])
    useEffect(() => {
        localStorage.setItem(LAYOUT_KEY_NO_VIEWER, JSON.stringify(layoutNoViewer))
    }, [layoutNoViewer])

    // Pinned panels
    const PINNED_PANELS_KEY = 'dashboard-pinned-panels'
    const [pinnedPanels, setPinnedPanels] = useState(() => {
        try {
            const stored = localStorage.getItem(PINNED_PANELS_KEY)
            return stored ? new Set(JSON.parse(stored)) : new Set()
        } catch { return new Set() }
    })
    useEffect(() => {
        localStorage.setItem(PINNED_PANELS_KEY, JSON.stringify([...pinnedPanels]))
    }, [pinnedPanels])

    const handleTogglePinPanel = (panelId) => {
        setPinnedPanels(prev => {
            const next = new Set(prev)
            next.has(panelId) ? next.delete(panelId) : next.add(panelId)
            return next
        })
    }

    const handleContentResize = useCallback((widgetId, px) => {
        setAutoSizeHeights(prev => prev[widgetId] === px ? prev : { ...prev, [widgetId]: px })
    }, [])

    // Clean up pinned panels when widgets change
    useEffect(() => {
        const widgetIds = new Set(widgets.map(w => w.id))
        setPinnedPanels(prev => {
            const cleaned = new Set([...prev].filter(id => widgetIds.has(id)))
            return cleaned.size !== prev.size ? cleaned : prev
        })
    }, [widgets])

    const widgetById = useMemo(() => new Map(widgets.map(w => [w.id, w])), [widgets])

    const currentLayout = useMemo(() => {
        const layout = showCenter ? layoutWithViewer : layoutNoViewer
        const widgetIds = widgets.map(w => w.id)
        const layoutById = new Map(layout.map(item => [item.i, item]))
        const cleanLayout = layout.filter(l => widgetIds.includes(l.i))
        const newEntries = widgetIds
            .filter(id => !layoutById.has(id))
            .map(id => ({ i: id, x: 0, y: Infinity, w: 16, h: 9, minW: 2, minH: 3 }))
        const mergedLayout = [...cleanLayout, ...newEntries]

        const PANEL_HEADER_PX = 40
        return mergedLayout.map(item => {
            const widget = widgetById.get(item.i)
            const canAutoSize = !widget?.noPadding && !manualResized.has(item.i)
            const measuredPx = autoSizeHeights[item.i]
            let h = item.h
            if (canAutoSize && measuredPx > 0) {
                h = Math.max(item.minH || 3, Math.ceil((measuredPx + PANEL_HEADER_PX + 8) / ROW_HEIGHT))
            }
            return { ...item, h, minW: item.i === 'center' ? 3 : 2, minH: 3, static: pinnedPanels.has(item.i) }
        })
    }, [showCenter, layoutWithViewer, layoutNoViewer, widgets, pinnedPanels, autoSizeHeights, manualResized, widgetById])

    const [isMobile, setIsMobile] = useState(window.innerWidth < 768)

    useEffect(() => {
        if (!containerRef.current) return
        const observer = new ResizeObserver(entries => {
            const width = entries[0]?.contentRect.width
            if (width) { setContainerWidth(width); setIsMobile(width < 768) }
        })
        observer.observe(containerRef.current)
        return () => observer.disconnect()
    }, [])

    const mobileLayout = useMemo(() => {
        if (!showCenter) return [
            { i: 'left', x: 0, y: 0, w: 24, h: 10, static: true },
            { i: 'right', x: 0, y: 10, w: 24, h: 10, static: true }
        ]
        return [
            { i: 'center', x: 0, y: 0, w: 24, h: 12, static: true },
            { i: 'left', x: 0, y: 12, w: 24, h: 10, static: true },
            { i: 'right', x: 0, y: 22, w: 24, h: 10, static: true }
        ]
    }, [showCenter])

    const activeLayout = isMobile ? mobileLayout : currentLayout

    const handleLayoutChange = useCallback((newLayout) => {
        if (showCenter) {
            setLayoutWithViewer(newLayout)
        } else {
            setLayoutNoViewer(newLayout)
        }
    }, [showCenter])

    const handleResizeStop = useCallback((layout, oldItem, newItem) => {
        if (showCenter) {
            setLayoutWithViewer(layout)
            localStorage.setItem(LAYOUT_KEY_WITH_VIEWER, JSON.stringify(layout))
        } else {
            setLayoutNoViewer(layout)
            localStorage.setItem(LAYOUT_KEY_NO_VIEWER, JSON.stringify(layout))
        }

        setManualResized(prev => {
            const next = new Set([...prev, newItem.i])
            localStorage.setItem(MANUAL_RESIZED_KEY, JSON.stringify([...next]))
            return next
        })

        if (newItem.i === 'center') setViewerKey(k => k + 1)
        if (onPanelResize) {
            onPanelResize(newItem.i, {
                width: newItem.w * (containerWidth / GRID_COLS),
                height: newItem.h * ROW_HEIGHT
            })
        }
    }, [showCenter, onPanelResize, containerWidth])

    return (
        <div ref={containerRef} className={`w-full overflow-x-hidden overflow-y-auto ${className}`} style={{ minHeight: 'calc(100vh - 180px)' }}>
            <GridLayout
                className="layout"
                layout={activeLayout}
                cols={GRID_COLS}
                rowHeight={ROW_HEIGHT}
                width={containerWidth}
                onLayoutChange={isMobile ? undefined : handleLayoutChange}
                onDragStop={handleResizeStop}
                onResizeStop={handleResizeStop}
                draggableHandle=".panel-header"
                margin={[16, 16]}
                containerPadding={[0, 0]}
                useCSSTransforms={true}
                compactType={null}
                preventCollision={false}
                isResizable={!isMobile}
                isDraggable={!isMobile}
                resizeHandles={['se', 'sw', 's', 'n', 'e', 'w']}
                resizeConfig={{ handles: ['se', 'sw', 's', 'n', 'e', 'w'], enabled: !isMobile }}
                dragConfig={{ handle: '.panel-header', cancel: 'button,input,select,textarea,a,[role="button"]' }}
            >
                {widgets.map(widget => (
                    <div key={widget.id}>
                        <PanelWrapper
                            title={widget.title}
                            fullHeight={widget.fullHeight}
                            panelId={widget.id}
                            isPinned={pinnedPanels.has(widget.id)}
                            onTogglePin={handleTogglePinPanel}
                            onContentResize={!widget.noPadding ? (px) => handleContentResize(widget.id, px) : undefined}
                        >
                            {widget.noPadding ? (
                                <div className="h-full w-full" key={widget.id === 'center' ? viewerKey : undefined}>
                                    {widget.content}
                                </div>
                            ) : (
                                <div className="p-4 space-y-4">{widget.content}</div>
                            )}
                        </PanelWrapper>
                    </div>
                ))}
            </GridLayout>
        </div>
    )
}

function PanelWrapper({
    title, children, fullHeight = false,
    panelId, isPinned = false, onTogglePin,
    onContentResize
}) {
    const contentRef = useRef(null)

    useEffect(() => {
        if (!onContentResize || !contentRef.current) return
        const el = contentRef.current
        const report = () => { if (el.clientHeight > 0) onContentResize(el.clientHeight) }
        const obs = new ResizeObserver(report)
        obs.observe(el)
        report()
        return () => obs.disconnect()
    }, [onContentResize])

    return (
        <div className={`h-full w-full glass-card p-0 overflow-hidden flex flex-col ${fullHeight ? 'min-h-0' : ''}`}>
            {/* Drag handle header */}
            <div className={`panel-header flex items-center justify-between px-3 py-2 border-b border-white/10 select-none bg-gradient-to-r from-white/5 to-transparent shrink-0 ${isPinned ? 'cursor-default' : 'cursor-move'}`}>
                <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider truncate">{title}</span>
                <div className="flex items-center gap-1 shrink-0">
                    {onTogglePin && (
                        <button
                            onClick={(e) => { e.stopPropagation(); onTogglePin(panelId) }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="p-1 hover:bg-white/10 rounded transition-colors"
                            title={isPinned ? 'Unpin panel' : 'Pin panel'}
                        >
                            <Pin className={`w-3.5 h-3.5 ${isPinned ? 'text-cyan-400 fill-cyan-400' : 'text-zinc-500'}`} />
                        </button>
                    )}
                    {!isPinned && (
                        <div className="flex items-center gap-1 opacity-40 ml-1">
                            <div className="w-1 h-1 rounded-full bg-current" />
                            <div className="w-1 h-1 rounded-full bg-current" />
                            <div className="w-1 h-1 rounded-full bg-current" />
                        </div>
                    )}
                </div>
            </div>
            {/* Content — measured for auto-sizing; noPadding panels fill cell height instead */}
            <div
                ref={onContentResize ? contentRef : undefined}
                className={onContentResize ? '' : 'flex-1 overflow-hidden min-h-0'}
            >
                {children}
            </div>
        </div>
    )
}
