import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Stage, Layer, Image as KonvaImage, Arrow, Text as KonvaText, Line, Shape, Rect, Ellipse } from 'react-konva'
import { motion } from 'framer-motion'
import {
    X, Check, MousePointer2, Type, MoveUpRight, Cloud as CloudIcon, Pencil, Undo2, Redo2, Trash2,
    Square, Circle,
} from 'lucide-react'
import { useDrawerWidth } from '../utils/useDrawerWidth'

const TOOLS = { SELECT: 'select', TEXT: 'text', ARROW: 'arrow', CLOUD: 'cloud', PEN: 'pen', RECT: 'rect', ELLIPSE: 'ellipse' }
// Types whose geometry is a dragged bounding box (x/y always the true
// top-left corner, width/height always >= 0) — cloud, rectangle, ellipse.
// Arrow/pen instead store raw point lists and don't need this normalization.
const BOX_TYPES = new Set(['cloud', 'rect', 'ellipse'])
const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#ffffff']

let idSeq = 0
const nextId = () => `m${++idSeq}`

// Walks a w×h rectangle's perimeter, returning points spaced ~`spacing` apart
// (arc length). Used as the vertex ring for the revision-cloud bumps below.
function perimeterPoints(w, h, spacing) {
    const edges = [
        { x1: 0, y1: 0, x2: w, y2: 0 },
        { x1: w, y1: 0, x2: w, y2: h },
        { x1: w, y1: h, x2: 0, y2: h },
        { x1: 0, y1: h, x2: 0, y2: 0 },
    ]
    const points = []
    for (const e of edges) {
        const dx = e.x2 - e.x1
        const dy = e.y2 - e.y1
        const len = Math.hypot(dx, dy)
        const steps = Math.max(1, Math.round(len / spacing))
        for (let i = 0; i < steps; i++) {
            const t = i / steps
            points.push({ x: e.x1 + dx * t, y: e.y1 + dy * t })
        }
    }
    return points
}

// Classic CAD "revision cloud": a ring of overlapping outward-bulging arcs
// traced around a rectangle's perimeter. Konva has no built-in primitive for
// this, so it's drawn with a custom sceneFunc.
function CloudNode({ shape, ...props }) {
    const sceneFunc = useCallback((ctx, node) => {
        const w = Math.abs(shape.width) || 1
        const h = Math.abs(shape.height) || 1
        const bumpSize = Math.max(10, Math.min(w, h) / 6)
        const pts = perimeterPoints(w, h, bumpSize)
        ctx.beginPath()
        for (let i = 0; i < pts.length; i++) {
            const p1 = pts[i]
            const p2 = pts[(i + 1) % pts.length]
            const dx = p2.x - p1.x
            const dy = p2.y - p1.y
            const dist = Math.hypot(dx, dy) || 1
            const radius = dist / 2
            const mx = (p1.x + p2.x) / 2
            const my = (p1.y + p2.y) / 2
            // Outward normal (points ring is walked clockwise, so this bulges out)
            const nx = dy / dist
            const ny = -dx / dist
            const bulge = radius * 0.55
            const cx = mx + nx * bulge
            const cy = my + ny * bulge
            const r = Math.hypot(p1.x - cx, p1.y - cy)
            const a1 = Math.atan2(p1.y - cy, p1.x - cx)
            const a2 = Math.atan2(p2.y - cy, p2.x - cx)
            ctx.arc(cx, cy, r, a1, a2, false)
        }
        ctx.closePath()
        ctx.fillStrokeShape(node)
    }, [shape.width, shape.height])

    // `shape.x`/`shape.y` are always kept normalized to the true top-left
    // corner (see handleStagePointerMove's box-drag branch) — width/height
    // are always >= 0, so no min/abs juggling is needed here at render time.
    //
    // `{...props}` is spread FIRST and explicit values follow — NOT the other
    // way around. `props` (from the caller's `common` object) always contains
    // a `stroke` key, set to `undefined` whenever this shape isn't selected.
    // Spreading `{...props}` *after* an explicit `stroke={shape.color}` would
    // let that `stroke: undefined` silently clobber it back to no color at
    // all — Konva then has neither a fill nor a stroke to paint, so the
    // cloud draws (hit-testing still works) but is completely invisible.
    // This was the actual bug: clouds always overwrote their own color.
    return (
        <Shape
            {...props}
            x={shape.x}
            y={shape.y}
            sceneFunc={sceneFunc}
            stroke={props.stroke || shape.color}
            strokeWidth={shape.strokeWidth}
            hitStrokeWidth={Math.max(20, shape.strokeWidth * 4)}
        />
    )
}

