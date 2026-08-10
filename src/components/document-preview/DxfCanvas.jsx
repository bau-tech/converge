import { useEffect, useRef, useState } from 'react'
import { Color } from 'three'
import { DxfViewer } from 'dxf-viewer'
import DxfParseWorker from '../../utils/dxfViewerWorker.js?worker'
import { Loader2 } from 'lucide-react'

// WebGL/three.js-based DXF viewer, replacing an earlier hand-rolled canvas 2D
// renderer that only understood LINE/CIRCLE/ARC/POLYLINE/POINT/TEXT and had
// no support at all for layers, per-entity color, or hatches. dxf-viewer
// handles block instancing (INSERT/BLOCKS — the thing that made real-world
// exports look empty under the old renderer), per-layer/entity color, and
// hatch fills natively.
//
// Tradeoff: dxf-viewer depends on three@^0.161.0, while @speckle/viewer and
// IfcCanvas.jsx are pinned to three@0.140.2 — incompatible ranges, so this
// bundles a second three.js copy. That's a bundle-size cost only: this
// component and IfcCanvas.jsx/the main SpeckleViewer never share three.js
// objects across that version boundary, each owns its own renderer/scene.
//
// Fonts must be raw TTF (dxf-viewer's requirement) — text is silently not
// rendered without one. Bundles Roboto (Apache-2.0) from Google Fonts.
const FONT_URLS = ['/fonts/Roboto-Regular.ttf']

// pickModeActive/onPickPoint: drawing-alignment feature's calibration UI
// (AlignmentPanel.jsx) — while active, a pointerdown reports the click's
// TRUE (unshifted) modelspace {x, y} back to onPickPoint. dxf-viewer
// internally shifts its scene by -origin for float precision, so its own
// "position" (scene coords) must have GetOrigin() added back before it
// means anything to the alignment transform math (which works in real
// drawing/modelspace coordinates, matching what a saved transform's
// control_points and what the backend's ezdxf-based texture export both use).
export function DxfCanvas({ url, pickModeActive = false, onPickPoint }) {
    const containerRef = useRef(null)
    const [status, setStatus] = useState('loading') // loading | ready | error
    const [error, setError] = useState(null)
    const viewerRef = useRef(null)
    const onPickPointRef = useRef(onPickPoint)
    useEffect(() => { onPickPointRef.current = onPickPoint }, [onPickPoint])

    useEffect(() => {
        let cancelled = false
        let viewer = null

        async function load() {
            try {
                viewer = new DxfViewer(containerRef.current, {
                    clearColor: new Color('#1a1a1a'),
                    autoResize: true,
                    colorCorrection: true,
                    sceneOptions: { wireframeMesh: true },
                })
                // Load() fits the camera to the drawing's extents internally
                // once parsing/preparation finishes — no manual FitView needed.
                await viewer.Load({
                    url,
                    fonts: FONT_URLS,
                    workerFactory: () => new DxfParseWorker(),
                })
                if (cancelled) { viewer.Destroy(); viewer = null; return }
                viewerRef.current = viewer
                setStatus('ready')
            } catch (err) {
                if (!cancelled) { setError(err.message); setStatus('error') }
            }
        }

        load()

        return () => {
            cancelled = true
            viewerRef.current = null
            // Effect 2 below (pick-handler subscription) can also be tearing
            // down at the same time and its Unsubscribe() call reaches into
            // this same viewer's renderer — if Destroy() runs first, that
            // Unsubscribe() throws "WebGL renderer not available" on an
            // already-destroyed viewer. Uncaught, that error propagates past
            // this component (no ErrorBoundary wraps the floating alignment/
            // documents panels) and takes down the whole React tree.
            try { viewer?.Destroy() } catch (e) { console.warn('[DxfCanvas] Destroy error:', e) }
        }
    }, [url])

    useEffect(() => {
        const viewer = viewerRef.current
        if (!viewer || status !== 'ready' || !pickModeActive) return
        const handler = (e) => {
            const origin = viewer.GetOrigin()
            const { position } = e.detail
            onPickPointRef.current?.({ x: position.x + origin.x, y: position.y + origin.y })
        }
        viewer.Subscribe('pointerdown', handler)
        // See the Destroy() comment in the effect above — this can run after
        // that cleanup has already torn down the renderer.
        return () => { try { viewer.Unsubscribe('pointerdown', handler) } catch (e) { console.warn('[DxfCanvas] Unsubscribe error:', e) } }
    }, [status, pickModeActive])

    return (
        <div className="relative w-full h-full">
            <div ref={containerRef} className="w-full h-full" style={pickModeActive ? { cursor: 'crosshair' } : undefined} />
            {status === 'loading' && (
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-[var(--speckle-foreground-3)] pointer-events-none">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading DXF drawing…
                </div>
            )}
            {status === 'error' && (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-red-400 px-8 text-center pointer-events-none">
                    Could not preview this DXF file: {error}
                </div>
            )}
        </div>
    )
}
