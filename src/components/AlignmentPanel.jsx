import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { motion, useDragControls } from 'framer-motion'
import { X, Crosshair, Check, Loader2 } from 'lucide-react'
import { DxfCanvas } from './document-preview/DxfCanvas'
import { solveAlignmentTransform, DegenerateAlignmentPointsError } from '../utils/alignmentTransform'

// Floating calibration panel for the drawing-to-3D-model alignment feature
// (ACC "Align Documents"-style: pick 2 matching points on the drawing and in
// the 3D model, solve a 2D similarity transform, preview it live as an
// overlay plane). Deliberately NOT a full-screen overlay like DocumentPreview/
// DocumentsPanel — the main SpeckleViewer (already loaded, same WebGL
// context) needs to stay visible and interactive underneath for 3D point
// picking, so this renders as a small floating card alongside it instead.
export function AlignmentPanel({ doc, streamId, normalizerUrl, modelId, viewerRef, onClose, onSaved }) {
    const base = (normalizerUrl || '').replace(/\/$/, '')
    const isDwg = /\.dwg$/i.test(doc?.filename || '')
    const drawingUrl = isDwg
        ? `${base}/projects/${streamId}/documents/${doc.doc_id}/preview.dxf`
        : `${base}/projects/${streamId}/documents/${doc.doc_id}/download`
    // Re-aligning an already-aligned drawing has a known scale from last
    // time — use it so the preview texture is sized off the drawing's real
    // physical size, same as DocumentsPanel's toggle. A brand-new alignment
    // has no scale yet (nothing's been picked), so this falls back to the
    // backend's flat default until it's saved and re-opened.
    const textureUrl = `${base}/projects/${streamId}/documents/${doc.doc_id}/align-texture.png${doc?.align_transform?.scale ? `?scale=${doc.align_transform.scale}` : ''}`

    const existing = doc?.align_control_points
    const [drawingPoints, setDrawingPoints] = useState([
        existing?.[0]?.drawing ?? null, existing?.[1]?.drawing ?? null,
    ])
    const [worldPoints, setWorldPoints] = useState([
        existing?.[0]?.world ?? null, existing?.[1]?.world ?? null,
    ])
    const [pointIndex, setPointIndex] = useState(0)
    const [elevationZ, setElevationZ] = useState(doc?.align_elevation_z ?? '')
    const [extents, setExtents] = useState(null) // {extminX, extminY, extmaxX, extmaxY}
    const [textureObjectUrl, setTextureObjectUrl] = useState(null)
    const [textureError, setTextureError] = useState(null)
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState(null)

    // Fetch the texture once — it depends only on the drawing file, not on
    // the calibration points/elevation, which only affect where/how it's
    // placed. Reused as both the live-preview overlay's texture and the
    // saved alignment's texture (same URL either way).
    useEffect(() => {
        let cancelled = false
        fetch(textureUrl).then(async (res) => {
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `Failed to render texture (${res.status})`)
            const extminX = parseFloat(res.headers.get('X-Extent-Min-X'))
            const extminY = parseFloat(res.headers.get('X-Extent-Min-Y'))
            const extmaxX = parseFloat(res.headers.get('X-Extent-Max-X'))
            const extmaxY = parseFloat(res.headers.get('X-Extent-Max-Y'))
            const blob = await res.blob()
            if (cancelled) return
            setExtents({ extminX, extminY, extmaxX, extmaxY })
            setTextureObjectUrl(URL.createObjectURL(blob))
        }).catch((e) => { if (!cancelled) setTextureError(e.message) })
        return () => { cancelled = true }
    }, [textureUrl])

    // 3D pick handler — registered with the viewer once, reads current
    // pointIndex via ref (registered callback would otherwise close over a
    // stale value from whenever setAlignmentPickHandler was last called).
    const pointIndexRef = useRef(pointIndex)
    useEffect(() => { pointIndexRef.current = pointIndex }, [pointIndex])

    useEffect(() => {
        const viewer = viewerRef?.current
        if (!viewer) return
        viewer.setAlignmentPickActive(true)
        viewer.setAlignmentPickHandler((point) => {
            const idx = pointIndexRef.current
            viewer.setAlignmentPickMarker(idx, point)
            setWorldPoints((prev) => {
                const next = [...prev]
                next[idx] = point
                return next
            })
        })
        // Re-show markers for any points preloaded from an existing alignment.
        worldPoints.forEach((p, i) => { if (p) viewer.setAlignmentPickMarker(i, p) })
        return () => {
            viewer.setAlignmentPickActive(false)
            viewer.setAlignmentPickHandler(null)
            viewer.clearAlignmentPickMarkers()
            viewer.clearAlignmentOverlay()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewerRef])

    const handlePickDrawingPoint = useCallback((point) => {
        setDrawingPoints((prev) => {
            const next = [...prev]
            next[pointIndexRef.current] = point
            return next
        })
    }, [])

    // Auto-advance from point 1 to point 2 once point 1 is fully set on both sides.
    useEffect(() => {
        if (pointIndex === 0 && drawingPoints[0] && worldPoints[0] && !drawingPoints[1] && !worldPoints[1]) {
            setPointIndex(1)
        }
    }, [drawingPoints, worldPoints, pointIndex])

    const transform = useMemo(() => {
        if (!drawingPoints[0] || !drawingPoints[1] || !worldPoints[0] || !worldPoints[1]) return null
        try {
            return solveAlignmentTransform(drawingPoints[0], drawingPoints[1], worldPoints[0], worldPoints[1])
        } catch (e) {
            if (e instanceof DegenerateAlignmentPointsError) return null
            throw e
        }
    }, [drawingPoints, worldPoints])

    const elevationNum = elevationZ === '' ? null : Number(elevationZ)
    // Default the elevation field to the picked points' average Z the first
    // time both are available, without fighting the user's own later edits.
    useEffect(() => {
        if (elevationZ === '' && worldPoints[0] && worldPoints[1]) {
            setElevationZ((((worldPoints[0].z + worldPoints[1].z) / 2).toFixed(3)))
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [worldPoints])

    // Live preview
    useEffect(() => {
        const viewer = viewerRef?.current
        if (!viewer) return
        if (transform && extents && textureObjectUrl && elevationNum != null && !Number.isNaN(elevationNum)) {
            viewer.setAlignmentOverlay({ textureUrl: textureObjectUrl, extents, transform, elevationZ: elevationNum })
        } else {
            viewer.clearAlignmentOverlay()
        }
    }, [transform, extents, textureObjectUrl, elevationNum, viewerRef])

    useEffect(() => () => {
        if (textureObjectUrl) URL.revokeObjectURL(textureObjectUrl)
    }, [textureObjectUrl])

    const canSave = !!transform && elevationNum != null && !Number.isNaN(elevationNum)

    const handleSave = async () => {
        if (!canSave) return
        setSaving(true)
        setSaveError(null)
        try {
            const res = await fetch(`${base}/projects/${streamId}/documents/${doc.doc_id}/align`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transform,
                    elevation_z: elevationNum,
                    model_id: modelId,
                    control_points: [
                        { drawing: drawingPoints[0], world: worldPoints[0] },
                        { drawing: drawingPoints[1], world: worldPoints[1] },
                    ],
                }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `Save failed (${res.status})`)
            }
            const updated = await res.json()
            onSaved?.(updated)
        } catch (e) {
            setSaveError(e.message)
        } finally {
            setSaving(false)
        }
    }

    const pointStatus = (i) => (drawingPoints[i] && worldPoints[i] ? 'done' : (drawingPoints[i] || worldPoints[i]) ? 'partial' : 'empty')

    const dragControls = useDragControls()

    return (
        <motion.div
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
            drag dragControls={dragControls} dragListener={false} dragMomentum={false}
            className="fixed left-4 bottom-4 z-[205000] w-[380px] max-h-[85vh] flex flex-col rounded-xl glass shadow-2xl overflow-hidden"
        >
            <div
                className="flex items-center justify-between px-4 py-3 border-b border-[var(--speckle-outline-3)] shrink-0 cursor-move touch-none"
                onPointerDown={(e) => { if (!e.target.closest('button')) dragControls.start(e) }}
            >
                <div className="flex items-center gap-2 min-w-0">
                    <Crosshair className="w-4 h-4 text-[var(--speckle-foreground)] shrink-0" />
                    <h3 className="font-semibold text-sm text-[var(--speckle-foreground)] truncate">Align "{doc?.filename}"</h3>
                </div>
                <button onClick={onClose} className="p-1 hover:bg-[var(--speckle-outline-3)] rounded-lg transition-colors shrink-0">
                    <X className="w-4 h-4 text-[var(--speckle-foreground-3)]" />
                </button>
            </div>

            <p className="px-4 pt-3 text-[11px] text-[var(--speckle-foreground-3)]">
                Pick 2 matching points: once on the drawing below, once on the same spot in the 3D model behind this panel.
            </p>

            <div className="flex gap-2 px-4 pt-2">
                {[0, 1].map((i) => (
                    <button
                        key={i}
                        onClick={() => setPointIndex(i)}
                        className={`flex-1 text-[11px] px-2 py-1.5 rounded-lg border transition-colors ${
                            pointIndex === i ? 'border-blue-400 bg-blue-500/10 text-[var(--speckle-foreground)]' : 'border-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]'
                        }`}
                    >
                        {pointStatus(i) === 'done' ? <Check className="w-3 h-3 inline mr-1 text-emerald-400" /> : null}
                        Point {i + 1}
                        <span className="block text-[10px] opacity-70">
                            drawing {drawingPoints[i] ? '✓' : '—'} · 3D {worldPoints[i] ? '✓' : '—'}
                        </span>
                    </button>
                ))}
            </div>

            <div className="mx-4 mt-3 h-56 rounded-lg overflow-hidden border border-[var(--speckle-outline-3)] shrink-0">
                <DxfCanvas url={drawingUrl} pickModeActive onPickPoint={handlePickDrawingPoint} />
            </div>

            <div className="px-4 pt-3">
                <label className="text-[11px] text-[var(--speckle-foreground-3)]">Elevation (Z)</label>
                <input
                    type="number" step="any" value={elevationZ}
                    onChange={(e) => setElevationZ(e.target.value)}
                    placeholder="Defaults to the picked points' average Z"
                    className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg bg-[var(--speckle-foundation-page)] border border-[var(--speckle-outline-3)] text-[var(--speckle-foreground)]"
                />
            </div>

            {textureError && <p className="px-4 pt-2 text-[11px] text-red-400">{textureError}</p>}
            {saveError && <p className="px-4 pt-2 text-[11px] text-red-400">{saveError}</p>}

            <div className="px-4 py-3 mt-auto flex gap-2">
                <button
                    onClick={onClose}
                    className="flex-1 text-xs px-2 py-2 rounded-lg bg-[var(--speckle-outline-3)]/50 hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] transition-colors"
                >
                    Cancel
                </button>
                <button
                    onClick={handleSave}
                    disabled={!canSave || saving}
                    className="flex-1 flex items-center justify-center gap-1.5 text-xs px-2 py-2 rounded-lg bg-blue-500 hover:bg-blue-400 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
                >
                    {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    Save alignment
                </button>
            </div>
        </motion.div>
    )
}
