import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react'
import {
    Calendar, Upload, Download, ChevronRight, ChevronDown,
    AlertCircle, Link, Link2Off, Plus, X, Pencil, Trash2, Flame, CalendarPlus
} from 'lucide-react'
import { GenerateScheduleDialog } from './GenerateScheduleDialog'

const GANTT_PX = 560
const MS_PER_DAY = 86_400_000
const DEP_TYPE_LABELS = { FINISH_START: 'FS', START_START: 'SS', FINISH_FINISH: 'FF', START_FINISH: 'SF' }

function safeParseDateMs(dateStr) {
    if (!dateStr) return null
    const ms = Date.parse(dateStr)
    return isNaN(ms) ? null : ms
}

function datePct(dateStr, projectStartMs, projectDuration) {
    if (!projectStartMs || !projectDuration) return null
    const ms = safeParseDateMs(dateStr)
    if (ms === null) return null
    return Math.max(0, Math.min(100, ((ms - projectStartMs) / projectDuration) * 100))
}

// ms → percent-of-timeline, same clamping as datePct but for an epoch ms
// value already in hand (drag preview dates) instead of a date string.
function msPct(ms, projectStartMs, projectDuration) {
    if (ms === null || !projectStartMs || !projectDuration) return null
    return Math.max(0, Math.min(100, ((ms - projectStartMs) / projectDuration) * 100))
}

// planned_start/finish are DATE columns (no time-of-day) — this must match
// the plain 'YYYY-MM-DD' shape the <input type="date"> edit form already
// sends the PATCH endpoint (see handleSaveEdit), not a full ISO datetime.
function toDateOnlyIso(ms) {
    const d = new Date(ms)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fmtDate(dateStr) {
    const ms = safeParseDateMs(dateStr)
    if (ms === null) return '—'
    return new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
}

function fmtDateLong(dateStr) {
    const ms = safeParseDateMs(dateStr)
    if (ms === null) return '—'
    return new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
}

function monthLabels(projectStartMs, projectEndMs, projectDuration) {
    if (!projectStartMs || !projectEndMs || !projectDuration) return []
    const labels = []
    const d = new Date(projectStartMs)
    d.setDate(1)
    while (d.getTime() <= projectEndMs) {
        const pct = ((d.getTime() - projectStartMs) / projectDuration) * 100
        if (pct >= 0 && pct <= 100) {
            labels.push({
                label: d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }),
                pct: Math.max(0, pct),
            })
        }
        d.setMonth(d.getMonth() + 1)
    }
    return labels
}

// Standard Gantt elbow connector: out of the predecessor's right edge, a
// short horizontal run, a vertical jog to the successor's row, then into its
// left edge — the conventional visual for FS/SS/FF/SF dependency arrows.
function elbowPath(x1, y1, x2, y2) {
    const midX = x2 > x1 + 12 ? x1 + (x2 - x1) / 2 : x1 + 10
    return `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`
}

