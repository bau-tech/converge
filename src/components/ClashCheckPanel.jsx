import { useState, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import { X, Play, Loader2, Send, AlertTriangle, Plus, Trash2 } from 'lucide-react'
import { createTopic, createViewpoint } from '../utils/bcfClient'
import { useDrawerWidth } from '../utils/useDrawerWidth'
import { ClashLogoIcon } from './ClashLogoIcon'

const MODES = [
    { value: 'collision', label: 'Collision (overlapping solids)' },
    { value: 'intersection', label: 'Intersection (mesh faces crossing)' },
    { value: 'clearance', label: 'Clearance (minimum distance)' },
]

// selectorA/selectorB start blank — they're seeded from the model's actual
// IFC classes once `ifcClasses` loads (see the effect below), since hardcoded
// names like "IfcColumn"/"IfcBeam" may not exist in every model.
let ruleIdSeq = 0
function newRule() {
    return {
        id: ++ruleIdSeq,
        name: '',
        selectorA: '',
        selectorB: '',
        mode: 'collision',
        tolerance: 0.01,
        clearance: 0.1,
    }
}

// Full-screen clash detection panel. Exports the current model to IFC
// server-side and runs real BVH mesh-level clash detection (ifcclash) —
// not bounding-box approximation. Mirrors IdsCheckPanel.jsx's structure:
// run a check, review results, push selected clashes to BCF via the same
// createTopic() call BcfTopicPanel/BcfKanbanBoard already use. Unlike the
// IDS check panel, each pushed clash also gets a real viewpoint + snapshot
// by flying the live 3D viewer to the two clashing elements (viewerRef),
// since "what does this clash actually look like" matters a lot more here
// than for a generic IDS pass/fail.
//
// Supports multiple rules per run (e.g. "Columns vs Beams" + "Pipes vs
// Ducts") — the backend exports the model to IFC once and runs every rule
// against that same export in one job, so results come back grouped by rule.
export function ClashCheckPanel({ projectId, normalizerUrl, viewerRef, topics = [], onTopicsChange, onRequestSync, ifcClasses = [], onClose, serverUrl, serverToken }) {
    const base = (normalizerUrl || '').replace(/\/$/, '')
    const [width, startResize] = useDrawerWidth()

    const [rules, setRules] = useState(() => [newRule()])
    const [checking, setChecking] = useState(false)
    const [result, setResult] = useState(null)   // { rules: [...], total_count }
    const [ifcSource, setIfcSource] = useState(null)
    const [compareInfo, setCompareInfo] = useState(null)   // { model_b_id, ifc_source_a, ifc_source_b } | null
    const [error, setError] = useState(null)
    const [selected, setSelected] = useState(new Set())   // keys: "<ruleIndex>:<clashIndex>"
    const [pushing, setPushing] = useState(false)
    const [pushedMsg, setPushedMsg] = useState(null)
    const pollRef = useRef(null)

    // Other already-ingested models this model can be cross-checked against
    // (clash-check operates on bim_models rows, so the candidate model must
    // already be ingested — same precondition as the active model itself).
    const [availableModels, setAvailableModels] = useState([])
    const [compareModel, setCompareModel] = useState(null)   // a row from availableModels, or null for single-model mode

    useEffect(() => {
        if (!base) return
        let cancelled = false
        fetch(`${base}/models`)
            .then(res => res.ok ? res.json() : [])
            .then(models => { if (!cancelled) setAvailableModels(Array.isArray(models) ? models : []) })
            .catch(() => { if (!cancelled) setAvailableModels([]) })
        return () => { cancelled = true }
    }, [base])

    const otherModels = availableModels.filter(m => m.model_id !== projectId)
    const compareLabel = (m) => `${m.branch_name || m.stream_id} · ${m.source || 'unknown'} · ${m.ingested_at ? new Date(m.ingested_at).toLocaleDateString() : ''}`

    // Seed any still-blank rule's selectors with real IFC classes once they load
    // (a fresh rule starts blank since there's no model-agnostic sensible default).
    // Only touches rules the user hasn't picked anything for yet.
    useEffect(() => {
        if (ifcClasses.length === 0) return
        setRules(prev => prev.map(r => r.selectorA !== '' ? r : {
            ...r,
            selectorA: ifcClasses[0] || '',
            selectorB: ifcClasses[1] && ifcClasses[1] !== ifcClasses[0] ? ifcClasses[1] : '',
        }))
    }, [ifcClasses])

    const updateRule = (id, patch) =>
        setRules(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r))
    const addRule = () => setRules(prev => [...prev, {
        ...newRule(),
        selectorA: ifcClasses[0] || '',
        selectorB: ifcClasses[1] && ifcClasses[1] !== ifcClasses[0] ? ifcClasses[1] : '',
    }])
    const removeRule = (id) => setRules(prev => prev.length > 1 ? prev.filter(r => r.id !== id) : prev)

    const runCheck = async () => {
        const validRules = rules.filter(r => r.selectorA.trim())
        if (!projectId || validRules.length === 0) return
        setChecking(true)
        setError(null)
        setResult(null)
        setIfcSource(null)
        setCompareInfo(null)
        setSelected(new Set())
        setPushedMsg(null)
        try {
            const startRes = await fetch(`${base}/models/${projectId}/clash-check`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    rules: validRules.map(r => ({
                        name: r.name.trim() || null,
                        selector_a: r.selectorA.trim(),
                        selector_b: r.selectorB.trim() || null,
                        mode: r.mode,
                        tolerance: Number(r.tolerance),
                        clearance: Number(r.clearance),
                        allow_touching: true,
                    })),
                    server_url: serverUrl || undefined,
                    token: serverToken || undefined,
                    compare_model_id: compareModel?.model_id || undefined,
                }),
            })
            if (!startRes.ok) throw new Error(`Could not start check (${startRes.status})`)
            const { job_id } = await startRes.json()

            const poll = async () => {
                const statusRes = await fetch(`${base}/models/${projectId}/clash-check/${job_id}/status`)
                const status = await statusRes.json()
                if (status.status === 'complete') {
                    setResult(status.result)
                    setIfcSource(status.ifc_source || null)
                    setCompareInfo(status.compare
                        ? { ...status.compare, label: compareModel ? compareLabel(compareModel) : status.compare.model_b_id }
                        : null)
                    setChecking(false)
                } else if (status.status === 'failed') {
                    setError(status.error || 'Clash check failed')
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

    const toggleClash = (key) => {
        setSelected(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    const pushToBcf = async () => {
        if (!projectId || selected.size === 0 || !result) return
        setPushing(true)
        setPushedMsg(null)
        const authorName = localStorage.getItem('bcfAuthorName') || 'Clash Check'
        const created = []
        let snapshotCount = 0
        for (const key of selected) {
            const [ruleIdx, clashIdx] = key.split(':').map(Number)
            const rule = result.rules[ruleIdx]
            const clash = rule?.clashes[clashIdx]
            if (!clash) continue
            try {
                const topic = await createTopic(projectId, {
                    title: `Clash${rule.name ? ` (${rule.name})` : ''}: ${clash.a_ifc_class}${clash.a_name ? ` "${clash.a_name}"` : ''} × ${clash.b_ifc_class}${clash.b_name ? ` "${clash.b_name}"` : ''}`,
                    description: `${rule.mode} clash (distance ${clash.distance.toFixed(3)})${compareInfo ? `\nModel A vs Model B (${compareInfo.label})` : ''}\n\nA GlobalId: ${clash.a_global_id}\nB GlobalId: ${clash.b_global_id}`,
                    creation_author: authorName,
                    topic_type: 'Clash',
                    topic_status: 'Open',
                    // 'clearance' is a minimum-distance proximity warning, not an
                    // actual overlap — real geometric clashes ('collision'/
                    // 'intersection') get flagged Critical instead of a uniform
                    // 'Normal' that gave every auto-created topic the same weight.
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
                } catch {
                    // viewpoint/snapshot is best-effort — the topic itself was already created
                }
                created.push(enriched)
            } catch {
                // best-effort per-clash — continue pushing the rest
            }
        }
        // Drop the 'clash' isolation filter the viewer applied while framing
        // each pushed clash, so the dashboard's main view isn't left ghosted.
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
                    <ClashLogoIcon className="w-6 h-6" />
                    <h2 className="font-semibold text-sm text-[var(--speckle-foreground)]">Clash Detection</h2>
                </div>
                <button onClick={handleClose} className="p-1.5 hover:bg-[var(--speckle-outline-3)] rounded-lg transition-colors">
                    <X className="w-4 h-4 text-[var(--speckle-foreground-3)]" />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
                <div className="space-y-4">
                    <div className="rounded-xl border border-[var(--speckle-outline-3)] p-3 space-y-1.5">
                        <label className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Compare against (optional)</label>
                        <select
                            value={compareModel?.model_id || ''}
                            onChange={e => setCompareModel(otherModels.find(m => m.model_id === e.target.value) || null)}
                            className="px-2.5 py-1.5 text-sm rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none w-full"
                        >
                            <option value="">This model only (default)</option>
                            {otherModels.map(m => <option key={m.model_id} value={m.model_id}>{compareLabel(m)}</option>)}
                        </select>
                        <p className="text-[10px] text-[var(--speckle-foreground-3)]">
                            {compareModel
                                ? 'Cross-model check: Group A is matched in this model, Group B in the model selected above.'
                                : 'Pick another already-ingested model to clash this one against it, instead of against itself.'}
                        </p>
                    </div>

                    <div className="rounded-xl border border-[var(--speckle-outline-3)] p-3 space-y-3">
                        {rules.map((rule, idx) => (
                            <div key={rule.id} className="flex items-center gap-2 flex-wrap pb-3 border-b border-[var(--speckle-outline-3)] last:border-b-0 last:pb-0">
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Rule {idx + 1} name (optional)</label>
                                    <input
                                        value={rule.name}
                                        onChange={e => updateRule(rule.id, { name: e.target.value })}
                                        placeholder="e.g. Columns vs Beams"
                                        className="px-2.5 py-1.5 text-sm rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none w-44"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">{compareModel ? 'Model A' : 'Group A'}</label>
                                    <select
                                        value={rule.selectorA}
                                        onChange={e => updateRule(rule.id, { selectorA: e.target.value })}
                                        disabled={ifcClasses.length === 0}
                                        className="px-2.5 py-1.5 text-sm rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none w-40 disabled:opacity-50"
                                    >
                                        {ifcClasses.length === 0 && <option value="">Loading classes…</option>}
                                        {ifcClasses.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">{compareModel ? 'Model B' : 'Group B (optional)'}</label>
                                    <select
                                        value={rule.selectorB}
                                        onChange={e => updateRule(rule.id, { selectorB: e.target.value })}
                                        disabled={ifcClasses.length === 0}
                                        className="px-2.5 py-1.5 text-sm rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none w-52 disabled:opacity-50"
                                    >
                                        <option value="">{compareModel ? '— Same class as Model A —' : '— None (clash A against itself) —'}</option>
                                        {ifcClasses.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Mode</label>
                                    <select
                                        value={rule.mode}
                                        onChange={e => updateRule(rule.id, { mode: e.target.value })}
                                        className="px-2.5 py-1.5 text-sm rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none"
                                    >
                                        {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                                    </select>
                                </div>
                                {rule.mode === 'intersection' && (
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Tolerance (m)</label>
                                        <input
                                            type="number" step="0.001" value={rule.tolerance}
                                            onChange={e => updateRule(rule.id, { tolerance: e.target.value })}
                                            className="px-2.5 py-1.5 text-sm rounded bg-[var(--speckle-foundation)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none w-24"
                                        />
                                    </div>
                                )}
                                {rule.mode === 'clearance' && (
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider">Clearance (m)</label>
                                        <input
                                            type="number" step="0.01" value={rule.clearance}
                                            onChange={e => updateRule(rule.id, { clearance: e.target.value })}
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
                                disabled={!rules.some(r => r.selectorA.trim()) || checking || !projectId}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-amber-500 text-black font-medium disabled:opacity-40 transition-opacity ml-auto"
                            >
                                {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                                Run Check{rules.length > 1 ? ` (${rules.length} rules)` : ''}
                            </button>
                        </div>
                        <p className="text-[10px] text-[var(--speckle-foreground-3)]">
                            Groups list every IFC class actually present in this model{compareModel ? ' (Model A only — Model B isn\'t checked against this list, so a class missing there just reports zero clashes)' : ''}. Collision finds overlapping solids — the standard hard-clash check. All rules run together against the same exported model{compareModel ? 's' : ''}.
                            {compareModel && ' For cross-model checks, only the side belonging to the model currently open in the viewer can be highlighted/snapshotted.'}
                        </p>
                    </div>

                    {error && (
                        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</p>
                    )}

                    {!result && !checking && !error && (
                        <p className="text-xs text-[var(--speckle-foreground-3)] text-center py-10">
                            Set up one or more rules above and run a check to see clashes here.
                        </p>
                    )}

                    {result && (
                        <div className="space-y-2">
                            <div className="flex items-center gap-3 rounded-xl border border-[var(--speckle-outline-3)] px-4 py-3">
                                <AlertTriangle className={`w-4 h-4 shrink-0 ${result.total_count > 0 ? 'text-amber-400' : 'text-emerald-400'}`} />
                                <div className="text-sm text-[var(--speckle-foreground)] font-medium">
                                    {result.total_count} clash{result.total_count === 1 ? '' : 'es'} across {result.rules.length} rule{result.rules.length === 1 ? '' : 's'}
                                    {compareInfo && <span className="text-[var(--speckle-foreground-3)] font-normal"> · vs {compareInfo.label}</span>}
                                </div>
                            </div>
                            {compareInfo && (
                                <p className="text-[11px] text-[var(--speckle-foreground-3)] -mt-1">
                                    Model A source: {compareInfo.ifc_source_a === 'original_ifc' ? 'original IFC' : 'reconstructed IFC'} · Model B source: {compareInfo.ifc_source_b === 'original_ifc' ? 'original IFC' : 'reconstructed IFC'}
                                </p>
                            )}
                            {ifcSource && (
                                <p className="text-[11px] text-[var(--speckle-foreground-3)] -mt-1">
                                    {ifcSource === 'original_ifc'
                                        ? 'Checked against the original IFC file uploaded to this stream — 3D highlighting/snapshots will work for IFC-sourced models. For models published from Revit (where this IFC was independently exported), the clash GlobalIds won\'t match this model\'s elements, so highlighting/snapshots won\'t resolve.'
                                        : 'No original IFC file found on this stream — checked against a reconstructed IFC. 3D highlighting/snapshots still work, resolved through each element\'s id.'}
                                </p>
                            )}

                            {result.rules.map((rule, ruleIdx) => (
                                <div key={ruleIdx} className="space-y-1.5">
                                    <div className="flex items-center gap-2 px-1 pt-2">
                                        <span className="text-xs font-semibold text-[var(--speckle-foreground-2)]">
                                            {rule.name || `Rule ${ruleIdx + 1}`}
                                        </span>
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">
                                            {compareInfo
                                                ? `A: ${rule.selector_a} vs B: ${rule.selector_b}`
                                                : `${rule.selector_a}${rule.selector_b ? ` vs ${rule.selector_b}` : ' (self)'}`} · {rule.mode}
                                        </span>
                                        <span className={`text-[10px] ml-auto ${rule.count > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                                            {rule.count} clash{rule.count === 1 ? '' : 'es'}
                                        </span>
                                    </div>
                                    {rule.clashes.map((c, clashIdx) => {
                                        const key = `${ruleIdx}:${clashIdx}`
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
                                                        {compareInfo && <span className="text-[var(--speckle-foreground-3)]">A: </span>}
                                                        {c.a_ifc_class}{c.a_name ? ` "${c.a_name}"` : ''}
                                                        {' × '}
                                                        {compareInfo && <span className="text-[var(--speckle-foreground-3)]">B: </span>}
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
                    )}

                    {pushedMsg && (
                        <p className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">{pushedMsg}</p>
                    )}
                </div>
            </div>

            {result && result.total_count > 0 && (
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
