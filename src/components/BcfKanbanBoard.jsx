import { useState, useEffect, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { X, Trash2, ImageOff, ChevronLeft, Send, ExternalLink, Camera, Pencil } from 'lucide-react'
import {
    updateTopic, deleteTopic, listComments, createComment,
    listViewpoints, createViewpoint, getSnapshotUrl, blobUrlToBase64, listUsers,
} from '../utils/bcfClient'
import {
    COLUMNS, topicToColumn, columnToUpdates,
    PRIORITIES, PRIORITY_COLOR, PRIORITY_BORDER, priorityRank, isOverdue,
} from '../utils/bcfWorkflow'
import { archiveLinkedSpeckleComment } from '../utils/bcfSync'
import { BcfLogoIcon } from './BcfLogoIcon'
import { ViewpointMarkupEditor } from './ViewpointMarkupEditor'
import { useAuth } from '../contexts/AuthContext'

const COLUMN_COLOR = {
    Backlog: { border: 'border-zinc-400/50', bg: 'bg-zinc-400/10', text: 'text-zinc-300', badge: 'bg-zinc-400/20 text-zinc-200' },
    'To Do': { border: 'border-amber-500/50', bg: 'bg-amber-500/10', text: 'text-amber-300', badge: 'bg-amber-500/25 text-amber-300' },
    'In Progress': { border: 'border-blue-500/50', bg: 'bg-blue-500/10', text: 'text-blue-300', badge: 'bg-blue-500/25 text-blue-300' },
    Review: { border: 'border-purple-500/50', bg: 'bg-purple-500/10', text: 'text-purple-300', badge: 'bg-purple-500/25 text-purple-300' },
    Done: { border: 'border-emerald-500/50', bg: 'bg-emerald-500/10', text: 'text-emerald-300', badge: 'bg-emerald-500/25 text-emerald-300' },
}

function Column({ id, title, count, children }) {
    const { setNodeRef, isOver } = useDroppable({ id })
    const colors = COLUMN_COLOR[title]
    return (
        <div
            ref={setNodeRef}
            className={`flex flex-col gap-2 flex-1 min-w-[260px] rounded-xl border-2 p-3 transition-colors ${
                isOver ? 'border-amber-400/80 bg-amber-400/15' : (colors ? `${colors.border} ${colors.bg}` : 'border-[var(--speckle-outline-3)]')
            }`}
        >
            <div className="flex items-center justify-between px-1 shrink-0">
                <h3 className={`text-xs font-bold uppercase tracking-wider ${colors?.text || 'text-[var(--speckle-foreground-2)]'}`}>{title}</h3>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${colors?.badge || 'bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]'}`}>{count}</span>
            </div>
            <div className="flex flex-col gap-2 overflow-y-auto flex-1 min-h-[120px] pr-0.5">
                {children}
                {count === 0 && (
                    <div className="text-[11px] text-[var(--speckle-foreground-disabled)] text-center py-6">No issues</div>
                )}
            </div>
        </div>
    )
}

function CardContent({ topic, snapshotUrl, onOpen, onDelete, grabbing }) {
    const overdue = isOverdue(topic)
    return (
        <div className={`glass-card p-0 overflow-hidden group border-l-2 ${PRIORITY_BORDER[topic.priority] || 'border-l-transparent'} ${grabbing ? 'cursor-grabbing shadow-2xl' : 'cursor-grab'}`}>
            <div
                className="aspect-video bg-[var(--speckle-outline-3)] flex items-center justify-center overflow-hidden"
                onClick={() => onOpen?.(topic)}
            >
                {snapshotUrl
                    ? <img src={snapshotUrl} className="w-full h-full object-cover" alt="" />
                    : <ImageOff className="w-5 h-5 text-[var(--speckle-foreground-disabled)]" />}
            </div>
            <div className="p-2.5" onClick={() => onOpen?.(topic)}>
                <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-medium text-[var(--speckle-foreground)] line-clamp-2">{topic.title}</p>
                    <button
                        onPointerDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); onDelete?.(topic) }}
                        className="opacity-0 group-hover:opacity-100 text-[var(--speckle-foreground-3)] hover:text-red-400 transition-opacity shrink-0"
                        title="Delete"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </div>
                <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                    {topic.priority && <span className={`text-[9px] px-1 py-0.5 rounded ${PRIORITY_COLOR[topic.priority] || 'bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]'}`}>{topic.priority}</span>}
                    {topic.topic_type && <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]">{topic.topic_type}</span>}
                    {topic.due_date && (
                        <span className={`text-[9px] px-1 py-0.5 rounded ${overdue ? 'bg-red-500/20 text-red-400' : 'bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]'}`}>
                            {overdue ? 'Overdue · ' : ''}{new Date(topic.due_date).toLocaleDateString()}
                        </span>
                    )}
                </div>
                <p className="text-[10px] text-[var(--speckle-foreground-3)] mt-1 truncate">
                    {topic.creation_author}{topic.assigned_to ? ` → ${topic.assigned_to}` : ''}
                </p>
            </div>
        </div>
    )
}

// No transform on the original node — it stays in place and just dims while
// dragging. The visible "follows the cursor" copy is rendered separately via
// <DragOverlay> (a body-level portal), which avoids being clipped by the
// column's overflow-y-auto the way an in-place transform would be.
function Card({ topic, snapshotUrl, onOpen, onDelete }) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: topic.guid })

    return (
        <div ref={setNodeRef} {...listeners} {...attributes} className={isDragging ? 'opacity-30' : ''}>
            <CardContent topic={topic} snapshotUrl={snapshotUrl} onOpen={onOpen} onDelete={onDelete} />
        </div>
    )
}

// Full-screen Kanban admin view over the BCF topics already loaded by
// BcfTopicPanel (same `topics`/`onTopicsChange` — single source of truth,
// no separate fetch). Reachable as a web overlay, not a separate app.
export function BcfKanbanBoard({ projectId, viewerRef, topics = [], streamId = null, onTopicsChange, onClose, serverUrl, serverToken }) {
    const { user } = useAuth()
    const [snapshots, setSnapshots] = useState({})
    const [viewpoints, setViewpoints] = useState({})
    const [selectedTopic, setSelectedTopic] = useState(null)
    const [topicComments, setTopicComments] = useState([])
    const [newComment, setNewComment] = useState('')
    const [activeTopic, setActiveTopic] = useState(null)
    const [addingViewpoint, setAddingViewpoint] = useState(false) // markup editor open for selectedTopic
    const [addViewpointDraft, setAddViewpointDraft] = useState(null) // freshly captured viewpoint pending annotation

    // Registered bcf_users, for the "Assigned to" datalist — same source as
    // BcfTopicPanel's create form.
    const [users, setUsers] = useState([])
    useEffect(() => {
        listUsers().then(setUsers).catch(() => setUsers([]))
    }, [])

    // Lazy-load each topic's first viewpoint (snapshot + the raw viewpoint,
    // the latter so opening a card can fly the viewer there), once per topic
    // guid — re-runs only for topics not already in `snapshots` so a status
    // drag (which replaces the `topics` array) doesn't re-fetch everything.
    useEffect(() => {
        if (!projectId) return
        const missing = topics.filter(t => !(t.guid in snapshots))
        if (missing.length === 0) return
        let cancelled = false
        ;(async () => {
            const entries = await Promise.all(missing.map(async (t) => {
                try {
                    const vps = await listViewpoints(projectId, t.guid)
                    const vp = vps?.[vps.length - 1] // most recently added viewpoint, not the first
                    if (!vp) return [t.guid, null, null]
                    const url = await getSnapshotUrl(projectId, t.guid, vp.guid)
                    return [t.guid, url, vp]
                } catch {
                    return [t.guid, null, null]
                }
            }))
            if (cancelled) return
            setSnapshots(prev => ({ ...prev, ...Object.fromEntries(entries.map(([guid, url]) => [guid, url])) }))
            setViewpoints(prev => ({ ...prev, ...Object.fromEntries(entries.map(([guid, , vp]) => [guid, vp])) }))
        })()
        return () => { cancelled = true }
    }, [projectId, topics, snapshots])

    // Revoke all snapshot blob URLs when the board closes.
    useEffect(() => () => {
        Object.values(snapshots).forEach(url => { if (url) URL.revokeObjectURL(url) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const columns = useMemo(() => {
        const map = {}
        COLUMNS.forEach(c => { map[c] = [] })
        topics.forEach(t => { map[topicToColumn(t)].push(t) })
        // Critical-first within each column; ties broken by soonest due date
        // (unset due dates sort last), then newest first.
        const dueTime = (t) => (t.due_date ? new Date(t.due_date).getTime() : Infinity)
        Object.values(map).forEach((items) => items.sort((a, b) =>
            priorityRank(b) - priorityRank(a)
            || dueTime(a) - dueTime(b)
            || new Date(b.creation_date) - new Date(a.creation_date)
        ))
        return map
    }, [topics])

    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

    const handleDragStart = useCallback((event) => {
        setActiveTopic(topics.find(t => t.guid === event.active.id) || null)
    }, [topics])

    const handleDragEnd = useCallback((event) => {
        setActiveTopic(null)
        const { active, over } = event
        if (!over) return
        const topicGuid = active.id
        const newColumn = over.id
        const topic = topics.find(t => t.guid === topicGuid)
        if (!topic || topicToColumn(topic) === newColumn) return
        const prevFields = { topic_status: topic.topic_status, stage: topic.stage }
        const updates = columnToUpdates(newColumn)
        onTopicsChange(topics.map(t => (t.guid === topicGuid ? { ...t, ...updates } : t)))
        updateTopic(projectId, topicGuid, updates).catch(() => {
            onTopicsChange(topics.map(t => (t.guid === topicGuid ? { ...t, ...prevFields } : t)))
        })
    }, [topics, projectId, onTopicsChange])

    // Same optimistic-update-with-rollback shape as handleDragEnd above, but
    // for arbitrary field edits (priority/due_date) made from the detail
    // panel rather than a column drop. Also patches selectedTopic so the open
    // panel reflects the change immediately instead of waiting for a re-open.
    const updateTopicField = useCallback((topic, updates) => {
        const prevFields = Object.fromEntries(Object.keys(updates).map((k) => [k, topic[k]]))
        const apply = (fields) => {
            onTopicsChange(topics.map(t => (t.guid === topic.guid ? { ...t, ...fields } : t)))
            setSelectedTopic(prev => (prev && prev.guid === topic.guid ? { ...prev, ...fields } : prev))
        }
        apply(updates)
        updateTopic(projectId, topic.guid, updates).catch(() => apply(prevFields))
    }, [topics, projectId, onTopicsChange])

    const openTopic = async (topic) => {
        setSelectedTopic(topic)
        const vp = viewpoints[topic.guid]
        if (vp) viewerRef?.current?.restoreBcfViewpoint(vp, topic.guid)
        try { setTopicComments(await listComments(projectId, topic.guid)) }
        catch { setTopicComments([]) }
    }

    const handleClose = () => {
        try { viewerRef?.current?.resetFilter() } catch {}
        onClose?.()
    }

    // Captures a fresh viewpoint from the current 3D view and opens the
    // markup editor on it, for adding a (possibly annotated) second
    // viewpoint to an already-existing topic.
    const openAddViewpoint = async () => {
        if (!selectedTopic || !projectId) return
        try {
            const vp = await viewerRef?.current?.captureViewpoint()
            if (!vp?.snapshot_base64) return
            setAddViewpointDraft(vp)
            setAddingViewpoint(true)
        } catch (e) {
            console.warn('Could not capture viewpoint:', e)
        }
    }

    // Loads the topic's *existing* saved viewpoint image (annotations and
    // all) back into the markup editor for further annotation — distinct
    // from openAddViewpoint(), which always starts from a brand-new capture
    // of whatever the 3D view currently shows. Saving still creates a new
    // viewpoint (camera/selection unchanged, only the image differs),
    // preserving BCF viewpoint history rather than mutating this one in place.
    const openEditViewpoint = async () => {
        const existing = viewpoints[selectedTopic?.guid]
        const currentSnapshotUrl = snapshots[selectedTopic?.guid]
        if (!existing || !currentSnapshotUrl) return
        try {
            const base64 = await blobUrlToBase64(currentSnapshotUrl)
            const {
                camera_view_point, camera_direction, camera_up_vector,
                field_of_view, view_to_world_scale, is_orthogonal, clipping_planes, selection,
            } = existing
            setAddViewpointDraft({
                camera_view_point, camera_direction, camera_up_vector,
                field_of_view, view_to_world_scale, is_orthogonal, clipping_planes, selection,
                snapshot_base64: base64,
            })
            setAddingViewpoint(true)
        } catch (e) {
            console.warn('Could not load existing viewpoint for editing:', e)
        }
    }

    const handleMarkupSave = async (newBase64) => {
        if (addViewpointDraft && selectedTopic) {
            try {
                const viewpoint = await createViewpoint(projectId, selectedTopic.guid, { ...addViewpointDraft, snapshot_base64: newBase64 })
                setViewpoints(prev => ({ ...prev, [selectedTopic.guid]: viewpoint }))
                setSnapshots(prev => {
                    const old = prev[selectedTopic.guid]
                    if (old) URL.revokeObjectURL(old)
                    return { ...prev, [selectedTopic.guid]: `data:image/png;base64,${newBase64}` }
                })
            } catch (e) {
                console.warn('Could not add viewpoint:', e)
            }
        }
        setAddViewpointDraft(null)
        setAddingViewpoint(false)
    }

    const handleMarkupCancel = () => {
        setAddViewpointDraft(null)
        setAddingViewpoint(false)
    }

    const removeTopic = async (topic) => {
        // Best-effort: archive the linked Speckle comment first — see
        // BcfTopicPanel.jsx's removeTopic for why (Speckle has no real
        // comment delete, only archive, and a failure here must not block
        // the actual BCF-side deletion).
        if (streamId) {
            try {
                await archiveLinkedSpeckleComment(projectId, topic.guid, streamId, { serverUrl, token: serverToken })
            } catch (err) {
                console.warn('Could not archive linked Speckle comment:', err)
            }
        }
        try {
            await deleteTopic(projectId, topic.guid)
            onTopicsChange(topics.filter(t => t.guid !== topic.guid))
            if (selectedTopic?.guid === topic.guid) setSelectedTopic(null)
        } catch (e) {
            console.warn('Could not delete topic:', e)
        }
    }

    const submitComment = async () => {
        if (!newComment.trim() || !selectedTopic) return
        const authorName = user?.name || 'Dashboard User'
        try {
            const comment = await createComment(projectId, selectedTopic.guid, { comment: newComment.trim(), author: authorName })
            setTopicComments(prev => [...prev, comment])
            setNewComment('')
        } catch (e) {
            console.warn('Could not add comment:', e)
        }
    }

    return (
        <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200000] flex flex-col"
            style={{ backgroundColor: 'var(--speckle-foundation-page)' }}
        >
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--speckle-outline-3)] shrink-0">
                <div className="flex items-center gap-2">
                    <BcfLogoIcon className="w-6 h-6" />
                    <h2 className="font-semibold text-sm text-[var(--speckle-foreground)]">BCF Issue Board</h2>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => window.open('/admin', '_blank', 'noopener,noreferrer')}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-3)] hover:text-[var(--speckle-foreground)] transition-colors"
                        title="Open the bcf-server admin panel in a new window"
                    >
                        <ExternalLink className="w-3.5 h-3.5" /> Admin
                    </button>
                    <button onClick={handleClose} className="p-1.5 hover:bg-[var(--speckle-outline-3)] rounded-lg transition-colors">
                        <X className="w-4 h-4 text-[var(--speckle-foreground-3)]" />
                    </button>
                </div>
            </div>

            <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveTopic(null)}>
                <div className="flex-1 overflow-x-auto overflow-y-hidden flex gap-4 p-5">
                    {Object.entries(columns).map(([status, items]) => (
                        <Column key={status} id={status} title={status} count={items.length}>
                            {items.map(t => (
                                <Card key={t.guid} topic={t} snapshotUrl={snapshots[t.guid]} onOpen={openTopic} onDelete={removeTopic} />
                            ))}
                        </Column>
                    ))}
                </div>
                <DragOverlay dropAnimation={null}>
                    {activeTopic && (
                        <div className="w-[276px]">
                            <CardContent topic={activeTopic} snapshotUrl={snapshots[activeTopic.guid]} grabbing />
                        </div>
                    )}
                </DragOverlay>
            </DndContext>

            {/* Topic detail slide-over */}
            {selectedTopic && (
                <motion.div
                    initial={{ x: 360 }} animate={{ x: 0 }} exit={{ x: 360 }}
                    transition={{ duration: 0.18 }}
                    className="absolute top-0 right-0 h-full w-[360px] max-w-[calc(100vw-2rem)] glass-card rounded-none border-l border-[var(--speckle-outline-3)] flex flex-col overflow-hidden"
                >
                    <div className="p-4 border-b border-[var(--speckle-outline-3)] flex items-center justify-between shrink-0">
                        <button onClick={() => setSelectedTopic(null)} className="flex items-center gap-1 text-xs text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)]">
                            <ChevronLeft className="w-3.5 h-3.5" /> Back
                        </button>
                        <button onClick={() => removeTopic(selectedTopic)} className="text-[var(--speckle-foreground-3)] hover:text-red-400">
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-3">
                        {snapshots[selectedTopic.guid] ? (
                            <div className="relative">
                                <img src={snapshots[selectedTopic.guid]} className="w-full rounded-lg border border-[var(--speckle-outline-3)]" alt="" />
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
                                className="w-full flex items-center justify-center gap-1.5 text-xs px-2 py-2 rounded-lg bg-[var(--speckle-outline-3)]/50 hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] transition-colors border border-dashed border-[var(--speckle-outline-3)]"
                            >
                                <Camera className="w-3.5 h-3.5" /> Add viewpoint
                            </button>
                        )}
                        <h4 className="text-sm font-semibold text-[var(--speckle-foreground)]">{selectedTopic.title}</h4>
                        <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">{topicToColumn(selectedTopic)}</span>
                            {selectedTopic.topic_type && <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)]">{selectedTopic.topic_type}</span>}
                        </div>
                        <div className="flex items-center gap-3">
                            <label className="text-[10px] text-[var(--speckle-foreground-3)] shrink-0">Priority</label>
                            <select
                                value={selectedTopic.priority || ''}
                                onChange={(e) => updateTopicField(selectedTopic, { priority: e.target.value || null })}
                                className={`text-[10px] px-1.5 py-0.5 rounded border-none outline-none ${PRIORITY_COLOR[selectedTopic.priority] || 'bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)]'}`}
                            >
                                <option value="">Unset</option>
                                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                            </select>
                        </div>
                        <div className="flex items-center gap-3">
                            <label className="text-[10px] text-[var(--speckle-foreground-3)] shrink-0">Due date</label>
                            <input
                                type="date"
                                value={selectedTopic.due_date ? selectedTopic.due_date.slice(0, 10) : ''}
                                onChange={(e) => updateTopicField(selectedTopic, {
                                    due_date: e.target.value ? new Date(e.target.value).toISOString() : null,
                                })}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] outline-none"
                            />
                        </div>
                        <div className="flex items-center gap-3">
                            <label className="text-[10px] text-[var(--speckle-foreground-3)] shrink-0">Assigned to</label>
                            <input
                                value={selectedTopic.assigned_to || ''}
                                onChange={(e) => updateTopicField(selectedTopic, { assigned_to: e.target.value || null })}
                                placeholder="Unassigned"
                                list="bcf-assignee-options"
                                className="flex-1 text-[10px] px-1.5 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] outline-none placeholder:text-[var(--speckle-foreground-disabled)]"
                            />
                            <datalist id="bcf-assignee-options">
                                {users.map((u) => <option key={u.guid} value={u.email} />)}
                            </datalist>
                        </div>
                        {selectedTopic.description && <p className="text-xs text-[var(--speckle-foreground-3)] whitespace-pre-wrap">{selectedTopic.description}</p>}
                        <p className="text-[10px] text-[var(--speckle-foreground-3)]">{selectedTopic.creation_author} · {new Date(selectedTopic.creation_date).toLocaleString()}</p>

                        <div className="border-t border-[var(--speckle-outline-3)] pt-3 space-y-2">
                            {topicComments.map(c => (
                                <div key={c.guid} className="text-xs bg-[var(--speckle-outline-3)] rounded-lg p-2">
                                    <p className="text-[var(--speckle-foreground-2)] whitespace-pre-wrap">{c.comment}</p>
                                    <p className="text-[10px] text-[var(--speckle-foreground-3)] mt-1">{c.author} · {new Date(c.date).toLocaleString()}</p>
                                </div>
                            ))}
                            <div className="flex gap-1.5">
                                <input
                                    value={newComment}
                                    onChange={e => setNewComment(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') submitComment() }}
                                    placeholder="Add a comment…"
                                    className="flex-1 px-2.5 py-1.5 text-xs rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] focus:border-amber-500/50 outline-none"
                                />
                                <button onClick={submitComment} disabled={!newComment.trim()} className="p-1.5 rounded bg-amber-500/20 text-amber-400 disabled:opacity-30">
                                    <Send className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    </div>
                </motion.div>
            )}

            <AnimatePresence>
                {addingViewpoint && addViewpointDraft?.snapshot_base64 && (
                    <ViewpointMarkupEditor
                        imageBase64={addViewpointDraft.snapshot_base64}
                        onSave={handleMarkupSave}
                        onCancel={handleMarkupCancel}
                    />
                )}
            </AnimatePresence>
        </motion.div>
    )
}
