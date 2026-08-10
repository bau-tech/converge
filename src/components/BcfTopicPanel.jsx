import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Flag, X, Plus, Camera, Send, Trash2, Download, Upload, ChevronLeft, Pencil } from 'lucide-react'
import { BcfLogoIcon } from './BcfLogoIcon'
import { ViewpointMarkupEditor } from './ViewpointMarkupEditor'
import {
    createTopic, updateTopic, deleteTopic,
    listComments, createComment,
    listTopics, listViewpoints, createViewpoint, getSnapshotUrl, blobUrlToBase64,
    exportBcfzip, importBcfzip, listUsers,
} from '../utils/bcfClient'
import { archiveLinkedSpeckleComment } from '../utils/bcfSync'
import { PRIORITIES, PRIORITY_COLOR } from '../utils/bcfWorkflow'
import { useAuth } from '../contexts/AuthContext'

const TOPIC_TYPES = ['Issue', 'Clash', 'Request', 'Remark']
const TOPIC_STATUSES = ['Open', 'In Progress', 'Closed']

const STATUS_COLOR = {
    Open: 'bg-amber-500/20 text-amber-400',
    'In Progress': 'bg-blue-500/20 text-blue-400',
    Closed: 'bg-emerald-500/20 text-emerald-400',
}

// `topics` is owned by App.jsx (synced automatically and silently with
// Speckle on model load via bcfSync.js) — this component is a controlled
// display over that shared state, with manual create/delete/.bcfzip actions.
export function BcfTopicPanel({
    projectId, viewerRef, topics = [], fullData = null, streamId = null, onTopicsChange, onRequestSync,
    serverUrl, serverToken, autoOpenTopicGuid = null, onAutoOpenHandled,
}) {
    const { user } = useAuth()
    const [isOpen, setIsOpen] = useState(false)
    const [error, setError] = useState(null)

    const [selectedTopic, setSelectedTopic] = useState(null)
    const [topicComments, setTopicComments] = useState([])
    const [newComment, setNewComment] = useState('')
    const [snapshotUrl, setSnapshotUrl] = useState(null)

    // Caps how many topic rows actually mount — a project with hundreds of
    // BCF issues used to render every one of them as a live DOM node with
    // its own onClick handler regardless of whether the list was even
    // scrolled into view. Resets on projectId (a stable primitive) rather
    // than the `topics` array itself — App.jsx can hand this a new array
    // reference on unrelated re-renders (e.g. a single topic being patched
    // in place via onTopicsChange), which would otherwise snap an
    // already-expanded "show more" state back to the page size every time.
    const TOPIC_PAGE_SIZE = 50
    const [visibleTopicCount, setVisibleTopicCount] = useState(TOPIC_PAGE_SIZE)
    useEffect(() => { setVisibleTopicCount(TOPIC_PAGE_SIZE) }, [projectId])

    const [creating, setCreating] = useState(false)
    const [pendingViewpoint, setPendingViewpoint] = useState(null)
    const [newTitle, setNewTitle] = useState('')
    const [newDescription, setNewDescription] = useState('')
    const [newType, setNewType] = useState('Issue')
    const [newPriority, setNewPriority] = useState('Normal')
    const [newStatus, setNewStatus] = useState('Open')
    const [newAssignedTo, setNewAssignedTo] = useState('')
    const [newDueDate, setNewDueDate] = useState('')

    // Registered bcf_users, for the "Assigned to" datalist — free text is
    // still accepted for assignees outside the system (matches openBCF/
    // BIMcollab, which don't constrain this field either).
    const [users, setUsers] = useState([])
    useEffect(() => {
        listUsers().then(setUsers).catch(() => setUsers([]))
    }, [])

    const importInputRef = useRef(null)

    // Markup editor state — `markupMode` is null | 'create' | 'add-viewpoint'.
    // 'create' annotates pendingViewpoint's own snapshot in place; 'add-viewpoint'
    // captures a fresh one for an already-existing topic (addViewpointDraft)
    // and posts it as a new viewpoint on save.
    const [markupMode, setMarkupMode] = useState(null)
    const [addViewpointDraft, setAddViewpointDraft] = useState(null)

    // Reset any open detail/create view when switching models — a stale
    // selectedTopic/topic guid from the previous model must not leak through.
    useEffect(() => {
        setSelectedTopic(null)
        setCreating(false)
    }, [projectId])

    // The model-load sync in App.jsx only runs once per model and may have
    // raced against `comments` still loading — re-running here whenever the
    // panel is opened is a cheap, user-initiated way to catch anything it
    // missed, since pull/push are fully idempotent (safe to re-run anytime).
    // onRequestSync is intentionally excluded from deps — it's a fresh
    // closure every App.jsx render, and depending on it would re-fire this
    // on every parent render while the panel happens to be open, not just
    // when isOpen actually toggles.
    useEffect(() => {
        if (isOpen) onRequestSync?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen])

    // Load the selected topic's viewpoint snapshot as a blob URL (the raw
    // endpoint needs a Bearer header a plain <img src> can't send).
    useEffect(() => {
        setSnapshotUrl(null)
        const vp = selectedTopic?.viewpoint
        if (!vp || !projectId) return
        let objectUrl = null
        let cancelled = false
        getSnapshotUrl(projectId, selectedTopic.guid, vp.guid)
            .then((url) => {
                if (cancelled) { URL.revokeObjectURL(url); return }
                objectUrl = url
                setSnapshotUrl(url)
            })
            .catch(() => {}) // no snapshot for this viewpoint — fine, just don't show one
        return () => {
            cancelled = true
            if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
    }, [selectedTopic, projectId])

    const openTopic = async (topic) => {
        setSelectedTopic(topic)
        setCreating(false)
        if (topic.viewpoint) viewerRef.current?.restoreBcfViewpoint(topic.viewpoint, topic.guid)
        try {
            setTopicComments(await listComments(projectId, topic.guid))
        } catch {
            setTopicComments([])
        }
    }

    // Deep link from a BCF-assignment email (?layout=...&topic=<guid>) — once
    // the right model has loaded and this guid shows up in the (async,
    // App.jsx-owned) `topics` list, pop the panel straight to it. No-ops
    // (harmlessly re-runs on every topics change) until either that happens
    // or the guid is cleared — e.g. the email pointed at a topic whose model
    // was never resolved, so `topics` here is scoped to a different project
    // than the one the link was meant for.
    useEffect(() => {
        if (!autoOpenTopicGuid) return
        const match = topics.find((t) => t.guid === autoOpenTopicGuid)
        if (!match) return
        openTopic(match)
        setIsOpen(true)
        onAutoOpenHandled?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoOpenTopicGuid, topics])

    const startCreating = async () => {
        setSelectedTopic(null)
        setCreating(true)
        setNewTitle('')
        setNewDescription('')
        setNewType('Issue')
        setNewPriority('Normal')
        setNewStatus('Open')
        setNewAssignedTo('')
        setNewDueDate('')
        setPendingViewpoint(null)
        try {
            const vp = await viewerRef.current?.captureViewpoint()
            setPendingViewpoint(vp || null)
        } catch {
            setPendingViewpoint(null)
        }
    }

    const submitNewTopic = async () => {
        if (!newTitle.trim() || !projectId) return
        const authorName = user?.name || 'Dashboard User'
        try {
            const topic = await createTopic(projectId, {
                title: newTitle.trim(),
                description: newDescription.trim() || null,
                creation_author: authorName,
                topic_type: newType,
                topic_status: newStatus,
                priority: newPriority,
                assigned_to: newAssignedTo.trim() || null,
                due_date: newDueDate ? new Date(newDueDate).toISOString() : null,
            })
            let viewpoint = null
            if (pendingViewpoint) {
                viewpoint = await createViewpoint(projectId, topic.guid, pendingViewpoint)
            }
            const enriched = { ...topic, viewpoint }
            onTopicsChange?.([...topics, enriched])
            setCreating(false)
            setSelectedTopic(enriched)
            setTopicComments([])
            onRequestSync?.() // push this new topic to Speckle right away, don't wait for next model load
        } catch (e) {
            console.warn('Could not create BCF topic:', e)
            setError('Could not create topic')
        }
    }

    // Captures a fresh viewpoint from the current 3D view and opens the
    // markup editor on it — the "add a second (annotated) viewpoint to an
    // already-existing topic" flow, which didn't exist before this.
    const openAddViewpoint = async () => {
        if (!selectedTopic || !projectId) return
        try {
            const vp = await viewerRef.current?.captureViewpoint()
            if (!vp?.snapshot_base64) { setError('Could not capture a screenshot of the current view'); return }
            setAddViewpointDraft(vp)
            setMarkupMode('add-viewpoint')
        } catch (e) {
            console.warn('Could not capture viewpoint:', e)
            setError('Could not capture viewpoint')
        }
    }

    // Loads the topic's *existing* saved viewpoint image (annotations and
    // all, if it already has any) back into the markup editor for further
    // annotation — distinct from openAddViewpoint(), which always starts
    // from a brand-new capture of whatever the 3D view currently shows.
    // Reuses the same `addViewpointDraft`/'add-viewpoint' save path: saving
    // still creates a new viewpoint (camera/selection unchanged, only the
    // image differs), preserving BCF viewpoint history rather than mutating
    // the existing one in place.
    const openEditViewpoint = async () => {
        if (!selectedTopic?.viewpoint || !snapshotUrl) return
        try {
            const base64 = await blobUrlToBase64(snapshotUrl)
            const {
                camera_view_point, camera_direction, camera_up_vector,
                field_of_view, view_to_world_scale, is_orthogonal, clipping_planes, selection,
            } = selectedTopic.viewpoint
            setAddViewpointDraft({
                camera_view_point, camera_direction, camera_up_vector,
                field_of_view, view_to_world_scale, is_orthogonal, clipping_planes, selection,
                snapshot_base64: base64,
            })
            setMarkupMode('add-viewpoint')
        } catch (e) {
            console.warn('Could not load existing viewpoint for editing:', e)
            setError('Could not load existing viewpoint for editing')
        }
    }

    const handleMarkupSave = async (newBase64) => {
        if (markupMode === 'create') {
            setPendingViewpoint((prev) => (prev ? { ...prev, snapshot_base64: newBase64 } : prev))
            setMarkupMode(null)
            return
        }
        if (markupMode === 'add-viewpoint' && addViewpointDraft && selectedTopic) {
            try {
                const viewpoint = await createViewpoint(projectId, selectedTopic.guid, { ...addViewpointDraft, snapshot_base64: newBase64 })
                const enriched = { ...selectedTopic, viewpoint }
                setSelectedTopic(enriched)
                onTopicsChange?.(topics.map((t) => (t.guid === selectedTopic.guid ? enriched : t)))
            } catch (e) {
                console.warn('Could not add viewpoint:', e)
                setError('Could not add viewpoint')
            }
        }
        setAddViewpointDraft(null)
        setMarkupMode(null)
    }

    const handleMarkupCancel = () => {
        setMarkupMode(null)
        setAddViewpointDraft(null)
    }

    const submitComment = async () => {
        if (!newComment.trim() || !selectedTopic) return
        const authorName = user?.name || 'Dashboard User'
        try {
            const comment = await createComment(projectId, selectedTopic.guid, {
                comment: newComment.trim(),
                author: authorName,
            })
            setTopicComments((prev) => [...prev, comment])
            setNewComment('')
            onRequestSync?.() // relay this reply to Speckle right away, don't wait for next model load
        } catch (e) {
            console.warn('Could not add comment:', e)
        }
    }

    const removeTopic = async (topic) => {
        // Best-effort: archive the linked Speckle comment (however this topic
        // is linked — pushed by us, or the native comment it was pulled
        // from) so it doesn't linger there after being deleted here. Speckle
        // has no real comment delete, only archive — and a failure here must
        // not block the actual BCF-side deletion.
        if (streamId) {
            try {
                await archiveLinkedSpeckleComment(projectId, topic.guid, streamId, { serverUrl, token: serverToken })
            } catch (err) {
                console.warn('Could not archive linked Speckle comment:', err)
            }
        }
        try {
            await deleteTopic(projectId, topic.guid)
            onTopicsChange?.(topics.filter((t) => t.guid !== topic.guid))
            if (selectedTopic?.guid === topic.guid) setSelectedTopic(null)
        } catch (e) {
            console.warn('Could not delete topic:', e)
        }
    }

    // Optimistic update with rollback on failure — same shape as
    // BcfKanbanBoard's drag-and-drop status updates, applied here to the
    // priority/due_date fields edited from this panel's detail view.
    const updateTopicField = (topic, updates) => {
        const prevFields = Object.fromEntries(Object.keys(updates).map((k) => [k, topic[k]]))
        const apply = (fields) => {
            onTopicsChange?.(topics.map((t) => (t.guid === topic.guid ? { ...t, ...fields } : t)))
            setSelectedTopic((prev) => (prev && prev.guid === topic.guid ? { ...prev, ...fields } : prev))
        }
        apply(updates)
        updateTopic(projectId, topic.guid, updates).catch(() => apply(prevFields))
    }

    const handleImportFile = async (e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file || !projectId) return
        try {
            await importBcfzip(projectId, file)
            const list = await listTopics(projectId)
            const withViewpoints = await Promise.all(
                list.map(async (t) => {
                    try {
                        const vps = await listViewpoints(projectId, t.guid)
                        return { ...t, viewpoint: vps[vps.length - 1] || null } // most recently added viewpoint, not the first
                    } catch {
                        return { ...t, viewpoint: null }
                    }
                })
            )
            onTopicsChange?.(withViewpoints)
        } catch (err) {
            console.warn('BCF import failed:', err)
            setError('Import failed — not a valid .bcfzip?')
        }
    }

    return (
        <motion.div
            initial={false}
            // z-[260]: above the Element panel (z-[245]) so this FAB stays clickable
            // even when the panel is covering the bottom-right corner of the viewer.
            className="fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom))] right-6 z-[260] flex flex-col items-end"
        >
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 20 }}
                        className="pointer-events-auto w-[350px] h-[500px] max-w-[calc(100vw-3rem)] max-h-[calc(100vh-6rem)] panel-thin flex flex-col overflow-hidden mb-4 shadow-2xl"
                    >
                        {/* Header */}
                        <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between bg-white/5">
                            <div className="flex items-center gap-1.5">
                                <BcfLogoIcon className="w-5 h-5" />
                                <h3 className="font-medium text-xs">BCF Topics</h3>
                            </div>
                            <div className="flex items-center gap-0.5">
                                <button
                                    onClick={() => projectId && exportBcfzip(projectId)}
                                    disabled={!projectId || topics.length === 0}
                                    className="p-1 hover:bg-white/10 rounded-md transition-colors text-zinc-400 disabled:opacity-30"
                                    title="Export all topics as .bcfzip"
                                >
                                    <Download className="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onClick={() => importInputRef.current?.click()}
                                    disabled={!projectId}
                                    className="p-1 hover:bg-white/10 rounded-md transition-colors text-zinc-400 disabled:opacity-30"
                                    title="Import a .bcfzip"
                                >
                                    <Upload className="w-3.5 h-3.5" />
                                </button>
                                <input ref={importInputRef} type="file" accept=".bcfzip,.zip" className="hidden" onChange={handleImportFile} />
                                <datalist id="bcf-assignee-options">
                                    {users.map((u) => <option key={u.guid} value={u.email} />)}
                                </datalist>
                                <button onClick={() => setIsOpen(false)} className="p-1 hover:bg-white/10 rounded-md transition-colors">
                                    <X className="w-3.5 h-3.5 text-zinc-400" />
                                </button>
                            </div>
                        </div>

                        {/* Body */}
                        <div className="flex-1 overflow-y-auto">
                            {!projectId ? (
                                <p className="text-xs text-zinc-500 px-4 py-6 text-center">
                                    Load a model to use BCF topics
                                </p>
                            ) : creating ? (
                                <div className="p-3 space-y-2">
                                    <button onClick={() => setCreating(false)} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200">
                                        <ChevronLeft className="w-3.5 h-3.5" /> Back
                                    </button>
                                    {pendingViewpoint?.snapshot_base64 ? (
                                        <div className="relative">
                                            <img
                                                src={`data:image/png;base64,${pendingViewpoint.snapshot_base64}`}
                                                alt="Captured viewpoint"
                                                className="w-full rounded-lg border border-white/10"
                                            />
                                            <button
                                                onClick={() => setMarkupMode('create')}
                                                className="absolute top-1.5 right-1.5 p-1.5 rounded-md bg-black/60 text-white hover:bg-amber-500 hover:text-black transition-colors"
                                                title="Annotate this screenshot"
                                            >
                                                <Pencil className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-2 text-xs px-2 py-1 rounded text-zinc-500 bg-white/5">
                                            <Camera className="w-3.5 h-3.5" />
                                            Capturing view…
                                        </div>
                                    )}
                                    <input
                                        value={newTitle}
                                        onChange={(e) => setNewTitle(e.target.value)}
                                        placeholder="Title"
                                        className="w-full px-2 py-1 text-sm rounded bg-black/20 border border-white/10 focus:border-amber-500/50 outline-none"
                                        autoFocus
                                    />
                                    <textarea
                                        value={newDescription}
                                        onChange={(e) => setNewDescription(e.target.value)}
                                        placeholder="Description (optional)"
                                        rows={3}
                                        className="w-full px-2 py-1 text-sm rounded bg-black/20 border border-white/10 focus:border-amber-500/50 outline-none resize-none"
                                    />
                                    <div className="flex gap-1.5">
                                        <select value={newType} onChange={(e) => setNewType(e.target.value)} className="flex-1 px-2 py-1 text-xs rounded bg-black/20 border border-white/10">
                                            {TOPIC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                                        </select>
                                        <select value={newStatus} onChange={(e) => setNewStatus(e.target.value)} className="flex-1 px-2 py-1 text-xs rounded bg-black/20 border border-white/10">
                                            {TOPIC_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                                        </select>
                                        <select value={newPriority} onChange={(e) => setNewPriority(e.target.value)} className="flex-1 px-2 py-1 text-xs rounded bg-black/20 border border-white/10">
                                            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                                        </select>
                                    </div>
                                    <div className="flex gap-1.5">
                                        <input
                                            value={newAssignedTo}
                                            onChange={(e) => setNewAssignedTo(e.target.value)}
                                            placeholder="Assigned to"
                                            list="bcf-assignee-options"
                                            className="flex-1 min-w-0 px-2 py-1 text-xs rounded bg-black/20 border border-white/10 focus:border-amber-500/50 outline-none"
                                        />
                                        <input
                                            type="date"
                                            value={newDueDate}
                                            onChange={(e) => setNewDueDate(e.target.value)}
                                            className="px-2 py-1 text-xs rounded bg-black/20 border border-white/10 focus:border-amber-500/50 outline-none"
                                        />
                                    </div>
                                    <button
                                        onClick={submitNewTopic}
                                        disabled={!newTitle.trim()}
                                        className="w-full py-1 text-xs rounded bg-amber-500 text-black font-medium disabled:opacity-40"
                                    >
                                        Create Topic
                                    </button>
                                </div>
                            ) : selectedTopic ? (
                                <div className="p-3 space-y-2">
                                    <button onClick={() => setSelectedTopic(null)} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200">
                                        <ChevronLeft className="w-3.5 h-3.5" /> Back
                                    </button>
                                    <div className="flex items-start justify-between gap-2">
                                        <h4 className="text-xs font-medium text-zinc-200">{selectedTopic.title}</h4>
                                        <button onClick={() => removeTopic(selectedTopic)} className="text-zinc-500 hover:text-red-400 shrink-0">
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                        {selectedTopic.topic_status && (
                                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_COLOR[selectedTopic.topic_status] || 'bg-zinc-700 text-zinc-300'}`}>
                                                {selectedTopic.topic_status}
                                            </span>
                                        )}
                                        {selectedTopic.topic_type && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-zinc-300">{selectedTopic.topic_type}</span>}
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <label className="text-[10px] text-zinc-500 shrink-0">Priority</label>
                                        <select
                                            value={selectedTopic.priority || ''}
                                            onChange={(e) => updateTopicField(selectedTopic, { priority: e.target.value || null })}
                                            className={`text-[10px] px-1.5 py-0.5 rounded border-none outline-none ${PRIORITY_COLOR[selectedTopic.priority] || 'bg-white/10 text-zinc-300'}`}
                                        >
                                            <option value="">Unset</option>
                                            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                                        </select>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <label className="text-[10px] text-zinc-500 shrink-0">Due date</label>
                                        <input
                                            type="date"
                                            value={selectedTopic.due_date ? selectedTopic.due_date.slice(0, 10) : ''}
                                            onChange={(e) => updateTopicField(selectedTopic, {
                                                due_date: e.target.value ? new Date(e.target.value).toISOString() : null,
                                            })}
                                            className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-zinc-300 outline-none"
                                        />
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <label className="text-[10px] text-zinc-500 shrink-0">Assigned to</label>
                                        <input
                                            value={selectedTopic.assigned_to || ''}
                                            onChange={(e) => updateTopicField(selectedTopic, { assigned_to: e.target.value || null })}
                                            placeholder="Unassigned"
                                            list="bcf-assignee-options"
                                            className="flex-1 text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-zinc-300 outline-none placeholder:text-zinc-500"
                                        />
                                    </div>
                                    {selectedTopic.description && <p className="text-xs text-zinc-400 whitespace-pre-wrap">{selectedTopic.description}</p>}
                                    <p className="text-[10px] text-zinc-500">{selectedTopic.creation_author} · {new Date(selectedTopic.creation_date).toLocaleString()}</p>
                                    {snapshotUrl ? (
                                        <div className="relative">
                                            <img src={snapshotUrl} className="w-full rounded-lg border border-white/10" alt="Viewpoint snapshot" />
                                            <div className="absolute top-1.5 right-1.5 flex gap-1">
                                                <button
                                                    onClick={openEditViewpoint}
                                                    className="p-1.5 rounded-md bg-black/60 text-white hover:bg-amber-500 hover:text-black transition-colors"
                                                    title="Continue annotating this saved viewpoint"
                                                >
                                                    <Pencil className="w-3.5 h-3.5" />
                                                </button>
                                                <button
                                                    onClick={openAddViewpoint}
                                                    className="p-1.5 rounded-md bg-black/60 text-white hover:bg-amber-500 hover:text-black transition-colors"
                                                    title="Capture and annotate a new viewpoint from the current view"
                                                >
                                                    <Camera className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <button
                                            onClick={openAddViewpoint}
                                            className="w-full flex items-center justify-center gap-1.5 text-xs px-2 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-zinc-200 transition-colors border border-dashed border-white/10"
                                        >
                                            <Camera className="w-3.5 h-3.5" /> Add viewpoint
                                        </button>
                                    )}

                                    <div className="border-t border-white/10 pt-2 space-y-1.5">
                                        {topicComments.map((c) => (
                                            <div key={c.guid} className="text-xs bg-white/5 rounded-md p-1.5">
                                                <p className="text-zinc-300 whitespace-pre-wrap">{c.comment}</p>
                                                <p className="text-[10px] text-zinc-500 mt-1">{c.author} · {new Date(c.date).toLocaleString()}</p>
                                            </div>
                                        ))}
                                        <div className="flex gap-1.5">
                                            <input
                                                value={newComment}
                                                onChange={(e) => setNewComment(e.target.value)}
                                                onKeyDown={(e) => { if (e.key === 'Enter') submitComment() }}
                                                placeholder="Add a comment…"
                                                className="flex-1 px-2 py-1 text-xs rounded bg-black/20 border border-white/10 focus:border-amber-500/50 outline-none"
                                            />
                                            <button onClick={submitComment} disabled={!newComment.trim()} className="p-1 rounded-md bg-amber-500/20 text-amber-400 disabled:opacity-30">
                                                <Send className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="p-1.5">
                                    {error && <p className="text-xs text-red-400 px-2 py-2">{error}</p>}
                                    {topics.length === 0 && (
                                        <p className="text-xs text-zinc-500 px-2 py-6 text-center">No BCF topics yet</p>
                                    )}
                                    {topics.slice(0, visibleTopicCount).map((t) => (
                                        <button
                                            key={t.guid}
                                            onClick={() => openTopic(t)}
                                            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-white/5 transition-colors flex items-start gap-2"
                                        >
                                            <Flag className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
                                            <div className="min-w-0 flex-1">
                                                <p className="text-xs font-medium text-zinc-200 truncate">{t.title}</p>
                                                <div className="flex items-center gap-1 mt-0.5">
                                                    {t.topic_status && (
                                                        <span className={`text-[9px] px-1 py-0.5 rounded ${STATUS_COLOR[t.topic_status] || 'bg-zinc-700 text-zinc-300'}`}>
                                                            {t.topic_status}
                                                        </span>
                                                    )}
                                                    <span className="text-[10px] text-zinc-500 truncate">
                                                        {t.creation_author}{t.assigned_to ? ` → ${t.assigned_to}` : ''}
                                                    </span>
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                    {topics.length > visibleTopicCount && (
                                        <button
                                            onClick={() => setVisibleTopicCount((n) => n + TOPIC_PAGE_SIZE)}
                                            className="w-full text-center px-2 py-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                                        >
                                            Show {Math.min(TOPIC_PAGE_SIZE, topics.length - visibleTopicCount)} more ({topics.length - visibleTopicCount} remaining)
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* New Topic button */}
                        {projectId && !creating && !selectedTopic && (
                            <div className="p-2 border-t border-white/10">
                                <button
                                    onClick={startCreating}
                                    className="w-full flex items-center justify-center gap-1.5 py-1 text-xs rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors"
                                >
                                    <Plus className="w-3.5 h-3.5" /> New Topic from current view
                                </button>
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {markupMode === 'create' && pendingViewpoint?.snapshot_base64 && (
                    <ViewpointMarkupEditor
                        imageBase64={pendingViewpoint.snapshot_base64}
                        onSave={handleMarkupSave}
                        onCancel={handleMarkupCancel}
                    />
                )}
                {markupMode === 'add-viewpoint' && addViewpointDraft?.snapshot_base64 && (
                    <ViewpointMarkupEditor
                        imageBase64={addViewpointDraft.snapshot_base64}
                        onSave={handleMarkupSave}
                        onCancel={handleMarkupCancel}
                    />
                )}
            </AnimatePresence>

            <motion.button
                whileHover={{ scale: isOpen ? 1 : 1.08 }}
                whileTap={{ scale: 0.94 }}
                onClick={() => setIsOpen((v) => !v)}
                disabled={!projectId}
                title={!projectId ? 'Load a model first' : 'BCF Topics'}
                className="w-12 h-12 rounded-full border border-amber-500/40 backdrop-blur-md shadow-xl flex items-center justify-center transition-colors hover:bg-amber-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
            >
                <BcfLogoIcon className="w-8 h-8" />
            </motion.button>
        </motion.div>
    )
}
