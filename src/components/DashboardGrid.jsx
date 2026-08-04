import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { X, Pin, PinOff, Lock, Unlock } from 'lucide-react'
import GridLayout from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { settingBtnCls, settingBtnInactive, settingBtnActive, settingInputCls, ColorRow } from './chartSettingsUI'
import { COLOR_SCHEMES } from './AdaptiveCharts'
import { useHeaderHeight } from '../utils/useHeaderHeight'

const MOBILE_BREAKPOINT = 768
// iPhone 7 reference viewport (375x667 CSS px) — mobile panel heights are
// fixed px fractions of this, not vh. vh is unreliable in mobile Safari: it's
// computed against the *largest* possible viewport (address bar collapsed),
// so 50vh measured while the address bar is showing is taller than the
// visible area, and the value jumps as the address bar shows/hides on
// scroll. A fixed px height tied to a real device viewport doesn't move.
const MOBILE_VIEWPORT_HEIGHT = 667
// Sized so the viewer plus one full chart/widget panel both fit within one
// iPhone 7 screen with (near-)zero scrolling: measured overhead above the
// viewer (header incl. collapsed Stats accordion + the mobile layout's own
// top padding) is 137px, plus an 8px gap between the two panels, leaving
// ~522px to split.
//
// MOBILE_CHART_HEIGHT can't go much below ~240 — a vertical bar chart with
// rotated category labels (e.g. "Elements by Level") reserves a fixed ~110px
// for axis/label chrome (prepareBarOption's `grid.top`/`grid.bottom` in
// AdaptiveCharts.jsx) regardless of container size, so anything shorter
// leaves too little room for the bars themselves — tried 200px first and it
// rendered as illegible squashed bars with overlapping axis text, which
// defeats the point of fitting it on screen at all. 240 leaves a legible
// ~100px plot area. The viewer gets the remaining budget.
const MOBILE_VIEWER_HEIGHT = 280
const MOBILE_CHART_HEIGHT = 240
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
//
// v12 -> v13: granularity doubling again (drag/resize snapping was too
// coarse), but unlike v5->v6/v8->v9 this one also halves margin/
// containerPadding (8 -> 4) in the same step. The v9 writeup above explains
// why: react-grid-layout's pixel size is unitSize*units + (units-1)*marginPx,
// so doubling units while halving unitSize but leaving marginPx fixed makes
// the margin term grow relative to the unit term, inflating every panel by
// ~25-30%. Halving marginPx alongside the unit doubling keeps that ratio
// (and therefore physical panel sizes) effectively unchanged.
//
// v13 -> v14: same move again — still not granular enough. Margin/
// containerPadding halved again (4 -> 2) alongside the unit doubling, same
// reasoning as v12->v13.
//
// v14 -> v15: same move again, same reasoning as v12->v13/v13->v14 — resize
// snapping was still too coarse. Margin/containerPadding halved again
// (2 -> 1) alongside the unit doubling to keep the margin term from
// dominating calcGridItemWHPx's pixel-size formula.
//
// v15 -> v16: rowHeight stops being a fixed 3px constant and becomes
// calcColWidth(containerWidth) instead — i.e. row units and column units are
// now the same number of pixels. Previously colWidth scaled with the window
// (cols is a fixed count over a fluid width) while rowHeight never did, so a
// panel's aspect ratio silently drifted with window width (relatively flatter
// on wide monitors, relatively taller/narrower on small ones) and "w equals
// h" never actually meant square except at whatever one width it was
// eyeballed at. With rowHeight tied to colWidth, w === h is a true square at
// any width. This changes the px-per-unit conversion for every panel
// (colWidth at typical desktop widths is ~2-3x the old fixed 3px), so
// existing saved layouts would render wildly oversized under the new scale —
// hence the version bump. VIEWER_W/VIEWER_H/SLOT_W/SLOT_H/TABLE_H below are
// re-tuned for this new scale (see their own comments).
const LAYOUT_KEY = 'dashboard-panel-layout-v16'
const CHART_SETTINGS_KEY = 'dashboard-chart-settings'
const PINNED_VIEWER_KEY = 'dashboard-viewer-pinned'
const PINNED_CHARTS_KEY = 'dashboard-pinned-chart-panels'
const PIN_TOP_GAP = 1   // px gap below the header, matches the grid's own margin/containerPadding
const PIN_Z_INDEX = 35  // below header's z-50, above ordinary scrolling panel content
const COLS = 192
const GRID_MARGIN = 1
const GRID_CONTAINER_PADDING = 1

