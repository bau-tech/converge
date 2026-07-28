// Thin worker entry point for dxf-viewer's off-main-thread DXF parsing —
// mirrors the package's own documented usage (see vagran/dxf-viewer-example-src),
// imported by DxfCanvas.jsx via Vite's native `?worker` module worker syntax.
import { DxfViewer } from 'dxf-viewer'

DxfViewer.SetupWorker()
