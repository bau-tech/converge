import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { X } from 'lucide-react'
import GridLayout from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'

const MOBILE_BREAKPOINT = 768
const LAYOUT_KEY = 'dashboard-panel-layout-v2'
const CHART_SETTINGS_KEY = 'dashboard-chart-settings'
const COLS = 24
const ROW_HEIGHT = 30

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

function defaultPanelLayout(panel, typeIndex, hasViewer) {
    if (panel.type === 'viewer') {
        return { i: panel.id, x: 0, y: 0, w: 2, h: 3, minW: 2, minH: 3 }
    }
    if (panel.type === 'chart') {
        const col = typeIndex % 2
        return {
            i: panel.id,
            x: hasViewer ? (col === 0 ? 14 : 19) : (col === 0 ? 0 : 8),
            y: Math.floor(typeIndex / 2) * 2,
            w: 2,
            h: 2,
            minW: 2, minH: 2,
        }
    }
    return {
        i: panel.id,
        x: hasViewer ? 14 : 0,
        y: Infinity,
        w: 2,
        h: 2,
        minW: 2, minH: 2,
    }
}

function mergeLayouts(panels, savedLayout) {
    const panelIds = new Set(panels.map(p => p.id))
    const hasViewer = panels.some(p => p.type === 'viewer')
    const typeCounts = { chart: 0, other: 0 }
    const savedById = new Map(
        savedLayout
            .filter(item => panelIds.has(item.i))
            .map(item => [item.i, item])
    )
    return panels.map(panel => {
        const idx = panel.type === 'chart' ? typeCounts.chart++ : typeCounts.other++
        const defaults = defaultPanelLayout(panel, idx, hasViewer)
        const saved = savedById.get(panel.id)
        return {
            ...defaults,
            ...saved,
            // Always use current minW/minH from defaults so old saved values
            // with larger minimums can't prevent panels from being resized small.
            minW: defaults.minW,
            minH: defaults.minH,
            i: panel.id,
        }
    })
}

// ── Popover style helpers ──────────────────────────────────────────────────
const inputStyle = { background: 'var(--speckle-foundation)', border: '1px solid var(--speckle-outline-3)', borderRadius: 6, padding: '4px 8px', fontSize: 12, color: 'var(--speckle-foreground)', outline: 'none', width: '100%' }
const btnStyle   = { padding: '4px 6px', borderRadius: 6, border: '1px solid var(--speckle-outline-3)', background: 'var(--speckle-foundation)', color: 'var(--speckle-foreground-3)', cursor: 'pointer', fontSize: 11, fontWeight: 500 }
const activeBtnStyle = { border: '1px solid #22d3ee', background: 'rgba(6,182,212,0.15)', color: '#22d3ee' }

