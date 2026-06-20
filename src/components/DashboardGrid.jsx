import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { X, Pin, PinOff } from 'lucide-react'
import GridLayout from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { settingBtnCls, settingBtnInactive, settingBtnActive, settingInputCls, ColorRow } from './chartSettingsUI'

const MOBILE_BREAKPOINT = 768
// Bumped v4 -> v5 to force everyone onto the new compact default sizing below
// (viewer + 4 charts + a table all fit on one screen without scrolling).
//
// v5 -> v6: pure granularity doubling (like v2->v3->v4 before it) so resize
// snapping is fine enough that a panel can actually reach the canvas's right
// edge instead of stopping a column short. Physical sizes are unchanged —
// every column/row count below is doubled while colWidth/rowHeight halve.
//
// v6 -> v7: same reason as v4 -> v5 above, not a coordinate-system change.
// mergeLayouts() always prefers an existing `saved` entry over recomputing a
// default, so any panel that got an oversized position from the old naive
// slot-index bug (fixed in mergeLayouts/findFreeSlot) keeps that bad size
// forever once it's persisted — the fix only protects *new* panels. Bumping
// the key abandons that contaminated data so every panel goes through the
// fixed placement logic fresh.
//
// v7 -> v8: v7 was loaded once in production with the old loadSavedLayout()
// still in place (the one below, with the v5/v3/v2 legacy-migration fallback
// chain). That one load found v7 empty, fell back to the old v5 key, scaled
// it x2, and WROTE the scaled result into v7 — poisoning the supposed clean
// slate before the fallback removal even shipped. The legacy chain itself is
// gone for good now (see history below), so v8 is a real clean slate with no
// mechanism left that could ever resurrect old coordinates into it.
//
// v8 -> v9: the actual root cause of "every panel renders oversized", present
// since the v5->v6 granularity doubling and untouched by any of the above —
// react-grid-layout computes pixel size as
//   unitSize * units + (units - 1) * marginPx
// (see calcGridItemWHPx in its source). With COLS=192/ROW_HEIGHT=4, a panel
// needs a LOT of units to reach a normal physical size, so the margin term
// (units - 1) * 8 swamps the actual unitSize * units term — e.g. a 60-row
// panel computed to 4*60 + 8*59 = 712px tall, nearly 3x its intended size.
// This hit every panel (viewer included — it just read as "fine" because a
// dark 3D thumbnail doesn't visually scream "huge" the way a chart does).
// Fix: make the grid coarser (fewer, bigger units) so the same 8px margin is
// a small fraction of a panel's size instead of dominating it. Panel
// proportions (quarter-width slots, full-width table) are unchanged — only
// COLS/ROW_HEIGHT and the matching W/H constants below were rescaled.
//
// v9 -> v10: charts/widgets now default to half the viewer's width and half
// its height (quarter its area) instead of matching it 1:1, so the viewer
// reads as the dashboard's primary panel and more tiles fit per screen.
//
// v10 -> v11: viewer default resized (VIEWER_W/H 6x10 -> 5x5).
//
// v11 -> v12: SLOT_H rescaled (5 -> 3) to track the viewer's new 5x5 size —
// slots stay at half the viewer's width/height (now square, like the viewer).
const LAYOUT_KEY = 'dashboard-panel-layout-v12'
const CHART_SETTINGS_KEY = 'dashboard-chart-settings'
const PINNED_VIEWER_KEY = 'dashboard-viewer-pinned'
const PIN_TOP_GAP = 8   // px gap below the header, matches the grid's own margin/containerPadding
const PIN_Z_INDEX = 35  // below header's z-50, above ordinary scrolling panel content
const COLS = 24
const ROW_HEIGHT = 24

function useIsMobile() {
    const [isMobile, setIsMobile] = useState(
        () => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT
    )
    useEffect(() => {
        const fn = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
        window.addEventListener('resize', fn)
        return () => window.removeEventListener('resize', fn)
    }, [])
    return isMobile
}

function loadSavedLayout() {
    try {
        const saved = localStorage.getItem(LAYOUT_KEY)
        return saved ? JSON.parse(saved) : []
    } catch { return [] }
}

// Viewer defaults to a quarter-width tile. Charts/widgets default to half its
// width and half its height (a quarter its area) so the viewer reads as the
// dashboard's primary panel — newly added widgets flow into the next free
// slot at this smaller size, and the user grows one deliberately if needed.
const VIEWER_W = 5
const VIEWER_H = 5
const SLOT_W = 3
const SLOT_H = 3
const TABLE_W = COLS    // tables default to full width to show their columns usefully
const TABLE_H = 8

function defaultPanelLayout(panel, pos) {
    if (panel.type === 'viewer') {
        return { i: panel.id, x: 0, y: 0, w: VIEWER_W, h: VIEWER_H, minW: 1, minH: 1 }
    }
    if (panel.type === 'table') {
        return { i: panel.id, x: 0, y: Infinity, w: TABLE_W, h: TABLE_H, minW: 1, minH: 1 }
    }
    // Charts and every other widget type share one flowing grid of slots,
    // starting right after the viewer (if present). `pos` (from findFreeSlot,
    // below) is the actual free cell — not assumed from array order.
    return { i: panel.id, x: pos?.x ?? 0, y: pos?.y ?? 0, w: SLOT_W, h: SLOT_H, minW: 1, minH: 1 }
}

function rectsOverlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

// First free SLOT_W x SLOT_H cell, row-major, that doesn't overlap anything
// in `occupied` — used to place a brand-new panel (no saved position yet)
// into real free space instead of a naive slot-index guess, which can land
// on top of a panel the user has already moved or resized.
function findFreeSlot(occupied, startX) {
    const slotsPerRow = Math.max(1, Math.floor((COLS - startX) / SLOT_W))
    for (let row = 0; ; row++) {
        for (let col = 0; col < slotsPerRow; col++) {
            const candidate = { x: startX + col * SLOT_W, y: row * SLOT_H, w: SLOT_W, h: SLOT_H }
            if (!occupied.some(r => rectsOverlap(candidate, r))) return candidate
        }
    }
}

function mergeLayouts(panels, savedLayout) {
    const panelIds = new Set(panels.map(p => p.id))
    const hasViewer = panels.some(p => p.type === 'viewer')
    const startX = hasViewer ? VIEWER_W : 0
    const savedById = new Map(
        savedLayout
            .filter(item => panelIds.has(item.i))
            .map(item => [item.i, item])
    )

    // Built up as we go, in panel order, so each new panel's free-slot search
    // sees every panel placed before it — including ones placed earlier in
    // this same pass (e.g. several charts becoming visible at once).
    const occupied = []
    return panels.map(panel => {
        const saved = savedById.get(panel.id)
        const isFlowSlot = panel.type !== 'viewer' && panel.type !== 'table'
        const defaults = (isFlowSlot && !saved)
            ? defaultPanelLayout(panel, findFreeSlot(occupied, startX))
            : defaultPanelLayout(panel, null)
        const result = {
            ...defaults,
            ...saved,
            // Always use current minW/minH from defaults so old saved values
            // with larger minimums can't prevent panels from being resized small.
            minW: defaults.minW,
            minH: defaults.minH,
            i: panel.id,
        }
        occupied.push(result)
        return result
    })
}

// ── Popover style helpers — shared with ChartBuilder via chartSettingsUI ──
function SettingRow({ label, children }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">{label}</span>
            {children}
        </div>
    )
}
function ToggleBtn({ label, active, ...rest }) {
    return (
        <button {...rest} className={`flex-1 ${settingBtnCls} ${active ? settingBtnActive : settingBtnInactive}`}>
            {active ? '✓ ' : ''}{label}
        </button>
    )
}

const CHART_TYPES = [
    { type: 'bar', orientation: 'h', label: 'H-Bar' },
    { type: 'bar', orientation: 'v', label: 'V-Bar' },
    { type: 'pie', orientation: null, label: 'Pie'   },
]

const COLOR_SCHEMES = [
    { id: 'default', label: 'Purple',  colors: ['#A855F7','#D946EF','#EC4899','#8B5CF6','#6366F1','#3B82F6','#0EA5E9'] },
    { id: 'speckle', label: 'Speckle', colors: ['#136CFF','#276FE5','#4B40C9','#34D399','#FBBF24','#F87171','#B8C0CC'] },
    { id: 'emerald', label: 'Green',   colors: ['#10B981','#34D399','#6EE7B7','#059669','#047857','#065F46','#064E3B'] },
    { id: 'blue',    label: 'Blue',    colors: ['#3B82F6','#60A5FA','#93C5FD','#2563EB','#1D4ED8','#1E40AF','#1E3A8A'] },
    { id: 'amber',   label: 'Amber',   colors: ['#F59E0B','#FBBF24','#FCD34D','#D97706','#B45309','#92400E','#78350F'] },
    { id: 'rose',    label: 'Rose',    colors: ['#F43F5E','#FB7185','#FDA4AF','#E11D48','#BE123C','#9F1239','#881337'] },
]

const SORT_OPTIONS = [
    { id: 'desc', label: 'Most first'  },
    { id: 'asc',  label: 'Least first' },
    { id: 'az',   label: 'A → Z'       },
    { id: 'za',   label: 'Z → A'       },
]

// Colors a chart panel's settings might have had baked in by the old buggy
// updateChartSettings (see below) — stripped from persisted settings on load
// so previously-saved panels go back to following the live dark/light toggle.
const STALE_DEFAULT_FONT_COLORS = new Set(['#e4e4e7', '#000000'])

const DEFAULT_CHART_SETTINGS = {
    type: 'bar', orientation: 'h',
    title: null, maxItems: 15,
    colorScheme: 'default', sortOrder: 'desc',
    minCount: 0, showLabels: true, donut: true,
    showLegend: false, showGridLines: true,
    // Axis / label typography
    // tickAngle: null = orientation-aware default (0° for horizontal bars, -45° for vertical)
    // Font colors are intentionally absent here — they default to whatever the
    // live dark/light toggle resolves to (see getChartSettings) unless the user
    // explicitly picks a custom color via the settings popover.
    tickFontSize: 11,
    tickAngle: null,
    valueFontSize: 11,
    labelFontSize: 11,
    // Value/axis formatting
    // unit: free-text suffix appended to values (e.g. "m³", "kg"); decimals:
    // null = auto (2 if a unit is set, else 0); axisMin/axisMax: null = auto-scaled.
    unit: null,
    decimals: null,
    thousandsSeparator: true,
    axisMin: null,
    axisMax: null,
    // Pie/donut leader-line label content — each independently toggleable.
    pieLabelName: true,
    pieLabelValue: true,
    pieLabelPercent: true,
    // Leader line connecting an outside label back to its slice — independent
    // of whether labels themselves are shown, so labels can float without one.
    pieLeaderLine: true,
    // BCF Issue Stats widget only
    showSummaryTiles: true,
    showPriorityChips: true,
}

