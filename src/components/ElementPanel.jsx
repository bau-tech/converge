import { motion, AnimatePresence } from 'framer-motion'
import {
    X, ChevronDown, ChevronRight, Copy, Check, Filter, Eye, MoreHorizontal, Loader2,
    Paperclip, Link2, Unlink2, Plus, Search, FileText, Waypoints,
} from 'lucide-react'
import { useState, useEffect, useCallback } from 'react'
import { DocumentPreview } from './DocumentPreview'

// Recursive Key-Value Tree Component
const ObjectTreeItem = ({ data, label, depth = 0, path = '', onFilter, onCopy, isAutoWidth = false, activeFilter = null }) => {
    const [isOpen, setIsOpen] = useState(
        // Default open "properties", "Attributes", or top-level items
        depth === 0 || label === 'properties' || label === 'Attributes'
    )
    const [isHovered, setIsHovered] = useState(false)

    // Helper to get type label
    const getTypeLabel = (val) => {
        if (Array.isArray(val)) return `[${val.length}]`
        if (typeof val === 'object' && val !== null) return '{}'
        return ''
    }

    // Handle null/undefined
    if (data === null || data === undefined) {
        return (
            <div className="flex items-center gap-2 py-1 text-xs font- mono text-zinc-500 hover:bg-white/5 px-2 rounded group"
                style={{ paddingLeft: `${(depth * 12) + 8}px` }}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <span className="text-zinc-500">{label}</span>
                <span className="italic text-zinc-600">null</span>
            </div>
        )
    }

    // Handle Primitive Values
    if (typeof data !== 'object') {
        const strVal = String(data)
        const isUrl = strVal.startsWith('http')

        return (
            <div
                className="flex items-center justify-between py-1 text-xs font-mono hover:bg-white/5 rounded px-2 group transition-colors"
                style={{ paddingLeft: `${(depth * 12) + 8}px` }}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <div className="flex items-center gap-4 flex-1 overflow-hidden">
                    <span className="text-zinc-400 whitespace-nowrap">{label}</span>
                    <span className={`text-zinc-200 ${isAutoWidth ? 'break-all whitespace-normal' : 'truncate'}`} title={strVal}>{strVal}</span>
                </div>

                {/* Hover Actions */}
                <div className={`flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity`}>
                    <button
                        onClick={(e) => { e.stopPropagation(); onCopy(strVal); }}
                        aria-label={`Copy value: ${strVal}`}
                        className="p-1 hover:bg-white/10 rounded text-zinc-400 hover:text-white"
                        title="Copy value"
                    >
                        <Copy className="w-3 h-3" />
                    </button>
                    <button
                        onClick={(e) => { e.stopPropagation(); onFilter(path || label, data); }}
                        aria-label={activeFilter?.path === (path || label) && String(activeFilter.value) === String(data)
                            ? `Clear filter: ${label}`
                            : `Filter by ${label}: ${strVal}`}
                        aria-pressed={activeFilter?.path === (path || label) && String(activeFilter.value) === String(data)}
                        className={`p-1 rounded transition-colors ${
                            activeFilter?.path === (path || label) && String(activeFilter.value) === String(data)
                                ? 'bg-cyan-500/30 text-cyan-300'
                                : 'hover:bg-cyan-500/20 text-zinc-400 hover:text-cyan-400'
                        }`}
                        title={activeFilter?.path === (path || label) && String(activeFilter.value) === String(data)
                            ? 'Clear this filter'
                            : 'Filter 3D viewer by this value'}
                    >
                        <Filter className="w-3 h-3" />
                    </button>
                </div>
            </div>
        )
    }

    // Handle Objects / Arrays
    const itemCount = Array.isArray(data) ? data.length : Object.keys(data).length
    if (itemCount === 0) return null

    return (
        <div>
            <div
                className="flex items-center justify-between py-1 text-xs font-mono hover:bg-white/5 rounded px-2 cursor-pointer group select-none"
                style={{ paddingLeft: `${(depth * 12) + 8}px` }}
                onClick={() => setIsOpen(!isOpen)}
            >
                <div className="flex items-center gap-1">
                    {isOpen ? <ChevronDown className="w-3 h-3 text-zinc-500" /> : <ChevronRight className="w-3 h-3 text-zinc-500" />}
                    <span className="text-zinc-300 font-semibold">{label}</span>
                </div>
            </div>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        {Object.entries(data).map(([key, value]) => {
                            // Skip internal keys
                            if (key.startsWith('__') || key.startsWith('@')) return null
                            return (
                                <ObjectTreeItem
                                    key={key}
                                    label={key}
                                    data={value}
                                    depth={depth + 1}
                                    path={path ? `${path}.${key}` : key}
                                    onFilter={onFilter}
                                    onCopy={onCopy}
                                    isAutoWidth={isAutoWidth}
                                    activeFilter={activeFilter}
                                />
                            )
                        })}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

// Documents linked to the currently-selected element (bim_documents.linked_element,
// see db/documents.py) — list + attach/unlink. Keyed by speckleId from the caller so
// switching elements remounts this (clears any open picker/search) instead of racing
// a stale fetch against the new element's id.
function ElementDocumentsSection({ normalizerUrl, streamId, speckleId, onLinksChanged, darkMode, documentLinksVersion }) {
    const [docs, setDocs] = useState([])
    const [loading, setLoading] = useState(true)
    const [showPicker, setShowPicker] = useState(false)
    const [available, setAvailable] = useState([])
    const [loadingAvailable, setLoadingAvailable] = useState(false)
    const [search, setSearch] = useState('')
    const [busyId, setBusyId] = useState(null)
    const [previewDoc, setPreviewDoc] = useState(null)

    const base = (normalizerUrl || '').replace(/\/$/, '')

    const loadLinked = useCallback(async () => {
        if (!base || !streamId || !speckleId) { setDocs([]); setLoading(false); return }
        setLoading(true)
        try {
            const res = await fetch(`${base}/projects/${streamId}/documents?linked_element=${encodeURIComponent(speckleId)}`)
            setDocs(res.ok ? await res.json() : [])
        } catch {
            setDocs([])
        } finally {
            setLoading(false)
        }
    }, [
        base, streamId, speckleId,
        // Not read in the body — a pure "something changed elsewhere"
        // signal (App.jsx's refreshDocumentPins, e.g. a document deleted
        // from DocumentsPanel while this section is mounted but hidden
        // behind it) telling this to refetch even though speckleId itself
        // didn't change.
        documentLinksVersion,
    ])

    useEffect(() => { loadLinked() }, [loadLinked])

    const openPicker = async () => {
        setShowPicker(true)
        if (!base || !streamId) return
        setLoadingAvailable(true)
        try {
            const res = await fetch(`${base}/projects/${streamId}/documents`)
            const rows = res.ok ? await res.json() : []
            setAvailable(rows.filter((d) => !d.linked_element))
        } catch {
            setAvailable([])
        } finally {
            setLoadingAvailable(false)
        }
    }

    const linkDoc = async (docId) => {
        setBusyId(docId)
        try {
            await fetch(`${base}/projects/${streamId}/documents/${docId}/link-element`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ speckle_id: speckleId }),
            })
            setShowPicker(false)
            setSearch('')
            await loadLinked()
            onLinksChanged?.()
        } finally {
            setBusyId(null)
        }
    }

    const unlinkDoc = async (docId) => {
        setBusyId(docId)
        try {
            await fetch(`${base}/projects/${streamId}/documents/${docId}/link-element`, { method: 'DELETE' })
            await loadLinked()
            onLinksChanged?.()
        } finally {
            setBusyId(null)
        }
    }

    if (!streamId) return null

    const filteredAvailable = available.filter((d) => d.filename.toLowerCase().includes(search.toLowerCase()))

    return (
        <div className={`px-4 py-3 border-b ${darkMode ? 'border-[#333]' : 'border-gray-200'}`}>
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-400">
                    <Paperclip className="w-3.5 h-3.5" />
                    Documents {docs.length > 0 && `(${docs.length})`}
                </div>
                <button
                    onClick={openPicker}
                    className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300"
                    title="Attach a document to this element"
                >
                    <Plus className="w-3 h-3" /> Attach
                </button>
            </div>

            {loading && (
                <div className="flex items-center gap-2 text-xs text-zinc-500 py-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                </div>
            )}

            {!loading && docs.length === 0 && (
                <div className="text-[11px] text-zinc-600 italic py-1">No documents attached</div>
            )}

            <div className="space-y-1">
                {docs.map((d) => (
                    <div key={d.doc_id} className="flex items-center justify-between gap-2 text-xs bg-white/5 rounded px-2 py-1.5 group">
                        <button
                            onClick={() => setPreviewDoc(d)}
                            className="flex items-center gap-1.5 min-w-0 text-left"
                            title={`View ${d.filename}`}
                        >
                            <FileText className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                            <span className="truncate text-zinc-300">{d.filename}</span>
                        </button>
                        <div className="flex items-center gap-2 shrink-0">
                            <button
                                onClick={() => setPreviewDoc(d)}
                                className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-cyan-400"
                                title="View document"
                            >
                                <Eye className="w-3 h-3" />
                            </button>
                            <button
                                onClick={() => unlinkDoc(d.doc_id)}
                                disabled={busyId === d.doc_id}
                                className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 disabled:opacity-50"
                                title="Unlink document"
                            >
                                {busyId === d.doc_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Unlink2 className="w-3 h-3" />}
                            </button>
                        </div>
                    </div>
                ))}
            </div>

            <AnimatePresence>
                {showPicker && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                    >
                        <div className="mt-2 border border-white/10 rounded p-2">
                            <div className="flex items-center gap-1.5 bg-white/5 rounded px-2 py-1 mb-1.5">
                                <Search className="w-3 h-3 text-zinc-500 shrink-0" />
                                <input
                                    autoFocus
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    placeholder="Search documents…"
                                    className="bg-transparent text-[11px] text-zinc-300 outline-none flex-1 min-w-0"
                                />
                                <button onClick={() => setShowPicker(false)} className="text-zinc-500 hover:text-white shrink-0">
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                            <div className="max-h-40 overflow-y-auto custom-scrollbar space-y-0.5">
                                {loadingAvailable && (
                                    <div className="flex items-center gap-2 text-[11px] text-zinc-500 py-1">
                                        <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                                    </div>
                                )}
                                {!loadingAvailable && filteredAvailable.length === 0 && (
                                    <div className="text-[11px] text-zinc-600 italic py-1">
                                        {available.length === 0 ? 'No unlinked documents in this project' : 'No matches'}
                                    </div>
                                )}
                                {filteredAvailable.map((d) => (
                                    <button
                                        key={d.doc_id}
                                        onClick={() => linkDoc(d.doc_id)}
                                        disabled={busyId === d.doc_id}
                                        className="w-full flex items-center gap-1.5 text-[11px] text-left px-2 py-1 rounded hover:bg-cyan-500/10 text-zinc-300 disabled:opacity-50"
                                    >
                                        {busyId === d.doc_id ? <Loader2 className="w-3 h-3 animate-spin shrink-0" /> : <Link2 className="w-3 h-3 text-zinc-500 shrink-0" />}
                                        <span className="truncate">{d.filename}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {previewDoc && (
                    <DocumentPreview
                        doc={previewDoc}
                        downloadUrl={`${base}/projects/${streamId}/documents/${previewDoc.doc_id}/download`}
                        dwgPreviewUrl={`${base}/projects/${streamId}/documents/${previewDoc.doc_id}/preview.dxf`}
                        onClose={() => setPreviewDoc(null)}
                    />
                )}
            </AnimatePresence>
        </div>
    )
}

export default function ElementPanel({ element, onClose, onFilter, darkMode = true, normalizerUrl, streamId, onDocumentLinksChanged, documentLinksVersion, hideDocuments = false, onOpenConnectivity }) {
    const [width, setWidth] = useState(400)
    const [isAutoWidth, setIsAutoWidth] = useState(false)
    const [isResizing, setIsResizing] = useState(false)
    const [copied, setCopied] = useState(false)
    // Track the currently-active property filter so the user can see what's applied
    const [activeFilter, setActiveFilter] = useState(null)   // { path, value }

    if (!element) return null

    const handleCopy = (text) => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    const handlePropertyFilter = (path, value) => {
        if (!onFilter) return
        // Toggle: clicking the same filter again clears it
        if (activeFilter?.path === path && String(activeFilter.value) === String(value)) {
            setActiveFilter(null)
            onFilter({})   // empty → App clears filter
        } else {
            setActiveFilter({ path, value })
            onFilter({ [path]: value })
        }
    }

    const startResizing = (e) => {
        e.preventDefault()
        setIsResizing(true)

        const startX = e.clientX
        const startWidth = typeof width === 'number' ? width : 400 // Fallback if auto

        const handleMouseMove = (moveEvent) => {
            const newWidth = startWidth + (startX - moveEvent.clientX)
            const constrainedWidth = Math.max(300, Math.min(newWidth, window.innerWidth - 50))
            setWidth(constrainedWidth)
            setIsAutoWidth(false) // Dragging always exits auto mode
        }

        const handleMouseUp = () => {
            setIsResizing(false)
            document.removeEventListener('mousemove', handleMouseMove)
            document.removeEventListener('mouseup', handleMouseUp)
        }

        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', handleMouseUp)
    }

    const toggleAutoWidth = () => {
        if (isAutoWidth) {
            setWidth(400)
            setIsAutoWidth(false)
        } else {
            setWidth('auto') // Will need CSS adjustment
            setIsAutoWidth(true)
        }
    }

    // Organize Top-Level Props standard to Speckle
    const topLevelProps = {
        id: element.id,
        name: element.name || 'Unnamed',
        speckle_type: element.speckle_type ? element.speckle_type.split('.').pop() : 'Unknown',
        category: element.category,
        family: element.family,
        type: element.type
    }

    // The rest of the properties
    const propertyData = element.raw_properties || element.properties || {}
    // If we have raw_properties, we might want to merge or prioritize. 
    // Usually 'properties' is the main bag.

    return (
        <motion.div
            initial={{ x: 400, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 400, opacity: 0 }}
            transition={{ duration: isResizing ? 0 : 0.3 }} // Disable transition during drag
            // minWidth as a plain 300px conflicts with maxWidth: 90vw on any
            // screen narrower than ~333px (min-width wins over a smaller
            // max-width per the CSS spec), forcing a small overflow on
            // phones — min(300px, calc(100vw - 2rem)) lets the floor itself
            // shrink instead of fighting the cap.
            style={{
                width: isAutoWidth ? 'fit-content' : width,
                minWidth: 'min(300px, calc(100vw - 2rem))',
                maxWidth: isAutoWidth ? '60vw' : '90vw',
            }}
            // z-[245]: above the viewer toolbar, which despite declaring z-[200] in
            // ViewerToolbar.jsx actually renders at z-[240] globally — SpeckleViewer.jsx
            // portals the whole toolbar to document.body inside its own fixed-position
            // wrapper set to z-[240], and ViewerToolbar's own z-[200] only orders things
            // *within* that portal's stacking context, not against page content like
            // this panel. Must stay above that real 240, not the nominal 200.
            className={`fixed right-0 top-0 bottom-0 shadow-2xl z-[245] flex flex-col border-l
                ${darkMode ? 'bg-[#1e1e1e] border-[#333]' : 'bg-white border-gray-200'}
            `}
        >
            {/* Resize Handle */}
            <div
                className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-cyan-500/50 transition-colors z-10"
                onMouseDown={startResizing}
                onDoubleClick={toggleAutoWidth}
                title="Drag to resize, Double-click to auto-adjust"
            />

            {/* Header - "Selected" style from screenshot */}
            <div className={`flex items-center justify-between px-4 py-3 border-b ${darkMode ? 'border-[#333] bg-[#252526]' : 'border-gray-200 bg-gray-50'}`}>
                <h2 className={`font-semibold text-sm ${darkMode ? 'text-white' : 'text-gray-900'}`}>Selected</h2>
                <div className="flex items-center gap-3">
                    <button className="text-zinc-400 hover:text-white transition-colors" title="Isolate" aria-label="Isolate element in viewer">
                        <Eye className="w-4 h-4" />
                    </button>
                    <button className="text-zinc-400 hover:text-white transition-colors" title="Filter Selection" aria-label="Filter by selection">
                        <Filter className="w-4 h-4" />
                    </button>
                    <button className="text-zinc-400 hover:text-white transition-colors" title="More" aria-label="More options" aria-haspopup="true">
                        <MoreHorizontal className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => onOpenConnectivity?.(element)}
                        disabled={!element?.element_id}
                        className="text-zinc-400 hover:text-amber-400 disabled:opacity-30 disabled:hover:text-zinc-400 transition-colors"
                        title="Show connectivity graph"
                        aria-label="Show connectivity graph"
                    >
                        <Waypoints className="w-4 h-4" />
                    </button>
                    <div className="w-px h-4 bg-zinc-700 mx-1"></div>
                    <button onClick={onClose} aria-label="Close panel" className="text-zinc-400 hover:text-red-400 transition-colors">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Top Level Summary (Always visible) */}
            <div className={`px-4 py-3 border-b ${darkMode ? 'border-[#333]' : 'border-gray-200'}`}>
                <div className="flex items-center gap-2 mb-2">
                    <ChevronDown className="w-4 h-4 text-zinc-500" />
                    <span className="font-semibold text-sm text-white">{topLevelProps.category || topLevelProps.speckle_type}</span>
                </div>

                {/* Fixed Top Properties Table Style */}
                <div className="space-y-1 ml-6">
                    {Object.entries(topLevelProps).map(([key, val]) => {
                        if (!val) return null
                        return (
                            <div key={key} className="flex justify-between text-xs font-mono group">
                                <span className="text-zinc-500 w-1/3">{key}</span>
                                <div className="flex-1 flex justify-between items-center overflow-hidden">
                                    <span className={`truncate text-zinc-300 ${key === 'id' ? 'font-mono text-zinc-400' : ''}`} title={val}>
                                        {val}
                                    </span>
                                    <button
                                        onClick={() => handleCopy(val)}
                                        aria-label={`Copy ${key} value`}
                                        className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-white p-0.5"
                                    >
                                        <Copy className="w-3 h-3" />
                                    </button>
                                </div>
                            </div>
                        )
                    })}
                </div>
            </div>

            {/* Every route in routers/documents.py requires a login server-side —
                skip rendering (and thus fetching) for anonymous share visitors
                rather than show a section that can only ever 401. */}
            {!hideDocuments && (
            <ElementDocumentsSection
                key={element.id}
                normalizerUrl={normalizerUrl}
                streamId={streamId}
                speckleId={element.id}
                onLinksChanged={onDocumentLinksChanged}
                darkMode={darkMode}
                documentLinksVersion={documentLinksVersion}
            />
            )}

            {/* Active filter indicator */}
            {activeFilter && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-cyan-500/10 border-b border-cyan-500/20 text-[11px]">
                    <Filter className="w-3 h-3 text-cyan-400 shrink-0" />
                    <span className="text-cyan-300 font-mono truncate flex-1">
                        {activeFilter.path} = <span className="text-white">{String(activeFilter.value)}</span>
                    </span>
                    <button
                        onClick={() => { setActiveFilter(null); onFilter && onFilter({}) }}
                        aria-label="Clear active property filter"
                        className="text-cyan-500 hover:text-white transition-colors shrink-0"
                        title="Clear filter"
                    >
                        <X className="w-3 h-3" />
                    </button>
                </div>
            )}

            {/* Scrollable Tree Content */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
                {/* Loading state while parameters are being fetched */}
                {!element.properties && (
                    <div className="flex items-center gap-2 px-3 py-4 text-zinc-500 text-xs">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Loading properties…
                    </div>
                )}
                {/* Render full properties tree */}
                {element.properties && Object.entries(element.properties).map(([pset, vals]) => (
                    <ObjectTreeItem
                        key={pset}
                        label={pset}
                        data={vals}
                        depth={0}
                        onFilter={handlePropertyFilter}
                        activeFilter={activeFilter}
                        onCopy={handleCopy}
                        isAutoWidth={isAutoWidth}
                    />
                ))}
                {/* Fallback for legacy raw properties shape */}
                {!element.properties && propertyData && Object.keys(propertyData).length > 0 && (
                    <ObjectTreeItem
                        label="properties"
                        data={propertyData}
                        depth={0}
                        onFilter={handlePropertyFilter}
                        activeFilter={activeFilter}
                        onCopy={handleCopy}
                        isAutoWidth={isAutoWidth}
                    />
                )}

                {/* Render any additional data bags if they exist at root */}
                {element.quantities && (
                    <ObjectTreeItem
                        label="Quantities"
                        data={element.quantities}
                        depth={0}
                        onFilter={handlePropertyFilter}
                        activeFilter={activeFilter}
                        onCopy={handleCopy}
                        isAutoWidth={isAutoWidth}
                    />
                )}
                {element.materials && element.materials.length > 0 && (
                    <ObjectTreeItem
                        label="Materials"
                        data={element.materials}
                        depth={0}
                        onFilter={handlePropertyFilter}
                        activeFilter={activeFilter}
                        onCopy={handleCopy}
                        isAutoWidth={isAutoWidth}
                    />
                )}
            </div>

            {/* Element Count Footer */}
            <div className={`px-4 py-1.5 border-t text-[10px] flex justify-between items-center ${darkMode ? 'border-[#333] bg-[#252526] text-zinc-500' : 'bg-gray-50 text-gray-500'}`}>
                <span>@elements</span>
                <span>(0)</span>
            </div>

            {copied && (
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="absolute bottom-10 left-1/2 -translate-x-1/2 bg-zinc-900 text-white text-xs px-3 py-1.5 rounded-full border border-white/10 flex items-center gap-2"
                >
                    <Check className="w-3 h-3 text-green-400" />
                    Copied to clipboard
                </motion.div>
            )}
        </motion.div>
    )
}
