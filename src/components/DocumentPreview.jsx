import { motion } from 'framer-motion'
import { X, FileText, Download } from 'lucide-react'
import { IfcCanvas } from './document-preview/IfcCanvas'
import { DxfCanvas } from './document-preview/DxfCanvas'
import { DocxCanvas } from './document-preview/DocxCanvas'
import { XlsxCanvas } from './document-preview/XlsxCanvas'

function extOf(filename) {
    const m = /\.([a-z0-9]+)$/i.exec(filename || '')
    return m ? m[1].toLowerCase() : ''
}

// Nested full-screen overlay on top of DocumentsPanel — same stacking
// pattern as ViewpointMarkupEditor over BcfKanbanBoard, just one tier
// higher (z-[211000] vs. its z-[210000]) so the two don't tie if a future
// cross-panel trigger ever let both parents be open at once — today
// showBcfBoard/showDocuments are independent flags with no code path that
// opens both, but nothing enforces that, so the tie was a latent bug.
export function DocumentPreview({ doc, downloadUrl, dwgPreviewUrl, onClose }) {
    const ext = extOf(doc?.filename)
    const isPdf = ext === 'pdf' || doc?.mime_type === 'application/pdf'
    const isIfc = ext === 'ifc'
    const isDxf = ext === 'dxf'
    // No free/open library renders DWG directly — dwgPreviewUrl points at a
    // backend route that converts it to DXF server-side (LibreDWG's
    // dwg2dxf), then it's rendered by the same DxfCanvas as a native .dxf.
    const isDwg = ext === 'dwg'
    const isDocx = ext === 'docx'
    const isXlsx = ext === 'xlsx' || ext === 'xls'
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)
    const isText = ext === 'txt' || ext === 'md'

    return (
        <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[211000] flex flex-col"
            style={{ backgroundColor: 'var(--speckle-foundation-page)' }}
        >
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--speckle-outline-3)] shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                    <FileText className="w-5 h-5 text-[var(--speckle-foreground)] shrink-0" />
                    <h2 className="font-semibold text-sm text-[var(--speckle-foreground)] truncate">{doc?.filename}</h2>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <a
                        href={downloadUrl}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground)] transition-colors"
                    >
                        <Download className="w-3.5 h-3.5" /> Download
                    </a>
                    <button onClick={onClose} className="p-1.5 hover:bg-[var(--speckle-outline-3)] rounded-lg transition-colors">
                        <X className="w-4 h-4 text-[var(--speckle-foreground-3)]" />
                    </button>
                </div>
            </div>

            <div className="flex-1 min-h-0">
                {isPdf && (
                    <iframe
                        src={`${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}inline=true`}
                        title={doc?.filename}
                        className="w-full h-full border-0"
                    />
                )}
                {isIfc && <IfcCanvas url={downloadUrl} />}
                {isDxf && <DxfCanvas url={downloadUrl} />}
                {isDwg && <DxfCanvas url={dwgPreviewUrl} />}
                {isDocx && <DocxCanvas url={downloadUrl} />}
                {isXlsx && <XlsxCanvas url={downloadUrl} />}
                {isImage && (
                    <div className="w-full h-full flex items-center justify-center overflow-auto p-4">
                        <img
                            src={`${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}inline=true`}
                            alt={doc?.filename}
                            className="max-w-full max-h-full object-contain"
                        />
                    </div>
                )}
                {isText && (
                    <iframe
                        src={`${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}inline=true`}
                        title={doc?.filename}
                        className="w-full h-full border-0"
                    />
                )}
                {!isPdf && !isIfc && !isDxf && !isDwg && !isDocx && !isXlsx && !isImage && !isText && (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-sm text-[var(--speckle-foreground-3)]">
                        <FileText className="w-8 h-8 text-[var(--speckle-foreground-disabled)]" />
                        <p>No preview available for this file type.</p>
                        <p className="text-xs text-[var(--speckle-foreground-disabled)]">Supported previews: PDF, IFC, DXF, DWG, DOCX, XLSX/XLS, images, TXT/MD</p>
                    </div>
                )}
            </div>
        </motion.div>
    )
}