// Right-docked, resizable markup editor for a single BCF viewpoint
// screenshot — same drawer shell (size, resize handle, shared width) as
// IdsCheckPanel/ClashCheckPanel via useDrawerWidth(). Takes a bare base64
// PNG (no `data:` prefix — matches the `snapshot_base64` shape used
// everywhere else in this codebase) and returns one the same way, with any
// annotations flattened directly into the raster image. The backend never
// knows the difference — bim-normalizer/bcf/viewpoints.py just stores
// whatever bytes it's given.
export function ViewpointMarkupEditor({ imageBase64, onSave, onCancel }) {
    const [width, startResize] = useDrawerWidth()
    const [image, setImage] = useState(null) // HTMLImageElement, natural size
    const [activeTool, setActiveTool] = useState(TOOLS.SELECT)
    const [activeColor, setActiveColor] = useState(COLORS[0])
    const [elements, setElements] = useState([])
    const [history, setHistory] = useState([[]])
    const [historyIndex, setHistoryIndex] = useState(0)
    const [selectedId, setSelectedId] = useState(null)
    const [editingText, setEditingText] = useState(null) // { id, x, y } in natural coords, or null

    const stageRef = useRef(null)
    const drawingRef = useRef(null) // in-progress shape while dragging out an arrow/cloud/pen stroke
    const containerRef = useRef(null)
    const textAreaRef = useRef(null)

    useEffect(() => {
        const img = new window.Image()
        img.onload = () => setImage(img)
        img.src = `data:image/png;base64,${imageBase64}`
    }, [imageBase64])

    // Focus the text-edit textarea via rAF rather than the `autoFocus`
    // attribute — it mounts synchronously inside the same click that placed
    // it, and Konva's Stage can grab focus back for its own keyboard
    // handling in that same tick, stealing it immediately (the textarea
    // would then blur before the user types anything, and blur-with-empty
    // text deletes the placeholder — text looked completely non-functional).
    // Deferring to the next frame lets that settle first.
    useEffect(() => {
        if (!editingText) return
        const raf = requestAnimationFrame(() => textAreaRef.current?.focus())
        return () => cancelAnimationFrame(raf)
    }, [editingText])

    const naturalWidth = image?.naturalWidth || 1
    const naturalHeight = image?.naturalHeight || 1

    const { displayWidth, displayHeight, scale } = useMemo(() => {
        // Fit within the drawer's own width (not the full window — this is a
        // docked panel now, not a full-screen overlay) and most of the
        // viewport height, same proportions IdsCheckPanel/ClashCheckPanel use.
        const maxW = width - 48 // drawer padding
        const maxH = window.innerHeight * 0.68
        const s = Math.min(1, maxW / naturalWidth, maxH / naturalHeight)
        return { displayWidth: naturalWidth * s, displayHeight: naturalHeight * s, scale: s }
    }, [naturalWidth, naturalHeight, width])

    // Scales with image resolution so strokes/text don't look absurdly thin
    // on a 4K capture or absurdly thick on a small one.
    const strokeWidth = Math.max(3, naturalWidth / 400)
    const fontSize = Math.max(16, Math.round(naturalWidth / 45))

    const commit = useCallback((next) => {
        setElements(next)
        setHistory((h) => [...h.slice(0, historyIndex + 1), next])
        setHistoryIndex((i) => i + 1)
    }, [historyIndex])

    const undo = () => {
        if (historyIndex === 0) return
        const i = historyIndex - 1
        setHistoryIndex(i)
        setElements(history[i])
        setSelectedId(null)
    }
    const redo = () => {
        if (historyIndex >= history.length - 1) return
        const i = historyIndex + 1
        setHistoryIndex(i)
        setElements(history[i])
        setSelectedId(null)
    }

    const deleteSelected = useCallback(() => {
        if (!selectedId) return
        commit(elements.filter((el) => el.id !== selectedId))
        setSelectedId(null)
    }, [selectedId, elements, commit])

    useEffect(() => {
        const onKeyDown = (e) => {
            if (editingText) return // let the textarea handle its own keys
            if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected() }
            else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
            else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo() }
            else if (e.key === 'Escape') { e.preventDefault(); onCancel?.() }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [editingText, deleteSelected, historyIndex, history, onCancel, undo, redo])

    const updateElement = (id, patch) => {
        commit(elements.map((el) => (el.id === id ? { ...el, ...patch } : el)))
    }

    const stagePointer = () => {
        const stage = stageRef.current
        if (!stage) return null
        // getPointerPosition() returns raw screen/container pixels, ignoring
        // the Stage's own scaleX/scaleY (set below to fit the natural-size
        // image into the viewport). getRelativePointerPosition() runs that
        // same point back through the stage's transform, giving coordinates
        // in the *natural* image-pixel space that shapes are stored in —
        // required for both correct placement and correct full-res export.
        return stage.getRelativePointerPosition()
    }

    const handleStagePointerDown = (e) => {
        if (activeTool === TOOLS.SELECT) {
            // The background image has listening={false}, so it's transparent
            // to hit-testing — a click on it (or truly empty canvas) hits the
            // Stage itself, distinguishing it from a click on an annotation.
            if (e.target === e.target.getStage()) setSelectedId(null)
            return
        }
        const pos = stagePointer()
        if (!pos) return

        if (activeTool === TOOLS.TEXT) {
            const id = nextId()
            // Text finalizes via commitText() (on blur/Enter), not the
            // generic pointerup handler below — leave drawingRef untouched
            // so pointerup doesn't push a premature "empty text" history
            // entry for what's really still an in-progress edit.
            setElements((prev) => [...prev, { id, type: 'text', x: pos.x, y: pos.y, text: '', color: activeColor, fontSize }])
            setEditingText({ id, x: pos.x, y: pos.y, originalText: '' })
            return
        }
        if (activeTool === TOOLS.ARROW) {
            const id = nextId()
            drawingRef.current = { id, type: 'arrow' }
            setElements((prev) => [...prev, { id, type: 'arrow', points: [pos.x, pos.y, pos.x, pos.y], color: activeColor, strokeWidth }])
            return
        }
        if (activeTool === TOOLS.PEN) {
            const id = nextId()
            drawingRef.current = { id, type: 'pen' }
            setElements((prev) => [...prev, { id, type: 'pen', points: [pos.x, pos.y], color: activeColor, strokeWidth }])
            return
        }
        // Cloud / Rectangle / Ellipse — all a dragged bounding box, same shape.
        const toolToType = { [TOOLS.CLOUD]: 'cloud', [TOOLS.RECT]: 'rect', [TOOLS.ELLIPSE]: 'ellipse' }
        const type = toolToType[activeTool]
        if (type) {
            const id = nextId()
            drawingRef.current = { id, type, startX: pos.x, startY: pos.y }
            setElements((prev) => [...prev, { id, type, x: pos.x, y: pos.y, width: 0, height: 0, color: activeColor, strokeWidth }])
        }
    }

    const handleStagePointerMove = () => {
        const drawing = drawingRef.current
        if (!drawing) return
        const pos = stagePointer()
        if (!pos) return
        setElements((prev) => prev.map((el) => {
            if (el.id !== drawing.id) return el
            if (el.type === 'arrow') return { ...el, points: [el.points[0], el.points[1], pos.x, pos.y] }
            if (BOX_TYPES.has(el.type)) {
                // Keep x/y normalized to the true top-left at every step (not
                // just at drop) so width/height never go negative and the
                // shape's render never has to compensate for that.
                const { startX, startY } = drawing
                return {
                    ...el,
                    x: Math.min(startX, pos.x),
                    y: Math.min(startY, pos.y),
                    width: Math.abs(pos.x - startX),
                    height: Math.abs(pos.y - startY),
                }
            }
            if (el.type === 'pen') return { ...el, points: [...el.points, pos.x, pos.y] }
            return el
        }))
    }

    const handleStagePointerUp = () => {
        if (!drawingRef.current) return
        drawingRef.current = null
        // Finalize into history now that the shape's geometry has settled —
        // dragging out an arrow/cloud/pen stroke updates `elements` directly
        // (above) without touching history, so this is the one push per shape.
        setElements((current) => {
            setHistory((h) => [...h.slice(0, historyIndex + 1), current])
            setHistoryIndex((i) => i + 1)
            return current
        })
    }

    const commitText = (value) => {
        const trimmed = value.trim()
        const id = editingText?.id
        setEditingText(null)
        if (!id) return
        if (!trimmed) {
            // Empty text placed and abandoned — drop it rather than saving a
            // blank label. Not pushed to history since it was never
            // committed there in the first place (see handleStagePointerDown).
            setElements((prev) => prev.filter((el) => el.id !== id))
            return
        }
        setElements((prev) => {
            const next = prev.map((el) => (el.id === id ? { ...el, text: trimmed } : el))
            setHistory((h) => [...h.slice(0, historyIndex + 1), next])
            setHistoryIndex((i) => i + 1)
            return next
        })
        setActiveTool(TOOLS.SELECT)
    }

    // Escape while editing text: revert to whatever it said before this edit
    // session started, rather than commitText('')'s "empty = delete" rule —
    // that rule is right for abandoning a freshly-placed label, but wrong for
    // an existing one being re-edited (Escape shouldn't destroy it).
    const cancelTextEdit = () => {
        const id = editingText?.id
        const original = editingText?.originalText ?? ''
        setEditingText(null)
        if (!id) return
        if (!original.trim()) {
            setElements((prev) => prev.filter((el) => el.id !== id))
        } else {
            setElements((prev) => prev.map((el) => (el.id === id ? { ...el, text: original } : el)))
        }
    }

    const handleSave = () => {
        const stage = stageRef.current
        if (!stage) { onSave?.(imageBase64); return }
        const dataUrl = stage.toDataURL({ mimeType: 'image/png', pixelRatio: 1 / scale })
        onSave?.(dataUrl.split(',')[1] || imageBase64)
    }

    const toolButtons = [
        { tool: TOOLS.SELECT, icon: MousePointer2, title: 'Select / move (Delete to remove)' },
        { tool: TOOLS.TEXT, icon: Type, title: 'Text callout' },
        { tool: TOOLS.ARROW, icon: MoveUpRight, title: 'Arrow' },
        { tool: TOOLS.CLOUD, icon: CloudIcon, title: 'Revision cloud' },
        { tool: TOOLS.RECT, icon: Square, title: 'Rectangle' },
        { tool: TOOLS.ELLIPSE, icon: Circle, title: 'Ellipse' },
        { tool: TOOLS.PEN, icon: Pencil, title: 'Freehand pen' },
    ]

    // Rendered via a portal straight into document.body — this editor is
    // opened from inside BcfTopicPanel's small `fixed bottom-6 right-6`
    // floating panel, and if any ancestor between there and the root ever
    // establishes a new CSS containing block (a transform/filter/etc. —
    // common with animation libraries), `position: fixed` here would resolve
    // against that small panel instead of the real viewport. A portal makes
    // this editor a true child of <body>, immune to that regardless of cause.
    return createPortal(
        <motion.div
            initial={{ x: width }} animate={{ x: 0 }} exit={{ x: width }}
            transition={{ type: 'tween', duration: 0.2 }}
            className="fixed top-0 right-0 h-full z-[210000] flex flex-col shadow-2xl border-l border-[var(--speckle-outline-3)]"
            style={{ backgroundColor: 'var(--speckle-foundation-page)', width }}
        >
            <div
                onMouseDown={startResize}
                title="Drag to resize"
                className="absolute left-0 top-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-amber-500/40 active:bg-amber-500/60 transition-colors z-10"
            />
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--speckle-outline-3)] shrink-0">
                <h2 className="font-semibold text-sm text-[var(--speckle-foreground)]">Annotate Viewpoint</h2>
                <div className="flex items-center gap-1.5">
                    <button onClick={onCancel} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground)] transition-colors">
                        <X className="w-3.5 h-3.5" /> Cancel
                    </button>
                    <button onClick={handleSave} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-amber-500 text-black font-medium hover:bg-amber-400 transition-colors">
                        <Check className="w-3.5 h-3.5" /> Save
                    </button>
                </div>
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--speckle-outline-3)] shrink-0 flex-wrap">
                <div className="flex items-center gap-1 bg-[var(--speckle-outline-3)] rounded-lg p-1">
                    {toolButtons.map(({ tool, icon: Icon, title }) => (
                        <button
                            key={tool}
                            title={title}
                            onClick={() => setActiveTool(tool)}
                            className={`p-1.5 rounded-md transition-colors ${activeTool === tool ? 'bg-amber-500/20 text-amber-400' : 'text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-2)] hover:text-[var(--speckle-foreground)]'}`}
                        >
                            <Icon className="w-4 h-4" />
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-1">
                    {COLORS.map((c) => (
                        <button
                            key={c}
                            title={c}
                            onClick={() => setActiveColor(c)}
                            className={`w-5 h-5 rounded-full border-2 transition-transform ${activeColor === c ? 'border-[var(--speckle-foreground)] scale-110' : 'border-transparent'}`}
                            style={{ backgroundColor: c }}
                        />
                    ))}
                </div>
                <div className="flex items-center gap-1 bg-[var(--speckle-outline-3)] rounded-lg p-1">
                    <button title="Undo (Ctrl+Z)" onClick={undo} disabled={historyIndex === 0} className="p-1.5 rounded-md text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-2)] hover:text-[var(--speckle-foreground)] disabled:opacity-30 disabled:pointer-events-none transition-colors">
                        <Undo2 className="w-4 h-4" />
                    </button>
                    <button title="Redo (Ctrl+Y)" onClick={redo} disabled={historyIndex >= history.length - 1} className="p-1.5 rounded-md text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-2)] hover:text-[var(--speckle-foreground)] disabled:opacity-30 disabled:pointer-events-none transition-colors">
                        <Redo2 className="w-4 h-4" />
                    </button>
                    <button title="Delete selected (Del)" onClick={deleteSelected} disabled={!selectedId} className="p-1.5 rounded-md text-[var(--speckle-foreground-3)] hover:bg-red-500/10 hover:text-red-400 disabled:opacity-30 disabled:pointer-events-none transition-colors">
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Canvas area */}
            <div className="flex-1 flex items-center justify-center overflow-auto p-4">
                {image && (
                    <div ref={containerRef} className="relative" style={{ width: displayWidth, height: displayHeight }}>
                        <Stage
                            ref={stageRef}
                            width={displayWidth}
                            height={displayHeight}
                            scaleX={scale}
                            scaleY={scale}
                            onPointerDown={handleStagePointerDown}
                            onPointerMove={handleStagePointerMove}
                            onPointerUp={handleStagePointerUp}
                            className="rounded-lg overflow-hidden border border-[var(--speckle-outline-3)] shadow-2xl"
                        >
                            <Layer>
                                <KonvaImage name="bg-image" image={image} width={naturalWidth} height={naturalHeight} listening={false} />
                                {elements.map((el) => {
                                    const common = {
                                        // NOTE: `key` deliberately isn't set here — React strips
                                        // `key` out of props entirely, so passing it via a spread
                                        // object silently does nothing. It's set as a literal JSX
                                        // attribute on each returned element below instead.
                                        draggable: activeTool === TOOLS.SELECT,
                                        onClick: () => activeTool === TOOLS.SELECT && setSelectedId(el.id),
                                        onTap: () => activeTool === TOOLS.SELECT && setSelectedId(el.id),
                                        onDragEnd: (e) => {
                                            if (el.type === 'text' || el.type === 'cloud' || el.type === 'rect') {
                                                // These all treat x/y as the top-left corner.
                                                updateElement(el.id, { x: e.target.x(), y: e.target.y() })
                                            } else if (el.type === 'ellipse') {
                                                // Konva's Ellipse treats x/y as its *center* — convert
                                                // back to the top-left convention every other box shape
                                                // in `elements` uses, so width/height stay meaningful.
                                                updateElement(el.id, { x: e.target.x() - el.width / 2, y: e.target.y() - el.height / 2 })
                                            } else {
                                                updateElement(el.id, { offsetX: e.target.x(), offsetY: e.target.y() })
                                            }
                                        },
                                        stroke: selectedId === el.id ? '#ffffff' : undefined,
                                    }
                                    if (el.type === 'text') {
                                        return (
                                            <KonvaText
                                                key={el.id}
                                                {...common}
                                                x={el.x} y={el.y}
                                                text={el.text}
                                                fontSize={el.fontSize}
                                                fill={el.color}
                                                fontStyle="bold"
                                                shadowColor="black" shadowBlur={4} shadowOpacity={0.8}
                                                visible={editingText?.id !== el.id}
                                                onDblClick={() => setEditingText({ id: el.id, x: el.x, y: el.y, originalText: el.text })}
                                                onDblTap={() => setEditingText({ id: el.id, x: el.x, y: el.y, originalText: el.text })}
                                            />
                                        )
                                    }
                                    if (el.type === 'arrow') {
                                        return (
                                            <Arrow
                                                key={el.id}
                                                {...common}
                                                x={el.offsetX || 0} y={el.offsetY || 0}
                                                points={el.points}
                                                stroke={selectedId === el.id ? '#ffffff' : el.color}
                                                fill={el.color}
                                                strokeWidth={el.strokeWidth}
                                                pointerLength={el.strokeWidth * 3.5}
                                                pointerWidth={el.strokeWidth * 3.5}
                                                hitStrokeWidth={Math.max(20, el.strokeWidth * 4)}
                                            />
                                        )
                                    }
                                    if (el.type === 'cloud') {
                                        return <CloudNode key={el.id} {...common} shape={el} strokeWidth={selectedId === el.id ? el.strokeWidth + 1.5 : el.strokeWidth} />
                                    }
                                    if (el.type === 'rect') {
                                        return (
                                            <Rect
                                                key={el.id}
                                                {...common}
                                                x={el.x} y={el.y}
                                                width={el.width} height={el.height}
                                                stroke={selectedId === el.id ? '#ffffff' : el.color}
                                                strokeWidth={el.strokeWidth}
                                                cornerRadius={Math.min(6, el.strokeWidth)}
                                            />
                                        )
                                    }
                                    if (el.type === 'ellipse') {
                                        return (
                                            <Ellipse
                                                key={el.id}
                                                {...common}
                                                x={el.x + el.width / 2} y={el.y + el.height / 2}
                                                radiusX={Math.max(1, el.width / 2)} radiusY={Math.max(1, el.height / 2)}
                                                stroke={selectedId === el.id ? '#ffffff' : el.color}
                                                strokeWidth={el.strokeWidth}
                                            />
                                        )
                                    }
                                    if (el.type === 'pen') {
                                        return (
                                            <Line
                                                key={el.id}
                                                {...common}
                                                x={el.offsetX || 0} y={el.offsetY || 0}
                                                points={el.points}
                                                stroke={selectedId === el.id ? '#ffffff' : el.color}
                                                strokeWidth={el.strokeWidth}
                                                tension={0.4}
                                                lineCap="round"
                                                lineJoin="round"
                                                hitStrokeWidth={Math.max(20, el.strokeWidth * 4)}
                                            />
                                        )
                                    }
                                    return null
                                })}
                            </Layer>
                        </Stage>

                        {editingText && containerRef.current && (
                            <textarea
                                ref={textAreaRef}
                                defaultValue={elements.find((el) => el.id === editingText.id)?.text || ''}
                                onBlur={(e) => commitText(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.blur() }
                                    if (e.key === 'Escape') { e.preventDefault(); cancelTextEdit() }
                                }}
                                className="absolute bg-black/70 text-white font-bold outline-none border border-amber-500/60 rounded px-1 min-w-[80px]"
                                style={{
                                    left: editingText.x * scale,
                                    top: editingText.y * scale,
                                    fontSize: fontSize * scale,
                                    color: activeColor,
                                }}
                            />
                        )}
                    </div>
                )}
            </div>
        </motion.div>,
        document.body
    )
}