// Row height in px, made equal to the live column width so grid units are
// square (see the v15->v16 note above) — matches react-grid-layout's own
// calcGridColWidth formula (lib/calculateUtils.js) exactly, since this value
// is fed straight into its `rowHeight` prop and needs to equal what it
// computes internally for `colWidth` on the same render.
function calcColWidth(containerWidthPx) {
    return (containerWidthPx - GRID_MARGIN * (COLS - 1) - GRID_CONTAINER_PADDING * 2) / COLS
}

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

// VIEWER_W/H: captured from a live resize (viewer widened until its internal
// diff-menu toolbar fit on a single row, at a 1912px container width) rather
// than derived from the grid math — same "tune by hand, capture the result"
// approach as before. The measured width was 76, bumped 2 units to 78 so
// (COLS - VIEWER_W) divides evenly by 3 (see SLOT_W below) instead of leaving
// a sliver at the right edge — widening only gives the diff toolbar more
// room, so it can't reintroduce the wrap this was tuned to avoid. VIEWER_H is
// the *old* fixed-rowHeight measurement (170 units @ 3px = 679px tall)
// converted to the new dynamic-rowHeight scale (h * (colWidth + margin) -
// margin = target px) so the viewer keeps the same on-screen height it had
// when it was tuned, instead of ballooning ~2.5x under the new pixels-per-unit.
const VIEWER_W = 78
const VIEWER_H = 68
// SLOT_W: (COLS - VIEWER_W) split into 3 equal columns so three chart panels
// tile flush alongside the viewer at one row each, right up to the canvas's
// far edge — 192 - 78 = 114 = 38 * 3 exactly, no leftover sliver.
// SLOT_H === SLOT_W: with rowHeight now equal to colWidth (see calcColWidth
// above), any panel with w === h renders as an exact square at any window
// width — no separate height conversion needed here, unlike VIEWER_H above.
const SLOT_W = 38
const SLOT_H = 38
const TABLE_W = COLS    // tables default to full width to show their columns usefully
// TABLE_H: old fixed-rowHeight measurement (64 units @ 3px = 255px tall)
// converted the same way as VIEWER_H so tables don't change height under the
// new scale.
const TABLE_H = 26

// Only ever called for viewer/table — charts and every other widget type are
// always repacked directly in mergeLayouts (see below) instead of going
// through a "default" position.
function defaultPanelLayout(panel) {
    if (panel.type === 'viewer') {
        return { i: panel.id, x: 0, y: 0, w: VIEWER_W, h: VIEWER_H, minW: 1, minH: 1 }
    }
    // table
    return { i: panel.id, x: 0, y: Infinity, w: TABLE_W, h: TABLE_H, minW: 1, minH: 1 }
}

function rectsOverlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

// First free w x h cell, row-major (in SLOT_W/SLOT_H steps), that doesn't
// overlap anything in `occupied`. `w`/`h` default to one slot but can be a
// saved custom size (e.g. a chart resized to span 2 slots).
function findFreeSlot(occupied, startX, w = SLOT_W, h = SLOT_H) {
    for (let row = 0; ; row++) {
        for (let x = startX; x + w <= COLS; x += SLOT_W) {
            const candidate = { x, y: row * SLOT_H, w, h }
            if (!occupied.some(r => rectsOverlap(candidate, r))) return candidate
        }
    }
}

