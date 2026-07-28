import { useState, useRef, useEffect } from 'react'
import { Loader2, X, Ruler, Maximize2, Trash2, Camera, Sun, Scissors, Expand } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { ViewMode } from '@speckle/viewer'

// MeasurementType numeric values (mirrors @speckle/shared/viewer/state)
const MeasurementType = { PERPENDICULAR: 0, POINTTOPOINT: 1, AREA: 2, POINT: 3 }

const UNITS = [
    { value: 'mm', label: 'mm' },
    { value: 'cm', label: 'cm' },
    { value: 'm',  label: 'm'  },
    { value: 'ft', label: 'ft' },
    { value: 'in', label: 'in' },
]

const PRECISIONS = [0, 1, 2, 3, 4]

const MEAS_TYPES = [
    {
        type: MeasurementType.POINTTOPOINT,
        label: 'Point',
        title: 'Point to Point',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="4" cy="12" r="2" fill="currentColor" stroke="none" />
                <circle cx="20" cy="12" r="2" fill="currentColor" stroke="none" />
                <line x1="6" y1="12" x2="18" y2="12" strokeDasharray="3 2" />
            </svg>
        ),
    },
    {
        type: MeasurementType.PERPENDICULAR,
        label: 'Perp',
        title: 'Perpendicular',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="4" y1="20" x2="20" y2="4" />
                <line x1="12" y1="12" x2="20" y2="20" />
                <path d="M16 16 L16 20 L12 20" strokeWidth="1.5" fill="none" />
            </svg>
        ),
    },
    {
        type: MeasurementType.AREA,
        label: 'Area',
        title: 'Area',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="4,18 12,4 20,18" />
            </svg>
        ),
    },
]

const TYPE_ICONS_SMALL = {
    [MeasurementType.POINTTOPOINT]: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <circle cx="4" cy="12" r="2.5" fill="currentColor" stroke="none" />
            <circle cx="20" cy="12" r="2.5" fill="currentColor" stroke="none" />
            <line x1="7" y1="12" x2="17" y2="12" strokeDasharray="3 2" />
        </svg>
    ),
    [MeasurementType.PERPENDICULAR]: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="4" y1="20" x2="20" y2="4" />
            <line x1="12" y1="12" x2="20" y2="20" />
        </svg>
    ),
    [MeasurementType.AREA]: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="4,18 12,4 20,18" />
        </svg>
    ),
    [MeasurementType.POINT]: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <circle cx="12" cy="12" r="4" />
        </svg>
    ),
}

const VIEW_MODES = [
    {
        mode: ViewMode.DEFAULT,
        label: 'Default',
        icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            </svg>
        ),
    },
    {
        mode: ViewMode.ARCTIC,
        label: 'Arctic',
        icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
            </svg>
        ),
    },
    {
        mode: ViewMode.PEN,
        label: 'Pen',
        icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
        ),
    },
    {
        mode: ViewMode.SOLID,
        label: 'Solid',
        icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <circle cx="12" cy="12" r="9" />
            </svg>
        ),
    },
    {
        mode: ViewMode.SHADED,
        label: 'Shaded',
        icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 3a9 9 0 1 0 0 18A9 9 0 0 0 12 3z" />
                <path d="M12 3v18" fill="currentColor" />
                <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
            </svg>
        ),
    },
]

// Canonical preset views — strings passed directly to setCameraView
const CANONICAL_VIEWS = [
    { id: 'front',  label: 'Front'  },
    { id: 'back',   label: 'Back'   },
    { id: 'left',   label: 'Left'   },
    { id: 'right',  label: 'Right'  },
    { id: 'top',    label: 'Top'    },
    { id: '3d',     label: '3D'     },
]