export function GridDashboard({ panels, renderPanel, onClosePanel, darkMode = true }) {
    const isMobile = useIsMobile()
    const containerRef = useRef(null)
    const [containerWidth, setContainerWidth] = useState(1200)

    const [chartSettings, setChartSettings] = useState(() => {
        try {
            const saved = localStorage.getItem(CHART_SETTINGS_KEY)
            if (!saved) return {}
            const parsed = JSON.parse(saved)
            // Migration: earlier versions baked the currently-active theme's font
            // color into every panel's settings on any edit, so panels touched
            // while in dark mode stayed stuck on dark-mode colors forever after
            // switching to light mode (and vice versa). Strip those stale baked
            // values so affected panels go back to following the live toggle.
            for (const settings of Object.values(parsed)) {
                for (const key of ['tickFontColor', 'valueFontColor', 'labelFontColor']) {
                    if (STALE_DEFAULT_FONT_COLORS.has(settings[key])) delete settings[key]
                }
            }
            return parsed
        } catch { return {} }
    })
    useEffect(() => {
        localStorage.setItem(CHART_SETTINGS_KEY, JSON.stringify(chartSettings))
    }, [chartSettings])
    const getChartSettings = (panelId) => ({
        ...DEFAULT_CHART_SETTINGS,
        tickFontColor:  darkMode ? '#e4e4e7' : '#000000',
        valueFontColor: darkMode ? '#e4e4e7' : '#000000',
        labelFontColor: darkMode ? '#e4e4e7' : '#000000',
        ...chartSettings[panelId],
    })
    const updateChartSettings = (panelId, updates) =>
        setChartSettings(prev => ({ ...prev, [panelId]: { ...prev[panelId], ...updates } }))

    // Which chart panel currently has its settings popover open
    const [settingsPanelId, setSettingsPanelId] = useState(null)
    const closeSettings = () => setSettingsPanelId(null)

    // Viewer pin: when on, the viewer's real content renders into a fixed-position
    // portal (see render below) instead of inline, so it stays put while the rest
    // of the canvas scrolls. react-grid-layout absolutely-positions every child it
    // manages via inline style, which native CSS `position: sticky` can't override —
    // portaling out of its control is the only way to get sticky-like behavior here.
    const [pinnedViewer, setPinnedViewer] = useState(() => {
        try { return localStorage.getItem(PINNED_VIEWER_KEY) === '1' } catch { return false }
    })
    useEffect(() => {
        try { localStorage.setItem(PINNED_VIEWER_KEY, pinnedViewer ? '1' : '0') } catch { /* ignore */ }
    }, [pinnedViewer])

    // Tracks the placeholder's on-screen rect so the portaled viewer can match it.
    // `top` is deliberately NOT scroll-driven (header height + a fixed gap only) —
    // that's the whole point of pinning. `left`/`width`/`height` track the
    // placeholder via ResizeObserver since the page only scrolls vertically
    // (overflow-x: hidden), so horizontal position is scroll-invariant.
    const placeholderRef = useRef(null)
    const [pinnedRect, setPinnedRect] = useState({ top: 0, left: 0, width: 0, height: 0 })
    useEffect(() => {
        if (!pinnedViewer) return
        const headerEl = document.querySelector('header')
        const placeholderEl = placeholderRef.current
        if (!placeholderEl) return

        const update = () => {
            const headerH = headerEl?.getBoundingClientRect().height ?? 0
            const r = placeholderEl.getBoundingClientRect()
            setPinnedRect({ top: headerH + PIN_TOP_GAP, left: r.left, width: r.width, height: r.height })
        }
        update()

        const ro = new ResizeObserver(update)
        ro.observe(placeholderEl)
        if (headerEl) ro.observe(headerEl)
        window.addEventListener('resize', update)
        return () => { ro.disconnect(); window.removeEventListener('resize', update) }
    }, [pinnedViewer])

    // liveLayoutRef: always holds the latest positions; updated on every
    // onLayoutChange tick without causing a re-render.
    const liveLayoutRef = useRef(loadSavedLayout())

    // panelKey encodes both IDs and types so layoutForGridLayout rebuilds when
    // the panel set or any panel's type changes (fix: type-only changes were missed).
    const panelKey = panels.map(p => `${p.id}:${p.type}`).join(',')

    // Chart panel ids are deterministic (`chart-${chartKey}`), so toggling a
    // chart off then back on reuses the same id. If a saved position from a
    // previous session still sits in liveLayoutRef for that id, the merge
    // below would resurrect it as-is — including stale/oversized values left
    // over from this layout scheme's grid-granularity migrations. Detect the
    // hidden->visible transition and drop that stale entry so the chart goes
    // through mergeLayouts' fresh free-slot search instead, the same as any
    // other brand-new panel. One extra render (via purgeTick) is the cost of
    // not mutating the ref during render itself.
    const prevChartIdsRef = useRef(new Set())
    const [purgeTick, setPurgeTick] = useState(0)
    useEffect(() => {
        const currentChartIds = new Set(
            panels.filter(p => p.type === 'chart' && !p.widget).map(p => p.id)
        )
        const newlyShown = [...currentChartIds].filter(id => !prevChartIdsRef.current.has(id))
        prevChartIdsRef.current = currentChartIds
        if (newlyShown.length === 0) return
        const before = liveLayoutRef.current.length
        liveLayoutRef.current = liveLayoutRef.current.filter(item => !newlyShown.includes(item.i))
        if (liveLayoutRef.current.length !== before) setPurgeTick(t => t + 1)
    }, [panelKey])

    // Computed inside useMemo (not in the render body) to avoid mutating refs
    // during speculative renders in React 18 concurrent mode.
    // The layout reference is STABLE across re-renders where panelKey doesn't
    // change — same object reference → react-grid-layout's deepEqual is trivially
    // true → no mid-gesture position reset.
    const layoutForGridLayout = useMemo(() => {
        const merged = mergeLayouts(panels, liveLayoutRef.current)
        // Dragging the viewer's placeholder while pinned would be meaningless (its
        // real content lives in the portal below) — disable drag only, not resize,
        // so the reserved slot (and the pinned box that tracks its rect) can still
        // be resized. Always set explicitly (not just "add when pinned") — RGL's
        // onLayoutChange fires on every render and echoes the layout array back,
        // so handleLayoutChange persists whatever isDraggable value was here into
        // liveLayoutRef.current; only setting it while pinned would let `false`
        // leak into the saved layout and stick around after unpinning.
        return merged.map(item => item.i === 'viewer' ? { ...item, isDraggable: !pinnedViewer } : item)
    },
        // liveLayoutRef.current is intentionally read only when panelKey/purgeTick changes
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [panelKey, purgeTick, pinnedViewer]
    )

    useEffect(() => {
        if (!containerRef.current) return
        const obs = new ResizeObserver(entries => {
            const w = entries[0]?.contentRect.width
            if (w) setContainerWidth(w)
        })
        obs.observe(containerRef.current)
        return () => obs.disconnect()
    }, [])

    const handleLayoutChange = useCallback((nextLayout) => {
        // Merge: update positions of currently-rendered panels, preserve positions of absent ones
        // (react-grid-layout fires this on every render — if charts aren't mounted yet, their
        // seeded positions must survive until they appear)
        const nextById = new Map(nextLayout.map(item => [item.i, item]))
        const merged = liveLayoutRef.current.map(item =>
            nextById.has(item.i) ? nextById.get(item.i) : item
        )
        nextLayout.forEach(item => {
            if (!merged.some(m => m.i === item.i)) merged.push(item)
        })
        liveLayoutRef.current = merged
    }, [])

    const handleLayoutEnd = useCallback((nextLayout) => {
        const nextById = new Map(nextLayout.map(item => [item.i, item]))
        const merged = liveLayoutRef.current.map(item =>
            nextById.has(item.i) ? nextById.get(item.i) : item
        )
        nextLayout.forEach(item => {
            if (!merged.some(m => m.i === item.i)) merged.push(item)
        })
        liveLayoutRef.current = merged
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(merged))
        window.dispatchEvent(new Event('resize'))
    }, [])

    if (isMobile) {
        return (
            <div className="flex flex-col gap-2 p-2">
                {panels.map(panel => (
                    <div
                        key={panel.id}
                        className="panel-thin w-full overflow-hidden"
                        style={{ height: panel.type === 'viewer' ? '60vh' : '300px' }}
                    >
                        {renderPanel(panel)}
                        {panel.type !== 'viewer' && onClosePanel && (
                            <button
                                onMouseDown={e => e.stopPropagation()}
                                onClick={e => { e.stopPropagation(); onClosePanel(panel) }}
                                style={{
                                    position: 'absolute', top: 4, right: 4,
                                    zIndex: 9999, width: 20, height: 20,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    borderRadius: 4, cursor: 'pointer',
                                    background: 'transparent', border: 'none', padding: 0,
                                    color: 'var(--speckle-foreground-3)',
                                }}
                                title="Close panel"
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>
                ))}
            </div>
        )
    }

    return (
        // Cancel the parent <main>'s px-4 lg:px-6 py-2 so containerPadding below
        // (8px) is the *only* source of edge spacing — making it match the 8px
        // gap between panels instead of stacking on top of it.
        // Width must explicitly compensate for the negative margin: combining
        // `w-full` (100%) with `-mx-*` is over-constrained, so the browser
        // silently drops the right margin and the grid falls short on the
        // right instead of reaching the true edge — calc() keeps both margins.
        <div ref={containerRef} className="w-[calc(100%+2rem)] lg:w-[calc(100%+3rem)] -mx-4 lg:-mx-6 -mt-2">
            <GridLayout
                layout={layoutForGridLayout}
                cols={COLS}
                rowHeight={ROW_HEIGHT}
                width={containerWidth}
                margin={[8, 8]}
                containerPadding={[8, 8]}
                draggableHandle=".drag-zone"
                draggableCancel="button,input,select,textarea,a,[role='button']"
                resizeHandles={['se', 'sw', 's', 'n', 'e', 'w']}
                resizeConfig={{ handles: ['se', 'sw', 's', 'n', 'e', 'w'] }}
                dragConfig={{ handle: '.drag-zone', cancel: 'button,input,select,textarea,a,[role="button"]' }}
                compactType="vertical"
                preventCollision={false}
                isDraggable
                isResizable
                useCSSTransforms
                onLayoutChange={handleLayoutChange}
                onDragStop={handleLayoutEnd}
                onResizeStop={handleLayoutEnd}
            >
                {panels.map(panel => {
                    const cs = getChartSettings(panel.id)
                    // Custom widget charts (sunburst/treemap/etc) carry their own type via
                    // ChartBuilder — the type-toggle buttons (and `cs.type`) don't apply to them.
                    const effectiveChartType = panel.widget?.chartConfig?.config?.type ?? cs.type
                    const settingsOpen = settingsPanelId === panel.id
                    return (
                        <div
                            key={panel.id}
                            className="panel-thin"
                            onDoubleClick={(panel.type === 'chart' || panel.type === 'bcf_stats')
                                ? e => { e.stopPropagation(); setSettingsPanelId(settingsOpen ? null : panel.id) }
                                : undefined}
                        >
                            {/* Overflow clip on inner wrapper only — outer must stay clean
                                so react-resizable handle spans are not clipped */}
                            <div className="absolute inset-0 overflow-hidden rounded-[6px]">
                                {panel.type === 'viewer' && pinnedViewer ? (
                                    <div
                                        ref={placeholderRef}
                                        className="w-full h-full flex flex-col items-center justify-center gap-2 border-2 border-dashed border-[var(--speckle-outline-3)] rounded-[6px] text-[var(--speckle-foreground-3)] cursor-pointer select-none"
                                        onMouseDown={e => e.stopPropagation()}
                                        onClick={e => { e.stopPropagation(); setPinnedViewer(false) }}
                                        title="Click to unpin viewer"
                                    >
                                        <PinOff size={20} />
                                        <span className="text-xs">Pinned — click to unpin</span>
                                    </div>
                                ) : (
                                    renderPanel(panel, cs)
                                )}
                            </div>

                            {/* Chart-type toggles — standard chart panels only, not custom widget charts */}
                            {panel.type === 'chart' && !panel.widget && (
                                <div style={{ position: 'absolute', top: 4, right: 28, zIndex: 9999, display: 'flex', gap: 2 }}>
                                    {CHART_TYPES.map(({ type, orientation, label }) => {
                                        const active = cs.type === type && (type === 'pie' || cs.orientation === orientation)
                                        return (
                                            <button key={label}
                                                onMouseDown={e => e.stopPropagation()}
                                                onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { type, orientation: orientation || 'h' }) }}
                                                title={label}
                                                style={{ width: 20, height: 20, borderRadius: 4, border: 'none', outline: 'none', cursor: 'pointer', padding: 0, fontSize: 10, background: active ? 'rgba(39,111,229,0.2)' : 'transparent', color: active ? 'var(--speckle-outline-1)' : 'var(--speckle-foreground-3)' }}
                                            >{label[0]}</button>
                                        )
                                    })}
                                </div>
                            )}

                            {/* Close button */}
                            {panel.type !== 'viewer' && onClosePanel && (
                                <button
                                    onMouseDown={e => e.stopPropagation()}
                                    onClick={e => { e.stopPropagation(); onClosePanel(panel) }}
                                    style={{ position: 'absolute', top: 4, right: 4, zIndex: 9999, width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, cursor: 'pointer', background: 'transparent', border: 'none', outline: 'none', padding: 0, color: 'var(--speckle-foreground-3)' }}
                                    title="Close panel"
                                ><X size={12} /></button>
                            )}

                            {/* Pin toggle — viewer only for now. Same corner the close button
                                would use on any other panel (free here since the viewer has none). */}
                            {panel.type === 'viewer' && (
                                <button
                                    onMouseDown={e => e.stopPropagation()}
                                    onClick={e => { e.stopPropagation(); setPinnedViewer(v => !v) }}
                                    style={{ position: 'absolute', top: 4, right: 4, zIndex: 9999, width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, cursor: 'pointer', background: pinnedViewer ? 'rgba(39,111,229,0.2)' : 'transparent', border: 'none', outline: 'none', padding: 0, color: pinnedViewer ? 'var(--speckle-outline-1)' : 'var(--speckle-foreground-3)' }}
                                    title={pinnedViewer ? 'Unpin viewer' : 'Pin viewer to top'}
                                >{pinnedViewer ? <PinOff size={12} /> : <Pin size={12} />}</button>
                            )}

                            {/* Settings popover — opens on double-click for all chart panels */}
                            {(panel.type === 'chart' || panel.type === 'bcf_stats') && settingsOpen && (
                                <div
                                    onMouseDown={e => e.stopPropagation()}
                                    onClick={e => e.stopPropagation()}
                                    className="absolute bottom-2 left-1/2 -translate-x-1/2 z-[9999] w-[290px] max-h-[80%] overflow-y-auto glass-card shadow-2xl flex flex-col gap-2.5"
                                >
                                    {/* Header */}
                                    <div className="flex items-center justify-between">
                                        <span className="text-[11px] font-semibold text-[var(--speckle-foreground-2)] uppercase tracking-wider">
                                            {panel.type === 'bcf_stats' ? 'Widget properties' : 'Chart properties'}
                                        </span>
                                        <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); closeSettings() }} className="text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] transition-colors"><X size={13} /></button>
                                    </div>

                                    {panel.type === 'bcf_stats' ? (<>
                                        {/* ── BCF Issue Stats — donut + label content ──── */}
                                        <SettingRow label="Show in leader-line label">
                                            <div className="flex gap-1">
                                                <ToggleBtn label="Name" active={cs.pieLabelName}
                                                    onMouseDown={e => e.stopPropagation()}
                                                    onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { pieLabelName: !cs.pieLabelName }) }} />
                                                <ToggleBtn label="Value" active={cs.pieLabelValue}
                                                    onMouseDown={e => e.stopPropagation()}
                                                    onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { pieLabelValue: !cs.pieLabelValue }) }} />
                                                <ToggleBtn label="%" active={cs.pieLabelPercent}
                                                    onMouseDown={e => e.stopPropagation()}
                                                    onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { pieLabelPercent: !cs.pieLabelPercent }) }} />
                                            </div>
                                        </SettingRow>

                                        <div className="flex gap-2 flex-wrap">
                                            <ToggleBtn label="Donut" active={cs.donut}
                                                onMouseDown={e => e.stopPropagation()}
                                                onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { donut: !cs.donut }) }} />
                                            <ToggleBtn label="Legend" active={cs.showLegend}
                                                onMouseDown={e => e.stopPropagation()}
                                                onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { showLegend: !cs.showLegend }) }} />
                                            <ToggleBtn label="Labels" active={cs.showLabels}
                                                onMouseDown={e => e.stopPropagation()}
                                                onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { showLabels: !cs.showLabels }) }} />
                                            <ToggleBtn label="Leader line" active={cs.pieLeaderLine}
                                                onMouseDown={e => e.stopPropagation()}
                                                onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { pieLeaderLine: !cs.pieLeaderLine }) }} />
                                        </div>

                                        {cs.showLabels && (<>
                                            <SettingRow label={`Label size: ${cs.labelFontSize}px`}>
                                                <input type="range" min={7} max={16} step={1} value={cs.labelFontSize}
                                                    onChange={e => updateChartSettings(panel.id, { labelFontSize: Number(e.target.value) })}
                                                    className="w-full accent-[var(--speckle-outline-1)]" />
                                            </SettingRow>
                                            <ColorRow label="Label colour"
                                                value={cs.labelFontColor}
                                                onChange={v => updateChartSettings(panel.id, { labelFontColor: v })} />
                                        </>)}

                                        {/* ── Layout ────────────────────────────────── */}
                                        <div className="border-t border-[var(--speckle-outline-3)] pt-2 flex flex-col gap-2.5">
                                            <span className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Layout</span>
                                            <div className="flex gap-2 flex-wrap">
                                                <ToggleBtn label="Summary tiles" active={cs.showSummaryTiles}
                                                    onMouseDown={e => e.stopPropagation()}
                                                    onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { showSummaryTiles: !cs.showSummaryTiles }) }} />
                                                <ToggleBtn label="Priority chips" active={cs.showPriorityChips}
                                                    onMouseDown={e => e.stopPropagation()}
                                                    onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { showPriorityChips: !cs.showPriorityChips }) }} />
                                            </div>
                                        </div>
                                    </>) : (<>

                                    {/* Title — widget panels manage title via ChartBuilder so skip */}
                                    {!panel.widget && (
                                        <SettingRow label="Title">
                                            <input type="text" value={cs.title ?? ''} onChange={e => updateChartSettings(panel.id, { title: e.target.value || null })} placeholder="Default" className={settingInputCls} />
                                        </SettingRow>
                                    )}

                                    {/* Chart type — widget panels manage type/orientation via ChartBuilder */}
                                    {!panel.widget && (
                                        <SettingRow label="Type">
                                            <div className="flex gap-1">
                                                {CHART_TYPES.map(({ type, orientation, label }) => {
                                                    const active = cs.type === type && (type === 'pie' || cs.orientation === orientation)
                                                    return (
                                                        <button key={label} onMouseDown={e => e.stopPropagation()}
                                                            onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { type, orientation: orientation || 'h' }) }}
                                                            className={`flex-1 ${settingBtnCls} ${active ? settingBtnActive : settingBtnInactive}`}
                                                        >{label}</button>
                                                    )
                                                })}
                                            </div>
                                        </SettingRow>
                                    )}

                                    {/* Sort order */}
                                    <SettingRow label="Sort">
                                        <div className="flex gap-1 flex-wrap">
                                            {SORT_OPTIONS.map(({ id, label }) => (
                                                <button key={id} onMouseDown={e => e.stopPropagation()}
                                                    onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { sortOrder: id }) }}
                                                    className={`flex-1 min-w-[60px] ${settingBtnCls} ${cs.sortOrder === id ? settingBtnActive : settingBtnInactive}`}
                                                >{label}</button>
                                            ))}
                                        </div>
                                    </SettingRow>

                                    {/* Color scheme */}
                                    <SettingRow label="Color">
                                        <div className="flex gap-1.5 items-center">
                                            {COLOR_SCHEMES.map(({ id, label, colors }) => (
                                                <button key={id} onMouseDown={e => e.stopPropagation()}
                                                    onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { colorScheme: id }) }}
                                                    title={label}
                                                    className={`w-6 h-6 rounded-md p-0 cursor-pointer border-2 ${cs.colorScheme === id ? 'border-[var(--speckle-outline-1)]' : 'border-transparent'}`}
                                                    style={{ background: `linear-gradient(135deg, ${colors[0]} 50%, ${colors[1]} 50%)` }}
                                                />
                                            ))}
                                        </div>
                                    </SettingRow>

                                    {/* Max items */}
                                    <SettingRow label={`Max items: ${cs.maxItems}`}>
                                        <input type="range" min={3} max={30} step={1} value={cs.maxItems}
                                            onChange={e => updateChartSettings(panel.id, { maxItems: Number(e.target.value) })}
                                            className="w-full accent-[var(--speckle-outline-1)]" />
                                    </SettingRow>

                                    {/* Min count threshold */}
                                    <SettingRow label={`Min count: ${cs.minCount}`}>
                                        <input type="range" min={0} max={50} step={1} value={cs.minCount}
                                            onChange={e => updateChartSettings(panel.id, { minCount: Number(e.target.value) })}
                                            className="w-full accent-[var(--speckle-outline-1)]" />
                                    </SettingRow>

                                    {/* Show labels / Donut / Legend / Grid lines toggles */}
                                    <div className="flex gap-2 flex-wrap">
                                        <ToggleBtn label="Labels" active={cs.showLabels} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { showLabels: !cs.showLabels }) }} />
                                        {effectiveChartType === 'pie' && (
                                            <ToggleBtn label="Donut" active={cs.donut} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { donut: !cs.donut }) }} />
                                        )}
                                        {['pie', 'sunburst', 'treemap', 'bar'].includes(effectiveChartType) && (
                                            <ToggleBtn label="Legend" active={cs.showLegend} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { showLegend: !cs.showLegend }) }} />
                                        )}
                                        {effectiveChartType === 'bar' && (
                                            <ToggleBtn label="Grid lines" active={cs.showGridLines} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { showGridLines: !cs.showGridLines }) }} />
                                        )}
                                    </div>

                                    {/* ── Typography ─────────────────────────────── */}
                                    <div className="border-t border-[var(--speckle-outline-3)] pt-2 flex flex-col gap-2.5">
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Typography</span>

                                        {/* Axis ticks */}
                                        <SettingRow label={`Axis tick size: ${cs.tickFontSize}px`}>
                                            <input type="range" min={7} max={18} step={1} value={cs.tickFontSize}
                                                onChange={e => updateChartSettings(panel.id, { tickFontSize: Number(e.target.value) })}
                                                className="w-full accent-[var(--speckle-outline-1)]" />
                                        </SettingRow>
                                        <ColorRow label="Axis tick colour"
                                            value={cs.tickFontColor}
                                            onChange={v => updateChartSettings(panel.id, { tickFontColor: v })} />

                                        {/* Value labels on bars */}
                                        {cs.showLabels && effectiveChartType === 'bar' && (<>
                                            <SettingRow label={`Value label size: ${cs.valueFontSize}px`}>
                                                <input type="range" min={7} max={16} step={1} value={cs.valueFontSize}
                                                    onChange={e => updateChartSettings(panel.id, { valueFontSize: Number(e.target.value) })}
                                                    className="w-full accent-[var(--speckle-outline-1)]" />
                                            </SettingRow>
                                            <ColorRow label="Value label colour"
                                                value={cs.valueFontColor}
                                                onChange={v => updateChartSettings(panel.id, { valueFontColor: v })} />
                                        </>)}

                                        {/* Pie slice labels */}
                                        {effectiveChartType === 'pie' && cs.showLabels && (<>
                                            <SettingRow label={`Slice label size: ${cs.labelFontSize}px`}>
                                                <input type="range" min={7} max={16} step={1} value={cs.labelFontSize}
                                                    onChange={e => updateChartSettings(panel.id, { labelFontSize: Number(e.target.value) })}
                                                    className="w-full accent-[var(--speckle-outline-1)]" />
                                            </SettingRow>
                                            <ColorRow label="Slice label colour"
                                                value={cs.labelFontColor}
                                                onChange={v => updateChartSettings(panel.id, { labelFontColor: v })} />
                                        </>)}

                                        {/* Axis label angle — category axis (X for vertical bars, Y for horizontal bars) */}
                                        {effectiveChartType === 'bar' && (() => {
                                            const effectiveAngle = cs.tickAngle ?? (cs.orientation === 'v' ? -45 : 0)
                                            return (
                                                <SettingRow label="Axis label angle">
                                                    <div className="flex gap-1">
                                                        {(cs.orientation === 'v' ? [0, -30, -45, -90] : [0, -15, -30, -45]).map(angle => (
                                                            <button key={angle} onMouseDown={e => e.stopPropagation()}
                                                                onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { tickAngle: angle }) }}
                                                                className={`flex-1 ${settingBtnCls} ${effectiveAngle === angle ? settingBtnActive : settingBtnInactive}`}
                                                            >{angle}°</button>
                                                        ))}
                                                    </div>
                                                </SettingRow>
                                            )
                                        })()}
                                    </div>

                                    {/* ── Value formatting ─────────────────────────── */}
                                    <div className="border-t border-[var(--speckle-outline-3)] pt-2 flex flex-col gap-2.5">
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Value formatting</span>

                                        <SettingRow label="Unit suffix">
                                            <input type="text" value={cs.unit ?? ''} placeholder="e.g. m³, kg"
                                                onChange={e => updateChartSettings(panel.id, { unit: e.target.value || null })}
                                                className={settingInputCls} />
                                        </SettingRow>

                                        <SettingRow label={`Decimals: ${cs.decimals ?? 'auto'}`}>
                                            <div className="flex gap-1">
                                                {[null, 0, 1, 2, 3].map(d => (
                                                    <button key={d ?? 'auto'} onMouseDown={e => e.stopPropagation()}
                                                        onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { decimals: d }) }}
                                                        className={`flex-1 ${settingBtnCls} ${cs.decimals === d ? settingBtnActive : settingBtnInactive}`}
                                                    >{d ?? 'Auto'}</button>
                                                ))}
                                            </div>
                                        </SettingRow>

                                        <ToggleBtn label="Thousands separator" active={cs.thousandsSeparator}
                                            onMouseDown={e => e.stopPropagation()}
                                            onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { thousandsSeparator: !cs.thousandsSeparator }) }} />

                                        {effectiveChartType === 'bar' && (
                                            <SettingRow label="Axis range">
                                                <div className="flex gap-1.5">
                                                    <input type="number" value={cs.axisMin ?? ''} placeholder="Min (auto)"
                                                        onChange={e => updateChartSettings(panel.id, { axisMin: e.target.value === '' ? null : e.target.value })}
                                                        className={settingInputCls} />
                                                    <input type="number" value={cs.axisMax ?? ''} placeholder="Max (auto)"
                                                        onChange={e => updateChartSettings(panel.id, { axisMax: e.target.value === '' ? null : e.target.value })}
                                                        className={settingInputCls} />
                                                </div>
                                            </SettingRow>
                                        )}
                                    </div>

                                    {/* ── Pie/donut leader-line labels ─────────────── */}
                                    {effectiveChartType === 'pie' && (
                                        <div className="border-t border-[var(--speckle-outline-3)] pt-2 flex flex-col gap-2.5">
                                            <span className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Pie/donut labels</span>
                                            <SettingRow label="Show in leader-line label">
                                                <div className="flex gap-1">
                                                    <ToggleBtn label="Name" active={cs.pieLabelName}
                                                        onMouseDown={e => e.stopPropagation()}
                                                        onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { pieLabelName: !cs.pieLabelName }) }} />
                                                    <ToggleBtn label="Value" active={cs.pieLabelValue}
                                                        onMouseDown={e => e.stopPropagation()}
                                                        onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { pieLabelValue: !cs.pieLabelValue }) }} />
                                                    <ToggleBtn label="%" active={cs.pieLabelPercent}
                                                        onMouseDown={e => e.stopPropagation()}
                                                        onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { pieLabelPercent: !cs.pieLabelPercent }) }} />
                                                </div>
                                            </SettingRow>
                                            <ToggleBtn label="Leader line" active={cs.pieLeaderLine}
                                                onMouseDown={e => e.stopPropagation()}
                                                onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { pieLeaderLine: !cs.pieLeaderLine }) }} />
                                        </div>
                                    )}
                                    </>)}
                                </div>
                            )}
                        </div>
                    )
                })}
            </GridLayout>

            {/* Pinned viewer's real content — portaled to document.body so it sits in
                a fixed-position box, completely outside react-grid-layout's absolute
                positioning. The placeholder above keeps reserving the grid slot. */}
            {pinnedViewer && createPortal(
                <div
                    className="panel-thin overflow-hidden"
                    style={{
                        position: 'fixed',
                        top: pinnedRect.top,
                        left: pinnedRect.left,
                        width: pinnedRect.width,
                        height: pinnedRect.height,
                        zIndex: PIN_Z_INDEX,
                    }}
                >
                    {panels.filter(p => p.type === 'viewer').map(panel => (
                        <Fragment key={panel.id}>{renderPanel(panel, getChartSettings(panel.id))}</Fragment>
                    ))}
                    <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); setPinnedViewer(false) }}
                        style={{ position: 'absolute', top: 4, right: 4, zIndex: 9999, width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, cursor: 'pointer', background: 'rgba(39,111,229,0.2)', border: 'none', outline: 'none', padding: 0, color: 'var(--speckle-outline-1)' }}
                        title="Unpin viewer"
                    ><PinOff size={12} /></button>
                </div>,
                document.body
            )}
        </div>
    )
}

export function GridPanel({ title, icon, children, headerActions, className = '', contentClassName = 'overflow-auto' }) {
    return (
        <div className={`h-full flex flex-col overflow-hidden relative ${className}`}>
            <div className="panel-header">
                {/* drag-zone covers only the title area */}
                <div className="drag-zone flex items-center gap-1.5 min-w-0 flex-1 cursor-move overflow-hidden">
                    {icon && <span className="shrink-0 text-[var(--speckle-foreground-3)]">{icon}</span>}
                    <span className="text-xs font-medium truncate text-[var(--speckle-foreground-2)]">
                        {title}
                    </span>
                </div>
            </div>
            {/* Actions rendered as absolute overlay at z-index 200 — above ALL resize
                handles (z-index 100) and the panel-header (z-index 110) so clicks always
                land on the buttons and never on an underlying resize handle. */}
            {headerActions && (
                <div
                    style={{ position: 'absolute', top: 0, right: 4, height: 30, zIndex: 200 }}
                    className="flex items-center gap-1"
                >
                    {headerActions}
                </div>
            )}
            <div className={`flex-1 min-h-0 ${contentClassName}`}>
                {children}
            </div>
        </div>
    )
}