function mergeLayouts(panels, savedLayout) {
    const panelIds = new Set(panels.map(p => p.id))
    const savedById = new Map(
        savedLayout
            .filter(item => panelIds.has(item.i))
            .map(item => [item.i, item])
    )

    const results = new Map()
    const occupied = []

    // Viewer/table keep their saved position verbatim — only charts/widgets
    // get auto-aligned (see below).
    for (const panel of panels) {
        if (panel.type !== 'viewer' && panel.type !== 'table') continue
        const saved = savedById.get(panel.id)
        const defaults = defaultPanelLayout(panel)
        const result = { ...defaults, ...saved, minW: defaults.minW, minH: defaults.minH, i: panel.id }
        results.set(panel.id, result)
        occupied.push(result)
    }

    // Charts must start flush against the viewer's *actual* right edge, not
    // the VIEWER_W constant — if the viewer was ever resized (its saved w
    // differs from VIEWER_W), using the constant here either leaves a real
    // gap (viewer shrunk) or makes findFreeSlot reject the first column as
    // overlapping the now-wider viewer and skip straight to the second one
    // (viewer grown) — both produce exactly the permanent horizontal gap this
    // is fixing. Falls back to VIEWER_W only while the viewer's own layout is
    // still being resolved for the very first time (no viewer panel present).
    const viewerPanel = panels.find(p => p.type === 'viewer')
    const viewerResult = viewerPanel ? results.get(viewerPanel.id) : null
    const startX = viewerResult ? viewerResult.x + viewerResult.w : 0

    // Charts and every other widget type are always densely repacked — left
    // to right, top to bottom, starting right after the viewer — rather than
    // trusting a saved x/y verbatim. react-grid-layout's compactType="vertical"
    // only ever closes *vertical* gaps; if a panel that used to sit to a
    // chart's left gets removed, nothing recomputes x, so that chart is left
    // sitting in its old column with a permanent empty gap where the viewer
    // should now be flush against it. Repacking on every render closes that
    // gap automatically instead of requiring another saved-layout migration.
    // Relative order is preserved (sorted by each panel's last saved position,
    // new panels last) so a user's drag-to-reorder still sticks — only the
    // literal x/y coordinate is discarded. Saved w/h (size) is kept as-is.
    const flowPanels = panels.filter(p => p.type !== 'viewer' && p.type !== 'table')
    const sortedFlowPanels = [...flowPanels].sort((a, b) => {
        const sa = savedById.get(a.id)
        const sb = savedById.get(b.id)
        if (!sa && !sb) return 0
        if (!sa) return 1   // brand-new panels (no saved position) sort last
        if (!sb) return -1
        return (sa.y - sb.y) || (sa.x - sb.x)
    })
    for (const panel of sortedFlowPanels) {
        const saved = savedById.get(panel.id)
        const w = saved?.w ?? SLOT_W
        const h = saved?.h ?? SLOT_H
        const pos = findFreeSlot(occupied, startX, w, h)
        const result = { i: panel.id, x: pos.x, y: pos.y, w, h, minW: 1, minH: 1 }
        results.set(panel.id, result)
        occupied.push(result)
    }

    return panels.map(panel => results.get(panel.id))
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

export function GridDashboard({ panels, renderPanel, onClosePanel, darkMode = true, readOnly = false }) {
    const isMobile = useIsMobile()
    const headerHeight = useHeaderHeight()
    const containerRef = useRef(null)
    const [containerWidth, setContainerWidth] = useState(1200)
    // Square grid units (see the v15->v16 note above calcColWidth): recomputed
    // on every resize alongside containerWidth so it never drifts out of sync
    // with what react-grid-layout derives internally for colWidth.
    const rowHeightPx = useMemo(() => calcColWidth(containerWidth), [containerWidth])

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

    // Chart pinning: unlike the viewer's pin (which fixes its on-screen
    // position), pinning a chart only locks its *size* — it stays exactly
    // where it is in the scrolling grid, but react-grid-layout won't let it
    // be resized until unpinned. No placeholder/portal needed here since the
    // panel never leaves its normal spot.
    const [pinnedCharts, setPinnedCharts] = useState(() => {
        try { return new Set(JSON.parse(localStorage.getItem(PINNED_CHARTS_KEY) || '[]')) }
        catch { return new Set() }
    })
    useEffect(() => {
        try { localStorage.setItem(PINNED_CHARTS_KEY, JSON.stringify([...pinnedCharts])) } catch { /* ignore */ }
    }, [pinnedCharts])
    const toggleChartPin = useCallback((id) => {
        setPinnedCharts(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }, [])

    // liveLayoutRef: always holds the latest positions; updated on every
    // onLayoutChange tick without causing a re-render.
    const liveLayoutRef = useRef(loadSavedLayout())

    // panelKey encodes both IDs and types so layoutForGridLayout rebuilds when
    // the panel set or any panel's type changes (fix: type-only changes were missed).
    const panelKey = panels.map(p => `${p.id}:${p.type}`).join(',')

    // Chart panel ids are deterministic (`chart-${chartKey}`), so toggling a
    // chart off then back on reuses the same id. mergeLayouts always repacks
    // chart/widget position fresh regardless of any saved entry, but it still
    // uses a saved entry's y/x (and w/h) as the *sort key* / requested size for
    // repacking — so without this purge, a re-shown chart would resume its old
    // place in the packing order (and any stale/oversized w/h from an older
    // grid-granularity migration) instead of being treated as brand new like
    // any other newly-added panel. One extra render (via purgeTick) is the
    // cost of not mutating the ref during render itself.
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
    // Bumped whenever a drag/resize gesture ends (see handleLayoutEnd) so
    // layoutForGridLayout recomputes right away — otherwise chart/widget
    // panels only pick up the viewer's new size (mergeLayouts' startX) on
    // the next full reload, since nothing else in the dep list below changes
    // just from resizing the viewer.
    const [layoutVersion, setLayoutVersion] = useState(0)

    const layoutForGridLayout = useMemo(() => {
        const merged = mergeLayouts(panels, liveLayoutRef.current)
        return merged.map(item => {
            // Dragging the viewer's placeholder while pinned would be meaningless (its
            // real content lives in the portal below) — disable drag only, not resize,
            // so the reserved slot (and the pinned box that tracks its rect) can still
            // be resized. Always set explicitly (not just "add when pinned") — RGL's
            // onLayoutChange fires on every render and echoes the layout array back,
            // so handleLayoutChange persists whatever isDraggable value was here into
            // liveLayoutRef.current; only setting it while pinned would let `false`
            // leak into the saved layout and stick around after unpinning.
            // readOnly is ANDed in here too, not just on the grid-level isDraggable prop
            // below — RGL's per-item isDraggable/isResizable, when explicitly set (as
            // these always are, see above), overrides the grid-level default rather than
            // inheriting it, so leaving readOnly out of these per-item values would let a
            // read-only share visitor still drag the viewer or resize ordinary panels.
            if (item.i === 'viewer') return { ...item, isDraggable: !pinnedViewer && !readOnly }
            // Pinned charts stay fully draggable — only resizing is locked — and,
            // same reasoning as above, isResizable is always set explicitly so a
            // stale `false` from a since-unpinned chart can't leak into liveLayoutRef.
            if (pinnedCharts.has(item.i)) return { ...item, isResizable: false }
            return { ...item, isResizable: !readOnly }
        })
    },
        // liveLayoutRef.current is intentionally read only when one of these changes
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [panelKey, purgeTick, pinnedViewer, pinnedCharts, layoutVersion, readOnly]
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
        // Re-run mergeLayouts now, with the just-committed size/position, so a
        // viewer resize (or any drag/resize) immediately repacks chart/widget
        // panels against it instead of waiting for the next reload.
        setLayoutVersion(v => v + 1)
    }, [])

    if (isMobile) {
        return (
            // Horizontal padding dropped (py-2 only) — <main> in App.jsx already
            // supplies the mobile gutter; adding another here stacked into an
            // oversized inset that shrank every card well below the actual
            // device width (see App.jsx's <main> comment).
            <div className="flex flex-col gap-2 py-2">
                {panels.map(panel => (
                    <div
                        key={panel.id}
                        className="panel-thin w-full overflow-hidden"
                        // Viewer always pins directly below the header on mobile — there's
                        // no per-user toggle here (unlike desktop's Pin/PinOff button);
                        // it's always on for this layout. Viewer and chart/widget panels
                        // get different fixed heights (not a shared constant) so the
                        // viewer plus one full chart both fit within the iPhone 7's
                        // native 667px viewport height with no scrolling needed — see
                        // MOBILE_VIEWER_HEIGHT/MOBILE_CHART_HEIGHT above.
                        style={
                            panel.type === 'viewer'
                                ? { height: MOBILE_VIEWER_HEIGHT, position: 'sticky', top: headerHeight + PIN_TOP_GAP, zIndex: PIN_Z_INDEX }
                                : { height: MOBILE_CHART_HEIGHT }
                        }
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
        // (1px) is the *only* source of edge spacing — making it match the 1px
        // gap between panels instead of stacking on top of it.
        // Width must explicitly compensate for the negative margin: combining
        // `w-full` (100%) with `-mx-*` is over-constrained, so the browser
        // silently drops the right margin and the grid falls short on the
        // right instead of reaching the true edge — calc() keeps both margins.
        <div ref={containerRef} className="w-[calc(100%+2rem)] lg:w-[calc(100%+3rem)] -mx-4 lg:-mx-6 -mt-2">
            <GridLayout
                layout={layoutForGridLayout}
                cols={COLS}
                rowHeight={rowHeightPx}
                width={containerWidth}
                margin={[GRID_MARGIN, GRID_MARGIN]}
                containerPadding={[GRID_CONTAINER_PADDING, GRID_CONTAINER_PADDING]}
                draggableHandle=".drag-zone"
                draggableCancel="button,input,select,textarea,a,[role='button']"
                resizeHandles={['se', 'sw', 's', 'n', 'e', 'w']}
                resizeConfig={{ handles: ['se', 'sw', 's', 'n', 'e', 'w'] }}
                dragConfig={{ handle: '.drag-zone', cancel: 'button,input,select,textarea,a,[role="button"]' }}
                compactType="vertical"
                preventCollision={false}
                isDraggable={!readOnly}
                isResizable={!readOnly}
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

                            {/* Size-lock toggle — chart panels only (standard + custom widget
                                charts). Unlike the viewer's pin, this only disables resizing
                                (see layoutForGridLayout's isResizable) — the panel stays put in
                                the scrolling grid, it's just locked at its current size. */}
                            {panel.type === 'chart' && (
                                <button
                                    onMouseDown={e => e.stopPropagation()}
                                    onClick={e => { e.stopPropagation(); toggleChartPin(panel.id) }}
                                    style={{ position: 'absolute', top: 4, right: 28, zIndex: 9999, width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, cursor: 'pointer', background: pinnedCharts.has(panel.id) ? 'rgba(39,111,229,0.2)' : 'transparent', border: 'none', outline: 'none', padding: 0, color: pinnedCharts.has(panel.id) ? 'var(--speckle-outline-1)' : 'var(--speckle-foreground-3)' }}
                                    title={pinnedCharts.has(panel.id) ? 'Unlock chart size' : 'Lock chart size'}
                                >{pinnedCharts.has(panel.id) ? <Lock size={12} /> : <Unlock size={12} />}</button>
                            )}

                            {/* Chart-type toggles — standard chart panels only, not custom widget charts */}
                            {panel.type === 'chart' && !panel.widget && (
                                <div style={{ position: 'absolute', top: 4, right: 52, zIndex: 9999, display: 'flex', gap: 2 }}>
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
