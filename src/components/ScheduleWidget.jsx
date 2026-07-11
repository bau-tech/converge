import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
    Calendar, Upload, ChevronRight, ChevronDown,
    Clock, Loader2, AlertCircle, Link, Link2Off, Plus, X, Pencil, Trash2, Flame
} from 'lucide-react'

const GANTT_PX = 560

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

function TaskBar({ task, leftPct, widthPct, isActive }) {
    const isSummary = !task.parent_task_id
    const colorClass =
        task.is_critical                    ? 'bg-red-500/80' :
        task.status === 'COMPLETED'         ? 'bg-green-500/70' :
        task.status === 'INPROGRESS'        ? 'bg-blue-500/70' :
        isSummary                           ? 'bg-amber-500/55' :
                                              'bg-amber-400/40'

    return (
        <div className="relative h-5 w-full">
            {task.is_milestone ? (
                <div
                    className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rotate-45 ${
                        task.is_critical ? 'bg-red-400' : 'bg-amber-400'
                    } ${isActive ? 'ring-1 ring-white' : ''}`}
                    style={{ left: `${leftPct}%` }}
                />
            ) : (
                <div
                    className={`absolute inset-y-1 rounded-sm ${colorClass} ${
                        isActive ? 'ring-1 ring-amber-300' : ''
                    } ${isSummary ? 'rounded' : ''}`}
                    style={{ left: `${leftPct}%`, width: `${Math.max(0.4, widthPct)}%`, minWidth: 4 }}
                />
            )}
        </div>
    )
}

export default function ScheduleWidget({ normalizerModelId, normalizerUrl, onFilterElements, viewerSelectedIds }) {
    const [schedule, setSchedule]     = useState(null)
    const [loading, setLoading]       = useState(false)
    const [error, setError]           = useState(null)
    const [uploading, setUploading]   = useState(false)
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
    const [criticalHighlighted, setCriticalHighlighted] = useState(false)
    const fileInputRef = useRef(null)
    const base = normalizerUrl || ''

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

    const handleTaskClick = (task) => {
        const isAlreadyActive = activeTaskId === task.task_id
        setActiveTaskId(isAlreadyActive ? null : task.task_id)
        setEditingTask(false)
        setCriticalHighlighted(false)
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
        return <div className="flex items-center justify-center h-full text-zinc-600 text-sm">Load a model first</div>
    }

    const hasTasks   = (schedule?.tasks?.length ?? 0) > 0
    const linkedCount = schedule?.tasks?.filter(t => t.element_count > 0).length ?? 0

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Toolbar */}
            <div className="flex items-center gap-3 px-3 py-2 border-b border-white/5 shrink-0 flex-wrap gap-y-1">
                <Clock className="w-4 h-4 text-amber-400 shrink-0" />
                <span className="text-sm font-semibold text-amber-400">4D Schedule</span>
                {hasTasks && (
                    <>
                        <span className="text-xs text-zinc-500">{schedule.task_count} tasks</span>
                        {linkedCount > 0 && (
                            <span className="flex items-center gap-1 text-xs text-green-400">
                                <Link className="w-3 h-3" />
                                {linkedCount} linked
                            </span>
                        )}
                        {schedule?.project_start && (
                            <span className="text-xs text-zinc-600">
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
                        className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-amber-500/50 w-36"
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
                                : 'bg-white/5 text-zinc-300 hover:bg-white/10 border-white/10'
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
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 border border-white/10 transition-colors disabled:opacity-50 shrink-0"
                >
                    <Plus className="w-3 h-3" />
                    New Task
                </button>
                <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || loading}
                    aria-label={uploading ? 'Importing schedule…' : 'Import an IFC file (IfcWorkSchedule) or MS Project XML (MSPDI) export'}
                    aria-busy={uploading}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border border-amber-500/20 transition-colors disabled:opacity-50 shrink-0"
                >
                    {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                    {uploading ? 'Importing…' : 'Import Schedule'}
                </button>
                <input ref={fileInputRef} type="file" accept=".ifc,.xml" className="hidden" onChange={handleUpload} />
            </div>

            {/* New task inline form */}
            {showNewTask && (
                <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 shrink-0 bg-white/[0.02]">
                    <input
                        value={newTaskName}
                        onChange={e => setNewTaskName(e.target.value)}
                        placeholder="Task name"
                        disabled={creatingTask}
                        className="flex-1 bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
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
                        className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-amber-500/50 disabled:opacity-50 max-w-[160px]"
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
                        className="w-20 bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <input
                        type="date"
                        value={newTaskStart}
                        onChange={e => setNewTaskStart(e.target.value)}
                        disabled={creatingTask}
                        className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <input
                        type="date"
                        value={newTaskFinish}
                        onChange={e => setNewTaskFinish(e.target.value)}
                        disabled={creatingTask}
                        className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <button
                        onClick={handleCreateTask}
                        disabled={creatingTask || !newTaskName.trim()}
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border border-amber-500/20 transition-colors disabled:opacity-50 shrink-0"
                    >
                        {creatingTask ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Create'}
                    </button>
                    <button
                        onClick={() => setShowNewTask(false)}
                        disabled={creatingTask}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
                        aria-label="Cancel"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {/* Active task: edit / delete */}
            {activeTaskId && !editingTask && (
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 shrink-0 bg-white/[0.02]">
                    <span className="text-[11px] text-zinc-400 truncate flex-1">
                        {schedule?.tasks?.find(t => t.task_id === activeTaskId)?.name}
                    </span>
                    <button
                        onClick={() => {
                            const t = schedule?.tasks?.find(t => t.task_id === activeTaskId)
                            if (t) startEditingTask(t)
                        }}
                        className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 border border-white/10 transition-colors"
                    >
                        <Pencil className="w-3 h-3" />
                        Edit
                    </button>
                    <button
                        onClick={handleDeleteTask}
                        disabled={deletingTask}
                        className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors disabled:opacity-50"
                    >
                        {deletingTask ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                        Delete
                    </button>
                </div>
            )}

            {/* Edit task inline form */}
            {activeTaskId && editingTask && (
                <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 shrink-0 bg-white/[0.02]">
                    <input
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        placeholder="Task name"
                        disabled={savingEdit}
                        className="flex-1 bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <select
                        value={editParent}
                        onChange={e => setEditParent(e.target.value)}
                        disabled={savingEdit}
                        aria-label="Parent task"
                        title="Parent task"
                        className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-amber-500/50 disabled:opacity-50 max-w-[160px]"
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
                        className="w-20 bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <input
                        type="date"
                        value={editStart}
                        onChange={e => setEditStart(e.target.value)}
                        disabled={savingEdit}
                        className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <input
                        type="date"
                        value={editFinish}
                        onChange={e => setEditFinish(e.target.value)}
                        disabled={savingEdit}
                        className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                    />
                    <button
                        onClick={handleSaveEdit}
                        disabled={savingEdit || !editName.trim()}
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border border-amber-500/20 transition-colors disabled:opacity-50 shrink-0"
                    >
                        {savingEdit ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
                    </button>
                    <button
                        onClick={() => setEditingTask(false)}
                        disabled={savingEdit}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
                        aria-label="Cancel edit"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {/* Link/unlink current 3D selection to the active task */}
            {activeTaskId && viewerSelectedIds?.length > 0 && (
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 shrink-0 bg-amber-500/[0.04]">
                    <span className="text-[11px] text-zinc-400">
                        {viewerSelectedIds.length} element{viewerSelectedIds.length !== 1 ? 's' : ''} selected in viewer
                    </span>
                    <div className="flex-1" />
                    <button
                        onClick={() => handleLinkSelection('link')}
                        disabled={linking}
                        className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg bg-green-500/15 text-green-400 hover:bg-green-500/25 border border-green-500/20 transition-colors disabled:opacity-50"
                    >
                        {linking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link className="w-3 h-3" />}
                        Link selected
                    </button>
                    <button
                        onClick={() => handleLinkSelection('unlink')}
                        disabled={linking}
                        className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors disabled:opacity-50"
                    >
                        {linking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2Off className="w-3 h-3" />}
                        Unlink selected
                    </button>
                </div>
            )}

            {/* Body */}
            {loading ? (
                <div className="flex-1 flex items-center justify-center gap-2 text-zinc-500 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading schedule…
                </div>
            ) : !hasTasks ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
                    <Calendar className="w-12 h-12 text-zinc-700" />
                    <p className="text-sm text-zinc-500 font-medium">No schedule data found</p>
                    <p className="text-xs text-zinc-600 max-w-xs">
                        Upload an IFC file that contains an <code className="text-zinc-400">IfcWorkSchedule</code>, or an MS Project XML (MSPDI) export, to enable 4D construction simulation.
                    </p>
                </div>
            ) : (
                <div className="flex-1 overflow-auto">
                    <table className="text-xs border-collapse w-full" style={{ minWidth: 700 + GANTT_PX }}>
                        <thead>
                            <tr className="border-b border-white/10 sticky top-0 z-10 bg-zinc-950">
                                <th className="text-left px-3 py-2 font-medium text-zinc-500 sticky left-0 bg-zinc-950" style={{ minWidth: 260 }}>
                                    Task
                                </th>
                                <th className="text-left px-2 py-2 font-medium text-zinc-500 w-24">Status</th>
                                <th className="text-left px-2 py-2 font-medium text-zinc-500 w-20">Start</th>
                                <th className="text-left px-2 py-2 font-medium text-zinc-500 w-20">Finish</th>
                                <th className="px-2 py-2 font-medium text-zinc-500" style={{ width: GANTT_PX }}>
                                    {/* Month labels + today marker */}
                                    <div className="relative h-4 select-none" style={{ width: GANTT_PX }}>
                                        {months.map((m, i) => (
                                            <span key={i} className="absolute top-0 text-[10px] text-zinc-600 whitespace-nowrap"
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
                                const leftPct     = datePct(task.planned_start,  projectStartMs, projectDuration) ?? 0
                                const rightPct    = datePct(task.planned_finish, projectStartMs, projectDuration) ?? leftPct
                                const widthPct    = Math.max(0, rightPct - leftPct)

                                return (
                                    <tr
                                        key={task.task_id}
                                        onClick={() => handleTaskClick(task)}
                                        className={`border-b border-white/5 cursor-pointer transition-colors ${
                                            isActive ? 'bg-amber-500/10' : 'hover:bg-white/5'
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
                                                        className="text-zinc-500 hover:text-zinc-200 shrink-0 transition-colors"
                                                    >
                                                        {isCollapsed
                                                            ? <ChevronRight className="w-3 h-3" />
                                                            : <ChevronDown className="w-3 h-3" />
                                                        }
                                                    </button>
                                                ) : (
                                                    <span className="w-3 shrink-0" />
                                                )}
                                                <span className={`truncate ${
                                                    task.depth === 0 ? 'font-semibold text-zinc-200' : 'text-zinc-300'
                                                } ${task.is_critical ? 'text-red-400' : ''}`}>
                                                    {task.wbs_code && (
                                                        <span className="text-zinc-600 mr-1.5 font-mono">{task.wbs_code}</span>
                                                    )}
                                                    {task.name}
                                                </span>
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
                                                                                   'bg-zinc-700/50 text-zinc-400'
                                                }`}>
                                                    {task.status === 'INPROGRESS' ? 'In Progress'
                                                        : task.status.charAt(0) + task.status.slice(1).toLowerCase()}
                                                </span>
                                            )}
                                        </td>

                                        {/* Dates */}
                                        <td className="px-2 py-1.5 text-zinc-400 tabular-nums whitespace-nowrap">
                                            {fmtDate(task.planned_start)}
                                        </td>
                                        <td className="px-2 py-1.5 text-zinc-400 tabular-nums whitespace-nowrap">
                                            {fmtDate(task.planned_finish)}
                                        </td>

                                        {/* Gantt bar */}
                                        <td className="px-2 py-1" style={{ width: GANTT_PX }}>
                                            {(task.planned_start || task.planned_finish) && (
                                                <div className="relative" style={{ width: GANTT_PX }}>
                                                    {months.map((m, i) => (
                                                        <div key={i} className="absolute inset-y-0 border-l border-white/5 pointer-events-none"
                                                            style={{ left: `${m.pct}%` }} />
                                                    ))}
                                                    {/* Today line in Gantt rows */}
                                                    {todayPct !== null && (
                                                        <div
                                                            className="absolute inset-y-0 w-px bg-cyan-400/40 pointer-events-none"
                                                            style={{ left: `${todayPct}%` }}
                                                        />
                                                    )}
                                                    <TaskBar task={task} leftPct={leftPct} widthPct={widthPct} isActive={isActive} />
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                )
                            })}
                            {visibleTasks.length === 0 && search && (
                                <tr>
                                    <td colSpan={5} className="px-4 py-8 text-center text-zinc-500 italic">
                                        No tasks match "{search}"
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>

                    {/* Legend */}
                    <div className="flex items-center gap-4 px-4 py-2 border-t border-white/5 text-[10px] text-zinc-600">
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
        </div>
    )
}
