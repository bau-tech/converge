import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import {
    X, Upload, FileText, Trash2, ChevronLeft, Check, History, Download, ShieldCheck, Eye, UploadCloud, GitBranch, Ruler,
    LayoutGrid, List, Folder, FolderPlus, Pencil, Info, Tag,
} from 'lucide-react'
import { DocumentPreview } from './DocumentPreview'
import { SpeckleModelsList } from './SpeckleModelsList'
import { useAuth } from '../contexts/AuthContext'
import { SUITABILITY_CODES, SUITABILITY_COLOR } from '../utils/suitabilityCodes'

// ISO 19650 filename convention template shown near the upload control —
// purely informational, never validated/blocked client-side (see
// bim-normalizer/naming/iso19650.py for the actual advisory check).
const NAMING_TEMPLATE = 'PROJECT-ORIGINATOR-VOLUME-LEVEL-TYPE-ROLE-NUMBER'

const PREVIEWABLE_EXT = new Set(['pdf', 'ifc', 'dxf', 'dwg', 'docx', 'xlsx', 'xls', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'txt', 'md'])
function isPreviewable(filename) {
    const m = /\.([a-z0-9]+)$/i.exec(filename || '')
    return m ? PREVIEWABLE_EXT.has(m[1].toLowerCase()) : false
}

const COLUMNS = ['WIP', 'Shared', 'Published', 'Archived']
// Mirrors bim-normalizer/nextcloud/groupfolders.py's STATUS_FOLDERS — needed
// to derive a document's subfolder from its nc_path client-side (see
// docFolderPath below), since folder placement isn't its own DB column.
const STATUS_SUBFOLDER = { WIP: '01_WIP', Shared: '02_Shared', Published: '03_Published', Archived: '04_Archived' }

// A document's subfolder, relative to its status root — '' means it sits
// directly in the status root (no folder). Derived on demand from nc_path
// rather than stored, so this feature needed zero schema/migration.
function docFolderPath(doc) {
    const prefix = `${doc.nc_group_folder}/${STATUS_SUBFOLDER[doc.status]}/`
    if (!doc.nc_path || !doc.nc_path.startsWith(prefix)) return ''
    const remainder = doc.nc_path.slice(prefix.length)
    const idx = remainder.lastIndexOf('/')
    return idx === -1 ? '' : remainder.slice(0, idx)
}

const COLUMN_COLOR = {
    WIP: { border: 'border-zinc-400/50', bg: 'bg-zinc-400/10', text: 'text-zinc-300', badge: 'bg-zinc-400/20 text-zinc-200' },
    Shared: { border: 'border-blue-500/50', bg: 'bg-blue-500/10', text: 'text-blue-300', badge: 'bg-blue-500/25 text-blue-300' },
    Published: { border: 'border-emerald-500/50', bg: 'bg-emerald-500/10', text: 'text-emerald-300', badge: 'bg-emerald-500/25 text-emerald-300' },
    Archived: { border: 'border-[var(--speckle-outline-3)]', bg: 'bg-[var(--speckle-outline-3)]/20', text: 'text-[var(--speckle-foreground-3)]', badge: 'bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]' },
}

// ISO 19650 gate per forward transition: WIP->Shared is "review" (approval),
// Shared->Published is "approve" (authorisation), Published->Archived is
// "verify" (verification) — see bim-normalizer/routers/documents.py.
const GATE_ENDPOINT = { Shared: 'review', Published: 'approve', Archived: 'verify' }
const GATE_LABEL = { Shared: 'Review & Share', Published: 'Approve & Publish', Archived: 'Verify & Archive' }
const GATE_ROLES = { Shared: ['author', 'reviewer', 'approver'], Published: ['approver'], Archived: ['approver'] }
// The bim_documents flag that GATE_ENDPOINT[status] sets — lets bulk-move
// (below) tell whether a doc still needs that gate before it can land on
// `status`, without a round-trip to the server first.
const READY_FLAG = { Shared: 'reviewed', Published: 'approved', Archived: 'verified' }

