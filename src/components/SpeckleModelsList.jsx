import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { Loader2, GitBranch, ImageOff, Trash2, FolderOpen, ChevronLeft } from 'lucide-react'
import { gqlFetch } from '../utils/speckleGraphQL'
import { useAuthedImage } from '../utils/useAuthedImage'
import { PanoramaThumbnail } from './PanoramaThumbnail'

// Speckle branch names are permissive, but keep uploaded-file-derived names
// tidy and URL/query-string-safe.
function slugifyBranchName(filename) {
    const base = filename.replace(/\.ifc$/i, '').trim()
    return (base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'upload')
}

const STATUSES = ['WIP', 'Shared', 'Published', 'Archived']
const STATUS_COLOR = {
    WIP: { border: 'border-zinc-400/50', bg: 'bg-zinc-400/10', text: 'text-zinc-300', badge: 'bg-zinc-400/20 text-zinc-200' },
    Shared: { border: 'border-blue-500/50', bg: 'bg-blue-500/10', text: 'text-blue-300', badge: 'bg-blue-500/25 text-blue-300' },
    Published: { border: 'border-emerald-500/50', bg: 'bg-emerald-500/10', text: 'text-emerald-300', badge: 'bg-emerald-500/25 text-emerald-300' },
    Archived: { border: 'border-[var(--speckle-outline-3)]', bg: 'bg-[var(--speckle-outline-3)]/20', text: 'text-[var(--speckle-foreground-3)]', badge: 'bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]' },
}