function formatValue(value, units) {
    if (value == null) return '—'
    const n = typeof value === 'number' ? value : parseFloat(value)
    if (isNaN(n)) return '—'
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${units || 'm'}`
}

function useOutsideClick(ref, enabled, cb) {
    useEffect(() => {
        if (!enabled) return
        const h = (e) => { if (ref.current && !ref.current.contains(e.target)) cb() }
        document.addEventListener('mousedown', h)
        return () => document.removeEventListener('mousedown', h)
    }, [enabled])
}

export default function ViewerToolbar({
    onSectionBoxClick,
    isSectionBoxEnabled,
    onZoomExtents,
    // Camera views
    onCameraView,
    namedViews = [],
    // Screenshot
    onScreenshot,
    // View modes
    viewMode,
    onViewMode,
    // Edges
    edgesEnabled,
    onToggleEdges,
    // Camera projection & fly-through
    isOrtho = false,
    onToggleProjection,
    isFlyMode = false,
    onToggleFlyMode,
    // Hide / Show
    selectionCount = 0,
    hiddenCount = 0,
    onHideSelected,
    onShowAllHidden,
    // Lighting
    lightConfig,
    onSetLighting,
    // Measurements
    measurementsActive,
    onToggleMeasurements,
    measurements = [],
    measurementOptions = {},
    onMeasurementOptions,
    onDeleteMeasurement,
    onClearMeasurements,
    // Explode
    explodeValue,
    onExplode,
    isViewerReady,
    isTimelineActive = false,
}) {
    const [showModes,       setShowModes]       = useState(false)
    const [showExplode,     setShowExplode]     = useState(false)
    const [showMeasurements,setShowMeasurements]= useState(false)
    const [showCamViews,    setShowCamViews]    = useState(false)
    const [showLighting,    setShowLighting]    = useState(false)

    const modesRef     = useRef(null)
    const explodeRef   = useRef(null)
    const measRef      = useRef(null)
    const camViewsRef  = useRef(null)
    const lightingRef  = useRef(null)

    const currentMode = VIEW_MODES.find(m => m.mode === viewMode) || VIEW_MODES[0]

    // Light config with safe defaults
    const lc = lightConfig || { enabled: true, castShadow: false, elevation: 1.33, azimuth: 0.75 }
    const elevDeg = Math.round((lc.elevation / Math.PI) * 180)
    const azimDeg = Math.round((lc.azimuth / (2 * Math.PI)) * 360)

    // Auto-open measurement panel when activated
    useEffect(() => {
        if (measurementsActive) setShowMeasurements(true)
    }, [measurementsActive])

    useOutsideClick(modesRef,     showModes,        () => setShowModes(false))
    useOutsideClick(explodeRef,   showExplode,      () => setShowExplode(false))
    useOutsideClick(measRef,      showMeasurements, () => setShowMeasurements(false))
    useOutsideClick(camViewsRef,  showCamViews,     () => setShowCamViews(false))
    useOutsideClick(lightingRef,  showLighting,     () => setShowLighting(false))

    const closeAll = () => {
        setShowModes(false)
        setShowExplode(false)
        setShowMeasurements(false)
        setShowCamViews(false)
        setShowLighting(false)
    }

    const handleSelectMode = (mode) => { onViewMode(mode); setShowModes(false) }

    const handleToggleMeasurements = () => {
        onToggleMeasurements()
        setShowMeasurements(prev => measurementsActive ? false : true)
        closeAll()
    }

    const currentType      = measurementOptions.type      ?? MeasurementType.POINTTOPOINT
    const currentUnits     = measurementOptions.units     ?? 'm'
    const currentPrecision = measurementOptions.precision ?? 2
    const vertexSnap       = measurementOptions.vertexSnap ?? true

    // ── Popover panel animation config ────────────────────────────────────────
    const popoverAnim = {
        initial:    { opacity: 0, y: 8, scale: 0.96 },
        animate:    { opacity: 1, y: 0, scale: 1 },
        exit:       { opacity: 0, y: 8, scale: 0.96 },
        transition: { duration: 0.15 },
    }
    // Side-anchored variant for the vertical rail's popovers (open to the
    // right of the rail instead of above the bottom pill).
    const popoverAnimSide = {
        initial:    { opacity: 0, x: -8, scale: 0.96 },
        animate:    { opacity: 1, x: 0, scale: 1 },
        exit:       { opacity: 0, x: -8, scale: 0.96 },
        transition: { duration: 0.15 },
    }
    const popoverCls = "glass rounded-xl shadow-2xl"

    return (
        <>
        {/* ── Vertical rail — Display/Appearance (View mode, Edges, Lighting,
            Colour by property): scene-appearance toggles set once and left,
            as opposed to the bottom pill's repeated-interaction tools. Split
            out so the bottom pill stays narrow on small/mobile widths. ──── */}
        <div
            className="absolute left-4 top-1/2 -translate-y-1/2 z-[200] flex items-center gap-2"
            style={{ pointerEvents: 'auto' }}
        >
            <div className="glass rounded-full overflow-hidden shadow-lg p-1.5 flex flex-col gap-1 items-center">
                {/* View Mode */}
                <button
                    className={`w-[30px] h-[30px] flex items-center justify-center rounded-full transition-all ${showModes ? 'bg-blue-500/80 text-white' : 'text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground)]'}`}
                    onClick={() => { closeAll(); setShowModes(v => !v) }}
                    disabled={!isViewerReady}
                    title={`View mode: ${currentMode.label}`}
                >
                    {currentMode.icon}
                </button>

                {/* Edges */}
                <button
                    className={`w-[30px] h-[30px] flex items-center justify-center rounded-full transition-all ${edgesEnabled ? 'bg-blue-500/60 text-white' : 'text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground)]'}`}
                    onClick={onToggleEdges}
                    disabled={!isViewerReady}
                    title={edgesEnabled ? 'Hide edges' : 'Show edges'}
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <line x1="3" y1="9" x2="21" y2="9" />
                        <line x1="3" y1="15" x2="21" y2="15" />
                        <line x1="9" y1="3" x2="9" y2="21" />
                        <line x1="15" y1="3" x2="15" y2="21" />
                    </svg>
                </button>

                {/* Lighting */}
                <button
                    className={`w-[30px] h-[30px] flex items-center justify-center rounded-full transition-all ${
                        showLighting
                            ? 'bg-amber-500/80 text-white'
                            : lc.enabled
                                ? 'text-amber-300 hover:bg-[var(--speckle-outline-3)]'
                                : 'text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] hover:text-amber-300'
                    }`}
                    onClick={() => { closeAll(); setShowLighting(v => !v) }}
                    disabled={!isViewerReady}
                    title="Sun lighting"
                >
                    <Sun className="w-5 h-5" />
                </button>
            </div>

            {/* ── View mode popover ─────────────────────────────────────── */}
            <AnimatePresence>
                {showModes && (
                    <motion.div ref={modesRef} {...popoverAnimSide} className={`${popoverCls} p-2 absolute left-full ml-2`}>
                        <div className="flex flex-col gap-1">
                            {VIEW_MODES.map(({ mode, label, icon }) => (
                                <button
                                    key={mode}
                                    onClick={() => handleSelectMode(mode)}
                                    title={label}
                                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-medium transition-all ${
                                        viewMode === mode
                                            ? 'bg-blue-500 text-white'
                                            : 'text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground)]'
                                    }`}
                                >
                                    {icon}
                                    {label}
                                </button>
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ── Lighting popover ──────────────────────────────────────── */}
            <AnimatePresence>
                {showLighting && (
                    <motion.div ref={lightingRef} {...popoverAnimSide} className={`${popoverCls} p-3 w-60 absolute left-full ml-2`}>
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-xs font-semibold text-amber-400 flex items-center gap-1.5">
                                <Sun className="w-3.5 h-3.5" />
                                Lighting
                            </span>
                            <button onClick={() => setShowLighting(false)} className="text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] transition-colors">
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>

                        {/* Enable toggle */}
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-[11px] text-[var(--speckle-foreground-2)] font-medium">Sun light</span>
                            <button
                                onClick={() => onSetLighting({ enabled: !lc.enabled })}
                                className={`relative w-9 h-5 rounded-full transition-colors ${lc.enabled ? 'bg-amber-500' : 'bg-[var(--speckle-outline-5)]'}`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${lc.enabled ? 'translate-x-4' : ''}`} />
                            </button>
                        </div>

                        {/* Sliders */}
                        <div className={`space-y-3 transition-opacity ${lc.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                            {/* Elevation */}
                            <div>
                                <div className="flex justify-between mb-1">
                                    <span className="text-[10px] text-[var(--speckle-foreground-3)] font-medium uppercase tracking-wider">Elevation</span>
                                    <span className="text-[10px] text-[var(--speckle-foreground-3)] font-mono">{elevDeg}°</span>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={Math.PI}
                                    step={0.02}
                                    value={lc.elevation}
                                    onChange={e => onSetLighting({ elevation: parseFloat(e.target.value) })}
                                    className="w-full accent-amber-500 cursor-pointer"
                                />
                            </div>

                            {/* Azimuth */}
                            <div>
                                <div className="flex justify-between mb-1">
                                    <span className="text-[10px] text-[var(--speckle-foreground-3)] font-medium uppercase tracking-wider">Azimuth</span>
                                    <span className="text-[10px] text-[var(--speckle-foreground-3)] font-mono">{azimDeg}°</span>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={2 * Math.PI}
                                    step={0.02}
                                    value={lc.azimuth}
                                    onChange={e => onSetLighting({ azimuth: parseFloat(e.target.value) })}
                                    className="w-full accent-amber-500 cursor-pointer"
                                />
                            </div>

                            {/* Cast shadows toggle */}
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] text-[var(--speckle-foreground-2)] font-medium">Cast shadows</span>
                                <button
                                    onClick={() => onSetLighting({ castShadow: !lc.castShadow })}
                                    className={`relative w-9 h-5 rounded-full transition-colors ${lc.castShadow ? 'bg-amber-500' : 'bg-[var(--speckle-outline-5)]'}`}
                                >
                                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${lc.castShadow ? 'translate-x-4' : ''}`} />
                                </button>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

        </div>

        <div
            className={`absolute ${isTimelineActive ? 'top-4' : 'bottom-4'} right-1/2 translate-x-1/2 z-[200] flex flex-col items-center gap-2`}
            style={{ pointerEvents: 'auto' }}
        >

            {/* ── Camera Views popover ──────────────────────────────────────── */}
            <AnimatePresence>
                {showCamViews && (
                    <motion.div ref={camViewsRef} {...popoverAnim} className={`${popoverCls} p-3 w-64`}>
                        <div className="flex items-center justify-between mb-2.5">
                            <span className="text-xs font-semibold text-sky-400 flex items-center gap-1.5">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                                Camera Views
                            </span>
                            <button onClick={() => setShowCamViews(false)} className="text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] transition-colors">
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>

                        {/* Canonical preset grid */}
                        <div className="grid grid-cols-3 gap-1 mb-2">
                            {CANONICAL_VIEWS.map(({ id, label }) => (
                                <button
                                    key={id}
                                    onClick={() => { onCameraView(id); setShowCamViews(false) }}
                                    className="py-1.5 rounded-lg text-[11px] font-medium text-[var(--speckle-foreground-2)] hover:bg-sky-500/20 hover:text-sky-300 transition-all border border-[var(--speckle-outline-3)] hover:border-sky-500/30"
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        {/* Named views from model */}
                        {namedViews.length > 0 && (
                            <>
                                <p className="text-[10px] text-[var(--speckle-foreground-3)] font-medium uppercase tracking-wider mb-1.5">Model Views</p>
                                <div className="max-h-36 overflow-y-auto space-y-0.5 custom-scrollbar">
                                    {namedViews.map((view, idx) => (
                                        <button
                                            key={view.id || view.name || idx}
                                            onClick={() => { onCameraView(view); setShowCamViews(false) }}
                                            className="w-full text-left px-2.5 py-1.5 rounded-lg text-[11px] text-[var(--speckle-foreground-2)] hover:bg-sky-500/15 hover:text-sky-300 transition-all truncate"
                                        >
                                            {view.name || view.id || `View ${idx + 1}`}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ── Explode popover ───────────────────────────────────────────── */}
            <AnimatePresence>
                {showExplode && (
                    <motion.div ref={explodeRef} {...popoverAnim} className={`${popoverCls} p-3 w-56`}>
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-xs font-semibold text-[var(--speckle-foreground-2)] flex items-center gap-1.5">
                                <Maximize2 className="w-3.5 h-3.5" />
                                Explode
                            </span>
                            <span className="text-[10px] text-[var(--speckle-foreground-3)] font-mono">{Math.round((explodeValue || 0) * 100)}%</span>
                        </div>
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={explodeValue || 0}
                            onChange={e => onExplode(parseFloat(e.target.value))}
                            className="w-full accent-blue-500 cursor-pointer"
                        />
                        <div className="flex justify-between text-[9px] text-[var(--speckle-foreground-3)] mt-1">
                            <span>0%</span>
                            <span>100%</span>
                        </div>
                        {(explodeValue || 0) > 0 && (
                            <button
                                onClick={() => onExplode(0)}
                                className="mt-2 w-full py-1 rounded-lg text-[10px] text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] hover:bg-[var(--speckle-outline-3)] transition-colors"
                            >
                                Reset
                            </button>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ── Measurements panel ────────────────────────────────────────── */}
            <AnimatePresence>
                {showMeasurements && (
                    <motion.div ref={measRef} {...popoverAnim} className={`${popoverCls} w-72`}>
                        {/* Header */}
                        <div className="flex items-center justify-between px-3 pt-3 pb-2 border-b border-[var(--speckle-outline-3)]">
                            <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                                <Ruler className="w-3.5 h-3.5" />
                                Measurements
                                {measurements.length > 0 && (
                                    <span className="ml-1 px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[9px] font-bold">
                                        {measurements.length}
                                    </span>
                                )}
                            </span>
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={handleToggleMeasurements}
                                    className={`text-[9px] px-2 py-0.5 rounded-full font-semibold transition-colors ${
                                        measurementsActive
                                            ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                                            : 'bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-2)] hover:text-[var(--speckle-foreground-2)]'
                                    }`}
                                >
                                    {measurementsActive ? 'Active' : 'Inactive'}
                                </button>
                                <button
                                    onClick={() => setShowMeasurements(false)}
                                    className="text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] transition-colors ml-1"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>

                        <div className="p-3 space-y-3">
                            {/* Type selector */}
                            <div>
                                <p className="text-[10px] text-[var(--speckle-foreground-3)] mb-1.5 font-medium uppercase tracking-wider">Type</p>
                                <div className="flex gap-1">
                                    {MEAS_TYPES.map(({ type, label, title, icon }) => (
                                        <button
                                            key={type}
                                            onClick={() => onMeasurementOptions({ type })}
                                            title={title}
                                            className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-lg text-[10px] font-medium transition-all ${
                                                currentType === type
                                                    ? 'bg-emerald-500/25 text-emerald-300 ring-1 ring-emerald-500/40'
                                                    : 'text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground)]'
                                            }`}
                                        >
                                            {icon}
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Units + Precision row */}
                            <div className="flex gap-2">
                                <div className="flex-1">
                                    <p className="text-[10px] text-[var(--speckle-foreground-3)] mb-1 font-medium uppercase tracking-wider">Units</p>
                                    <div className="flex gap-0.5">
                                        {UNITS.map(({ value, label }) => (
                                            <button
                                                key={value}
                                                onClick={() => onMeasurementOptions({ units: value })}
                                                className={`flex-1 py-1 rounded text-[10px] font-medium transition-all ${
                                                    currentUnits === value
                                                        ? 'bg-blue-500/25 text-blue-300 ring-1 ring-blue-500/30'
                                                        : 'text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground-2)]'
                                                }`}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="w-20">
                                    <p className="text-[10px] text-[var(--speckle-foreground-3)] mb-1 font-medium uppercase tracking-wider">Decimal</p>
                                    <div className="flex gap-0.5">
                                        {PRECISIONS.map(p => (
                                            <button
                                                key={p}
                                                onClick={() => onMeasurementOptions({ precision: p })}
                                                className={`flex-1 py-1 rounded text-[10px] font-medium transition-all ${
                                                    currentPrecision === p
                                                        ? 'bg-blue-500/25 text-blue-300 ring-1 ring-blue-500/30'
                                                        : 'text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground-2)]'
                                                }`}
                                            >
                                                {p}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {/* Snap toggle */}
                            <div className="flex gap-2">
                                <button
                                    onClick={() => onMeasurementOptions({ vertexSnap: !vertexSnap })}
                                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all ${
                                        vertexSnap
                                            ? 'bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/30'
                                            : 'text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground-2)]'
                                    }`}
                                >
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                        <circle cx="12" cy="12" r="3" />
                                        <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
                                    </svg>
                                    Snap
                                </button>
                            </div>

                            {/* Measurement list */}
                            {measurements.length > 0 && (
                                <div className="border-t border-[var(--speckle-outline-3)] pt-2">
                                    <div className="flex items-center justify-between mb-1.5">
                                        <p className="text-[10px] text-[var(--speckle-foreground-3)] font-medium uppercase tracking-wider">Results</p>
                                        <button
                                            onClick={onClearMeasurements}
                                            className="text-[9px] text-[var(--speckle-foreground-3)] hover:text-red-400 flex items-center gap-0.5 transition-colors"
                                        >
                                            <Trash2 className="w-2.5 h-2.5" />
                                            Clear all
                                        </button>
                                    </div>
                                    <div className="max-h-40 overflow-y-auto space-y-1 custom-scrollbar pr-0.5">
                                        {measurements.map((m, idx) => {
                                            const typeIcon = TYPE_ICONS_SMALL[m.measurementType ?? m.type ?? MeasurementType.POINTTOPOINT]
                                            const val = formatValue(m.value, m.units || currentUnits)
                                            return (
                                                <div
                                                    key={m.measurementId || m.uuid || idx}
                                                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-[var(--speckle-foundation)] hover:bg-[var(--speckle-outline-3)] group transition-colors"
                                                >
                                                    <span className="text-emerald-400/70 shrink-0">{typeIcon}</span>
                                                    <span className="text-xs font-mono text-[var(--speckle-foreground)] flex-1 tabular-nums">{val}</span>
                                                    <button
                                                        onClick={() => onDeleteMeasurement(m.toMeasurementData ? m.toMeasurementData() : m)}
                                                        className="text-[var(--speckle-foreground-3)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                                                        title="Delete"
                                                    >
                                                        <X className="w-3 h-3" />
                                                    </button>
                                                </div>
                                            )
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Empty states */}
                            {measurementsActive && measurements.length === 0 && (
                                <p className="text-[10px] text-[var(--speckle-foreground-3)] text-center py-1">
                                    Click on the model to place points
                                </p>
                            )}
                            {!measurementsActive && measurements.length === 0 && (
                                <p className="text-[10px] text-[var(--speckle-foreground-3)] text-center py-1">
                                    Activate to start measuring
                                </p>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ── Toolbar pill ──────────────────────────────────────────────────
                max-w + overflow-x-auto: at 8 buttons this pill's natural content
                width (~362px) exceeds the viewer panel itself on narrow phones
                (iPhone 7 is 375px wide, panel ~321px) — without a cap it overflows
                past the panel's own edges on both sides. 85vw (not a percentage of
                this absolutely-positioned pill's own containing block, which on
                mobile resolves wider than the visible panel and undershoots the
                fix) reliably fits inside the panel on phones while never engaging
                on desktop, where the pill's natural width is far below 85vw. */}
            <div className="glass rounded-full shadow-lg p-1.5 flex gap-1 items-center max-w-[85vw] overflow-x-auto no-scrollbar">

                {/* Section Box */}
                <button
                    className={`w-[30px] h-[30px] flex items-center justify-center rounded-full transition-colors ${isSectionBoxEnabled ? 'bg-blue-500 text-white' : 'text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground)]'}`}
                    onClick={onSectionBoxClick}
                    title="Section Box"
                >
                    <Scissors className="w-5 h-5" />
                </button>

                {/* Zoom Extents */}
                <button
                    className="w-[30px] h-[30px] flex items-center justify-center rounded-full transition-colors text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground)]"
                    onClick={onZoomExtents}
                    title="Zoom Extents"
                >
                    <Expand className="w-5 h-5" />
                </button>

                {/* Perspective / Ortho toggle */}
                <button
                    className={`w-[30px] h-[30px] flex items-center justify-center rounded-full transition-all text-xs font-bold ${isOrtho ? 'bg-sky-500/70 text-white' : 'text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground)]'}`}
                    onClick={onToggleProjection}
                    disabled={!isViewerReady}
                    title={isOrtho ? 'Switch to Perspective' : 'Switch to Orthographic'}
                >
                    {isOrtho ? 'Ortho' : 'Persp'}
                </button>

                {/* Camera Views */}
                <button
                    className={`w-[30px] h-[30px] flex items-center justify-center rounded-full transition-all ${showCamViews ? 'bg-sky-500/80 text-white' : 'text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] hover:text-sky-300'}`}
                    onClick={() => { closeAll(); setShowCamViews(v => !v) }}
                    disabled={!isViewerReady}
                    title="Camera Views"
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="2" y1="12" x2="22" y2="12"/>
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                    </svg>
                </button>

                <div className="w-px bg-[var(--speckle-outline-3)] mx-0.5 self-stretch" />

                {/* Screenshot */}
                <button
                    className="w-[30px] h-[30px] flex items-center justify-center rounded-full transition-colors text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground)]"
                    onClick={onScreenshot}
                    disabled={!isViewerReady}
                    title="Save Screenshot"
                >
                    <Camera className="w-5 h-5" />
                </button>

                <div className="w-px bg-[var(--speckle-outline-3)] mx-0.5 self-stretch" />

                {/* Fly-through mode */}
                <button
                    className={`w-[30px] h-[30px] flex items-center justify-center rounded-full transition-all ${isFlyMode ? 'bg-sky-500/80 text-white' : 'text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] hover:text-sky-300'}`}
                    onClick={onToggleFlyMode}
                    disabled={!isViewerReady}
                    title={isFlyMode ? 'Exit fly-through (back to orbit)' : 'Fly-through mode (WASD to move)'}
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
                    </svg>
                </button>

                {/* Hide selected */}
                {selectionCount > 0 && (
                    <button
                        className="w-[30px] h-[30px] flex items-center justify-center rounded-full transition-all text-amber-300 hover:bg-amber-500/20"
                        onClick={onHideSelected}
                        disabled={!isViewerReady}
                        title={`Hide selected (${selectionCount})`}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                            <line x1="1" y1="1" x2="23" y2="23"/>
                        </svg>
                    </button>
                )}

                {/* Show all hidden */}
                {hiddenCount > 0 && (
                    <button
                        className="w-[30px] h-[30px] flex items-center justify-center rounded-full transition-all text-green-300 hover:bg-green-500/20 relative"
                        onClick={onShowAllHidden}
                        disabled={!isViewerReady}
                        title={`Show ${hiddenCount} hidden objects`}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                            <circle cx="12" cy="12" r="3"/>
                        </svg>
                        <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-green-400 text-black text-[7px] font-bold flex items-center justify-center">{hiddenCount > 9 ? '9+' : hiddenCount}</span>
                    </button>
                )}

                {/* Measurements */}
                <button
                    className={`w-[30px] h-[30px] flex items-center justify-center rounded-full transition-all relative ${
                        measurementsActive
                            ? 'bg-emerald-500/80 text-white shadow-[0_0_10px_rgba(52,211,153,0.4)]'
                            : showMeasurements
                                ? 'bg-[var(--speckle-outline-3)] text-emerald-300'
                                : 'text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground)]'
                    }`}
                    onClick={() => { closeAll(); setShowMeasurements(v => !v) }}
                    disabled={!isViewerReady}
                    title={measurementsActive ? 'Measurements active' : 'Measure'}
                >
                    <Ruler className="w-5 h-5" />
                    {measurements.length > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-emerald-400 border border-black/40 text-[8px] font-bold text-black flex items-center justify-center leading-none">
                            {measurements.length > 9 ? '9+' : measurements.length}
                        </span>
                    )}
                </button>

                {/* Explode */}
                <button
                    className={`w-[30px] h-[30px] flex items-center justify-center rounded-full transition-all relative ${
                        showExplode || (explodeValue || 0) > 0
                            ? 'bg-amber-500/80 text-white'
                            : 'text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground)]'
                    }`}
                    onClick={() => { closeAll(); setShowExplode(v => !v) }}
                    disabled={!isViewerReady}
                    title="Explode model"
                >
                    <Maximize2 className="w-5 h-5" />
                    {(explodeValue || 0) > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400 border border-black/40" />
                    )}
                </button>
            </div>
        </div>
        </>
    )
}
