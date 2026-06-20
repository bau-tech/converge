import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    X, Upload, Trash2, Play, Loader2, ChevronDown, ChevronRight,
    CheckCircle2, XCircle, Send, Workflow, Pencil,
} from 'lucide-react'
import { createTopic, createViewpoint } from '../utils/bcfClient'
import { useDrawerWidth } from '../utils/useDrawerWidth'
import { IdsGraphEditor } from './IdsGraphEditor'
import { parseIdsXmlToGraph } from '../utils/idsXmlToGraph'

function failureKey(specIdx, reqIdx, entity) {
    return `${specIdx}-${reqIdx}-${entity.global_id || entity.id}`
}

function StatusPill({ ok }) {
    return ok
        ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
        : <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
}

function RequirementBlock({ specIdx, reqIdx, requirement, selected, onToggle, viewerRef }) {
    const [open, setOpen] = useState(!requirement.status)
    const failed = requirement.failed_entities || []

    return (
        <div className="rounded-lg border border-[var(--speckle-outline-3)] overflow-hidden">
            <button
                onClick={() => setOpen(v => !v)}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--speckle-outline-3)] transition-colors text-left"
            >
                {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--speckle-foreground-3)]" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--speckle-foreground-3)]" />}
                <StatusPill ok={requirement.status} />
                <span className="text-xs font-medium text-[var(--speckle-foreground)] flex-1 truncate">{requirement.description || requirement.label}</span>
                <span className="text-[10px] text-[var(--speckle-foreground-3)] shrink-0">{requirement.total_pass}/{requirement.total_applicable} pass</span>
            </button>
            {open && failed.length > 0 && (
                <div className="border-t border-[var(--speckle-outline-3)] divide-y divide-[var(--speckle-outline-3)]">
                    {failed.map((entity) => {
                        const key = failureKey(specIdx, reqIdx, entity)
                        return (
                            <label
                                key={key}
                                onClick={() => entity.global_id && viewerRef?.current?.focusElements([entity.global_id])}
                                title={entity.global_id ? 'Click to highlight this element in the 3D view' : undefined}
                                className="flex items-start gap-2 px-3 py-2 text-xs cursor-pointer hover:bg-[var(--speckle-outline-3)]"
                            >
                                <input
                                    type="checkbox"
                                    checked={selected.has(key)}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={() => onToggle(key, { specIdx, reqIdx, requirement, entity })}
                                    className="mt-0.5 shrink-0"
                                />
                                <div className="min-w-0 flex-1">
                                    <p className="text-[var(--speckle-foreground)] truncate">
                                        {entity.class}{entity.name ? ` — ${entity.name}` : ''}
                                    </p>
                                    <p className="text-[var(--speckle-foreground-3)] truncate">{entity.reason}</p>
                                </div>
                            </label>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

function SpecificationBlock({ specIdx, specification, selected, onToggle, viewerRef }) {
    const [open, setOpen] = useState(!specification.status)
    return (
        <div className="rounded-xl border border-[var(--speckle-outline-3)] overflow-hidden">
            <button
                onClick={() => setOpen(v => !v)}
                className="w-full flex items-center gap-2 px-3 py-2.5 bg-[var(--speckle-outline-3)] hover:opacity-90 transition-opacity text-left"
            >
                {open ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                <StatusPill ok={specification.status} />
                <span className="text-sm font-semibold text-[var(--speckle-foreground)] flex-1 truncate">{specification.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground-3)] shrink-0">
                    {specification.total_applicable_pass}/{specification.total_applicable} elements pass
                </span>
            </button>
            {open && (
                <div className="p-2 space-y-2">
                    {specification.requirements.map((req, reqIdx) => (
                        <RequirementBlock
                            key={reqIdx}
                            specIdx={specIdx}
                            reqIdx={reqIdx}
                            requirement={req}
                            selected={selected}
                            onToggle={onToggle}
                            viewerRef={viewerRef}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

// Full-screen IDS (Information Delivery Specification) checking panel.
// Upload an .ids file, run it against the current model (exported to IFC
// server-side and validated with ifctester), and optionally push selected
// failures into the existing BCF Kanban board via the same createTopic()
// call BcfTopicPanel/BcfKanbanBoard already use.
export function IdsCheckPanel({ projectId, normalizerUrl, viewerRef, topics = [], onTopicsChange, onRequestSync, onClose, serverUrl, serverToken }) {
    const base = (normalizerUrl || '').replace(/\/$/, '')
    const [width, startResize] = useDrawerWidth()

    const [specs, setSpecs] = useState([])
    const [selectedSpecId, setSelectedSpecId] = useState('')
    const [uploading, setUploading] = useState(false)
    const [checking, setChecking] = useState(false)
    const [result, setResult] = useState(null)
    const [ifcSource, setIfcSource] = useState(null)
    const [error, setError] = useState(null)
    const [selected, setSelected] = useState(new Map())
    const [pushing, setPushing] = useState(false)
    const [pushedMsg, setPushedMsg] = useState(null)
    const fileInputRef = useRef(null)
    const pollRef = useRef(null)
    const [showEditor, setShowEditor] = useState(false)
    const [editorInitialGraph, setEditorInitialGraph] = useState(null)

    const loadSpecs = useCallback(async () => {
        if (!projectId) return
        try {
            const res = await fetch(`${base}/models/${projectId}/ids-specs`)
            if (!res.ok) return
            const list = await res.json()
            setSpecs(list)
            if (list.length > 0 && !selectedSpecId) setSelectedSpecId(list[0].spec_id)
        } catch {
            // backend unreachable — leave specs empty, upload/run buttons stay usable to retry
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId, base])

    useEffect(() => { loadSpecs() }, [loadSpecs])

    useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current) }, [])

    const uploadSpecFile = async (file) => {
        const form = new FormData()
        form.append('file', file)

        // Large uploads can fail with a bare, content-type-less 5xx that
        // never reaches bim-normalizer at all (confirmed: a reverse-proxy
        // layer in front of this domain returns its own HTML error page for
        // request bodies past a size threshold, before forwarding anything).
        // That's deterministic on size — retrying changes nothing, so detect
        // it via the non-JSON content-type and fail immediately with a
        // message that points at the real cause instead of looking broken.
        // Genuine transient failures (network blip, momentary 5xx from the
        // app itself) still get a few spaced-out retries.
        let lastErr
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, 4000 * attempt))

            let res
            try {
                res = await fetch(`${base}/models/${projectId}/ids-specs`, { method: 'POST', body: form })
            } catch (err) {
                lastErr = err   // network-level failure — retryable
                continue
            }

            if (res.ok) {
                const spec = await res.json()
                setSpecs(prev => [spec, ...prev])
                setSelectedSpecId(spec.spec_id)
                return spec
            }

            const isJson = (res.headers.get('content-type') || '').includes('application/json')
            if (res.status >= 500 && !isJson) {
                throw new Error(
                    `Upload blocked by a reverse-proxy layer in front of this server (got a non-JSON ${res.status} ` +
                    `before reaching the app) — this usually means the proxy's request body size limit/buffer needs ` +
                    `raising for larger files. Contact whoever manages the server's reverse proxy.`
                )
            }
            if (res.status < 500) {
                // Deterministic rejection from the app itself (e.g. invalid IDS XML) — retrying won't help
                const body = await res.json().catch(() => ({}))
                throw new Error(body.detail || `Upload failed (${res.status})`)
            }
            lastErr = new Error(`Upload failed (${res.status})`)
        }
        throw lastErr
    }

    const handleUpload = async (e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file || !projectId) return
        setUploading(true)
        setError(null)
        try {
            await uploadSpecFile(file)
        } catch (err) {
            setError(err.message)
        } finally {
            setUploading(false)
        }
    }

    const openBlankEditor = () => {
        setEditorInitialGraph(null)
        setShowEditor(true)
    }

    const editSelectedSpecInEditor = async () => {
        if (!selectedSpecId) return
        setError(null)
        try {
            const res = await fetch(`${base}/models/${projectId}/ids-specs/${selectedSpecId}`)
            if (!res.ok) throw new Error(`Could not load spec (${res.status})`)
            const spec = await res.json()
            setEditorInitialGraph(parseIdsXmlToGraph(spec.content))
            setShowEditor(true)
        } catch (err) {
            setError(`Couldn't open this spec in the visual editor: ${err.message}`)
        }
    }

    const removeSpec = async (specId) => {
        try {
            await fetch(`${base}/models/${projectId}/ids-specs/${specId}`, { method: 'DELETE' })
            setSpecs(prev => prev.filter(s => s.spec_id !== specId))
            if (selectedSpecId === specId) setSelectedSpecId('')
        } catch {
            // best-effort — list will just look stale until next refresh
        }
    }

    const runCheck = async () => {
        if (!projectId || !selectedSpecId) return
        setChecking(true)
        setError(null)
        setResult(null)
        setIfcSource(null)
        setSelected(new Map())
        setPushedMsg(null)
        try {
            const startRes = await fetch(`${base}/models/${projectId}/ids-check`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    spec_id: selectedSpecId,
                    server_url: serverUrl || undefined,
                    token: serverToken || undefined,
                }),
            })
            if (!startRes.ok) throw new Error(`Could not start check (${startRes.status})`)
            const { job_id } = await startRes.json()

            const poll = async () => {
                const statusRes = await fetch(`${base}/models/${projectId}/ids-check/${job_id}/status`)
                const status = await statusRes.json()
                if (status.status === 'complete') {
                    setResult(status.result)
                    setIfcSource(status.ifc_source || null)
                    setChecking(false)
                } else if (status.status === 'failed') {
                    setError(status.error || 'IDS check failed')
                    setChecking(false)
                } else {
                    pollRef.current = setTimeout(poll, 1500)
                }
            }
            poll()
        } catch (err) {
            setError(err.message)
            setChecking(false)
        }
    }

    const toggleFailure = (key, entry) => {
        setSelected(prev => {
            const next = new Map(prev)
            if (next.has(key)) next.delete(key)
            else next.set(key, entry)
            return next
        })
    }

    const pushToBcf = async () => {
        if (!projectId || selected.size === 0) return
        setPushing(true)
        setPushedMsg(null)
        const authorName = localStorage.getItem('bcfAuthorName') || 'IDS Check'
        const created = []
        let snapshotCount = 0
        for (const { requirement, entity } of selected.values()) {
            try {
                const topic = await createTopic(projectId, {
                    title: `${entity.class}${entity.name ? ` "${entity.name}"` : ''} — ${requirement.label}`,
                    description: `${requirement.description}\n\n${entity.reason}${entity.global_id ? `\n\nGlobalId: ${entity.global_id}` : ''}`,
                    creation_author: authorName,
                    topic_type: 'Error',
                    topic_status: 'Open',
                    priority: 'Normal',
                })
                let enriched = topic
                if (entity.global_id) {
                    try {
                        const viewpoint = await viewerRef?.current?.captureViewpointForElements([entity.global_id])
                        if (viewpoint) {
                            const savedViewpoint = await createViewpoint(projectId, topic.guid, viewpoint)
                            enriched = { ...topic, viewpoint: savedViewpoint }
                            if (viewpoint.snapshot_base64) snapshotCount += 1
                        }
                    } catch {
                        // viewpoint/snapshot is best-effort — the topic itself was already created
                    }
                }
                created.push(enriched)
            } catch {
                // best-effort per-failure — continue pushing the rest
            }
        }
        // Drop the isolation filter the viewer applied while framing each
        // pushed failure, so the dashboard's main view isn't left ghosted.
        try { viewerRef?.current?.resetFilter() } catch {}
        if (created.length > 0) {
            onTopicsChange?.([...topics, ...created])
            onRequestSync?.()
        }
        setPushedMsg(`Pushed ${created.length} of ${selected.size} selected failures to BCF (${snapshotCount} with a snapshot).`)
        setSelected(new Map())
        setPushing(false)
    }

    const handleClose = () => {
        try { viewerRef?.current?.resetFilter() } catch {}
        onClose?.()
    }

    return (
        <motion.div
            initial={{ x: width }} animate={{ x: 0 }} exit={{ x: width }}
            transition={{ type: 'tween', duration: 0.2 }}
            className="fixed top-0 right-0 h-full z-[200000] flex flex-col shadow-2xl border-l border-[var(--speckle-outline-3)]"
            style={{ backgroundColor: 'var(--speckle-foundation-page)', width }}
        >
            <div
                onMouseDown={startResize}
                title="Drag to resize"
                className="absolute left-0 top-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-amber-500/40 active:bg-amber-500/60 transition-colors z-10"
            />
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--speckle-outline-3)] shrink-0">
                <h2 className="font-semibold text-sm text-[var(--speckle-foreground)]">IDS Check</h2>
                <button onClick={handleClose} className="p-1.5 hover:bg-[var(--speckle-outline-3)] rounded-lg transition-colors">
                    <X className="w-4 h-4 text-[var(--speckle-foreground-3)]" />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
                <div className="space-y-4">
                    {/* Spec picker + actions */}
                    <div className="flex items-center gap-2 flex-wrap">
                        <select
                            value={selectedSpecId}
                            onChange={e => setSelectedSpecId(e.target.value)}
                            className="px-2.5 py-1.5 text-sm rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none min-w-[220px]"
                        >
                            <option value="">Select an IDS spec…</option>
                            {specs.map(s => (
                                <option key={s.spec_id} value={s.spec_id}>{s.filename}</option>
                            ))}
                        </select>
                        {selectedSpecId && (
                            <>
                                <button
                                    onClick={editSelectedSpecInEditor}
                                    title="Edit this spec in the visual editor"
                                    className="p-1.5 rounded hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)]"
                                >
                                    <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onClick={() => removeSpec(selectedSpecId)}
                                    title="Delete this spec"
                                    className="p-1.5 rounded hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] hover:text-red-400"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </>
                        )}
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploading || !projectId}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-[var(--speckle-outline-3)] hover:opacity-90 disabled:opacity-40 transition-opacity"
                        >
                            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                            Upload .ids
                        </button>
                        <input ref={fileInputRef} type="file" accept=".ids,.xml" className="hidden" onChange={handleUpload} />

                        <button
                            onClick={openBlankEditor}
                            disabled={!projectId}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-[var(--speckle-outline-3)] hover:opacity-90 disabled:opacity-40 transition-opacity"
                        >
                            <Workflow className="w-3.5 h-3.5" />
                            Open Visual Editor
                        </button>

                        <button
                            onClick={runCheck}
                            disabled={!selectedSpecId || checking || !projectId}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-amber-500 text-black font-medium disabled:opacity-40 transition-opacity ml-auto"
                        >
                            {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                            Run Check
                        </button>
                    </div>

                    {error && (
                        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</p>
                    )}

                    {!result && !checking && !error && (
                        <p className="text-xs text-[var(--speckle-foreground-3)] text-center py-10">
                            Upload an .ids file and run a check to see a pass/fail report here.
                        </p>
                    )}

                    {result && (
                        <>
                            <div className="flex items-center gap-4 rounded-xl border border-[var(--speckle-outline-3)] px-4 py-3">
                                <StatusPill ok={result.status} />
                                <div className="text-sm text-[var(--speckle-foreground)] font-medium">{result.title || 'IDS Report'}</div>
                                <div className="text-xs text-[var(--speckle-foreground-3)] ml-auto">
                                    {result.total_specifications_pass}/{result.total_specifications} specifications pass
                                    {' · '}{result.total_checks_pass}/{result.total_checks} checks pass
                                </div>
                            </div>
                            {ifcSource && (
                                <p className="text-[11px] text-[var(--speckle-foreground-3)] -mt-1">
                                    {ifcSource === 'original_ifc'
                                        ? 'Checked against the original IFC file uploaded to this stream.'
                                        : 'No original IFC file found on this stream — checked against a reconstructed IFC (classification, storeys and geometry are estimated from normalized data).'}
                                </p>
                            )}

                            <div className="space-y-2">
                                {result.specifications.map((spec, specIdx) => (
                                    <SpecificationBlock
                                        key={specIdx}
                                        specIdx={specIdx}
                                        specification={spec}
                                        selected={selected}
                                        onToggle={toggleFailure}
                                        viewerRef={viewerRef}
                                    />
                                ))}
                            </div>
                        </>
                    )}

                    {pushedMsg && (
                        <p className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">{pushedMsg}</p>
                    )}
                </div>
            </div>

            {result && (
                <div className="border-t border-[var(--speckle-outline-3)] px-5 py-3 flex items-center justify-end gap-3 shrink-0">
                    <span className="text-xs text-[var(--speckle-foreground-3)]">{selected.size} selected</span>
                    <button
                        onClick={pushToBcf}
                        disabled={selected.size === 0 || pushing || !projectId}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 disabled:opacity-40 transition-colors"
                    >
                        {pushing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                        Push selected to BCF
                    </button>
                </div>
            )}

            <AnimatePresence>
                {showEditor && (
                    <IdsGraphEditor
                        uploadSpecFile={uploadSpecFile}
                        initialGraph={editorInitialGraph}
                        onClose={() => setShowEditor(false)}
                    />
                )}
            </AnimatePresence>
        </motion.div>
    )
}