function Column({ id, title, count, children }) {
    const { setNodeRef, isOver } = useDroppable({ id })
    const colors = STATUS_COLOR[title]
    return (
        <div
            ref={setNodeRef}
            className={`flex flex-col gap-2 flex-1 min-w-[240px] rounded-xl border-2 p-3 transition-colors ${
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
                    <div className="text-[11px] text-[var(--speckle-foreground-disabled)] text-center py-6">No models</div>
                )}
            </div>
        </div>
    )
}

function ModelCardContent({ branch, thumbUrl, panoramaUrl, token, onOpen, onDelete, grabbing }) {
    return (
        <div className={`glass-card p-0 overflow-hidden group ${grabbing ? 'cursor-grabbing shadow-2xl' : 'cursor-grab'}`}>
            <div
                className="aspect-video bg-[var(--speckle-outline-3)] flex items-center justify-center overflow-hidden"
                onClick={() => onOpen?.(branch)}
            >
                {thumbUrl
                    ? <PanoramaThumbnail baseUrl={thumbUrl} panoramaUrl={panoramaUrl} token={token} />
                    : <GitBranch className="w-6 h-6 text-[var(--speckle-foreground-disabled)]" />}
            </div>
            <div className="p-2.5" onClick={() => onOpen?.(branch)}>
                <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-medium text-[var(--speckle-foreground)] line-clamp-2 break-all">{branch.name}</p>
                    {onDelete && (
                        <button
                            onPointerDown={e => e.stopPropagation()}
                            onClick={e => { e.stopPropagation(); onDelete(branch) }}
                            className="text-[var(--speckle-foreground-3)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                            title="Delete"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                    <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]">
                        {branch.commits.totalCount} version{branch.commits.totalCount === 1 ? '' : 's'}
                    </span>
                </div>
            </div>
        </div>
    )
}

function ModelCard({ branch, thumbUrl, panoramaUrl, token, onOpen, onDelete }) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: branch.name })
    return (
        <div ref={setNodeRef} {...listeners} {...attributes} className={isDragging ? 'opacity-30' : ''}>
            <ModelCardContent branch={branch} thumbUrl={thumbUrl} panoramaUrl={panoramaUrl} token={token} onOpen={onOpen} onDelete={onDelete} />
        </div>
    )
}

// Kanban board for this project's Speckle models (branches), styled to match
// the Documents board exactly (same Column/Card visuals, same drag-between-
// columns-to-change-status interaction) — WIP/Shared/Published/Archived, but
// tracked in bim-normalizer's own bim_model_status table since Speckle
// branches have no native status field of their own.
//
// A "card" is a branch; a branch's own commits (versions) live in the detail
// drawer opened by clicking a card, each with a Load button that hands the
// commit up to the caller (App.jsx's loadModelData) — same as picking it
// from the normal version picker. Preview thumbnails reuse Speckle's own
// preview-service (`${serverUrl}/preview/{streamId}/commits/{commitId}`) —
// confirmed against a real deployment that this endpoint only honors the
// token via an Authorization header, silently falling back to its "this
// stream is private" placeholder for a ?token= query param even when that
// token owns the stream. A plain <img src> can't send a custom header, so
// useAuthedImage (PanoramaThumbnail, and the detail drawer below) fetches
// the bytes itself and hands the browser a local blob: URL instead.
//
// Delete removes the branch (and its commits) on Speckle itself via a direct
// GraphQL mutation (this component already holds the user's own server
// credentials for reads), then asks bim-normalizer to clean up everything
// *it* owns for that branch: the locally-ingested copy, any Nextcloud
// documents linked to one of its elements, and the status row.
// forwardRef: the "Upload IFC" trigger button lives in DocumentsPanel.jsx's
// shared header now (so it's positioned identically to the Documents tab's
// own "Upload" button instead of this component rendering a second,
// differently-positioned header row) — the parent calls triggerUpload() to
// open this component's own hidden file input, since the actual upload
// logic/state stays here unchanged.
export const SpeckleModelsList = forwardRef(function SpeckleModelsList(
    { streamId, serverUrl, serverToken, normalizerUrl, onLoadModel, onUploadingChange }, ref
) {
    const base = (normalizerUrl || '').replace(/\/$/, '')
    const [branches, setBranches] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [statusByBranch, setStatusByBranch] = useState({})
    const [selectedBranch, setSelectedBranch] = useState(null)
    // Versions shown in the detail drawer — starts as the branch's already-
    // fetched first page (commits(limit: 10) from the branches query above,
    // kept cheap since it runs for every branch just to populate the Kanban
    // cards) and grows via loadMoreCommits() only for the one branch someone
    // actually opens, cursor-paginated rather than raising that shared limit.
    const [selectedBranchCommits, setSelectedBranchCommits] = useState([])
    const [commitsCursor, setCommitsCursor] = useState(null)
    const [loadingMoreCommits, setLoadingMoreCommits] = useState(false)
    const [activeBranch, setActiveBranch] = useState(null)
    const [confirmDeleteBranch, setConfirmDeleteBranch] = useState(null)
    const [deleting, setDeleting] = useState(false)
    const [actionError, setActionError] = useState(null)
    const [uploading, setUploading] = useState(false)
    const [uploadStatus, setUploadStatus] = useState(null)
    const fileInputRef = useRef(null)

    useImperativeHandle(ref, () => ({
        triggerUpload: () => fileInputRef.current?.click(),
    }), [])

    useEffect(() => { onUploadingChange?.(uploading) }, [uploading, onUploadingChange])

    const columns = STATUSES.reduce((acc, status) => {
        acc[status] = branches.filter(b => (statusByBranch[b.name] || 'WIP') === status)
        return acc
    }, {})

    const load = useCallback(async () => {
        if (!streamId || !serverUrl) return
        setLoading(true)
        setError(null)
        try {
            const data = await gqlFetch(serverUrl, serverToken, `
                query GetBranches($streamId: String!) {
                    stream(id: $streamId) {
                        branches {
                            items {
                                id
                                name
                                description
                                commits(limit: 10) {
                                    totalCount
                                    cursor
                                    items { id message createdAt authorName }
                                }
                            }
                        }
                    }
                }
            `, { streamId })
            const items = (data?.stream?.branches?.items || []).filter(b => b.commits.totalCount > 0)
            setBranches(items)
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }, [streamId, serverUrl, serverToken])

    const loadStatuses = useCallback(async () => {
        if (!streamId || !base) return
        try {
            const res = await fetch(`${base}/projects/${streamId}/model-status`)
            if (!res.ok) return
            setStatusByBranch(await res.json())
        } catch {
            // Non-critical — statuses just default to WIP in the UI.
        }
    }, [streamId, base])

    useEffect(() => { load() }, [load])
    useEffect(() => { loadStatuses() }, [loadStatuses])

    const selectedBranchPreviewUrl = selectedBranch
        ? `${serverUrl}/preview/${streamId}/commits/${selectedBranch.commits.items[0]?.id}`
        : null
    const selectedBranchBlobUrl = useAuthedImage(selectedBranchPreviewUrl, serverToken)

    // Reset the detail drawer's version list to the branch's first page
    // whenever a different branch is opened (or closed) — otherwise a
    // previously-expanded branch's extra pages would leak into the next one.
    useEffect(() => {
        setSelectedBranchCommits(selectedBranch?.commits?.items || [])
        setCommitsCursor(selectedBranch?.commits?.cursor || null)
    }, [selectedBranch])

    const loadMoreCommits = async () => {
        if (!selectedBranch || loadingMoreCommits) return
        setLoadingMoreCommits(true)
        try {
            const data = await gqlFetch(serverUrl, serverToken, `
                query GetMoreCommits($streamId: String!, $branchName: String!, $cursor: String) {
                    stream(id: $streamId) {
                        branch(name: $branchName) {
                            commits(limit: 10, cursor: $cursor) {
                                cursor
                                items { id message createdAt authorName }
                            }
                        }
                    }
                }
            `, { streamId, branchName: selectedBranch.name, cursor: commitsCursor })
            const more = data?.stream?.branch?.commits
            setSelectedBranchCommits(prev => [...prev, ...(more?.items || [])])
            setCommitsCursor(more?.cursor || null)
        } catch (err) {
            setActionError(`Could not load more versions: ${err.message}`)
        } finally {
            setLoadingMoreCommits(false)
        }
    }

    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

    async function changeStatus(branchName, status) {
        setActionError(null)
        try {
            const res = await fetch(`${base}/projects/${streamId}/model-status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ branch_name: branchName, status }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `HTTP ${res.status}`)
            }
            setStatusByBranch(prev => ({ ...prev, [branchName]: status }))
        } catch (err) {
            setActionError(`Could not update status: ${err.message}`)
        }
    }

    const handleDragStart = (event) => {
        setActiveBranch(branches.find(b => b.name === event.active.id) || null)
    }

    const handleDragEnd = (event) => {
        setActiveBranch(null)
        const { active, over } = event
        if (!over) return
        const branch = branches.find(b => b.name === active.id)
        const targetStatus = over.id
        if (!branch || (statusByBranch[branch.name] || 'WIP') === targetStatus) return
        changeStatus(branch.name, targetStatus)
    }

    async function removeBranch(branch) {
        setDeleting(true)
        setActionError(null)
        try {
            await gqlFetch(serverUrl, serverToken, `
                mutation DeleteBranch($branch: BranchDeleteInput!) {
                    branchDelete(branch: $branch)
                }
            `, { branch: { streamId, id: branch.id } })

            const res = await fetch(`${base}/projects/${streamId}/models/delete-cleanup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ branch_name: branch.name }),
            })
            if (!res.ok) {
                let detail = `HTTP ${res.status}`
                try { const b = await res.json(); detail = b.detail || JSON.stringify(b) } catch {}
                throw new Error(`Deleted from Speckle, but local cleanup failed: ${detail}`)
            }

            setStatusByBranch(prev => {
                const next = { ...prev }
                delete next[branch.name]
                return next
            })
            setConfirmDeleteBranch(null)
            if (selectedBranch?.name === branch.name) setSelectedBranch(null)
            await load()
        } catch (err) {
            setActionError(err.message)
        } finally {
            setDeleting(false)
        }
    }

    // Uploads the raw .ifc file straight to Speckle's own native file-import
    // endpoint (bim-normalizer just proxies it) — Speckle's fileimport-service
    // converts it into a commit server-side, same as dragging a file onto the
    // Speckle web app itself. Once conversion finishes, hands off to the
    // normal onLoadModel flow (ingest + load into the viewer) so the new
    // model shows up immediately instead of just sitting there unloaded.
    async function uploadIfc(file) {
        setUploading(true)
        setActionError(null)
        const branchName = slugifyBranchName(file.name)
        const qs = new URLSearchParams({ branch_name: branchName })
        if (serverUrl) qs.set('server_url', serverUrl)
        if (serverToken) qs.set('token', serverToken)
        try {
            setUploadStatus('Uploading to Speckle…')
            const form = new FormData()
            form.append('file', file)
            const res = await fetch(`${base}/projects/${streamId}/models/upload-ifc?${qs}`, {
                method: 'POST', body: form,
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `Upload failed (${res.status})`)
            }
            const { upload_id: uploadId } = await res.json()

            setUploadStatus('Converting on Speckle…')
            let commitId = null
            for (let attempt = 0; attempt < 60; attempt++) {
                await new Promise(r => setTimeout(r, 3000))
                const statusRes = await fetch(`${base}/projects/${streamId}/models/upload-ifc/${uploadId}/status?${qs}`)
                if (!statusRes.ok) continue
                const statusData = await statusRes.json()
                if (statusData.status === 'error') throw new Error(statusData.message || 'Speckle failed to convert the IFC file')
                if (statusData.commit_id) { commitId = statusData.commit_id; break }
            }
            if (!commitId) throw new Error('Timed out waiting for Speckle to finish converting the IFC file')

            await load()
            onLoadModel?.(branchName, commitId)
        } catch (err) {
            setActionError(err.message)
        } finally {
            setUploading(false)
            setUploadStatus(null)
        }
    }

    const handleUploadFile = (e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (file) uploadIfc(file)
    }

    if (loading) {
        return (
            <div className="flex-1 flex items-center justify-center gap-2 text-sm text-[var(--speckle-foreground-3)]">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading models from Speckle…
            </div>
        )
    }
    if (error) {
        return (
            <div className="flex-1 flex items-center justify-center text-sm text-red-400 px-8 text-center">
                Could not load models: {error}
            </div>
        )
    }

    return (
        <div className="flex-1 flex flex-col overflow-hidden relative">
            <input ref={fileInputRef} type="file" accept=".ifc" className="hidden" onChange={handleUploadFile} />
            {uploadStatus && (
                <div className="flex items-center gap-1.5 px-5 pt-3 shrink-0 text-[11px] text-[var(--speckle-foreground-3)]">
                    <Loader2 className="w-3 h-3 animate-spin" /> {uploadStatus}
                </div>
            )}

            {actionError && (
                <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mx-5 mt-3">
                    {actionError}
                </div>
            )}

            {branches.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-sm text-[var(--speckle-foreground-3)]">
                    No models with commits found for this project.
                </div>
            ) : (
                <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveBranch(null)}>
                    <div className="flex-1 overflow-x-auto overflow-y-hidden flex gap-4 p-5">
                        {STATUSES.map(status => (
                            <Column key={status} id={status} title={status} count={columns[status].length}>
                                {columns[status].map(branch => (
                                    <ModelCard
                                        key={branch.name}
                                        branch={branch}
                                        thumbUrl={`${serverUrl}/preview/${streamId}/commits/${branch.commits.items[0]?.id}`}
                                        panoramaUrl={`${serverUrl}/preview/${streamId}/commits/${branch.commits.items[0]?.id}/all`}
                                        token={serverToken}
                                        onOpen={setSelectedBranch}
                                        onDelete={setConfirmDeleteBranch}
                                    />
                                ))}
                            </Column>
                        ))}
                    </div>
                    <DragOverlay dropAnimation={null}>
                        {activeBranch && (
                            <div className="w-[220px]">
                                <ModelCardContent
                                    branch={activeBranch}
                                    thumbUrl={`${serverUrl}/preview/${streamId}/commits/${activeBranch.commits.items[0]?.id}`}
                                    token={serverToken}
                                    grabbing
                                />
                            </div>
                        )}
                    </DragOverlay>
                </DndContext>
            )}

            {selectedBranch && (
                <motion.div
                    initial={{ x: 360 }} animate={{ x: 0 }} exit={{ x: 360 }}
                    transition={{ duration: 0.18 }}
                    className="absolute top-0 right-0 h-full w-[360px] max-w-[calc(100vw-2rem)] glass-card rounded-none border-l border-[var(--speckle-outline-3)] flex flex-col overflow-hidden"
                >
                    <div className="p-4 border-b border-[var(--speckle-outline-3)] flex items-center justify-between shrink-0">
                        <button onClick={() => setSelectedBranch(null)} className="flex items-center gap-1 text-xs text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)]">
                            <ChevronLeft className="w-3.5 h-3.5" /> Back
                        </button>
                        <button onClick={() => setConfirmDeleteBranch(selectedBranch)} className="text-[var(--speckle-foreground-3)] hover:text-red-400">
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-3">
                        <div className="aspect-video bg-[var(--speckle-outline-3)] rounded-lg flex items-center justify-center overflow-hidden relative">
                            {selectedBranchBlobUrl
                                ? <img src={selectedBranchBlobUrl} alt="" className="w-full h-full object-cover" />
                                : <ImageOff className="w-8 h-8 text-[var(--speckle-foreground-disabled)]" />}
                        </div>
                        <h4 className="text-sm font-semibold text-[var(--speckle-foreground)] break-all">{selectedBranch.name}</h4>
                        <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_COLOR[statusByBranch[selectedBranch.name] || 'WIP'].badge}`}>
                                {statusByBranch[selectedBranch.name] || 'WIP'}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)]">
                                {selectedBranch.commits.totalCount} version{selectedBranch.commits.totalCount === 1 ? '' : 's'}
                            </span>
                        </div>

                        <div className="border-t border-[var(--speckle-outline-3)] pt-3 space-y-1.5">
                            <p className="text-[10px] text-[var(--speckle-foreground-3)]">
                                Versions ({selectedBranchCommits.length} of {selectedBranch.commits.totalCount})
                            </p>
                            {selectedBranchCommits.map(commit => (
                                <button
                                    key={commit.id}
                                    onClick={() => onLoadModel?.(selectedBranch.name, commit.id)}
                                    className="w-full flex items-center justify-between gap-2 text-left text-[11px] text-[var(--speckle-foreground-2)] hover:text-[var(--speckle-foreground)] bg-[var(--speckle-outline-3)]/40 hover:bg-[var(--speckle-outline-3)] rounded px-2 py-1.5 transition-colors"
                                    title="Load this version into the dashboard"
                                >
                                    <span className="truncate">
                                        <span className="block truncate">{commit.message || 'No message'}</span>
                                        <span className="block text-[10px] text-[var(--speckle-foreground-3)]">{commit.authorName} · {new Date(commit.createdAt).toLocaleString()}</span>
                                    </span>
                                    <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                                </button>
                            ))}
                            {selectedBranchCommits.length < selectedBranch.commits.totalCount && (
                                <button
                                    onClick={loadMoreCommits}
                                    disabled={loadingMoreCommits}
                                    className="w-full flex items-center justify-center gap-1.5 text-[11px] text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] py-1.5 rounded transition-colors disabled:opacity-50"
                                >
                                    {loadingMoreCommits ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                                    {loadingMoreCommits ? 'Loading…' : 'Load more'}
                                </button>
                            )}
                        </div>
                    </div>
                </motion.div>
            )}

            <AnimatePresence>
                {confirmDeleteBranch && (
                    <motion.div
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[215000] flex items-center justify-center bg-black/50"
                        onClick={() => !deleting && setConfirmDeleteBranch(null)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                            className="glass-card w-[340px] p-4 space-y-3"
                            onClick={e => e.stopPropagation()}
                        >
                            <p className="text-sm font-medium text-[var(--speckle-foreground)]">Delete this model?</p>
                            <p className="text-xs text-[var(--speckle-foreground-3)] break-all">{confirmDeleteBranch.name}</p>
                            <p className="text-[11px] text-[var(--speckle-foreground-disabled)]">
                                Permanently removes it and all {confirmDeleteBranch.commits.totalCount} version{confirmDeleteBranch.commits.totalCount === 1 ? '' : 's'} from Speckle,
                                the locally-ingested copy, and any documents linked to its elements. This cannot be undone.
                            </p>
                            <div className="flex gap-2 pt-1">
                                <button
                                    onClick={() => setConfirmDeleteBranch(null)}
                                    disabled={deleting}
                                    className="flex-1 text-xs px-2 py-2 rounded-lg bg-[var(--speckle-outline-3)]/50 hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] transition-colors disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => removeBranch(confirmDeleteBranch)}
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
        </div>
    )
})