// Direct-manipulation drag/resize for Gantt bars, mirroring ifc-lite's
// useGanttBarDrag.ts (three modes: shift the whole bar, or resize from
// either edge) but adapted to our percent-of-GANTT_PX layout and DATE-only
// (no time-of-day) columns — snapping is always to whole days, there's no
// scale concept to snap finer against. `onBarPointerDown` is called with
// (event, mode); TaskBar itself renders the hit-zones but never talks to
// the network directly — that lives in the parent's startBarDrag.
function TaskBar({ task, leftPct, widthPct, isActive, isDragging, onBarPointerDown }) {
    const isSummary = !task.parent_task_id
    const colorClass =
        task.is_critical                    ? 'bg-red-500/80' :
        task.status === 'COMPLETED'         ? 'bg-green-500/70' :
        task.status === 'INPROGRESS'        ? 'bg-blue-500/70' :
        isSummary                           ? 'bg-amber-500/55' :
                                              'bg-amber-400/40'

    if (task.is_milestone) {
        return (
            <div className="relative h-5 w-full">
                <div
                    onPointerDown={(e) => onBarPointerDown(e, 'shift')}
                    title={`${fmtDateLong(task.planned_start)} — drag to move`}
                    className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rotate-45 cursor-grab active:cursor-grabbing ${
                        task.is_critical ? 'bg-red-400' : 'bg-amber-400'
                    } ${isActive ? 'ring-1 ring-white' : ''} ${isDragging ? 'ring-2 ring-cyan-400' : ''}`}
                    style={{ left: `${leftPct}%` }}
                />
            </div>
        )
    }

    // Edge hit-zones for resize, in px then converted to %-of-GANTT_PX — same
    // "min 4px, cap at 25% of bar width" rule as ifc-lite's GanttTaskBar, so
    // very short bars don't get unreachable edge zones. Below that floor the
    // whole bar is shift-only (resizing a task that thin isn't practical by
    // mouse anyway; the Edit form still works).
    const barWidthPx = (widthPct / 100) * GANTT_PX
    const edgeZonePx = Math.min(8, Math.max(4, barWidthPx * 0.25))
    const edgeZonePct = widthPct > 0 ? (edgeZonePx / GANTT_PX) * 100 : 0
    const showEdgeHandles = barWidthPx >= edgeZonePx * 2 + 4

    return (
        <div className="relative h-5 w-full">
            <div
                title={`${fmtDateLong(task.planned_start)} → ${fmtDateLong(task.planned_finish)}`}
                className={`absolute inset-y-1 rounded-sm ${colorClass} ${
                    isActive ? 'ring-1 ring-amber-300' : ''
                } ${isSummary ? 'rounded' : ''} ${isDragging ? 'ring-2 ring-cyan-400' : ''}`}
                style={{ left: `${leftPct}%`, width: `${Math.max(0.4, widthPct)}%`, minWidth: 4 }}
            />
            <div
                className="absolute inset-y-0 cursor-move"
                style={{
                    left: `${leftPct + (showEdgeHandles ? edgeZonePct : 0)}%`,
                    width: `${Math.max(0.4, widthPct - (showEdgeHandles ? edgeZonePct * 2 : 0))}%`,
                    minWidth: 4,
                }}
                onPointerDown={(e) => onBarPointerDown(e, 'shift')}
            />
            {showEdgeHandles && (
                <>
                    <div
                        className="absolute inset-y-0 cursor-ew-resize"
                        style={{ left: `${leftPct}%`, width: `${edgeZonePct}%`, minWidth: 4 }}
                        onPointerDown={(e) => onBarPointerDown(e, 'resize-start')}
                    />
                    <div
                        className="absolute inset-y-0 cursor-ew-resize"
                        style={{ left: `${leftPct + widthPct - edgeZonePct}%`, width: `${edgeZonePct}%`, minWidth: 4 }}
                        onPointerDown={(e) => onBarPointerDown(e, 'resize-finish')}
                    />
                </>
            )}
        </div>
    )
}

// WBS/Gantt authoring view: task tree, dependency arrows + CRUD, critical-path
// display (computed server-side by bim-normalizer's db/cpm.py — this
// component only ever renders is_critical/float_days, never computes them),
// task<->element linking. The other half of the merged 4D planner is
// SchedulePlaybackView (build-up scrubber) — see SchedulePanel.jsx.
export function ScheduleGanttView({ normalizerModelId, normalizerUrl, onFilterElements, viewerSelectedIds, storeyCounts }) {
    const [schedule, setSchedule]     = useState(null)
    const [loading, setLoading]       = useState(false)
    const [error, setError]           = useState(null)
    const [uploading, setUploading]   = useState(false)
    const [showGenerate, setShowGenerate] = useState(false)
    // { taskId, startMs, finishMs } while a bar is being dragged/resized —
    // see startBarDrag. Live-overrides that task's rendered position; null
    // the rest of the time.
    const [dragPreview, setDragPreview] = useState(null)
    const [collapsed, setCollapsed]   = useState(new Set())
    const [activeTaskId, setActiveTaskId] = useState(null)
    const [search, setSearch]         = useState('')
    const [showNewTask, setShowNewTask] = useState(false)
    const [newTaskName, setNewTaskName] = useState('')
    const [newTaskStart, setNewTaskStart] = useState('')
    const [newTaskFinish, setNewTaskFinish] = useState('')
    const [newTaskParent, setNewTaskParent] = useState('')
    const [newTaskWbs, setNewTaskWbs] = useState('')
    const [creatingTask, setCreatingTask] = useState(false)
    const [linking, setLinking] = useState(false)
    const [editingTask, setEditingTask] = useState(false)
    const [editName, setEditName] = useState('')
    const [editStart, setEditStart] = useState('')
    const [editFinish, setEditFinish] = useState('')
    const [editParent, setEditParent] = useState('')
    const [editWbs, setEditWbs] = useState('')
    const [savingEdit, setSavingEdit] = useState(false)
    const [deletingTask, setDeletingTask] = useState(false)
    const [deletingSchedule, setDeletingSchedule] = useState(false)
    const [criticalHighlighted, setCriticalHighlighted] = useState(false)
    const [showAddDep, setShowAddDep] = useState(null) // null | 'predecessor' | 'successor'
    const [depTargetId, setDepTargetId] = useState('')
    const [depType, setDepType] = useState('FINISH_START')
    const [depLag, setDepLag] = useState('')
    const [savingDep, setSavingDep] = useState(false)
    const [deletingDepId, setDeletingDepId] = useState(null)
    const fileInputRef = useRef(null)
    const base = (normalizerUrl || '').replace(/\/$/, '')

    // Dependency arrows (predecessor/successor links, see db/schedule.py) —
    // drawn as an SVG overlay since each row's Gantt bar lives in its own
    // <td>, not a shared canvas. X comes straight from leftPct/widthPct (no
    // DOM measurement needed, exact by construction); Y comes from each
    // row's actual rendered position via refs, which also naturally
    // accounts for sticky-column scroll state.
    const ganttContainerRef = useRef(null)
    const barRowRefs = useRef({})
    const [arrows, setArrows] = useState([])
    const [svgSize, setSvgSize] = useState({ width: 0, height: 0 })

    // Reset view state when the model changes so stale task IDs don't persist
    useEffect(() => {
        setCollapsed(new Set())
        setActiveTaskId(null)
        setSearch('')
        setError(null)
        setSchedule(null)
        setShowNewTask(false)
        setEditingTask(false)
        setCriticalHighlighted(false)
        setShowAddDep(null)
        setShowGenerate(false)
        setDragPreview(null)
    }, [normalizerModelId])

    // Union of speckle_ids across every critical-path task, for the "Critical Path" toggle
    const criticalElementIds = useMemo(() => {
        if (!schedule?.tasks?.length) return []
        const ids = new Set()
        for (const t of schedule.tasks) {
            if (t.is_critical) {
                for (const id of (t.speckle_ids || [])) ids.add(id)
            }
        }
        return Array.from(ids)
    }, [schedule])

    const toggleCriticalPath = () => {
        if (criticalHighlighted) {
            setCriticalHighlighted(false)
            onFilterElements?.(null)
        } else {
            setActiveTaskId(null)
            setCriticalHighlighted(true)
            onFilterElements?.(criticalElementIds.length > 0 ? criticalElementIds : null)
        }
    }

    const reloadSchedule = useCallback(async () => {
        const res = await fetch(`${base}/models/${normalizerModelId}/schedule`)
        if (!res.ok) throw new Error(`Reload failed: HTTP ${res.status}`)
        const data = await res.json()
        setSchedule(data)
        return data
    }, [base, normalizerModelId])

    useEffect(() => {
        if (!normalizerModelId) return
        setLoading(true)
        fetch(`${base}/models/${normalizerModelId}/schedule`)
            .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e.detail || `HTTP ${r.status}`)))
            .then(data => { setSchedule(data); setLoading(false) })
            .catch(e => { setError(e instanceof Error ? e.message : String(e)); setLoading(false) })
    }, [normalizerModelId, base])

    const handleUpload = async (e) => {
        const file = e.target.files?.[0]
        if (!file || !normalizerModelId) return
        setUploading(true)
        setError(null)
        const form = new FormData()
        form.append('file', file)
        try {
            const res = await fetch(`${base}/models/${normalizerModelId}/schedule/import`, {
                method: 'POST', body: form,
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `HTTP ${res.status}`)
            }
            await reloadSchedule()
            setCollapsed(new Set())
            setActiveTaskId(null)
        } catch (err) {
            setError(err.message)
        } finally {
            setUploading(false)
            if (fileInputRef.current) fileInputRef.current.value = ''
        }
    }

    const handleExportIfc = async () => {
        if (!normalizerModelId) return
        setError(null)
        try {
            const res = await fetch(`${base}/models/${normalizerModelId}/schedule/export-ifc`)
            if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`)
            const blob = await res.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `schedule-${normalizerModelId}.ifc`
            a.click()
            URL.revokeObjectURL(url)
        } catch (err) {
            setError(err.message)
        }
    }

    // Suggest the next WBS code under a given parent (e.g. parent "1.2" with 7
    // existing children -> "1.2.8"); blank when the parent has no code of its own.
    const suggestWbsFor = (parentId) => {
        if (!parentId || !schedule?.tasks) return ''
        const parent = schedule.tasks.find(t => t.task_id === parentId)
        if (!parent?.wbs_code) return ''
        const siblingCount = schedule.tasks.filter(t => t.parent_task_id === parentId).length
        return `${parent.wbs_code}.${siblingCount + 1}`
    }

    const handleCreateTask = async () => {
        if (!newTaskName.trim() || !normalizerModelId) return
        setCreatingTask(true)
        setError(null)
        try {
            const res = await fetch(`${base}/models/${normalizerModelId}/schedule/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newTaskName.trim(),
                    planned_start: newTaskStart || null,
                    planned_finish: newTaskFinish || null,
                    parent_task_id: newTaskParent || null,
                    wbs_code: newTaskWbs.trim() || null,
                }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `HTTP ${res.status}`)
            }
            await reloadSchedule()
            setNewTaskName('')
            setNewTaskStart('')
            setNewTaskFinish('')
            setNewTaskParent('')
            setNewTaskWbs('')
            setShowNewTask(false)
        } catch (err) {
            setError(err.message)
        } finally {
            setCreatingTask(false)
        }
    }

    const handleLinkSelection = async (mode) => {
        if (!activeTaskId || !viewerSelectedIds?.length || !normalizerModelId) return
        setLinking(true)
        setError(null)
        try {
            const res = await fetch(`${base}/models/${normalizerModelId}/schedule/tasks/${activeTaskId}/elements`, {
                method: mode === 'link' ? 'POST' : 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ speckle_ids: viewerSelectedIds }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `HTTP ${res.status}`)
            }
            await reloadSchedule()
        } catch (err) {
            setError(err.message)
        } finally {
            setLinking(false)
        }
    }

    const startEditingTask = (task) => {
        setEditName(task.name || '')
        setEditStart(task.planned_start || '')
        setEditFinish(task.planned_finish || '')
        setEditParent(task.parent_task_id || '')
        setEditWbs(task.wbs_code || '')
        setEditingTask(true)
    }

    const handleSaveEdit = async () => {
        if (!activeTaskId || !editName.trim() || !normalizerModelId) return
        setSavingEdit(true)
        setError(null)
        try {
            const res = await fetch(`${base}/models/${normalizerModelId}/schedule/tasks/${activeTaskId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: editName.trim(),
                    planned_start: editStart || null,
                    planned_finish: editFinish || null,
                    parent_task_id: editParent || null,
                    wbs_code: editWbs.trim() || null,
                }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `HTTP ${res.status}`)
            }
            await reloadSchedule()
            setEditingTask(false)
        } catch (err) {
            setError(err.message)
        } finally {
            setSavingEdit(false)
        }
    }

    // Direct-manipulation drag/resize (see TaskBar's hit-zones, which call
    // this on pointerdown). Self-contained: onMove/onUp/onKey are declared
    // fresh inside this closure and only ever reference each other by name,
    // so add/removeEventListener always pair up correctly regardless of
    // React re-renders mid-drag (setDragPreview below causes exactly that) —
    // no stale-closure risk from relying on component-level function
    // identity across renders, unlike a useCallback-memoized approach would.
    //
    // Live preview is purely local (dragPreview state, read by the row
    // render below); the PATCH only fires once, on release, and only if the
    // pointer actually moved — a plain click that happens to land on a hit
    // zone shouldn't trigger a network request.
    const startBarDrag = (e, task, mode) => {
        if (e.button !== 0) return
        if (!projectDuration || projectDuration <= 0 || !normalizerModelId) return

        const origStartMs = safeParseDateMs(task.planned_start)
        if (origStartMs === null) return
        const origFinishMs = safeParseDateMs(task.planned_finish) ?? origStartMs
        // Nothing to resize on a zero-duration bar (or a milestone, which
        // only ever gets 'shift' hit-zones from TaskBar anyway) — defend here too.
        if (mode !== 'shift' && origFinishMs <= origStartMs) return

        e.stopPropagation()
        e.preventDefault()

        const msPerPx = projectDuration / GANTT_PX
        const startClientX = e.clientX
        const taskId = task.task_id
        let liveStartMs = origStartMs
        let liveFinishMs = origFinishMs
        let moved = false

        setDragPreview({ taskId, startMs: liveStartMs, finishMs: liveFinishMs })

        const onMove = (ev) => {
            const rawDeltaMs = (ev.clientX - startClientX) * msPerPx
            const deltaMs = Math.round(rawDeltaMs / MS_PER_DAY) * MS_PER_DAY
            if (deltaMs !== 0) moved = true

            let s = origStartMs
            let f = origFinishMs
            if (mode === 'shift') {
                s = origStartMs + deltaMs
                f = origFinishMs + deltaMs
            } else if (mode === 'resize-start') {
                s = Math.min(origStartMs + deltaMs, origFinishMs - MS_PER_DAY)
            } else {
                f = Math.max(origFinishMs + deltaMs, origStartMs + MS_PER_DAY)
            }
            liveStartMs = s
            liveFinishMs = f
            setDragPreview({ taskId, startMs: s, finishMs: f })
        }

        const onUp = async () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            window.removeEventListener('keydown', onKey)
            setDragPreview(null)
            if (!moved) return

            setError(null)
            try {
                const res = await fetch(`${base}/models/${normalizerModelId}/schedule/tasks/${taskId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        planned_start: toDateOnlyIso(liveStartMs),
                        planned_finish: toDateOnlyIso(liveFinishMs),
                    }),
                })
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}))
                    throw new Error(body.detail || `HTTP ${res.status}`)
                }
                await reloadSchedule()
            } catch (err) {
                setError(err.message)
            }
        }

        const onKey = (ev) => {
            if (ev.key !== 'Escape') return
            // Removing the pointerup listener here means onUp (and its PATCH)
            // never fires for this gesture even once the button is released —
            // that's the abort, not a flag onUp has to check.
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            window.removeEventListener('keydown', onKey)
            setDragPreview(null)
        }

        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('keydown', onKey)
    }

    const handleDeleteTask = async () => {
        if (!activeTaskId || !normalizerModelId) return
        if (!window.confirm('Delete this task? This also removes it from the 4D timeline.')) return
        setDeletingTask(true)
        setError(null)
        try {
            const res = await fetch(`${base}/models/${normalizerModelId}/schedule/tasks/${activeTaskId}`, {
                method: 'DELETE',
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `HTTP ${res.status}`)
            }
            await reloadSchedule()
            setActiveTaskId(null)
            setEditingTask(false)
            onFilterElements?.(null)
        } catch (err) {
            setError(err.message)
        } finally {
            setDeletingTask(false)
        }
    }

    const handleDeleteSchedule = async () => {
        if (!normalizerModelId) return
        if (!window.confirm('Delete the entire schedule? This removes all tasks, dependencies and element links for this model. This cannot be undone.')) return
        setDeletingSchedule(true)
        setError(null)
        try {
            const res = await fetch(`${base}/models/${normalizerModelId}/schedule`, { method: 'DELETE' })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `HTTP ${res.status}`)
            }
            await reloadSchedule()
            setActiveTaskId(null)
            setEditingTask(false)
            setCriticalHighlighted(false)
            onFilterElements?.(null)
        } catch (err) {
            setError(err.message)
        } finally {
            setDeletingSchedule(false)
        }
    }

    const handleAddDependency = async () => {
        if (!activeTaskId || !depTargetId || !normalizerModelId) return
        setSavingDep(true)
        setError(null)
        const isPred = showAddDep === 'predecessor'
        try {
            const res = await fetch(`${base}/models/${normalizerModelId}/schedule/dependencies`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    predecessor_task_id: isPred ? depTargetId : activeTaskId,
                    successor_task_id:   isPred ? activeTaskId : depTargetId,
                    sequence_type: depType,
                    lag_days: depLag === '' ? null : Number(depLag),
                }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `HTTP ${res.status}`)
            }
            await reloadSchedule()
            setShowAddDep(null)
            setDepTargetId('')
            setDepType('FINISH_START')
            setDepLag('')
        } catch (err) {
            setError(err.message)
        } finally {
            setSavingDep(false)
        }
    }

    const handleDeleteDependency = async (dependencyId) => {
        if (!normalizerModelId) return
        setDeletingDepId(dependencyId)
        setError(null)
        try {
            const res = await fetch(`${base}/models/${normalizerModelId}/schedule/dependencies/${dependencyId}`, { method: 'DELETE' })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `HTTP ${res.status}`)
            }
            await reloadSchedule()
        } catch (err) {
            setError(err.message)
        } finally {
            setDeletingDepId(null)
        }
    }

    // Flat list of all tasks (independent of search/collapse) for parent-task pickers
    const taskOptions = useMemo(() => {
        if (!schedule?.tasks?.length) return []
        const byId = new Map(schedule.tasks.map(t => [t.task_id, t]))
        const depthOf = (task) => {
            let depth = 0
            let current = task
            const seen = new Set()
            while (current?.parent_task_id && !seen.has(current.task_id)) {
                seen.add(current.task_id)
                current = byId.get(current.parent_task_id)
                depth++
            }
            return depth
        }
        return schedule.tasks
            .slice()
            .sort((a, b) => a.sort_order - b.sort_order)
            .map(t => ({ ...t, depth: depthOf(t) }))
    }, [schedule])

    const taskById = useMemo(() => {
        const m = new Map()
        for (const t of (schedule?.tasks || [])) m.set(t.task_id, t)
        return m
    }, [schedule])

    const activeDependencies = useMemo(() => {
        if (!activeTaskId || !schedule?.dependencies) return { predecessors: [], successors: [] }
        return {
            predecessors: schedule.dependencies.filter(d => d.successor_task_id === activeTaskId),
            successors: schedule.dependencies.filter(d => d.predecessor_task_id === activeTaskId),
        }
    }, [activeTaskId, schedule])

    // When editing a task, its own subtree can't become its parent (would create a cycle)
    const editExcludedIds = useMemo(() => {
        if (!activeTaskId || !schedule?.tasks?.length) return new Set()
        const childrenOf = {}
        for (const t of schedule.tasks) {
            if (t.parent_task_id) {
                if (!childrenOf[t.parent_task_id]) childrenOf[t.parent_task_id] = []
                childrenOf[t.parent_task_id].push(t.task_id)
            }
        }
        const excluded = new Set([activeTaskId])
        const stack = [activeTaskId]
        while (stack.length) {
            const id = stack.pop()
            for (const childId of (childrenOf[id] || [])) {
                if (!excluded.has(childId)) {
                    excluded.add(childId)
                    stack.push(childId)
                }
            }
        }
        return excluded
    }, [activeTaskId, schedule])

    // Build O(n) child map then traverse in WBS order
    const { visibleTasks, childCounts } = useMemo(() => {
        if (!schedule?.tasks?.length) return { visibleTasks: [], childCounts: {} }

        const tasks = schedule.tasks
        // Map parent_id → sorted children
        const childrenOf = {}
        const childCounts = {}
        for (const t of tasks) {
            if (t.parent_task_id) {
                if (!childrenOf[t.parent_task_id]) childrenOf[t.parent_task_id] = []
                childrenOf[t.parent_task_id].push(t)
                childCounts[t.parent_task_id] = (childCounts[t.parent_task_id] || 0) + 1
            }
        }

        const normalise = (s) => (s || '').toLowerCase()
        const term = normalise(search)

        const visible = []
        const addTask = (task, depth) => {
            const matchesSearch = !term ||
                normalise(task.name).includes(term) ||
                normalise(task.wbs_code).includes(term)

            // If searching, show only matching tasks (ignore hierarchy collapse)
            if (term) {
                if (matchesSearch) visible.push({ ...task, depth })
                // Always recurse when filtering so descendants can still match
                for (const child of (childrenOf[task.task_id] || [])) addTask(child, depth + 1)
            } else {
                visible.push({ ...task, depth })
                if (!collapsed.has(task.task_id)) {
                    for (const child of (childrenOf[task.task_id] || [])) addTask(child, depth + 1)
                }
            }
        }

        for (const t of tasks.filter(t => !t.parent_task_id)) addTask(t, 0)
        return { visibleTasks: visible, childCounts }
    }, [schedule, collapsed, search])

    const projectStartMs   = useMemo(() => safeParseDateMs(schedule?.project_start), [schedule])
    const projectEndMs     = useMemo(() => safeParseDateMs(schedule?.project_end),   [schedule])
    const projectDuration  = (projectStartMs && projectEndMs && projectEndMs > projectStartMs)
        ? projectEndMs - projectStartMs : 0
    const months           = useMemo(
        () => monthLabels(projectStartMs, projectEndMs, projectDuration),
        [projectStartMs, projectEndMs, projectDuration]
    )

    // "Today" marker position
    const todayPct = useMemo(() => {
        if (!projectDuration) return null
        const pct = ((Date.now() - projectStartMs) / projectDuration) * 100
        return pct >= 0 && pct <= 100 ? pct : null
    }, [projectStartMs, projectDuration])

    // Recompute dependency-arrow endpoints whenever the visible rows or the
    // dependency list changes. Reads leftPct/widthPct back off each row's own
    // data attributes (set in the render below) rather than recalculating
    // date math here, so the arrow endpoints can never drift from the bars
    // they're supposed to be pointing at.
    useLayoutEffect(() => {
        const deps = schedule?.dependencies
        const container = ganttContainerRef.current
        if (!deps?.length || !container) { setArrows([]); return }

        const containerRect = container.getBoundingClientRect()
        const toContainerCoords = (rect) => ({
            top: rect.top - containerRect.top + container.scrollTop,
            left: rect.left - containerRect.left + container.scrollLeft,
        })

        const next = []
        for (const dep of deps) {
            const predEl = barRowRefs.current[dep.predecessor_task_id]
            const succEl = barRowRefs.current[dep.successor_task_id]
            if (!predEl || !succEl) continue // one or both rows collapsed/filtered out of view

            const predPos = toContainerCoords(predEl.getBoundingClientRect())
            const succPos = toContainerCoords(succEl.getBoundingClientRect())
            const predLeftPct = Number(predEl.dataset.leftPct) || 0
            const predWidthPct = Number(predEl.dataset.widthPct) || 0
            const succLeftPct = Number(succEl.dataset.leftPct) || 0

            const x1 = predPos.left + ((predLeftPct + predWidthPct) / 100) * GANTT_PX
            const y1 = predPos.top + predEl.offsetHeight / 2
            const x2 = succPos.left + (succLeftPct / 100) * GANTT_PX
            const y2 = succPos.top + succEl.offsetHeight / 2
            next.push({ key: `${dep.predecessor_task_id}-${dep.successor_task_id}`, x1, y1, x2, y2 })
        }
        setArrows(next)
        setSvgSize({ width: container.scrollWidth, height: container.scrollHeight })
    }, [visibleTasks, schedule?.dependencies, dragPreview])

    const handleTaskClick = (task) => {
        const isAlreadyActive = activeTaskId === task.task_id
        setActiveTaskId(isAlreadyActive ? null : task.task_id)
        setEditingTask(false)
        setCriticalHighlighted(false)
        setShowAddDep(null)
        if (task.element_count > 0) {
            onFilterElements?.(isAlreadyActive ? null : (task.speckle_ids ?? []))
        }
    }

    const toggleCollapse = (taskId, e) => {
        e.stopPropagation()
        setCollapsed(prev => {
            const next = new Set(prev)
            next.has(taskId) ? next.delete(taskId) : next.add(taskId)
            return next
        })
    }

    if (!normalizerModelId) {
        return <div className="flex items-center justify-center h-full text-[var(--speckle-foreground-3)] text-sm">Load a model first</div>
    }

    const hasTasks   = (schedule?.tasks?.length ?? 0) > 0
    const linkedCount = schedule?.tasks?.filter(t => t.element_count > 0).length ?? 0

    const depAddForm = (
        <div className="flex items-center gap-1.5 pl-2">
            <select
                value={depTargetId}
                onChange={e => setDepTargetId(e.target.value)}
                disabled={savingDep}
                aria-label="Task"
                className="flex-1 bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-1.5 py-1 text-[11px] text-[var(--speckle-foreground-2)] focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
            >
                <option value="">select task…</option>
                {taskOptions.filter(t => t.task_id !== activeTaskId).map(t => (
                    <option key={t.task_id} value={t.task_id}>
                        {t.wbs_code ? `${t.wbs_code} ` : ''}{t.name}
                    </option>
                ))}
            </select>
            <select
                value={depType}
                onChange={e => setDepType(e.target.value)}
                disabled={savingDep}
                aria-label="Dependency type"
                className="bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-1.5 py-1 text-[11px] text-[var(--speckle-foreground-2)] focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
            >
                <option value="FINISH_START">FS</option>
                <option value="START_START">SS</option>
                <option value="FINISH_FINISH">FF</option>
                <option value="START_FINISH">SF</option>
            </select>
            <input
                type="number"
                value={depLag}
                onChange={e => setDepLag(e.target.value)}
                placeholder="lag"
                disabled={savingDep}
                title="Lag in days"
                className="w-14 bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-1.5 py-1 text-[11px] text-[var(--speckle-foreground-2)] placeholder-[var(--speckle-foreground-3)] focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
            />
            <button
                onClick={handleAddDependency}
                disabled={savingDep || !depTargetId}
                className="shrink-0 text-[11px] px-2 py-1 rounded bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border border-amber-500/20 transition-colors disabled:opacity-50"
            >
                {savingDep ? 'Saving…' : 'Add'}
            </button>
            <button
                onClick={() => setShowAddDep(null)}
                disabled={savingDep}
                className="shrink-0 p-1 rounded hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]"
                aria-label="Cancel"
            >
                <X className="w-3 h-3" />
            </button>
        </div>
    )

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Toolbar */}
            <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--speckle-outline-3)] shrink-0 flex-wrap gap-y-1">
                {hasTasks && (
                    <>
                        <span className="text-xs text-[var(--speckle-foreground-3)]">{schedule.task_count} tasks</span>
                        {linkedCount > 0 && (
                            <span className="flex items-center gap-1 text-xs text-green-400">
                                <Link className="w-3 h-3" />
                                {linkedCount} linked
                            </span>
                        )}
                        {schedule?.project_start && (
                            <span className="text-xs text-[var(--speckle-foreground-3)]">
                                {fmtDateLong(schedule.project_start)} → {fmtDateLong(schedule.project_end)}
                            </span>
                        )}
                    </>
                )}
                {hasTasks && (
                    <input
                        type="search"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search tasks…"
                        className="bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2 py-1 text-xs text-[var(--speckle-foreground-2)] focus:outline-none focus:border-amber-500/50 w-36"
                    />
                )}
                {hasTasks && (
                    <button
                        onClick={toggleCriticalPath}
                        disabled={criticalElementIds.length === 0}
                        aria-label={criticalHighlighted ? 'Stop isolating critical path elements' : 'Isolate critical path elements in the 3D viewer'}
                        aria-pressed={criticalHighlighted}
                        title={criticalElementIds.length === 0 ? 'No critical-path elements linked yet' : undefined}
                        className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors disabled:opacity-40 shrink-0 ${
                            criticalHighlighted
                                ? 'bg-red-500/20 text-red-400 border-red-500/30'
                                : 'bg-[var(--speckle-outline-3)]/40 text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] border-[var(--speckle-outline-3)]'
                        }`}
                    >
                        <Flame className="w-3 h-3" />
                        Critical Path
                    </button>
                )}
                <div className="flex-1" />
                {error && (
                    <span className="flex items-center gap-1 text-xs text-red-400">
                        <AlertCircle className="w-3 h-3" />
                        {error}
                    </span>
                )}
                <button
                    onClick={() => setShowNewTask(v => {
                        const opening = !v
                        if (opening) {
                            setNewTaskParent(activeTaskId || '')
                            setNewTaskWbs(suggestWbsFor(activeTaskId || ''))
                        }
                        return opening
                    })}
                    disabled={loading}
                    aria-label="Create a new task manually"
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-[var(--speckle-outline-3)]/40 text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] border border-[var(--speckle-outline-3)] transition-colors disabled:opacity-50 shrink-0"
                >
                    <Plus className="w-3 h-3" />
                    New Task
                </button>
                <button
                    onClick={() => setShowGenerate(true)}
                    disabled={loading}
                    aria-label="Generate a schedule automatically from this model's storeys or element elevation"
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border border-amber-500/20 transition-colors disabled:opacity-50 shrink-0"
                >
                    <CalendarPlus className="w-3 h-3" />
                    Generate Schedule
                </button>
                <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || loading}
                    aria-label={uploading ? 'Importing schedule…' : 'Import an IFC file (IfcWorkSchedule) or MS Project XML (MSPDI) export'}
                    aria-busy={uploading}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-[var(--speckle-outline-3)]/40 text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] border border-[var(--speckle-outline-3)] transition-colors disabled:opacity-50 shrink-0"
                >
                    <Upload className="w-3 h-3" />
                    {uploading ? 'Importing…' : 'Import Schedule'}
                </button>
                <input ref={fileInputRef} type="file" accept=".ifc,.xml" className="hidden" onChange={handleUpload} />
                {hasTasks && (
                    <button
                        onClick={handleExportIfc}
                        aria-label="Export the current schedule as a schedule-only IFC file"
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-[var(--speckle-outline-3)]/40 text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] border border-[var(--speckle-outline-3)] transition-colors shrink-0"
                    >
                        <Download className="w-3 h-3" />
                        Export IFC
                    </button>
                )}
                {hasTasks && (
                    <button
                        onClick={handleDeleteSchedule}
                        disabled={deletingSchedule || loading}
                        aria-label="Delete the entire schedule for this model"
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors disabled:opacity-50 shrink-0"
                    >
                        <Trash2 className="w-3 h-3" />
                        Delete Plan
                    </button>
                )}
            </div>

            {/* New task inline form */}
            {showNewTask && (
                <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--speckle-outline-3)] shrink-0 bg-[var(--speckle-foundation-2)]">
                    <input
                        value={newTaskName}
                        onChange={e => setNewTaskName(e.target.value)}
                        placeholder="Task name"
                        disabled={creatingTask}
                        className="flex-1 bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2 py-1 text-xs text-[var(--speckle-foreground)] placeholder-[var(--speckle-foreground-3)] focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <select
                        value={newTaskParent}
                        onChange={e => {
                            const pid = e.target.value
                            setNewTaskParent(pid)
                            setNewTaskWbs(suggestWbsFor(pid))
                        }}
                        disabled={creatingTask}
                        aria-label="Parent task"
                        title="Parent task"
                        className="bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2 py-1 text-xs text-[var(--speckle-foreground-2)] focus:outline-none focus:border-amber-500/50 disabled:opacity-50 max-w-[160px]"
                    >
                        <option value="">— top level —</option>
                        {taskOptions.map(t => (
                            <option key={t.task_id} value={t.task_id}>
                                {'—'.repeat(t.depth)} {t.wbs_code ? `${t.wbs_code} ` : ''}{t.name}
                            </option>
                        ))}
                    </select>
                    <input
                        value={newTaskWbs}
                        onChange={e => setNewTaskWbs(e.target.value)}
                        placeholder="WBS #"
                        disabled={creatingTask}
                        title="WBS / sequence number (e.g. 1.2.8)"
                        className="w-20 bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2 py-1 text-xs text-[var(--speckle-foreground-2)] placeholder-[var(--speckle-foreground-3)] focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <input
                        type="date"
                        value={newTaskStart}
                        onChange={e => setNewTaskStart(e.target.value)}
                        disabled={creatingTask}
                        className="bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2 py-1 text-xs text-[var(--speckle-foreground-2)] focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <input
                        type="date"
                        value={newTaskFinish}
                        onChange={e => setNewTaskFinish(e.target.value)}
                        disabled={creatingTask}
                        className="bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2 py-1 text-xs text-[var(--speckle-foreground-2)] focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <button
                        onClick={handleCreateTask}
                        disabled={creatingTask || !newTaskName.trim()}
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border border-amber-500/20 transition-colors disabled:opacity-50 shrink-0"
                    >
                        {creatingTask ? 'Creating…' : 'Create'}
                    </button>
                    <button
                        onClick={() => setShowNewTask(false)}
                        disabled={creatingTask}
                        className="p-1.5 rounded-lg hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground-2)] transition-colors disabled:opacity-50"
                        aria-label="Cancel"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {/* Active task: edit / delete */}
            {activeTaskId && !editingTask && (
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--speckle-outline-3)] shrink-0 bg-[var(--speckle-foundation-2)]">
                    <span className="text-[11px] text-[var(--speckle-foreground-2)] truncate flex-1">
                        {schedule?.tasks?.find(t => t.task_id === activeTaskId)?.name}
                    </span>
                    <button
                        onClick={() => {
                            const t = schedule?.tasks?.find(t => t.task_id === activeTaskId)
                            if (t) startEditingTask(t)
                        }}
                        className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg bg-[var(--speckle-outline-3)]/40 text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] border border-[var(--speckle-outline-3)] transition-colors"
                    >
                        <Pencil className="w-3 h-3" />
                        Edit
                    </button>
                    <button
                        onClick={handleDeleteTask}
                        disabled={deletingTask}
                        className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors disabled:opacity-50"
                    >
                        <Trash2 className="w-3 h-3" />
                        Delete
                    </button>
                </div>
            )}

            {/* Edit task inline form */}
            {activeTaskId && editingTask && (
                <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--speckle-outline-3)] shrink-0 bg-[var(--speckle-foundation-2)]">
                    <input
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        placeholder="Task name"
                        disabled={savingEdit}
                        className="flex-1 bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2 py-1 text-xs text-[var(--speckle-foreground)] placeholder-[var(--speckle-foreground-3)] focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <select
                        value={editParent}
                        onChange={e => setEditParent(e.target.value)}
                        disabled={savingEdit}
                        aria-label="Parent task"
                        title="Parent task"
                        className="bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2 py-1 text-xs text-[var(--speckle-foreground-2)] focus:outline-none focus:border-amber-500/50 disabled:opacity-50 max-w-[160px]"
                    >
                        <option value="">— top level —</option>
                        {taskOptions.filter(t => !editExcludedIds.has(t.task_id)).map(t => (
                            <option key={t.task_id} value={t.task_id}>
                                {'—'.repeat(t.depth)} {t.wbs_code ? `${t.wbs_code} ` : ''}{t.name}
                            </option>
                        ))}
                    </select>
                    <input
                        value={editWbs}
                        onChange={e => setEditWbs(e.target.value)}
                        placeholder="WBS #"
                        disabled={savingEdit}
                        title="WBS / sequence number (e.g. 1.2.8)"
                        className="w-20 bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2 py-1 text-xs text-[var(--speckle-foreground-2)] placeholder-[var(--speckle-foreground-3)] focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <input
                        type="date"
                        value={editStart}
                        onChange={e => setEditStart(e.target.value)}
                        disabled={savingEdit}
                        className="bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2 py-1 text-xs text-[var(--speckle-foreground-2)] focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <input
                        type="date"
                        value={editFinish}
                        onChange={e => setEditFinish(e.target.value)}
                        disabled={savingEdit}
                        className="bg-[var(--speckle-foundation)] border border-[var(--speckle-outline-3)] rounded px-2 py-1 text-xs text-[var(--speckle-foreground-2)] focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <button
                        onClick={handleSaveEdit}
                        disabled={savingEdit || !editName.trim()}
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border border-amber-500/20 transition-colors disabled:opacity-50 shrink-0"
                    >
                        {savingEdit ? 'Saving…' : 'Save'}
                    </button>
                    <button
                        onClick={() => setEditingTask(false)}
                        disabled={savingEdit}
                        className="p-1.5 rounded-lg hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground-2)] transition-colors disabled:opacity-50"
                        aria-label="Cancel edit"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {/* Dependencies for the active task */}
            {activeTaskId && (
                <div className="border-b border-[var(--speckle-outline-3)] shrink-0 bg-[var(--speckle-foundation-2)] px-3 py-2 space-y-1.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--speckle-foreground-2)]">
                        <Link className="w-3 h-3" /> Dependencies
                    </div>

                    <div className="space-y-1">
                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">Predecessors</span>
                        {activeDependencies.predecessors.map(d => (
                            <div key={d.dependency_id} className="flex items-center gap-1.5 text-[11px] text-[var(--speckle-foreground-2)] pl-2">
                                <span className="truncate flex-1">{taskById.get(d.predecessor_task_id)?.name || '—'}</span>
                                <span className="shrink-0 px-1 rounded bg-[var(--speckle-outline-3)] text-[10px]">{DEP_TYPE_LABELS[d.sequence_type] || d.sequence_type}</span>
                                {d.lag_days ? <span className="shrink-0 text-[10px] text-[var(--speckle-foreground-3)]">{d.lag_days > 0 ? '+' : ''}{d.lag_days}d</span> : null}
                                <button
                                    onClick={() => handleDeleteDependency(d.dependency_id)}
                                    disabled={deletingDepId === d.dependency_id}
                                    className="shrink-0 p-0.5 rounded hover:bg-red-500/20 text-[var(--speckle-foreground-3)] hover:text-red-400 transition-colors disabled:opacity-50"
                                    aria-label="Remove dependency"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                        ))}
                        {showAddDep === 'predecessor' ? depAddForm : (
                            <button
                                onClick={() => { setShowAddDep('predecessor'); setDepTargetId(''); setDepType('FINISH_START'); setDepLag('') }}
                                className="flex items-center gap-1 text-[10px] text-[var(--speckle-foreground-3)] hover:text-amber-400 transition-colors pl-2"
                            >
                                <Plus className="w-3 h-3" /> Add predecessor
                            </button>
                        )}
                    </div>

                    <div className="space-y-1">
                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">Successors</span>
                        {activeDependencies.successors.map(d => (
                            <div key={d.dependency_id} className="flex items-center gap-1.5 text-[11px] text-[var(--speckle-foreground-2)] pl-2">
                                <span className="truncate flex-1">{taskById.get(d.successor_task_id)?.name || '—'}</span>
                                <span className="shrink-0 px-1 rounded bg-[var(--speckle-outline-3)] text-[10px]">{DEP_TYPE_LABELS[d.sequence_type] || d.sequence_type}</span>
                                {d.lag_days ? <span className="shrink-0 text-[10px] text-[var(--speckle-foreground-3)]">{d.lag_days > 0 ? '+' : ''}{d.lag_days}d</span> : null}
                                <button
                                    onClick={() => handleDeleteDependency(d.dependency_id)}
                                    disabled={deletingDepId === d.dependency_id}
                                    className="shrink-0 p-0.5 rounded hover:bg-red-500/20 text-[var(--speckle-foreground-3)] hover:text-red-400 transition-colors disabled:opacity-50"
                                    aria-label="Remove dependency"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                        ))}
                        {showAddDep === 'successor' ? depAddForm : (
                            <button
                                onClick={() => { setShowAddDep('successor'); setDepTargetId(''); setDepType('FINISH_START'); setDepLag('') }}
                                className="flex items-center gap-1 text-[10px] text-[var(--speckle-foreground-3)] hover:text-amber-400 transition-colors pl-2"
                            >
                                <Plus className="w-3 h-3" /> Add successor
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Link/unlink current 3D selection to the active task */}
            {activeTaskId && viewerSelectedIds?.length > 0 && (
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--speckle-outline-3)] shrink-0 bg-amber-500/[0.04]">
                    <span className="text-[11px] text-[var(--speckle-foreground-2)]">
                        {viewerSelectedIds.length} element{viewerSelectedIds.length !== 1 ? 's' : ''} selected in viewer
                    </span>
                    <div className="flex-1" />
                    <button
                        onClick={() => handleLinkSelection('link')}
                        disabled={linking}
                        className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg bg-green-500/15 text-green-400 hover:bg-green-500/25 border border-green-500/20 transition-colors disabled:opacity-50"
                    >
                        <Link className="w-3 h-3" />
                        Link selected
                    </button>
                    <button
                        onClick={() => handleLinkSelection('unlink')}
                        disabled={linking}
                        className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors disabled:opacity-50"
                    >
                        <Link2Off className="w-3 h-3" />
                        Unlink selected
                    </button>
                </div>
            )}

            {/* Body */}
            {loading ? (
                <div className="flex-1 flex items-center justify-center gap-2 text-[var(--speckle-foreground-3)] text-sm">
                    Loading schedule…
                </div>
            ) : !hasTasks ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
                    <Calendar className="w-12 h-12 text-[var(--speckle-outline-4)]" />
                    <p className="text-sm text-[var(--speckle-foreground-3)] font-medium">No schedule data found</p>
                    <p className="text-xs text-[var(--speckle-foreground-3)] max-w-xs">
                        Click <span className="text-amber-400">Generate Schedule</span> to auto-build one from this
                        model's storeys, or upload an IFC file containing an <code className="text-[var(--speckle-foreground-2)]">IfcWorkSchedule</code>,
                        or an MS Project XML (MSPDI) export, to enable 4D construction simulation.
                    </p>
                </div>
            ) : (
                <div className="flex-1 overflow-auto relative" ref={ganttContainerRef}>
                    {arrows.length > 0 && (
                        <svg
                            className="absolute top-0 left-0 pointer-events-none z-[5]"
                            width={svgSize.width} height={svgSize.height}
                        >
                            <defs>
                                <marker id="schedule-arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                                    <path d="M0,0 L6,3 L0,6 Z" fill="var(--speckle-foreground-3)" />
                                </marker>
                            </defs>
                            {arrows.map(a => (
                                <path
                                    key={a.key}
                                    d={elbowPath(a.x1, a.y1, a.x2, a.y2)}
                                    stroke="var(--speckle-foreground-3)"
                                    strokeOpacity={0.7}
                                    strokeWidth={1.25}
                                    fill="none"
                                    markerEnd="url(#schedule-arrowhead)"
                                />
                            ))}
                        </svg>
                    )}
                    <table className="text-xs border-collapse w-full" style={{ minWidth: 700 + GANTT_PX }}>
                        <thead>
                            <tr className="border-b border-[var(--speckle-outline-3)] sticky top-0 z-10 bg-[var(--speckle-foundation-page)]">
                                <th className="text-left px-3 py-2 font-medium text-[var(--speckle-foreground-3)] sticky left-0 bg-[var(--speckle-foundation-page)]" style={{ minWidth: 260 }}>
                                    Task
                                </th>
                                <th className="text-left px-2 py-2 font-medium text-[var(--speckle-foreground-3)] w-24">Status</th>
                                <th className="text-left px-2 py-2 font-medium text-[var(--speckle-foreground-3)] w-20">Start</th>
                                <th className="text-left px-2 py-2 font-medium text-[var(--speckle-foreground-3)] w-20">Finish</th>
                                <th className="px-2 py-2 font-medium text-[var(--speckle-foreground-3)]" style={{ width: GANTT_PX }}>
                                    {/* Month labels + today marker */}
                                    <div className="relative h-4 select-none" style={{ width: GANTT_PX }}>
                                        {months.map((m, i) => (
                                            <span key={i} className="absolute top-0 text-[10px] text-[var(--speckle-foreground-3)] whitespace-nowrap"
                                                style={{ left: `${m.pct}%` }}>
                                                {m.label}
                                            </span>
                                        ))}
                                        {todayPct !== null && (
                                            <div
                                                className="absolute top-0 bottom-0 w-px bg-cyan-400/70 pointer-events-none"
                                                style={{ left: `${todayPct}%` }}
                                                title="Today"
                                            />
                                        )}
                                    </div>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {visibleTasks.map(task => {
                                const hasChildren = !!childCounts[task.task_id]
                                const isCollapsed = collapsed.has(task.task_id)
                                const isActive    = activeTaskId === task.task_id
                                const isDraggingThis = dragPreview?.taskId === task.task_id
                                // While this task's bar is being dragged, render its live
                                // preview position instead of the (stale, not-yet-PATCHed)
                                // dates from `schedule` — everything else still reads from
                                // `task` as normal.
                                const leftPct  = isDraggingThis
                                    ? (msPct(dragPreview.startMs, projectStartMs, projectDuration) ?? 0)
                                    : (datePct(task.planned_start, projectStartMs, projectDuration) ?? 0)
                                const rightPct = isDraggingThis
                                    ? (msPct(dragPreview.finishMs, projectStartMs, projectDuration) ?? leftPct)
                                    : (datePct(task.planned_finish, projectStartMs, projectDuration) ?? leftPct)
                                const widthPct = Math.max(0, rightPct - leftPct)

                                return (
                                    <tr
                                        key={task.task_id}
                                        onClick={() => handleTaskClick(task)}
                                        className={`border-b border-[var(--speckle-outline-3)]/50 cursor-pointer transition-colors ${
                                            isActive ? 'bg-amber-500/10' : 'hover:bg-[var(--speckle-outline-3)]/30'
                                        }`}
                                    >
                                        {/* Task name */}
                                        <td className="px-3 py-1.5 sticky left-0 bg-inherit">
                                            <div className="flex items-center gap-1" style={{ paddingLeft: task.depth * 14 }}>
                                                {hasChildren ? (
                                                    <button
                                                        onClick={e => toggleCollapse(task.task_id, e)}
                                                        aria-label={isCollapsed ? `Expand task: ${task.name}` : `Collapse task: ${task.name}`}
                                                        aria-expanded={!isCollapsed}
                                                        className="text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] shrink-0 transition-colors"
                                                    >
                                                        {isCollapsed
                                                            ? <ChevronRight className="w-3 h-3" />
                                                            : <ChevronDown className="w-3 h-3" />
                                                        }
                                                    </button>
                                                ) : (
                                                    <span className="w-3 shrink-0" />
                                                )}
                                                <span
                                                    className={`truncate ${
                                                        task.depth === 0 ? 'font-semibold text-[var(--speckle-foreground)]' : 'text-[var(--speckle-foreground-2)]'
                                                    } ${task.is_critical ? 'text-red-400' : ''}`}
                                                    title={task.float_days != null ? `Float: ${task.float_days}d` : undefined}
                                                >
                                                    {task.wbs_code && (
                                                        <span className="text-[var(--speckle-foreground-3)] mr-1.5 font-mono">{task.wbs_code}</span>
                                                    )}
                                                    {task.name}
                                                </span>
                                                {task.float_days != null && (
                                                    <span
                                                        className={`shrink-0 text-[10px] tabular-nums ${task.is_critical ? 'text-red-400' : 'text-[var(--speckle-foreground-3)]'}`}
                                                        title={`Float: ${task.float_days}d`}
                                                    >
                                                        {task.float_days}d
                                                    </span>
                                                )}
                                                {task.element_count > 0 && (
                                                    <span className="ml-1 shrink-0 text-[10px] text-amber-400/60 tabular-nums">
                                                        {task.element_count}
                                                    </span>
                                                )}
                                            </div>
                                        </td>

                                        {/* Status */}
                                        <td className="px-2 py-1.5">
                                            {task.status && task.status !== 'NOTSTARTED' && (
                                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                                    task.status === 'COMPLETED'  ? 'bg-green-500/20 text-green-400' :
                                                    task.status === 'INPROGRESS' ? 'bg-blue-500/20 text-blue-400' :
                                                                                   'bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]'
                                                }`}>
                                                    {task.status === 'INPROGRESS' ? 'In Progress'
                                                        : task.status.charAt(0) + task.status.slice(1).toLowerCase()}
                                                </span>
                                            )}
                                        </td>

                                        {/* Dates */}
                                        <td className="px-2 py-1.5 text-[var(--speckle-foreground-2)] tabular-nums whitespace-nowrap">
                                            {fmtDate(task.planned_start)}
                                        </td>
                                        <td className="px-2 py-1.5 text-[var(--speckle-foreground-2)] tabular-nums whitespace-nowrap">
                                            {fmtDate(task.planned_finish)}
                                        </td>

                                        {/* Gantt bar */}
                                        <td className="px-2 py-1" style={{ width: GANTT_PX }}>
                                            {(task.planned_start || task.planned_finish) && (
                                                <div
                                                    className="relative"
                                                    style={{ width: GANTT_PX }}
                                                    ref={el => { if (el) barRowRefs.current[task.task_id] = el; else delete barRowRefs.current[task.task_id] }}
                                                    data-left-pct={leftPct}
                                                    data-width-pct={widthPct}
                                                >
                                                    {months.map((m, i) => (
                                                        <div key={i} className="absolute inset-y-0 border-l border-[var(--speckle-outline-3)]/50 pointer-events-none"
                                                            style={{ left: `${m.pct}%` }} />
                                                    ))}
                                                    {/* Today line in Gantt rows */}
                                                    {todayPct !== null && (
                                                        <div
                                                            className="absolute inset-y-0 w-px bg-cyan-400/40 pointer-events-none"
                                                            style={{ left: `${todayPct}%` }}
                                                        />
                                                    )}
                                                    <TaskBar
                                                        task={task}
                                                        leftPct={leftPct}
                                                        widthPct={widthPct}
                                                        isActive={isActive}
                                                        isDragging={isDraggingThis}
                                                        onBarPointerDown={(e, mode) => startBarDrag(e, task, mode)}
                                                    />
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                )
                            })}
                            {visibleTasks.length === 0 && search && (
                                <tr>
                                    <td colSpan={5} className="px-4 py-8 text-center text-[var(--speckle-foreground-3)] italic">
                                        No tasks match &quot;{search}&quot;
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>

                    {/* Legend */}
                    <div className="flex items-center gap-4 px-4 py-2 border-t border-[var(--speckle-outline-3)] text-[10px] text-[var(--speckle-foreground-3)]">
                        <span className="flex items-center gap-1.5">
                            <span className="w-3 h-2 rounded-sm bg-green-500/70 inline-block" /> Completed
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className="w-3 h-2 rounded-sm bg-blue-500/70 inline-block" /> In Progress
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className="w-3 h-2 rounded-sm bg-amber-400/40 inline-block" /> Planned
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className="w-3 h-2 rounded-sm bg-red-500/80 inline-block" /> Critical
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className="w-3 h-3 bg-amber-400 rotate-45 inline-block" /> Milestone
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className="w-px h-3 bg-cyan-400/70 inline-block" /> Today
                        </span>
                        <span className="ml-auto">
                            Click a task with a number to isolate its elements in the 3D viewer
                        </span>
                    </div>
                </div>
            )}

            <GenerateScheduleDialog
                open={showGenerate}
                onClose={() => setShowGenerate(false)}
                normalizerUrl={normalizerUrl}
                normalizerModelId={normalizerModelId}
                storeyCounts={storeyCounts}
                onGenerated={async () => {
                    await reloadSchedule()
                    setCollapsed(new Set())
                    setActiveTaskId(null)
                }}
            />
        </div>
    )
}
