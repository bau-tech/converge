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

export function DxfCanvas({ url }) {
    const containerRef = useRef(null)
    const [status, setStatus] = useState('loading') // loading | ready | error
    const [error, setError] = useState(null)

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
                setStatus('ready')
            } catch (err) {
                if (!cancelled) { setError(err.message); setStatus('error') }
            }
        }

        load()

        return () => {
            cancelled = true
            viewer?.Destroy()
        }
    }, [url])

    return (
        <div className="relative w-full h-full">
            <div ref={containerRef} className="w-full h-full" />
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
