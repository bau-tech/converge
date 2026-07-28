import { useState, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import { X, Play, Loader2, Send, AlertTriangle, Plus, Trash2, Layers } from 'lucide-react'
import { createTopic, createViewpoint } from '../utils/bcfClient'
import { useDrawerWidth } from '../utils/useDrawerWidth'
import { useAuth } from '../contexts/AuthContext'

const MODES = [
    { value: 'collision', label: 'Collision (overlapping solids)' },
    { value: 'intersection', label: 'Intersection (mesh faces crossing)' },
    { value: 'clearance', label: 'Clearance (minimum distance)' },
]

let ruleIdSeq = 0
function newRule() {
    return { id: ++ruleIdSeq, name: '', selectorA: '', selectorB: '', mode: 'collision', tolerance: 0.01, clearance: 0.1 }
}

function pairKey(a, b) { return `${a.branchName} × ${b.branchName}` }

// N-way cross-discipline clash checking across the currently combined models
// (see CombineModelsPicker.jsx). The backend (`/models/{id}/clash-check`)
// only ever compares exactly two models per call — this panel doesn't touch
// that; instead it orchestrates one call per pair among the combined set
// (e.g. 3 models -> 3 pairwise jobs: ARC-STR, ARC-FM, STR-FM), polls all of
// them, and renders one result section per pair plus a rolled-up total.
// Kept as a sibling to ClashCheckPanel.jsx (not merged into it) so the
// existing single-model/single-compare flow stays completely unchanged.
export function FederatedClashPanel({ combinedModels, normalizerUrl, viewerRef, topics = [], onTopicsChange, onRequestSync, ifcClasses = [], onClose, serverUrl, serverToken, projectId }) {
    const base = (normalizerUrl || '').replace(/\/$/, '')
    const { user } = useAuth()
    const [width, startResize] = useDrawerWidth()

    const [rules, setRules] = useState(() => [newRule()])
    const [checking, setChecking] = useState(false)
    const [pairJobs, setPairJobs] = useState([])  // [{ key, a, b, jobId, status, result, error }]
    const [error, setError] = useState(null)
    const [selected, setSelected] = useState(new Set())  // keys: "<pairIdx>:<ruleIdx>:<clashIdx>"
    const [pushing, setPushing] = useState(false)
    const [pushedMsg, setPushedMsg] = useState(null)
    const pollTimersRef = useRef([])

    // Unmount cleanup independent of handleClose — App.jsx's exitCombineMode
    // unmounts this panel directly (setShowFederatedClash(false)) without
    // ever calling handleClose, so relying on handleClose alone left any
    // still-polling pair-clash jobs running forever whenever combine mode
    // was exited that way instead of via this panel's own close button.
    useEffect(() => () => {
        pollTimersRef.current.forEach((t) => clearTimeout(t))
        pollTimersRef.current = []
    }, [])

    const updateRule = (id, patch) => setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    const addRule = () => setRules((prev) => [...prev, {
        ...newRule(),
        selectorA: ifcClasses[0] || '',
        selectorB: ifcClasses[1] && ifcClasses[1] !== ifcClasses[0] ? ifcClasses[1] : '',
    }])
    const removeRule = (id) => setRules((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev))

    const entries = [...combinedModels.values()].filter((m) => m.normalizerModelId)
    const pairs = []
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) pairs.push([entries[i], entries[j]])
    }

    const totalClashes = pairJobs.reduce((sum, p) => sum + (p.result?.total_count || 0), 0)
    const allDone = pairJobs.length > 0 && pairJobs.every((p) => p.status === 'complete' || p.status === 'failed')

    const runCheck = async () => {
        const validRules = rules.filter((r) => r.selectorA.trim())
        if (validRules.length === 0 || pairs.length === 0) return
        pollTimersRef.current.forEach((t) => clearTimeout(t))
        pollTimersRef.current = []
        setChecking(true)
        setError(null)
        setSelected(new Set())
        setPushedMsg(null)

        const ruleBody = validRules.map((r) => ({
            name: r.name.trim() || null,
            selector_a: r.selectorA.trim(),
            selector_b: r.selectorB.trim() || null,
            mode: r.mode,
            tolerance: Number(r.tolerance),
            clearance: Number(r.clearance),
            allow_touching: true,
        }))

        const initialJobs = pairs.map(([a, b]) => ({ key: pairKey(a, b), a, b, jobId: null, status: 'starting', result: null, error: null }))
        setPairJobs(initialJobs)

        const started = await Promise.all(pairs.map(async ([a, b], idx) => {
            try {
                const startRes = await fetch(`${base}/models/${a.normalizerModelId}/clash-check`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        rules: ruleBody,
                        server_url: serverUrl || undefined,
                        token: serverToken || undefined,
                        compare_model_id: b.normalizerModelId,
                    }),
                })
                if (!startRes.ok) throw new Error(`Could not start check (${startRes.status})`)
                const { job_id } = await startRes.json()
                return { idx, jobId: job_id, status: 'pending' }
            } catch (err) {
                return { idx, status: 'failed', error: err.message }
            }
        }))

        setPairJobs((prev) => prev.map((p, i) => {
            const s = started.find((x) => x.idx === i)
            return s ? { ...p, jobId: s.jobId, status: s.status, error: s.error } : p
        }))

        const poll = (idx, a, jobId) => {
            const timer = setTimeout(async () => {
                try {
                    const statusRes = await fetch(`${base}/models/${a.normalizerModelId}/clash-check/${jobId}/status`)
                    const status = await statusRes.json()
                    if (status.status === 'complete') {
                        setPairJobs((prev) => prev.map((p, i) => (i === idx ? { ...p, status: 'complete', result: status.result } : p)))
                    } else if (status.status === 'failed') {
                        setPairJobs((prev) => prev.map((p, i) => (i === idx ? { ...p, status: 'failed', error: status.error || 'Clash check failed' } : p)))
                    } else {
                        poll(idx, a, jobId)
                    }
                } catch (err) {
                    setPairJobs((prev) => prev.map((p, i) => (i === idx ? { ...p, status: 'failed', error: err.message } : p)))
                }
            }, 1500)
            pollTimersRef.current.push(timer)
        }
        started.forEach((s) => { if (s.status === 'pending') poll(s.idx, pairs[s.idx][0], s.jobId) })
        setChecking(false)
    }

    const toggleClash = (key) => {
        setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    const pushToBcf = async () => {
        if (!projectId || selected.size === 0) return
        setPushing(true)
        setPushedMsg(null)
        const authorName = user?.name || 'Clash Check'
        const created = []
        let snapshotCount = 0
        for (const key of selected) {
            const [pairIdx, ruleIdx, clashIdx] = key.split(':').map(Number)
            const pair = pairJobs[pairIdx]
            const rule = pair?.result?.rules?.[ruleIdx]
            const clash = rule?.clashes?.[clashIdx]
            if (!clash) continue
            try {
                const topic = await createTopic(projectId, {
                    title: `Clash (${pair.a.branchName} × ${pair.b.branchName}${rule.name ? ` — ${rule.name}` : ''}): ${clash.a_ifc_class}${clash.a_name ? ` "${clash.a_name}"` : ''} × ${clash.b_ifc_class}${clash.b_name ? ` "${clash.b_name}"` : ''}`,
                    description: `${rule.mode} clash (distance ${clash.distance.toFixed(3)})\n${pair.a.branchName} vs ${pair.b.branchName} (combined-view clash check)\n\nA GlobalId: ${clash.a_global_id}\nB GlobalId: ${clash.b_global_id}`,
                    creation_author: authorName,
                    topic_type: 'Clash',
                    topic_status: 'Open',
                    priority: rule.mode === 'clearance' ? 'High' : 'Critical',
                })
                let enriched = topic
                try {
                    const viewpoint = await viewerRef?.current?.captureViewpointForElements([clash.a_global_id, clash.b_global_id])
                    if (viewpoint) {
                        const savedViewpoint = await createViewpoint(projectId, topic.guid, viewpoint)
                        enriched = { ...topic, viewpoint: savedViewpoint }
                        if (viewpoint.snapshot_base64) snapshotCount += 1
                    }
                } catch { /* viewpoint/snapshot is best-effort */ }
                created.push(enriched)
            } catch { /* best-effort per-clash */ }
        }
        try { viewerRef?.current?.resetFilter() } catch {}
        if (created.length > 0) {
            onTopicsChange?.([...topics, ...created])
            onRequestSync?.()
        }
        setPushedMsg(`Pushed ${created.length} of ${selected.size} selected clashes to BCF (${snapshotCount} with a snapshot).`)
        setSelected(new Set())
        setPushing(false)
    }

    const handleClose = () => {
        pollTimersRef.current.forEach((t) => clearTimeout(t))
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
                <div className="flex items-center gap-2">
                    <Layers className="w-5 h-5 text-amber-400" />
                    <h2 className="font-semibold text-sm text-[var(--speckle-foreground)]">Combined Clash Detection</h2>
                </div>
                <button onClick={handleClose} className="p-1.5 hover:bg-[var(--speckle-outline-3)] rounded-lg transition-colors">
                    <X className="w-4 h-4 text-[var(--speckle-foreground-3)]" />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
                <div className="space-y-4">
                    <div className="rounded-xl border border-[var(--speckle-outline-3)] p-3 space-y-1.5">
                        <label className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Combined models</label>
                        <div className="flex flex-wrap gap-1.5">
                            {entries.map((m) => (
                                <span key={m.branchName} className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px]" style={{ backgroundColor: `${m.color}22`, border: `1px solid ${m.color}55` }}>
                                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: m.color }} />
                                    {m.branchName}
                                </span>
                            ))}
                        </div>
                        <p className="text-[10px] text-[var(--speckle-foreground-3)]">
                            {pairs.length === 0
                                ? 'Need at least 2 combined models to run a check.'
                                : `Will run ${pairs.length} pairwise check${pairs.length === 1 ? '' : 's'}: ${pairs.map(([a, b]) => `${a.branchName}×${b.branchName}`).join(', ')}.`}
                        </p>
                    </div>

                    <div className="rounded-xl border border-[var(--speckle-outline-3)] p-3 space-y-3">
                        {rules.map((rule, idx) => (
                            <div key={rule.id} className="flex items-center gap-2 flex-wrap pb-3 border-b border-[var(--speckle-outline-3)] last:border-b-0 last:pb-0">
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Rule {idx + 1} name (optional)</label>
                                    <input
                                        value={rule.name}
                                        onChange={(e) => updateRule(rule.id, { name: e.target.value })}
                                        placeholder="e.g. Columns vs Beams"
                                        className="px-2.5 py-1.5 text-sm rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none w-44"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Class A</label>
                                    <select
                                        value={rule.selectorA}
                                        onChange={(e) => updateRule(rule.id, { selectorA: e.target.value })}
                                        disabled={ifcClasses.length === 0}
                                        className="px-2.5 py-1.5 text-sm rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none w-40 disabled:opacity-50"
                                    >
                                        {ifcClasses.length === 0 && <option value="">Loading classes…</option>}
                                        {ifcClasses.map((c) => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Class B (optional)</label>
                                    <select
                                        value={rule.selectorB}
                                        onChange={(e) => updateRule(rule.id, { selectorB: e.target.value })}
                                        disabled={ifcClasses.length === 0}
                                        className="px-2.5 py-1.5 text-sm rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none w-52 disabled:opacity-50"
                                    >
                                        <option value="">— Same class as A —</option>
                                        {ifcClasses.map((c) => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Mode</label>
                                    <select
                                        value={rule.mode}
                                        onChange={(e) => updateRule(rule.id, { mode: e.target.value })}
                                        className="px-2.5 py-1.5 text-sm rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none"
                                    >
                                        {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                                    </select>
                                </div>
                                {rule.mode === 'intersection' && (
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Tolerance (m)</label>
                                        <input
                                            type="number" step="0.001" value={rule.tolerance}
                                            onChange={(e) => updateRule(rule.id, { tolerance: e.target.value })}
                                            className="px-2.5 py-1.5 text-sm rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none w-24"
                                        />
                                    </div>
                                )}
                                {rule.mode === 'clearance' && (
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Clearance (m)</label>
                                        <input
                                            type="number" step="0.01" value={rule.clearance}
                                            onChange={(e) => updateRule(rule.id, { clearance: e.target.value })}
                                            className="px-2.5 py-1.5 text-sm rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none w-24"
                                        />
                                    </div>
                                )}
                                <button
                                    onClick={() => removeRule(rule.id)}
                                    disabled={rules.length === 1}
                                    title="Remove rule"
                                    className="p-1.5 rounded text-[var(--speckle-foreground-3)] hover:bg-[var(--speckle-outline-3)] hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors self-end"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        ))}

                        <div className="flex items-center gap-2">
                            <button
                                onClick={addRule}
                                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-[var(--speckle-outline-3)] text-[var(--speckle-foreground-2)] hover:bg-[var(--speckle-outline-3)] transition-colors"
                            >
                                <Plus className="w-3.5 h-3.5" /> Add rule
                            </button>
                            <button
                                onClick={runCheck}
                                disabled={!rules.some((r) => r.selectorA.trim()) || checking || pairs.length === 0}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-amber-500 text-black font-medium disabled:opacity-40 transition-opacity ml-auto"
                            >
                                {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                                Run Check ({pairs.length} pair{pairs.length === 1 ? '' : 's'})
                            </button>
                        </div>
                        <p className="text-[10px] text-[var(--speckle-foreground-3)]">
                            Each pair is checked independently against the same rules — Class A is matched in the first model of each pair, Class B in the second.
                        </p>
                    </div>

                    {error && (
                        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</p>
                    )}

                    {pairJobs.length === 0 && !error && (
                        <p className="text-xs text-[var(--speckle-foreground-3)] text-center py-10">
                            Set up one or more rules above and run a check to see clashes across every combined pair here.
                        </p>
                    )}

                    {pairJobs.length > 0 && (
                        <div className="space-y-3">
                            <div className="flex items-center gap-3 rounded-xl border border-[var(--speckle-outline-3)] px-4 py-3">
                                <AlertTriangle className={`w-4 h-4 shrink-0 ${totalClashes > 0 ? 'text-amber-400' : 'text-emerald-400'}`} />
                                <div className="text-sm text-[var(--speckle-foreground)] font-medium">
                                    {allDone
                                        ? `${totalClashes} clash${totalClashes === 1 ? '' : 'es'} across ${pairJobs.length} pair${pairJobs.length === 1 ? '' : 's'}`
                                        : `Checking ${pairJobs.length} pair${pairJobs.length === 1 ? '' : 's'}…`}
                                </div>
                            </div>

                            {pairJobs.map((pair, pairIdx) => (
                                <div key={pair.key} className="space-y-1.5">
                                    <div className="flex items-center gap-2 px-1 pt-1">
                                        <span className="text-xs font-semibold text-[var(--speckle-foreground-2)]">{pair.key}</span>
                                        {pair.status === 'pending' || pair.status === 'starting' ? (
                                            <Loader2 className="w-3 h-3 animate-spin text-[var(--speckle-foreground-3)]" />
                                        ) : pair.status === 'failed' ? (
                                            <span className="text-[10px] text-red-400">{pair.error || 'failed'}</span>
                                        ) : (
                                            <span className={`text-[10px] ml-auto ${pair.result?.total_count > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                                                {pair.result?.total_count || 0} clash{pair.result?.total_count === 1 ? '' : 'es'}
                                            </span>
                                        )}
                                    </div>
                                    {pair.status === 'complete' && pair.result?.rules?.map((rule, ruleIdx) => (
                                        <div key={ruleIdx} className="space-y-1">
                                            {rule.clashes.map((c, clashIdx) => {
                                                const key = `${pairIdx}:${ruleIdx}:${clashIdx}`
                                                return (
                                                    <div
                                                        key={key}
                                                        onClick={() => viewerRef?.current?.focusElements([c.a_global_id, c.b_global_id])}
                                                        title="Click to highlight this clash in the 3D view"
                                                        className="flex items-start gap-2 px-3 py-2 rounded-lg border border-[var(--speckle-outline-3)] text-xs cursor-pointer hover:bg-[var(--speckle-outline-3)]"
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={selected.has(key)}
                                                            onClick={(e) => e.stopPropagation()}
                                                            onChange={() => toggleClash(key)}
                                                            className="mt-0.5 shrink-0"
                                                        />
                                                        <div className="min-w-0 flex-1">
                                                            <p className="text-[var(--speckle-foreground)]">
                                                                <span className="text-[var(--speckle-foreground-3)]">{pair.a.branchName}: </span>
                                                                {c.a_ifc_class}{c.a_name ? ` "${c.a_name}"` : ''}
                                                                {' × '}
                                                                <span className="text-[var(--speckle-foreground-3)]">{pair.b.branchName}: </span>
                                                                {c.b_ifc_class}{c.b_name ? ` "${c.b_name}"` : ''}
                                                            </p>
                                                            <p className="text-[var(--speckle-foreground-3)]">distance {c.distance.toFixed(3)}m</p>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                    )}

                    {pushedMsg && (
                        <p className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">{pushedMsg}</p>
                    )}
                </div>
            </div>

            {totalClashes > 0 && (
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
        </motion.div>
    )
}