function formatSize(bytes) {
    if (!bytes && bytes !== 0) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function Column({ id, title, count, children, emptyLabel = 'No documents', viewMode = 'grid' }) {
    const { setNodeRef, isOver } = useDroppable({ id })
    const colors = COLUMN_COLOR[title]
    return (
        <div
            ref={setNodeRef}
            className={`flex flex-col gap-2 flex-1 ${viewMode === 'list' ? 'min-w-[320px]' : 'min-w-[240px]'} rounded-xl border-2 p-3 transition-colors ${
                isOver ? 'border-amber-400/80 bg-amber-400/15' : `${colors.border} ${colors.bg}`
            }`}
        >
            <div className="flex items-center justify-between px-1 shrink-0">
                <h3 className={`text-xs font-bold uppercase tracking-wider ${colors.text}`}>{title}</h3>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${colors.badge}`}>{count}</span>
            </div>
            <div className="flex flex-col gap-2 overflow-y-auto flex-1 min-h-[120px] pr-0.5">
                {children}
                {count === 0 && (
                    <div className="text-[11px] text-[var(--speckle-foreground-disabled)] text-center py-6">{emptyLabel}</div>
                )}
            </div>
        </div>
    )
}

function CardContent({ doc, thumbUrl, downloadUrl, onDelete, canDelete, onGate, pendingGate, canGate, grabbing, versionLabel, selected, onCardClick }) {
    return (
        <div className={`glass-card p-0 overflow-hidden group ${grabbing ? 'cursor-grabbing shadow-2xl' : 'cursor-grab'} ${selected ? 'ring-2 ring-amber-400' : ''}`}>
            <div
                className="aspect-video bg-[var(--speckle-outline-3)] flex items-center justify-center overflow-hidden"
                onClick={e => onCardClick?.(doc, e)}
            >
                {thumbUrl
                    ? <img src={thumbUrl} className="w-full h-full object-cover" alt="" />
                    : <FileText className="w-6 h-6 text-[var(--speckle-foreground-disabled)]" />}
            </div>
            <div className="p-2.5" onClick={e => onCardClick?.(doc, e)}>
                <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-medium text-[var(--speckle-foreground)] line-clamp-2 break-all">{doc.filename}</p>
                    <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        {downloadUrl && (
                            <a
                                href={downloadUrl}
                                onPointerDown={e => e.stopPropagation()}
                                onClick={e => e.stopPropagation()}
                                className="text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)]"
                                title="Download"
                            >
                                <Download className="w-3.5 h-3.5" />
                            </a>
                        )}
                        {canDelete && (
                            <button
                                onPointerDown={e => e.stopPropagation()}
                                onClick={e => { e.stopPropagation(); onDelete?.(doc) }}
                                className="text-[var(--speckle-foreground-3)] hover:text-red-400"
                                title="Delete"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                    <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]">{formatSize(doc.size_bytes)}</span>
                    {doc.revision > 1 && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-300">rev {doc.revision}</span>
                    )}
                    {doc.approved
                        ? <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300 flex items-center gap-0.5"><ShieldCheck className="w-2.5 h-2.5" /> Approved</span>
                        : <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]">Not approved</span>}
                    {versionLabel && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] flex items-center gap-0.5" title={versionLabel.tooltip}>
                            <History className="w-2.5 h-2.5" /> {versionLabel.short}
                        </span>
                    )}
                </div>
                {pendingGate && canGate && (
                    <button
                        onPointerDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); onGate?.(doc) }}
                        className="mt-2 w-full flex items-center justify-center gap-1 text-[10px] px-2 py-1.5 rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors"
                    >
                        <Check className="w-3 h-3" /> {pendingGate}
                    </button>
                )}
            </div>
        </div>
    )
}

function ListRowContent({ doc, thumbUrl, downloadUrl, onDelete, canDelete, onGate, pendingGate, canGate, grabbing, versionLabel, selected, onCardClick }) {
    return (
        <div className={`glass-card p-2 flex items-center gap-3 group ${grabbing ? 'cursor-grabbing shadow-2xl' : 'cursor-grab'} ${selected ? 'ring-2 ring-amber-400' : ''}`}>
            <div
                className="w-9 h-9 shrink-0 rounded bg-[var(--speckle-outline-3)] flex items-center justify-center overflow-hidden"
                onClick={e => onCardClick?.(doc, e)}
            >
                {thumbUrl
                    ? <img src={thumbUrl} className="w-full h-full object-cover" alt="" />
                    : <FileText className="w-4 h-4 text-[var(--speckle-foreground-disabled)]" />}
            </div>
            <div className="flex-1 min-w-0 flex items-center gap-2" onClick={e => onCardClick?.(doc, e)}>
                <p className="text-xs font-medium text-[var(--speckle-foreground)] truncate">{doc.filename}</p>
                <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] shrink-0">{formatSize(doc.size_bytes)}</span>
                {doc.revision > 1 && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 shrink-0">rev {doc.revision}</span>
                )}
                {doc.approved
                    ? <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300 flex items-center gap-0.5 shrink-0"><ShieldCheck className="w-2.5 h-2.5" /> Approved</span>
                    : <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] shrink-0">Not approved</span>}
                {versionLabel && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] flex items-center gap-0.5 shrink-0" title={versionLabel.tooltip}>
                        <History className="w-2.5 h-2.5" /> {versionLabel.short}
                    </span>
                )}
            </div>
            {pendingGate && canGate && (
                <button
                    onPointerDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); onGate?.(doc) }}
                    className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors shrink-0"
                >
                    <Check className="w-3 h-3" /> {pendingGate}
                </button>
            )}
            <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                {downloadUrl && (
                    <a
                        href={downloadUrl}
                        onPointerDown={e => e.stopPropagation()}
                        onClick={e => e.stopPropagation()}
                        className="text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)]"
                        title="Download"
                    >
                        <Download className="w-3.5 h-3.5" />
                    </a>
                )}
                {canDelete && (
                    <button
                        onPointerDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); onDelete?.(doc) }}
                        className="text-[var(--speckle-foreground-3)] hover:text-red-400"
                        title="Delete"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>
        </div>
    )
}

function Card({ doc, thumbUrl, downloadUrl, onDelete, canDelete, onGate, pendingGate, canGate, viewMode = 'grid', versionLabel, selected, onCardClick }) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: doc.doc_id })
    const Content = viewMode === 'list' ? ListRowContent : CardContent
    return (
        <div ref={setNodeRef} {...listeners} {...attributes} className={isDragging ? 'opacity-30' : ''}>
            <Content
                doc={doc} thumbUrl={thumbUrl} downloadUrl={downloadUrl}
                onDelete={onDelete} canDelete={canDelete} onGate={onGate} pendingGate={pendingGate} canGate={canGate}
                versionLabel={versionLabel} selected={selected} onCardClick={onCardClick}
            />
        </div>
    )
}

// Full-screen document workflow overlay — mirrors BcfKanbanBoard.jsx's
// layout (fixed inset-0 + 360px detail drawer), not IdsCheckPanel's
// right-docked drawer, since this is a multi-column board like the BCF one.
export function DocumentsPanel({ streamId, normalizerUrl, serverUrl, serverToken, onClose, onLoadModel, onDocumentsChanged, activeModelId }) {
    const base = (normalizerUrl || '').replace(/\/$/, '')
    const { user } = useAuth()
    const [activeTab, setActiveTab] = useState('documents') // 'documents' | 'drawings' | 'models'
    const [viewMode, setViewMode] = useState('grid') // 'grid' | 'list' — applies to documents & drawings tabs
    const [documents, setDocuments] = useState([])
    // model_id -> {branch_name, commit_id, ingested_at} for every ingested
    // model in this project — lets the Drawings tab group by branch ("model")
    // while still knowing which specific version each drawing belongs to.
    // Not a picker (removed — see git history): read-only lookup only.
    const [modelsById, setModelsById] = useState({})
    const [thumbs, setThumbs] = useState({})
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [uploading, setUploading] = useState(false)
    const [selectedDoc, setSelectedDoc] = useState(null)
    const [activeDoc, setActiveDoc] = useState(null)
    const [myRoles, setMyRoles] = useState([])
    const [pendingGate, setPendingGate] = useState(null) // {docId, targetStatus}
    const [versions, setVersions] = useState([])
    const [previewDoc, setPreviewDoc] = useState(null)
    const [confirmDeleteDoc, setConfirmDeleteDoc] = useState(null)
    const [deleting, setDeleting] = useState(false)
    const [isDraggingFile, setIsDraggingFile] = useState(false)
    const [modelsUploading, setModelsUploading] = useState(false)
    // Folder navigation — ONE shared path across all 4 status columns (a
    // folder spans the whole workflow, not 4 independent trees; see
    // docFolderPath above and create_folder in routers/documents.py).
    const [folderPath, setFolderPath] = useState('')
    const [subfolders, setSubfolders] = useState([])
    const [newFolderPrompt, setNewFolderPrompt] = useState(false)
    const [newFolderName, setNewFolderName] = useState('')
    const [creatingFolder, setCreatingFolder] = useState(false)
    // Rename targets the folder *name* being edited (a direct child of the
    // currently-browsed folderPath — never folderPath itself), so no
    // adjustment to folderPath is ever needed on success.
    const [renameFolderTarget, setRenameFolderTarget] = useState(null)
    const [renameFolderValue, setRenameFolderValue] = useState('')
    const [renamingFolder, setRenamingFolder] = useState(false)
    const [deleteFolderTarget, setDeleteFolderTarget] = useState(null)
    const [deletingFolder, setDeletingFolder] = useState(false)
    // Bulk move: shift-click extends a range within a column, ctrl/cmd-click
    // toggles one doc, both without opening the detail drawer (see
    // handleCardClick below). Dragging any selected card then moves the
    // whole selection together (handleDragEnd), and the toolbar bar (below
    // the folder breadcrumb) offers the same as explicit buttons for
    // discoverability. Either path funnels through bulkMoveTo, which calls
    // moveDocument one doc at a time — reusing the existing per-doc
    // gate/role/Nextcloud-move logic in routers/documents.py rather than a
    // dedicated bulk backend route, and sequentially (not Promise.all) so a
    // large selection doesn't hammer Nextcloud with a burst of concurrent
    // MOVEs.
    const [selectedIds, setSelectedIds] = useState(() => new Set())
    const [bulkMoving, setBulkMoving] = useState(false)
    const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
    const [bulkDeleting, setBulkDeleting] = useState(false)
    const selectionAnchorRef = useRef(null)
    const fileInputRef = useRef(null)
    const reviseInputRef = useRef(null)
    const modelsListRef = useRef(null)
    const dragCounterRef = useRef(0)

    // Any project role can upload/revise/delete/link; only reviewer/approver
    // can clear the WIP->Shared gate; only approver can authorise/verify.
    const canAct = myRoles.length > 0
    const canReview = myRoles.includes('reviewer') || myRoles.includes('approver')
    const canApprove = myRoles.includes('approver')
    const GATE_CAN = { Shared: canReview, Published: canApprove, Archived: canApprove }

    // Drawings and generic documents share one Kanban render (below) and one
    // underlying `documents` fetch — split here by doc_type rather than a
    // separate endpoint/state, since bim_documents already carries it.
    // Drawings are additionally scoped to whichever *model* (Speckle branch)
    // is active in the main viewer — not the exact version. A drawing is
    // tagged with the specific version it was uploaded against (its
    // model_id), so re-ingesting a newer version of the same branch doesn't
    // make older drawings disappear; describeDrawingVersion (below) flags
    // them instead so they stay visible but visibly distinguishable.
    const wantDrawings = activeTab === 'drawings'
    const activeBranch = activeModelId ? modelsById[activeModelId]?.branch_name : undefined
    // Compares ingested_at, not just "is it the active model_id" — the
    // active version isn't guaranteed to be the newest one ingested (e.g.
    // the viewer can be pinned to an older commit), so the badge must say
    // which direction the difference actually goes rather than assuming.
    const describeDrawingVersion = d => {
        if (!d.model_id || d.model_id === activeModelId) return null
        const docModel = modelsById[d.model_id]
        const activeModel = activeModelId ? modelsById[activeModelId] : null
        const docDate = docModel?.ingested_at ? new Date(docModel.ingested_at) : null
        const activeDate = activeModel?.ingested_at ? new Date(activeModel.ingested_at) : null
        let short = 'different version'
        if (docDate && activeDate) short = docDate < activeDate ? 'older version' : 'newer version'
        const tooltip = docDate
            ? `From a ${short} of this model — ingested ${docDate.toLocaleDateString()}`
            : `From a different version of this model`
        return { short, tooltip }
    }
    const columns = COLUMNS.reduce((acc, status) => {
        acc[status] = documents.filter(d =>
            d.status === status &&
            ((d.doc_type || 'document') === 'drawing') === wantDrawings &&
            (!wantDrawings || !activeBranch || modelsById[d.model_id]?.branch_name === activeBranch) &&
            docFolderPath(d) === folderPath
        )
        return acc
    }, {})

    const loadDocuments = useCallback(async () => {
        if (!streamId || !base) return
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`${base}/projects/${streamId}/documents`)
            if (!res.ok) throw new Error(`Could not load documents (${res.status})`)
            setDocuments(await res.json())
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }, [streamId, base])

    useEffect(() => { loadDocuments() }, [loadDocuments])

    // A folderPath from a previous project would be meaningless (or worse,
    // coincidentally valid but wrong) after switching streams.
    useEffect(() => { setFolderPath('') }, [streamId])
    // Cards leave view on a tab/folder switch, so any selection made in the
    // previous view no longer corresponds to what's visible — drop it.
    useEffect(() => { setSelectedIds(new Set()) }, [activeTab, folderPath])

    const loadSubfolders = useCallback(async () => {
        if (!streamId || !base) return
        try {
            const res = await fetch(`${base}/projects/${streamId}/documents/folders?path=${encodeURIComponent(folderPath)}`)
            if (!res.ok) throw new Error(`Could not load folders (${res.status})`)
            setSubfolders((await res.json()).folders || [])
        } catch (err) {
            setError(err.message)
        }
    }, [streamId, base, folderPath])

    useEffect(() => { loadSubfolders() }, [loadSubfolders])

    useEffect(() => {
        if (!streamId || !base) return
        fetch(`${base}/projects/${streamId}/my-roles`)
            .then(res => res.ok ? res.json() : { roles: [] })
            .then(data => setMyRoles(data.roles || []))
            .catch(() => setMyRoles([]))
    }, [streamId, base])

    useEffect(() => {
        if (!streamId || !base) return
        fetch(`${base}/models/by-stream/${streamId}`)
            .then(res => res.ok ? res.json() : [])
            .then(data => setModelsById(Object.fromEntries(data.map(m => [m.model_id, m]))))
            .catch(() => setModelsById({}))
    }, [streamId, base])


    // Lazy-load each document's thumbnail once, tolerating 404 (no preview
    // available for CAD formats) by just leaving the icon fallback in place.
    useEffect(() => {
        const missing = documents.filter(d => !(d.doc_id in thumbs))
        if (missing.length === 0) return
        let cancelled = false
        missing.forEach(async d => {
            try {
                const res = await fetch(`${base}/projects/${streamId}/documents/${d.doc_id}/thumbnail`)
                if (!res.ok) { if (!cancelled) setThumbs(prev => ({ ...prev, [d.doc_id]: null })); return }
                const blob = await res.blob()
                if (!cancelled) setThumbs(prev => ({ ...prev, [d.doc_id]: URL.createObjectURL(blob) }))
            } catch {
                if (!cancelled) setThumbs(prev => ({ ...prev, [d.doc_id]: null }))
            }
        })
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [documents])

    // thumbs holds one URL.createObjectURL() blob URL per document, never
    // revoked — repeated open/close cycles of this panel (or documents
    // scrolling in/out) accumulated unreleased blob URLs for the life of
    // the tab. Revoke everything still outstanding on unmount; thumbsRef
    // mirrors state so this cleanup (registered once, on mount) always sees
    // the latest map instead of the empty one from its first render.
    const thumbsRef = useRef(thumbs)
    useEffect(() => { thumbsRef.current = thumbs }, [thumbs])
    useEffect(() => () => {
        Object.values(thumbsRef.current).forEach(url => { if (url) URL.revokeObjectURL(url) })
    }, [])

    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

    const uploadFile = async (file, { docType, modelId } = {}) => {
        const form = new FormData()
        form.append('file', file)
        if (docType) form.append('doc_type', docType)
        if (modelId) form.append('model_id', modelId)
        if (folderPath) form.append('folder_path', folderPath)
        const res = await fetch(`${base}/projects/${streamId}/documents/upload`, {
            method: 'POST', body: form,
        })
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.detail || `Upload failed for "${file.name}" (${res.status})`)
        }
        const doc = await res.json()
        setDocuments(prev => [...prev, doc])
    }

    const uploadFiles = async (files, opts) => {
        if (!files.length || !streamId) return
        if (opts?.docType === 'drawing' && !opts.modelId) {
            setError('No model loaded in the viewer — load a model before uploading a drawing')
            return
        }
        setUploading(true)
        setError(null)
        try {
            for (const file of files) {
                await uploadFile(file, opts)
            }
        } catch (err) {
            setError(err.message)
        } finally {
            setUploading(false)
        }
    }

    const uploadOptsForActiveTab = () =>
        activeTab === 'drawings' ? { docType: 'drawing', modelId: activeModelId } : undefined

    const handleUpload = (e) => {
        const files = Array.from(e.target.files || [])
        e.target.value = ''
        uploadFiles(files, uploadOptsForActiveTab())
    }

    const createFolder = async () => {
        const name = newFolderName.trim()
        if (!name) return
        setCreatingFolder(true)
        try {
            const res = await fetch(`${base}/projects/${streamId}/documents/folders`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parent_path: folderPath, name }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `Create folder failed (${res.status})`)
            }
            await loadSubfolders()
            setNewFolderPrompt(false)
        } catch (err) {
            setError(err.message)
        } finally {
            setCreatingFolder(false)
        }
    }

    const renameFolder = async () => {
        const newName = renameFolderValue.trim()
        if (!newName || !renameFolderTarget) return
        setRenamingFolder(true)
        try {
            const path = folderPath ? `${folderPath}/${renameFolderTarget}` : renameFolderTarget
            const res = await fetch(`${base}/projects/${streamId}/documents/folders/rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path, new_name: newName }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `Rename failed (${res.status})`)
            }
            await Promise.all([loadSubfolders(), loadDocuments()])
            setRenameFolderTarget(null)
        } catch (err) {
            setError(err.message)
        } finally {
            setRenamingFolder(false)
        }
    }

    const deleteFolder = async () => {
        if (!deleteFolderTarget) return
        setDeletingFolder(true)
        try {
            const path = folderPath ? `${folderPath}/${deleteFolderTarget}` : deleteFolderTarget
            const res = await fetch(`${base}/projects/${streamId}/documents/folders?path=${encodeURIComponent(path)}`, {
                method: 'DELETE',
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `Delete folder failed (${res.status})`)
            }
            await Promise.all([loadSubfolders(), loadDocuments()])
            setDeleteFolderTarget(null)
        } catch (err) {
            setError(err.message)
        } finally {
            setDeletingFolder(false)
        }
    }

    const handleDragEnter = (e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        dragCounterRef.current += 1
        setIsDraggingFile(true)
    }
    const handleDragOver = (e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
    }
    const handleDragLeave = (e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        dragCounterRef.current -= 1
        if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0
            setIsDraggingFile(false)
        }
    }
    const handleDrop = (e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        dragCounterRef.current = 0
        setIsDraggingFile(false)
        uploadFiles(Array.from(e.dataTransfer.files || []), uploadOptsForActiveTab())
    }

    const moveDocument = async (docId, status) => {
        const res = await fetch(`${base}/projects/${streamId}/documents/${docId}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
        })
        if (res.status === 409) return { needsGate: true }
        if (res.status === 403) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.detail || "You don't have permission to move this document")
        }
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.detail || `Move failed (${res.status})`)
        }
        const updated = await res.json()
        setDocuments(prev => prev.map(d => d.doc_id === docId ? updated : d))
        setSelectedDoc(prev => prev?.doc_id === docId ? updated : prev)
        return { needsGate: false }
    }

    const toggleSelected = (doc) => {
        setSelectedIds(prev => {
            const next = new Set(prev)
            if (next.has(doc.doc_id)) next.delete(doc.doc_id)
            else next.add(doc.doc_id)
            return next
        })
    }

    // File-explorer-style multi-select on the cards themselves, no separate
    // "select mode" toggle needed: shift-click extends a range from the last
    // clicked card (within the same column, since that's the only order the
    // board actually shows), ctrl/cmd-click toggles one card in/out. A plain
    // click keeps its existing job of opening the detail drawer, and clears
    // any selection first since opening one document implies "just this one".
    const handleCardClick = (doc, event) => {
        if (event.shiftKey && selectionAnchorRef.current) {
            const colDocs = columns[doc.status] || []
            const anchorIdx = colDocs.findIndex(d => d.doc_id === selectionAnchorRef.current)
            const targetIdx = colDocs.findIndex(d => d.doc_id === doc.doc_id)
            if (anchorIdx !== -1 && targetIdx !== -1) {
                const [lo, hi] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx]
                const rangeIds = colDocs.slice(lo, hi + 1).map(d => d.doc_id)
                setSelectedIds(prev => new Set([...prev, ...rangeIds]))
                return
            }
        }
        if (event.metaKey || event.ctrlKey) {
            selectionAnchorRef.current = doc.doc_id
            toggleSelected(doc)
            return
        }
        selectionAnchorRef.current = doc.doc_id
        setSelectedIds(new Set())
        openDoc(doc)
    }

    // Moves every id in `ids` (defaults to the current selection) to
    // `targetStatus`, one request at a time. For each doc that's exactly one
    // column behind the target and still missing the flag that column's
    // gate sets (READY_FLAG), this runs that gate first — same "Review &
    // Share"-style action the single-card button offers, just applied
    // across the whole batch instead of requiring a click per document.
    // Skipped when the user lacks the gating role, or when the doc is more
    // than one step behind (e.g. WIP straight to Published): those still go
    // through moveDocument and, if the server rejects them, end up in
    // `gated` below same as before. Docs that hit the 409 gate or fail
    // outright stay selected afterward so the user can see what still needs
    // attention — everything else is dropped from the selection.
    const bulkMoveTo = async (targetStatus, idsOverride) => {
        const candidateIds = idsOverride ?? Array.from(selectedIds)
        const ids = candidateIds.filter(id => documents.find(d => d.doc_id === id)?.status !== targetStatus)
        if (ids.length === 0 || bulkMoving) return
        setBulkMoving(true)
        setError(null)
        const gated = []
        const failed = []
        for (const id of ids) {
            const doc = documents.find(d => d.doc_id === id)
            try {
                const nextStatus = COLUMNS[COLUMNS.indexOf(doc.status) + 1]
                if (nextStatus === targetStatus && !doc[READY_FLAG[targetStatus]] && GATE_CAN[targetStatus]) {
                    const endpoint = GATE_ENDPOINT[targetStatus]
                    const res = await fetch(`${base}/projects/${streamId}/documents/${id}/${endpoint}`, { method: 'POST' })
                    if (res.ok) {
                        const gatedDoc = await res.json()
                        setDocuments(prev => prev.map(d => d.doc_id === id ? gatedDoc : d))
                    }
                }
                const { needsGate } = await moveDocument(id, targetStatus)
                if (needsGate) gated.push(id)
            } catch {
                failed.push(id)
            }
        }
        setBulkMoving(false)
        setSelectedIds(new Set([...gated, ...failed]))
        const movedCount = ids.length - gated.length - failed.length
        if (gated.length || failed.length) {
            const parts = []
            if (movedCount) parts.push(`${movedCount} moved to ${targetStatus}`)
            if (gated.length) parts.push(`${gated.length} need review/approval first`)
            if (failed.length) parts.push(`${failed.length} failed`)
            setError(parts.join(' — '))
        }
    }

    // Label reflects what bulkMoveTo will actually do for the current
    // selection — if at least one selected doc will get auto-gated on the
    // way, say so (mirrors GATE_LABEL's verb) rather than silently doing
    // more than the button says.
    const bulkButtonLabel = (status) => {
        const willAutoGate = Array.from(selectedIds).some(id => {
            const doc = documents.find(d => d.doc_id === id)
            if (!doc) return false
            const nextStatus = COLUMNS[COLUMNS.indexOf(doc.status) + 1]
            return nextStatus === status && !doc[READY_FLAG[status]] && GATE_CAN[status]
        })
        return willAutoGate ? `${GATE_LABEL[status].split(' & ')[0]} & Move to ${status}` : `Move to ${status}`
    }

    // Clears the gate for the document's *current* status (review while in
    // WIP, approve while in Shared, verify while in Published) without also
    // moving it — used by the detail drawer so a document can be gated
    // ahead of time, separate from actually dragging it to the next column.
    const clearGate = async (doc) => {
        const endpoint = GATE_ENDPOINT[COLUMNS[COLUMNS.indexOf(doc.status) + 1]]
        if (!endpoint) return
        const res = await fetch(`${base}/projects/${streamId}/documents/${doc.doc_id}/${endpoint}`, { method: 'POST' })
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.detail || `${endpoint} failed (${res.status})`)
        }
        const updated = await res.json()
        setDocuments(prev => prev.map(d => d.doc_id === doc.doc_id ? updated : d))
        setSelectedDoc(prev => prev?.doc_id === doc.doc_id ? updated : prev)
        return updated
    }

    // Sets the ISO 19650 "purpose of issue" suitability code — approver
    // only server-side, same error/state-update shape as clearGate above.
    const setSuitability = async (doc, code) => {
        const res = await fetch(`${base}/projects/${streamId}/documents/${doc.doc_id}/suitability`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        })
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.detail || `Setting suitability failed (${res.status})`)
        }
        const updated = await res.json()
        setDocuments(prev => prev.map(d => d.doc_id === doc.doc_id ? updated : d))
        setSelectedDoc(prev => prev?.doc_id === doc.doc_id ? updated : prev)
        return updated
    }

    // Runs the gate for `targetStatus` (review/approve/verify) then moves
    // the document into it — used both by the pending-gate prompt after a
    // drag-and-drop, and could be reused for a one-click "gate & move".
    const gateAndMove = async (doc, targetStatus) => {
        try {
            const endpoint = GATE_ENDPOINT[targetStatus]
            const res = await fetch(`${base}/projects/${streamId}/documents/${doc.doc_id}/${endpoint}`, { method: 'POST' })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `${endpoint} failed (${res.status})`)
            }
            const gated = await res.json()
            setDocuments(prev => prev.map(d => d.doc_id === doc.doc_id ? gated : d))
            await moveDocument(doc.doc_id, targetStatus)
            setPendingGate(null)
        } catch (err) {
            setError(err.message)
        }
    }

    const handleDragStart = (event) => {
        setActiveDoc(documents.find(d => d.doc_id === event.active.id) || null)
    }

    const handleDragEnd = async (event) => {
        setActiveDoc(null)
        const { active, over } = event
        if (!over) return
        const doc = documents.find(d => d.doc_id === active.id)
        if (!doc) return
        const targetStatus = over.id
        // Dragging a card that's part of a multi-selection moves the whole
        // selection together, via the same bulkMoveTo the toolbar buttons
        // use (including its auto-gate step) — dragging a card outside the
        // current selection is a normal single-doc move, same as before.
        if (selectedIds.has(doc.doc_id) && selectedIds.size > 1) {
            await bulkMoveTo(targetStatus, Array.from(selectedIds))
            return
        }
        if (doc.status === targetStatus) return
        try {
            const { needsGate } = await moveDocument(doc.doc_id, targetStatus)
            if (needsGate) setPendingGate({ docId: doc.doc_id, targetStatus })
        } catch (err) {
            setError(err.message)
        }
    }

    const removeDocument = async (doc) => {
        setDeleting(true)
        try {
            const res = await fetch(`${base}/projects/${streamId}/documents/${doc.doc_id}`, { method: 'DELETE' })
            if (!res.ok) throw new Error(`Delete failed (${res.status})`)
            setDocuments(prev => prev.filter(d => d.doc_id !== doc.doc_id))
            setThumbs(prev => {
                const { [doc.doc_id]: removedUrl, ...rest } = prev
                if (removedUrl) URL.revokeObjectURL(removedUrl)
                return rest
            })
            if (selectedDoc?.doc_id === doc.doc_id) setSelectedDoc(null)
            // A deleted document's linked_element (if any) is gone too — the
            // viewer's document-pin overlay only refreshes on its own
            // trigger points (App.jsx's model load / ElementPanel link
            // changes), neither of which fires from here, so it'd otherwise
            // keep showing a pin for a document that no longer exists.
            if (doc.linked_element) onDocumentsChanged?.()
        } catch (err) {
            setError(err.message)
        } finally {
            setDeleting(false)
            setConfirmDeleteDoc(null)
        }
    }

    // Deletes every selected document, one request at a time (same
    // sequential-not-Promise.all reasoning as bulkMoveTo above). Docs that
    // fail to delete stay selected afterward instead of being silently
    // dropped, so the failure is visible and retryable.
    const bulkDeleteSelected = async () => {
        const ids = Array.from(selectedIds)
        if (ids.length === 0 || bulkDeleting) return
        const anyLinked = ids.some(id => documents.find(d => d.doc_id === id)?.linked_element)
        setBulkDeleting(true)
        setError(null)
        const failed = []
        for (const id of ids) {
            try {
                const res = await fetch(`${base}/projects/${streamId}/documents/${id}`, { method: 'DELETE' })
                if (!res.ok) throw new Error()
                setDocuments(prev => prev.filter(d => d.doc_id !== id))
                setThumbs(prev => {
                    const { [id]: removedUrl, ...rest } = prev
                    if (removedUrl) URL.revokeObjectURL(removedUrl)
                    return rest
                })
                if (selectedDoc?.doc_id === id) setSelectedDoc(null)
            } catch {
                failed.push(id)
            }
        }
        setBulkDeleting(false)
        setConfirmBulkDelete(false)
        setSelectedIds(new Set(failed))
        if (failed.length) setError(`${failed.length} of ${ids.length} failed to delete`)
        if (anyLinked) onDocumentsChanged?.()
    }

    const openDoc = async (doc) => {
        setSelectedDoc(doc)
        setVersions([])
        try {
            const res = await fetch(`${base}/projects/${streamId}/documents/${doc.doc_id}/versions`)
            if (res.ok) setVersions(await res.json())
        } catch { /* version history is best-effort */ }
    }

    const handleRevise = async (e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file || !selectedDoc) return
        try {
            const form = new FormData()
            form.append('file', file)
            const res = await fetch(
                `${base}/projects/${streamId}/documents/${selectedDoc.doc_id}/revise`,
                { method: 'POST', body: form },
            )
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `Revise failed (${res.status})`)
            }
            const updated = await res.json()
            setDocuments(prev => prev.map(d => d.doc_id === updated.doc_id ? updated : d))
            setSelectedDoc(updated)
        } catch (err) {
            setError(err.message)
        }
    }

    return (
        <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200000] flex flex-col"
            style={{ backgroundColor: 'var(--speckle-foundation-page)' }}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {isDraggingFile && (
                <div className="absolute inset-0 z-[220000] flex flex-col items-center justify-center gap-3 bg-amber-500/10 border-4 border-dashed border-amber-400/70 pointer-events-none">
                    <UploadCloud className="w-12 h-12 text-amber-300" />
                    <p className="text-sm font-medium text-amber-200">Drop files to upload to WIP</p>
                </div>
            )}

            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--speckle-outline-3)] shrink-0">
                <div className="flex items-center gap-2">
                    <FileText className="w-5 h-5 text-[var(--speckle-foreground)]" />
                    <h2 className="font-semibold text-sm text-[var(--speckle-foreground)]">Documents</h2>
                    {user && (
                        <span className="text-xs text-[var(--speckle-foreground-2)] bg-[var(--speckle-outline-3)]/50 px-2 py-1 rounded-lg ml-1">
                            as {user.name}{user.org_name && ` (${user.org_name})`}{!canAct && ' (read-only)'}
                        </span>
                    )}
                    {error && <span className="text-[11px] text-red-400 ml-2">{error}</span>}
                </div>
                <div className="flex items-center gap-2">
                    {(activeTab === 'documents' || activeTab === 'drawings') && (
                        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--speckle-outline-3)]/50">
                            <button
                                onClick={() => setViewMode('grid')}
                                title="Grid view"
                                className={`p-1.5 rounded-md transition-colors ${viewMode === 'grid' ? 'bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground)]' : 'text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)]'}`}
                            >
                                <LayoutGrid className="w-3.5 h-3.5" />
                            </button>
                            <button
                                onClick={() => setViewMode('list')}
                                title="List view"
                                className={`p-1.5 rounded-md transition-colors ${viewMode === 'list' ? 'bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground)]' : 'text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)]'}`}
                            >
                                <List className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    )}
                    {(activeTab === 'documents' || activeTab === 'drawings') && canAct && (
                        <>
                            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleUpload} />
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={uploading || (activeTab === 'drawings' && !activeModelId)}
                                title={activeTab === 'drawings' && !activeModelId ? 'No model loaded in the viewer' : undefined}
                                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
                            >
                                <Upload className="w-3.5 h-3.5" /> {uploading ? 'Uploading…' : 'Upload'}
                            </button>
                            <span
                                title={`ISO 19650 naming (optional): ${NAMING_TEMPLATE}\ne.g. PRJ-ABC-00-00-DR-A-000001.pdf`}
                                className="text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] cursor-help"
                            >
                                <Info className="w-3.5 h-3.5" />
                            </span>
                        </>
                    )}
                    {activeTab === 'models' && canAct && (
                        <button
                            onClick={() => modelsListRef.current?.triggerUpload()}
                            disabled={modelsUploading}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
                        >
                            <Upload className="w-3.5 h-3.5" /> {modelsUploading ? 'Uploading…' : 'Upload IFC'}
                        </button>
                    )}
                    <button onClick={onClose} className="p-1.5 hover:bg-[var(--speckle-outline-3)] rounded-lg transition-colors">
                        <X className="w-4 h-4 text-[var(--speckle-foreground-3)]" />
                    </button>
                </div>
            </div>

            <div className="flex items-center gap-1 px-5 pt-3 shrink-0">
                <button
                    onClick={() => setActiveTab('documents')}
                    className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                        activeTab === 'documents' ? 'bg-amber-500/20 text-amber-300' : 'text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-3)]'
                    }`}
                >
                    Documents
                </button>
                <button
                    onClick={() => setActiveTab('drawings')}
                    className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors ${
                        activeTab === 'drawings' ? 'bg-amber-500/20 text-amber-300' : 'text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-3)]'
                    }`}
                >
                    <Ruler className="w-3 h-3" /> Drawings
                </button>
                <button
                    onClick={() => setActiveTab('models')}
                    className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors ${
                        activeTab === 'models' ? 'bg-amber-500/20 text-amber-300' : 'text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-3)]'
                    }`}
                >
                    <GitBranch className="w-3 h-3" /> Models
                </button>
            </div>

            {(activeTab === 'documents' || activeTab === 'drawings') && (
                <div className="flex items-center justify-between px-5 pt-2 shrink-0">
                    <div className="flex items-center gap-1 text-[11px] text-[var(--speckle-foreground-3)]">
                        <button
                            onClick={() => setFolderPath('')}
                            className={folderPath === '' ? 'text-[var(--speckle-foreground)] font-medium' : 'hover:text-[var(--speckle-foreground)]'}
                        >
                            Root
                        </button>
                        {folderPath && folderPath.split('/').map((seg, i, arr) => {
                            const upTo = arr.slice(0, i + 1).join('/')
                            return (
                                <span key={upTo} className="flex items-center gap-1">
                                    <span>/</span>
                                    <button
                                        onClick={() => setFolderPath(upTo)}
                                        className={upTo === folderPath ? 'text-[var(--speckle-foreground)] font-medium' : 'hover:text-[var(--speckle-foreground)]'}
                                    >
                                        {seg}
                                    </button>
                                </span>
                            )
                        })}
                    </div>
                    {canAct && (
                        <button
                            onClick={() => { setNewFolderName(''); setNewFolderPrompt(true) }}
                            className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg bg-[var(--speckle-outline-3)]/50 hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] transition-colors"
                        >
                            <FolderPlus className="w-3.5 h-3.5" /> New Folder
                        </button>
                    )}
                </div>
            )}

            {(activeTab === 'documents' || activeTab === 'drawings') && selectedIds.size > 0 && (
                <div className="flex items-center gap-2 flex-wrap px-5 pt-2 shrink-0">
                    <span className="text-[11px] text-[var(--speckle-foreground-3)]">
                        {selectedIds.size} selected — shift-click to extend, ctrl/cmd-click to toggle, or drag any selected card
                    </span>
                    {COLUMNS.filter(status => status !== 'WIP').map(status => (
                        <button
                            key={status}
                            onClick={() => bulkMoveTo(status)}
                            disabled={bulkMoving}
                            className={`text-[11px] px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50 hover:opacity-80 ${COLUMN_COLOR[status].badge}`}
                        >
                            {bulkButtonLabel(status)}
                        </button>
                    ))}
                    {canAct && (
                        <button
                            onClick={() => setConfirmBulkDelete(true)}
                            disabled={bulkMoving}
                            className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
                        >
                            <Trash2 className="w-3 h-3" /> Delete
                        </button>
                    )}
                    <button
                        onClick={() => setSelectedIds(new Set())}
                        className="text-[11px] px-2 py-1 rounded-lg text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)]"
                    >
                        Clear
                    </button>
                </div>
            )}

            {activeTab === 'models' ? (
                <SpeckleModelsList
                    ref={modelsListRef}
                    streamId={streamId} serverUrl={serverUrl} serverToken={serverToken}
                    normalizerUrl={normalizerUrl} onLoadModel={onLoadModel}
                    onUploadingChange={setModelsUploading}
                />
            ) : loading ? (
                <div className="flex-1 flex items-center justify-center text-xs text-[var(--speckle-foreground-3)]">Loading documents…</div>
            ) : (
                <>
                {subfolders.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap px-5 pt-3 shrink-0">
                        {subfolders.map(name => (
                            <div
                                key={name}
                                className="group flex items-center gap-1 rounded-lg bg-[var(--speckle-outline-3)]/50 hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] transition-colors"
                            >
                                <button
                                    onClick={() => setFolderPath(folderPath ? `${folderPath}/${name}` : name)}
                                    className="flex items-center gap-1.5 text-[11px] pl-2.5 pr-1 py-1.5"
                                >
                                    <Folder className="w-3.5 h-3.5" /> {name}
                                </button>
                                {canAct && (
                                    <div className="flex items-center gap-0.5 pr-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button
                                            onClick={() => { setRenameFolderValue(name); setRenameFolderTarget(name) }}
                                            className="p-1 hover:text-[var(--speckle-foreground)]"
                                            title="Rename folder"
                                        >
                                            <Pencil className="w-3 h-3" />
                                        </button>
                                        <button
                                            onClick={() => setDeleteFolderTarget(name)}
                                            className="p-1 hover:text-red-400"
                                            title="Delete folder"
                                        >
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
                <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveDoc(null)}>
                    <div className="flex-1 overflow-x-auto overflow-y-hidden flex gap-4 p-5">
                        {COLUMNS.map(status => (
                            <Column key={status} id={status} title={status} count={columns[status].length} emptyLabel={wantDrawings ? 'No drawings for this model' : 'No documents'} viewMode={viewMode}>
                                {columns[status].map(d => (
                                    <Card
                                        key={d.doc_id}
                                        doc={d}
                                        thumbUrl={thumbs[d.doc_id]}
                                        downloadUrl={`${base}/projects/${streamId}/documents/${d.doc_id}/download`}
                                        onDelete={setConfirmDeleteDoc}
                                        canDelete={canAct}
                                        onGate={(doc) => gateAndMove(doc, pendingGate.targetStatus)}
                                        pendingGate={pendingGate?.docId === d.doc_id ? GATE_LABEL[pendingGate.targetStatus] : null}
                                        canGate={pendingGate?.docId === d.doc_id ? GATE_CAN[pendingGate.targetStatus] : false}
                                        viewMode={viewMode}
                                        versionLabel={wantDrawings ? describeDrawingVersion(d) : null}
                                        selected={selectedIds.has(d.doc_id)}
                                        onCardClick={handleCardClick}
                                    />
                                ))}
                            </Column>
                        ))}
                    </div>
                    <DragOverlay dropAnimation={null}>
                        {activeDoc && (
                            <div className={`relative ${viewMode === 'list' ? 'w-[300px]' : 'w-[220px]'}`}>
                                {viewMode === 'list'
                                    ? <ListRowContent doc={activeDoc} thumbUrl={thumbs[activeDoc.doc_id]} grabbing />
                                    : <CardContent doc={activeDoc} thumbUrl={thumbs[activeDoc.doc_id]} grabbing />}
                                {selectedIds.has(activeDoc.doc_id) && selectedIds.size > 1 && (
                                    <div className="absolute -top-2 -right-2 min-w-[20px] h-5 px-1 rounded-full bg-amber-400 text-black text-[10px] font-bold flex items-center justify-center">
                                        {selectedIds.size}
                                    </div>
                                )}
                            </div>
                        )}
                    </DragOverlay>
                </DndContext>
                </>
            )}

            {selectedDoc && (
                <motion.div
                    initial={{ x: 360 }} animate={{ x: 0 }} exit={{ x: 360 }}
                    transition={{ duration: 0.18 }}
                    className="absolute top-0 right-0 h-full w-[360px] max-w-[calc(100vw-2rem)] glass-card rounded-none border-l border-[var(--speckle-outline-3)] flex flex-col overflow-hidden"
                >
                    <div className="p-4 border-b border-[var(--speckle-outline-3)] flex items-center justify-between shrink-0">
                        <button onClick={() => setSelectedDoc(null)} className="flex items-center gap-1 text-xs text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)]">
                            <ChevronLeft className="w-3.5 h-3.5" /> Back
                        </button>
                        {canAct && (
                            <button onClick={() => setConfirmDeleteDoc(selectedDoc)} className="text-[var(--speckle-foreground-3)] hover:text-red-400">
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-3">
                        <div className="aspect-video bg-[var(--speckle-outline-3)] rounded-lg flex items-center justify-center overflow-hidden">
                            {thumbs[selectedDoc.doc_id]
                                ? <img src={thumbs[selectedDoc.doc_id]} className="w-full h-full object-cover" alt="" />
                                : <FileText className="w-8 h-8 text-[var(--speckle-foreground-disabled)]" />}
                        </div>
                        <h4 className="text-sm font-semibold text-[var(--speckle-foreground)] break-all">{selectedDoc.filename}</h4>
                        <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${COLUMN_COLOR[selectedDoc.status]?.badge}`}>{selectedDoc.status}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)]">{formatSize(selectedDoc.size_bytes)}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)]">rev {selectedDoc.revision}</span>
                        </div>

                        {selectedDoc.naming_compliant ? (
                            <div
                                className="flex items-center gap-1.5 text-[11px] text-emerald-300 cursor-help"
                                title={Object.entries(selectedDoc.naming_fields || {}).map(([k, v]) => `${k}: ${v}`).join('\n')}
                            >
                                <Check className="w-3.5 h-3.5" /> ISO 19650 naming
                            </div>
                        ) : (
                            <div
                                className="flex items-center gap-1.5 text-[11px] text-[var(--speckle-foreground-3)] cursor-help"
                                title={`Expected pattern: ${NAMING_TEMPLATE}`}
                            >
                                <Info className="w-3.5 h-3.5" /> Non-standard filename
                            </div>
                        )}

                        {selectedDoc.status === 'WIP' && (
                            selectedDoc.reviewed ? (
                                <div className="flex items-center gap-1.5 text-[11px] text-blue-300">
                                    <ShieldCheck className="w-3.5 h-3.5" /> Reviewed by {selectedDoc.reviewed_by || '—'}
                                </div>
                            ) : canReview && (
                                <button
                                    onClick={() => clearGate(selectedDoc)}
                                    className="w-full flex items-center justify-center gap-1.5 text-xs px-2 py-2 rounded-lg bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 transition-colors"
                                >
                                    <Check className="w-3.5 h-3.5" /> Review
                                </button>
                            )
                        )}
                        {selectedDoc.status === 'Shared' && (
                            selectedDoc.approved ? (
                                <div className="flex items-center gap-1.5 text-[11px] text-emerald-300">
                                    <ShieldCheck className="w-3.5 h-3.5" /> Approved by {selectedDoc.approved_by || '—'}
                                </div>
                            ) : canApprove && (
                                <button
                                    onClick={() => clearGate(selectedDoc)}
                                    className="w-full flex items-center justify-center gap-1.5 text-xs px-2 py-2 rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors"
                                >
                                    <Check className="w-3.5 h-3.5" /> Approve
                                </button>
                            )
                        )}
                        {selectedDoc.status === 'Published' && (
                            selectedDoc.verified ? (
                                <div className="flex items-center gap-1.5 text-[11px] text-emerald-300">
                                    <ShieldCheck className="w-3.5 h-3.5" /> Verified by {selectedDoc.verified_by || '—'}
                                </div>
                            ) : canApprove && (
                                <button
                                    onClick={() => clearGate(selectedDoc)}
                                    className="w-full flex items-center justify-center gap-1.5 text-xs px-2 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 transition-colors"
                                >
                                    <Check className="w-3.5 h-3.5" /> Verify
                                </button>
                            )
                        )}

                        <div className="flex items-center gap-1.5 flex-wrap">
                            <Tag className="w-3.5 h-3.5 text-[var(--speckle-foreground-3)] shrink-0" />
                            {selectedDoc.suitability_code ? (
                                <span
                                    className={`text-[10px] px-1.5 py-0.5 rounded cursor-help ${SUITABILITY_COLOR[selectedDoc.suitability_code]}`}
                                    title={SUITABILITY_CODES[selectedDoc.suitability_code]}
                                >
                                    {selectedDoc.suitability_code}
                                </span>
                            ) : (
                                <span className="text-[10px] text-[var(--speckle-foreground-3)]">No suitability code</span>
                            )}
                            {canApprove && (
                                <select
                                    value={selectedDoc.suitability_code || ''}
                                    onChange={(e) => e.target.value && setSuitability(selectedDoc, e.target.value)}
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)]"
                                >
                                    <option value="" disabled>Set code…</option>
                                    {Object.entries(SUITABILITY_CODES).map(([code, label]) => (
                                        <option key={code} value={code}>{code} — {label}</option>
                                    ))}
                                </select>
                            )}
                        </div>

                        {isPreviewable(selectedDoc.filename) && (
                            <button
                                onClick={() => setPreviewDoc(selectedDoc)}
                                className="w-full flex items-center justify-center gap-1.5 text-xs px-2 py-2 rounded-lg bg-[var(--speckle-outline-3)]/50 hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] transition-colors"
                            >
                                <Eye className="w-3.5 h-3.5" /> Preview
                            </button>
                        )}

                        <div className="flex gap-2">
                            <a
                                href={`${base}/projects/${streamId}/documents/${selectedDoc.doc_id}/download`}
                                className="flex-1 flex items-center justify-center gap-1.5 text-xs px-2 py-2 rounded-lg bg-[var(--speckle-outline-3)]/50 hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] transition-colors"
                            >
                                <Download className="w-3.5 h-3.5" /> Download
                            </a>
                            {canAct && (
                                <>
                                    <input ref={reviseInputRef} type="file" className="hidden" onChange={handleRevise} />
                                    <button
                                        onClick={() => reviseInputRef.current?.click()}
                                        className="flex-1 flex items-center justify-center gap-1.5 text-xs px-2 py-2 rounded-lg bg-[var(--speckle-outline-3)]/50 hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] transition-colors"
                                    >
                                        <Upload className="w-3.5 h-3.5" /> New version
                                    </button>
                                </>
                            )}
                        </div>

                        {versions.length > 0 && (
                            <div className="border-t border-[var(--speckle-outline-3)] pt-3 space-y-1.5">
                                <p className="text-[10px] text-[var(--speckle-foreground-3)] flex items-center gap-1"><History className="w-3 h-3" /> Version history</p>
                                {versions.map(v => (
                                    <a
                                        key={v.version_id}
                                        href={`${base}/projects/${streamId}/documents/${selectedDoc.doc_id}/versions/${v.version_id}/download`}
                                        className="flex items-center justify-between text-[11px] text-[var(--speckle-foreground-2)] hover:text-[var(--speckle-foreground)] bg-[var(--speckle-outline-3)]/40 rounded px-2 py-1"
                                    >
                                        <span>{v.last_modified ? new Date(v.last_modified).toLocaleString() : v.version_id}</span>
                                        <span className="text-[var(--speckle-foreground-3)]">{formatSize(v.size)}</span>
                                    </a>
                                ))}
                            </div>
                        )}
                    </div>
                </motion.div>
            )}

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

            <AnimatePresence>
                {confirmDeleteDoc && (
                    <motion.div
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[215000] flex items-center justify-center bg-black/50"
                        onClick={() => !deleting && setConfirmDeleteDoc(null)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                            className="glass-card w-[320px] p-4 space-y-3"
                            onClick={e => e.stopPropagation()}
                        >
                            <p className="text-sm font-medium text-[var(--speckle-foreground)]">Delete this document?</p>
                            <p className="text-xs text-[var(--speckle-foreground-3)] break-all">{confirmDeleteDoc.filename}</p>
                            <p className="text-[11px] text-[var(--speckle-foreground-disabled)]">This removes it from Nextcloud. This cannot be undone.</p>
                            <div className="flex gap-2 pt-1">
                                <button
                                    onClick={() => setConfirmDeleteDoc(null)}
                                    disabled={deleting}
                                    className="flex-1 text-xs px-2 py-2 rounded-lg bg-[var(--speckle-outline-3)]/50 hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] transition-colors disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => removeDocument(confirmDeleteDoc)}
                                    disabled={deleting}
                                    className="flex-1 text-xs px-2 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
                                >
                                    {deleting ? 'Deleting…' : 'Delete'}
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {confirmBulkDelete && (
                    <motion.div
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[215000] flex items-center justify-center bg-black/50"
                        onClick={() => !bulkDeleting && setConfirmBulkDelete(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                            className="glass-card w-[320px] p-4 space-y-3"
                            onClick={e => e.stopPropagation()}
                        >
                            <p className="text-sm font-medium text-[var(--speckle-foreground)]">Delete {selectedIds.size} document{selectedIds.size === 1 ? '' : 's'}?</p>
                            <p className="text-[11px] text-[var(--speckle-foreground-disabled)]">This removes them from Nextcloud. This cannot be undone.</p>
                            <div className="flex gap-2 pt-1">
                                <button
                                    onClick={() => setConfirmBulkDelete(false)}
                                    disabled={bulkDeleting}
                                    className="flex-1 text-xs px-2 py-2 rounded-lg bg-[var(--speckle-outline-3)]/50 hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] transition-colors disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={bulkDeleteSelected}
                                    disabled={bulkDeleting}
                                    className="flex-1 text-xs px-2 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
                                >
                                    {bulkDeleting ? 'Deleting…' : 'Delete'}
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {newFolderPrompt && (
                    <motion.div
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[215000] flex items-center justify-center bg-black/50"
                        onClick={() => !creatingFolder && setNewFolderPrompt(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                            className="glass-card w-[320px] p-4 space-y-3"
                            onClick={e => e.stopPropagation()}
                        >
                            <p className="text-sm font-medium text-[var(--speckle-foreground)]">New folder</p>
                            <input
                                autoFocus
                                value={newFolderName}
                                onChange={e => setNewFolderName(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && createFolder()}
                                placeholder="Folder name"
                                // A CSS-variable background with a Tailwind opacity slash
                                // modifier (bg-[var(--speckle-outline-3)]/50, used elsewhere
                                // in this file for buttons/divs) doesn't reliably override an
                                // <input>'s browser-default white background — resulting in
                                // white-on-white invisible text. bg-zinc-800 is a plain
                                // Tailwind color (no CSS-var decomposition involved, so it
                                // actually renders) and already has an established .light-mode
                                // override elsewhere in index.css, matching the working pattern
                                // LoginScreen.jsx's own text input already uses.
                                className="w-full text-xs px-2 py-2 rounded-lg bg-zinc-800 border border-white/10 text-zinc-100 outline-none focus:border-primary/60"
                            />
                            <div className="flex gap-2 pt-1">
                                <button
                                    onClick={() => setNewFolderPrompt(false)}
                                    disabled={creatingFolder}
                                    className="flex-1 text-xs px-2 py-2 rounded-lg bg-[var(--speckle-outline-3)]/50 hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] transition-colors disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={createFolder}
                                    disabled={creatingFolder || !newFolderName.trim()}
                                    className="flex-1 text-xs px-2 py-2 rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
                                >
                                    {creatingFolder ? 'Creating…' : 'Create'}
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {renameFolderTarget && (
                    <motion.div
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[215000] flex items-center justify-center bg-black/50"
                        onClick={() => !renamingFolder && setRenameFolderTarget(null)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                            className="glass-card w-[320px] p-4 space-y-3"
                            onClick={e => e.stopPropagation()}
                        >
                            <p className="text-sm font-medium text-[var(--speckle-foreground)]">Rename folder</p>
                            <input
                                autoFocus
                                value={renameFolderValue}
                                onChange={e => setRenameFolderValue(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && renameFolder()}
                                placeholder="Folder name"
                                className="w-full text-xs px-2 py-2 rounded-lg bg-zinc-800 border border-white/10 text-zinc-100 outline-none focus:border-primary/60"
                            />
                            <div className="flex gap-2 pt-1">
                                <button
                                    onClick={() => setRenameFolderTarget(null)}
                                    disabled={renamingFolder}
                                    className="flex-1 text-xs px-2 py-2 rounded-lg bg-[var(--speckle-outline-3)]/50 hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] transition-colors disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={renameFolder}
                                    disabled={renamingFolder || !renameFolderValue.trim() || renameFolderValue.trim() === renameFolderTarget}
                                    className="flex-1 text-xs px-2 py-2 rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
                                >
                                    {renamingFolder ? 'Renaming…' : 'Rename'}
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {deleteFolderTarget && (
                    <motion.div
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[215000] flex items-center justify-center bg-black/50"
                        onClick={() => !deletingFolder && setDeleteFolderTarget(null)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                            className="glass-card w-[320px] p-4 space-y-3"
                            onClick={e => e.stopPropagation()}
                        >
                            <p className="text-sm font-medium text-[var(--speckle-foreground)]">Delete this folder?</p>
                            <p className="text-xs text-[var(--speckle-foreground-3)] break-all">{deleteFolderTarget}</p>
                            <p className="text-[11px] text-[var(--speckle-foreground-disabled)]">This removes it and everything inside it (in every status) from Nextcloud. This cannot be undone.</p>
                            <div className="flex gap-2 pt-1">
                                <button
                                    onClick={() => setDeleteFolderTarget(null)}
                                    disabled={deletingFolder}
                                    className="flex-1 text-xs px-2 py-2 rounded-lg bg-[var(--speckle-outline-3)]/50 hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] transition-colors disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={deleteFolder}
                                    disabled={deletingFolder}
                                    className="flex-1 text-xs px-2 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
                                >
                                    {deletingFolder ? 'Deleting…' : 'Delete'}
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    )
}