function SettingRow({ label, children }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 10, color: 'var(--speckle-foreground-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
            {children}
        </div>
    )
}
function ColorRow({ label, value, onChange }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: 'var(--speckle-foreground-3)' }}>{label}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 10, color: 'var(--speckle-foreground-3)', fontFamily: 'monospace' }}>{value}</span>
                <input type="color" value={value} onChange={e => onChange(e.target.value)}
                    style={{ width: 28, height: 22, border: '1px solid var(--speckle-outline-3)', borderRadius: 4, cursor: 'pointer', background: 'none', padding: 1 }} />
            </div>
        </div>
    )
}
function ToggleBtn({ label, active, ...rest }) {
    return (
        <button {...rest} style={{ ...btnStyle, flex: 1, ...(active ? activeBtnStyle : {}) }}>
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

const DEFAULT_CHART_SETTINGS = {
    type: 'bar', orientation: 'h',
    title: null, maxItems: 15,
    colorScheme: 'default', sortOrder: 'desc',
    minCount: 0, showLabels: true, donut: true,
    // Axis / label typography
    tickFontSize: 11,    tickFontColor: '#e4e4e7',
    tickAngle: -45,
    valueFontSize: 11,   valueFontColor: '#e4e4e7',
    labelFontSize: 11,   labelFontColor: '#e4e4e7',
}

export function GridDashboard({ panels, renderPanel, onClosePanel, darkMode = true }) {
    const isMobile = useIsMobile()
    const containerRef = useRef(null)
    const [containerWidth, setContainerWidth] = useState(1200)

    const [chartSettings, setChartSettings] = useState(() => {
        try {
            const saved = localStorage.getItem(CHART_SETTINGS_KEY)
            return saved ? JSON.parse(saved) : {}
        } catch { return {} }
    })
    useEffect(() => {
        localStorage.setItem(CHART_SETTINGS_KEY, JSON.stringify(chartSettings))
    }, [chartSettings])
    const getChartSettings = (panelId) => ({
        ...DEFAULT_CHART_SETTINGS,
        tickFontColor:  darkMode ? '#e4e4e7' : '#18181b',
        valueFontColor: darkMode ? '#e4e4e7' : '#18181b',
        labelFontColor: darkMode ? '#e4e4e7' : '#18181b',
        ...chartSettings[panelId],
    })
    const updateChartSettings = (panelId, updates) =>
        setChartSettings(prev => ({ ...prev, [panelId]: { ...getChartSettings(panelId), ...updates } }))

    // Which chart panel currently has its settings popover open
    const [settingsPanelId, setSettingsPanelId] = useState(null)
    const closeSettings = () => setSettingsPanelId(null)

    // liveLayoutRef: always holds the latest positions; updated on every
    // onLayoutChange tick without causing a re-render.
    const liveLayoutRef = useRef(loadSavedLayout())

    // panelKey encodes both IDs and types so layoutForGridLayout rebuilds when
    // the panel set or any panel's type changes (fix: type-only changes were missed).
    const panelKey = panels.map(p => `${p.id}:${p.type}`).join(',')

    // Computed inside useMemo (not in the render body) to avoid mutating refs
    // during speculative renders in React 18 concurrent mode.
    // The layout reference is STABLE across re-renders where panelKey doesn't
    // change — same object reference → react-grid-layout's deepEqual is trivially
    // true → no mid-gesture position reset.
    const layoutForGridLayout = useMemo(
        () => mergeLayouts(panels, liveLayoutRef.current),
        // liveLayoutRef.current is intentionally read only when panelKey changes
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [panelKey]
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
        <div ref={containerRef} className="w-full">
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
                    const settingsOpen = settingsPanelId === panel.id
                    return (
                        <div
                            key={panel.id}
                            className="panel-thin"
                            onDoubleClick={panel.type === 'chart'
                                ? e => { e.stopPropagation(); setSettingsPanelId(settingsOpen ? null : panel.id) }
                                : undefined}
                        >
                            {/* Overflow clip on inner wrapper only — outer must stay clean
                                so react-resizable handle spans are not clipped */}
                            <div className="absolute inset-0 overflow-hidden rounded-[6px]">
                                {renderPanel(panel, cs)}
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
                                                style={{ width: 20, height: 20, borderRadius: 4, border: 'none', cursor: 'pointer', padding: 0, fontSize: 10, background: active ? 'rgba(6,182,212,0.2)' : 'transparent', color: active ? '#22d3ee' : 'var(--speckle-foreground-3)' }}
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
                                    style={{ position: 'absolute', top: 4, right: 4, zIndex: 9999, width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, cursor: 'pointer', background: 'transparent', border: 'none', padding: 0, color: 'var(--speckle-foreground-3)' }}
                                    title="Close panel"
                                ><X size={12} /></button>
                            )}

                            {/* Settings popover — opens on double-click for all chart panels */}
                            {panel.type === 'chart' && settingsOpen && (
                                <div
                                    onMouseDown={e => e.stopPropagation()}
                                    onClick={e => e.stopPropagation()}
                                    style={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 9999, width: 290, maxHeight: '80%', overflowY: 'auto', background: 'var(--speckle-foundation-2)', border: '1px solid var(--speckle-outline-3)', borderRadius: 10, padding: '12px 14px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', gap: 10 }}
                                >
                                    {/* Header */}
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--speckle-foreground-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Chart properties</span>
                                        <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); closeSettings() }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--speckle-foreground-3)', padding: 0 }}><X size={13} /></button>
                                    </div>

                                    {/* Title — widget panels manage title via ChartBuilder so skip */}
                                    {!panel.widget && (
                                        <SettingRow label="Title">
                                            <input type="text" value={cs.title ?? ''} onChange={e => updateChartSettings(panel.id, { title: e.target.value || null })} placeholder="Default" style={inputStyle} />
                                        </SettingRow>
                                    )}

                                    {/* Chart type — widget panels manage type/orientation via ChartBuilder */}
                                    {!panel.widget && (
                                        <SettingRow label="Type">
                                            <div style={{ display: 'flex', gap: 4 }}>
                                                {CHART_TYPES.map(({ type, orientation, label }) => {
                                                    const active = cs.type === type && (type === 'pie' || cs.orientation === orientation)
                                                    return (
                                                        <button key={label} onMouseDown={e => e.stopPropagation()}
                                                            onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { type, orientation: orientation || 'h' }) }}
                                                            style={{ ...btnStyle, flex: 1, ...(active ? activeBtnStyle : {}) }}
                                                        >{label}</button>
                                                    )
                                                })}
                                            </div>
                                        </SettingRow>
                                    )}

                                    {/* Sort order */}
                                    <SettingRow label="Sort">
                                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                            {SORT_OPTIONS.map(({ id, label }) => (
                                                <button key={id} onMouseDown={e => e.stopPropagation()}
                                                    onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { sortOrder: id }) }}
                                                    style={{ ...btnStyle, flex: 1, minWidth: 60, ...(cs.sortOrder === id ? activeBtnStyle : {}) }}
                                                >{label}</button>
                                            ))}
                                        </div>
                                    </SettingRow>

                                    {/* Color scheme */}
                                    <SettingRow label="Color">
                                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                            {COLOR_SCHEMES.map(({ id, label, colors }) => (
                                                <button key={id} onMouseDown={e => e.stopPropagation()}
                                                    onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { colorScheme: id }) }}
                                                    title={label}
                                                    style={{ width: 24, height: 24, borderRadius: 6, border: cs.colorScheme === id ? '2px solid #22d3ee' : '2px solid transparent', padding: 0, cursor: 'pointer', background: `linear-gradient(135deg, ${colors[0]} 50%, ${colors[1]} 50%)` }}
                                                />
                                            ))}
                                        </div>
                                    </SettingRow>

                                    {/* Max items */}
                                    <SettingRow label={`Max items: ${cs.maxItems}`}>
                                        <input type="range" min={3} max={30} step={1} value={cs.maxItems}
                                            onChange={e => updateChartSettings(panel.id, { maxItems: Number(e.target.value) })}
                                            style={{ width: '100%', accentColor: '#22d3ee' }} />
                                    </SettingRow>

                                    {/* Min count threshold */}
                                    <SettingRow label={`Min count: ${cs.minCount}`}>
                                        <input type="range" min={0} max={50} step={1} value={cs.minCount}
                                            onChange={e => updateChartSettings(panel.id, { minCount: Number(e.target.value) })}
                                            style={{ width: '100%', accentColor: '#22d3ee' }} />
                                    </SettingRow>

                                    {/* Show labels / Donut toggles */}
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <ToggleBtn label="Labels" active={cs.showLabels} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { showLabels: !cs.showLabels }) }} />
                                        {cs.type === 'pie' && (
                                            <ToggleBtn label="Donut" active={cs.donut} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { donut: !cs.donut }) }} />
                                        )}
                                    </div>

                                    {/* ── Typography ─────────────────────────────── */}
                                    <div style={{ borderTop: '1px solid var(--speckle-outline-3)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
                                        <span style={{ fontSize: 10, color: 'var(--speckle-foreground-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Typography</span>

                                        {/* Axis ticks */}
                                        <SettingRow label={`Axis tick size: ${cs.tickFontSize}px`}>
                                            <input type="range" min={7} max={18} step={1} value={cs.tickFontSize}
                                                onChange={e => updateChartSettings(panel.id, { tickFontSize: Number(e.target.value) })}
                                                style={{ width: '100%', accentColor: '#22d3ee' }} />
                                        </SettingRow>
                                        <ColorRow label="Axis tick colour"
                                            value={cs.tickFontColor}
                                            onChange={v => updateChartSettings(panel.id, { tickFontColor: v })} />

                                        {/* Value labels on bars */}
                                        {cs.showLabels && cs.type !== 'pie' && (<>
                                            <SettingRow label={`Value label size: ${cs.valueFontSize}px`}>
                                                <input type="range" min={7} max={16} step={1} value={cs.valueFontSize}
                                                    onChange={e => updateChartSettings(panel.id, { valueFontSize: Number(e.target.value) })}
                                                    style={{ width: '100%', accentColor: '#22d3ee' }} />
                                            </SettingRow>
                                            <ColorRow label="Value label colour"
                                                value={cs.valueFontColor}
                                                onChange={v => updateChartSettings(panel.id, { valueFontColor: v })} />
                                        </>)}

                                        {/* Pie slice labels */}
                                        {cs.type === 'pie' && cs.showLabels && (<>
                                            <SettingRow label={`Slice label size: ${cs.labelFontSize}px`}>
                                                <input type="range" min={7} max={16} step={1} value={cs.labelFontSize}
                                                    onChange={e => updateChartSettings(panel.id, { labelFontSize: Number(e.target.value) })}
                                                    style={{ width: '100%', accentColor: '#22d3ee' }} />
                                            </SettingRow>
                                            <ColorRow label="Slice label colour"
                                                value={cs.labelFontColor}
                                                onChange={v => updateChartSettings(panel.id, { labelFontColor: v })} />
                                        </>)}

                                        {/* X-axis label angle — vertical bars only */}
                                        {cs.type === 'bar' && cs.orientation === 'v' && (
                                            <SettingRow label="X-axis label angle">
                                                <div style={{ display: 'flex', gap: 4 }}>
                                                    {[0, -30, -45, -90].map(angle => (
                                                        <button key={angle} onMouseDown={e => e.stopPropagation()}
                                                            onClick={e => { e.stopPropagation(); updateChartSettings(panel.id, { tickAngle: angle }) }}
                                                            style={{ ...btnStyle, flex: 1, ...(cs.tickAngle === angle ? activeBtnStyle : {}) }}
                                                        >{angle}°</button>
                                                    ))}
                                                </div>
                                            </SettingRow>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )
                })}
            </GridLayout>
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
