import { useCallback, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
    ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
    useNodesState, useEdgesState, addEdge, useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { X, Download, Upload, Save, Loader2, CheckCircle2, AlertTriangle, LayoutTemplate, Info } from 'lucide-react'
import {
    nodeTypes, PALETTE_GROUPS, VALID_SPEC_SOURCE_TYPES, VALID_RESTRICTION_SOURCE_TYPES, ACCENTS,
} from './idsGraphNodeTypes'
import { convertGraphToIdsXml, graphToCanvasJson, parseCanvasJson, validateGraph } from '../utils/idsGraphToXml'
import { SPEC_TEMPLATES, instantiateTemplate } from '../utils/idsTemplates'

// Full-screen native visual IDS graph editor — built in-house, independent
// of (not a fork of) the AGPL-licensed ids-flow/idsedit.com, producing the
// { nodes, edges } shape ../utils/idsGraphToXml.js turns into a runnable IDS
// spec (also an independent implementation, against the IDS 1.0 XSD itself
// rather than any third-party tool's source). The canvas-JSON envelope
// shape is kept interchangeable with ids-flow's "Export Canvas (.json)" for
// interop, since matching a data format isn't the same as copying code.
// Nested inside IdsCheckPanel.jsx the same way ClashCheckPanel/IdsCheckPanel
// themselves nest inside App.jsx.
function IdsGraphEditorInner({ uploadSpecFile, initialGraph, onClose, onSaved }) {
    const [nodes, setNodes, onNodesChange] = useNodesState(initialGraph?.nodes || [])
    const [edges, setEdges, onEdgesChange] = useEdgesState(initialGraph?.edges || [])
    const [importOpen, setImportOpen] = useState(false)
    const [importText, setImportText] = useState('')
    const [importError, setImportError] = useState(null)
    const [templatesOpen, setTemplatesOpen] = useState(false)
    const [metadata, setMetadata] = useState(initialGraph?.metadata || {})
    const [metadataOpen, setMetadataOpen] = useState(false)
    const [saving, setSaving] = useState(false)
    const [saveMsg, setSaveMsg] = useState(null)
    const [saveError, setSaveError] = useState(null)
    const idCounter = useRef(0)
    const colorMode = document.documentElement.classList.contains('light') ? 'light' : 'dark'
    const { fitView } = useReactFlow()

    // <ReactFlow fitView> only auto-fits once, on the very first render —
    // when nodes is still []. Loading a template or an imported canvas
    // afterward replaces the nodes but never re-centers the viewport, so the
    // new content can render outside the visible area. Refit explicitly
    // whenever nodes are bulk-replaced (next tick, so the new nodes have
    // measured dimensions for fitView to work with).
    const replaceGraph = (newNodes, newEdges) => {
        setNodes(newNodes)
        setEdges(newEdges)
        setTimeout(() => fitView({ padding: 0.2 }), 0)
    }

    const addNode = (type, defaultData) => {
        idCounter.current += 1
        const col = (idCounter.current - 1) % 4
        const row = Math.floor((idCounter.current - 1) / 4)
        const id = `${type}-${Date.now()}-${idCounter.current}`
        setNodes(nds => nds.concat({
            id, type,
            position: { x: 60 + col * 260, y: 60 + row * 200 },
            data: { ...defaultData },
        }))
    }

    const nodeTypeOf = useCallback((id) => nodes.find(n => n.id === id)?.type, [nodes])

    const isValidConnection = useCallback((conn) => {
        const sourceType = nodeTypeOf(conn.source)
        const targetType = nodeTypeOf(conn.target)
        if (targetType === 'spec') return VALID_SPEC_SOURCE_TYPES.has(sourceType)
        if (targetType === 'restriction') return VALID_RESTRICTION_SOURCE_TYPES.has(sourceType)
        return false
    }, [nodeTypeOf])

    const onConnect = useCallback((connection) => {
        idCounter.current += 1
        setEdges(eds => addEdge({ ...connection, id: `e${idCounter.current}` }, eds))
    }, [setEdges])

    const loadTemplate = (template) => {
        if (nodes.length > 0 && !window.confirm('Replace the current canvas with this template?')) return
        const { nodes: tNodes, edges: tEdges } = instantiateTemplate(template)
        replaceGraph(tNodes, tEdges)
        setTemplatesOpen(false)
    }

    const runImport = () => {
        try {
            const parsed = parseCanvasJson(importText)
            replaceGraph(parsed.nodes, parsed.edges)
            if (parsed.metadata) setMetadata(parsed.metadata)
            setImportError(null)
            setImportOpen(false)
            setImportText('')
        } catch (err) {
            setImportError(err.message)
        }
    }

    const exportJson = () => {
        const json = graphToCanvasJson(nodes, edges, metadata)
        const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${(nodes.find(n => n.type === 'spec')?.data?.name || 'ids-canvas').replace(/[^\w.-]+/g, '_')}.json`
        a.click()
        URL.revokeObjectURL(url)
    }

    const saveAsSpec = async () => {
        // Belt-and-suspenders: the button is disabled while invalid, but
        // guard the action itself too rather than let a stale render slip
        // an unfixable "needs applicability" (or similar) doc past the
        // XSD-required elements and into the opaque backend 400.
        const { valid: canSave, issues: blockingIssues } = validateGraph(nodes, edges)
        if (!canSave) {
            setSaveError(`Fix these issues first: ${blockingIssues.filter(i => i.severity === 'error').map(i => i.message).join('; ')}`)
            return
        }
        setSaving(true)
        setSaveError(null)
        setSaveMsg(null)
        try {
            const xml = convertGraphToIdsXml(nodes, edges, { metadata })
            const filename = `${(nodes.find(n => n.type === 'spec')?.data?.name || 'visual-rule').replace(/[^\w.-]+/g, '_')}.ids`
            const file = new File([xml], filename, { type: 'application/xml' })
            const spec = await uploadSpecFile(file)
            setSaveMsg(`Saved as "${filename}" and added to your spec list.`)
            onSaved?.(spec)
        } catch (err) {
            setSaveError(err.message)
        } finally {
            setSaving(false)
        }
    }

    const handleClose = () => {
        if (nodes.length > 0 && !window.confirm('Discard this canvas? Unsaved changes will be lost.')) return
        onClose?.()
    }

    const { valid, issues } = validateGraph(nodes, edges)

    return (
        <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200001] flex flex-col"
            style={{ backgroundColor: 'var(--speckle-foundation-page)' }}
        >
            <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--speckle-outline-3)] shrink-0">
                <div className="flex items-center gap-3">
                    <h2 className="font-semibold text-sm text-[var(--speckle-foreground)]">IDS Visual Editor</h2>
                    <span
                        className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${valid ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}
                        title={issues.join('\n')}
                    >
                        {valid ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                        {valid ? 'Valid IDS' : `${issues.length} issue${issues.length === 1 ? '' : 's'}`}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setMetadataOpen(true)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded bg-[var(--speckle-outline-3)] hover:opacity-90 transition-opacity"
                    >
                        <Info className="w-3.5 h-3.5" /> IDS Info
                    </button>
                    <button
                        onClick={() => setTemplatesOpen(true)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded bg-[var(--speckle-outline-3)] hover:opacity-90 transition-opacity"
                    >
                        <LayoutTemplate className="w-3.5 h-3.5" /> Templates
                    </button>
                    <button
                        onClick={() => setImportOpen(true)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded bg-[var(--speckle-outline-3)] hover:opacity-90 transition-opacity"
                    >
                        <Upload className="w-3.5 h-3.5" /> Import JSON
                    </button>
                    <button
                        onClick={exportJson}
                        disabled={nodes.length === 0}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded bg-[var(--speckle-outline-3)] hover:opacity-90 disabled:opacity-40 transition-opacity"
                    >
                        <Download className="w-3.5 h-3.5" /> Export JSON
                    </button>
                    <button
                        onClick={saveAsSpec}
                        disabled={saving || nodes.length === 0 || !valid}
                        title={!valid ? `Resolve validation errors first:\n${issues.filter(i => i.severity === 'error').map(i => i.message).join('\n')}` : undefined}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-amber-500 text-black font-medium disabled:opacity-40 transition-opacity"
                    >
                        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                        Save as Spec
                    </button>
                    <button onClick={handleClose} className="p-1.5 hover:bg-[var(--speckle-outline-3)] rounded-lg transition-colors">
                        <X className="w-4 h-4 text-[var(--speckle-foreground-3)]" />
                    </button>
                </div>
            </div>

            {(saveMsg || saveError) && (
                <div className="px-5 pt-2 shrink-0">
                    {saveMsg && <p className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-1.5">{saveMsg}</p>}
                    {saveError && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-1.5">{saveError}</p>}
                </div>
            )}

            <div className="flex-1 flex overflow-hidden">
                <div className="w-44 shrink-0 border-r border-[var(--speckle-outline-3)] overflow-y-auto p-3 space-y-4">
                    {PALETTE_GROUPS.map(group => (
                        <div key={group.label}>
                            <p className="text-[10px] uppercase tracking-wider text-[var(--speckle-foreground-3)] mb-1.5">{group.label}</p>
                            <div className="space-y-1">
                                {group.items.map(item => {
                                    const accent = ACCENTS[item.type] || 'var(--speckle-foreground)'
                                    return (
                                        <button
                                            key={item.type}
                                            onClick={() => addNode(item.type, item.defaultData)}
                                            // Same accent color as this type's node card on canvas
                                            // (NodeShell's border-left + header text) — a colored dot
                                            // plus matching text color here, rather than the previous
                                            // uniform gray for every entry, so the palette itself shows
                                            // at a glance which color you'll get on canvas.
                                            className="w-full flex items-center gap-2 text-left px-2.5 py-1.5 text-xs rounded hover:bg-[var(--speckle-outline-3)] transition-colors"
                                            style={{ color: accent }}
                                        >
                                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: accent }} />
                                            {item.label}
                                        </button>
                                    )
                                })}
                            </div>
                        </div>
                    ))}
                </div>

                <div className="flex-1 relative">
                    <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        isValidConnection={isValidConnection}
                        nodeTypes={nodeTypes}
                        colorMode={colorMode}
                        fitView
                    >
                        <Background />
                        <Controls />
                        <MiniMap pannable zoomable />
                    </ReactFlow>
                    {nodes.length === 0 && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <p className="text-sm text-[var(--speckle-foreground-3)]">Click a node type in the palette to start building a specification.</p>
                        </div>
                    )}
                </div>
            </div>

            {metadataOpen && (
                <div className="fixed inset-0 z-[200002] flex items-center justify-center bg-black/50" onClick={() => setMetadataOpen(false)}>
                    <div
                        className="w-[480px] rounded-xl border border-[var(--speckle-outline-3)] p-4 space-y-2"
                        style={{ backgroundColor: 'var(--speckle-foundation)' }}
                        onClick={e => e.stopPropagation()}
                    >
                        <h3 className="text-sm font-semibold text-[var(--speckle-foreground)]">IDS file info</h3>
                        <p className="text-xs text-[var(--speckle-foreground-3)]">
                            File-level metadata (the IDS &lt;ids:info&gt; section) — applies to the whole saved file, not any one specification.
                        </p>
                        {[
                            ['title', 'Title'], ['description', 'Description'], ['author', 'Author (email)'],
                            ['copyright', 'Copyright'], ['version', 'Version'], ['date', 'Date'],
                            ['purpose', 'Purpose'], ['milestone', 'Milestone'],
                        ].map(([key, label]) => (
                            <label key={key} className="block">
                                <span className="block text-[10px] uppercase tracking-wide text-[var(--speckle-foreground-3)] mb-0.5">{label}</span>
                                <input
                                    value={metadata[key] || ''}
                                    onChange={e => setMetadata(m => ({ ...m, [key]: e.target.value }))}
                                    className="w-full px-2.5 py-1.5 text-sm rounded bg-[var(--speckle-foundation-page)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none"
                                />
                            </label>
                        ))}
                        <div className="flex justify-end gap-2 pt-1">
                            <button onClick={() => setMetadataOpen(false)} className="px-3 py-1.5 text-xs rounded bg-amber-500 text-black font-medium">Done</button>
                        </div>
                    </div>
                </div>
            )}

            {importOpen && (
                <div className="fixed inset-0 z-[200002] flex items-center justify-center bg-black/50" onClick={() => setImportOpen(false)}>
                    <div
                        className="w-[520px] rounded-xl border border-[var(--speckle-outline-3)] p-4 space-y-2"
                        style={{ backgroundColor: 'var(--speckle-foundation)' }}
                        onClick={e => e.stopPropagation()}
                    >
                        <h3 className="text-sm font-semibold text-[var(--speckle-foreground)]">Import canvas JSON</h3>
                        <p className="text-xs text-[var(--speckle-foreground-3)]">
                            Paste a canvas exported from ids-flow / idsedit.com ("Export Canvas (.json)"), or from this editor's "Export JSON". This replaces the current canvas.
                        </p>
                        <textarea
                            value={importText}
                            onChange={e => setImportText(e.target.value)}
                            rows={8}
                            placeholder='{ "version": "1.0", "metadata": {...}, "nodes": [...], "edges": [...] }'
                            className="w-full px-2.5 py-1.5 text-xs font-mono rounded bg-[var(--speckle-foundation-page)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none resize-y"
                        />
                        {importError && <p className="text-xs text-red-400">{importError}</p>}
                        <div className="flex justify-end gap-2">
                            <button onClick={() => setImportOpen(false)} className="px-3 py-1.5 text-xs rounded hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]">Cancel</button>
                            <button onClick={runImport} disabled={!importText.trim()} className="px-3 py-1.5 text-xs rounded bg-amber-500 text-black font-medium disabled:opacity-40">Load</button>
                        </div>
                    </div>
                </div>
            )}

            {templatesOpen && (
                <div className="fixed inset-0 z-[200002] flex items-center justify-center bg-black/50" onClick={() => setTemplatesOpen(false)}>
                    <div
                        className="w-[560px] max-h-[80vh] overflow-y-auto rounded-xl border border-[var(--speckle-outline-3)] p-4 space-y-3"
                        style={{ backgroundColor: 'var(--speckle-foundation)' }}
                        onClick={e => e.stopPropagation()}
                    >
                        <h3 className="text-sm font-semibold text-[var(--speckle-foreground)]">Start from a template</h3>
                        {Object.entries(
                            SPEC_TEMPLATES.reduce((acc, t) => {
                                (acc[t.category] ||= []).push(t)
                                return acc
                            }, {})
                        ).map(([category, templates]) => (
                            <div key={category}>
                                <p className="text-[10px] uppercase tracking-wider text-[var(--speckle-foreground-3)] mb-1.5">{category}</p>
                                <div className="grid grid-cols-2 gap-2">
                                    {templates.map(t => (
                                        <button
                                            key={t.id}
                                            onClick={() => loadTemplate(t)}
                                            className="text-left p-2.5 rounded-lg border border-[var(--speckle-outline-3)] hover:bg-[var(--speckle-outline-3)] transition-colors"
                                        >
                                            <p className="text-xs font-medium text-[var(--speckle-foreground)]">{t.name}</p>
                                            <p className="text-[10px] text-[var(--speckle-foreground-3)]">{t.description}</p>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                        <div className="flex justify-end">
                            <button onClick={() => setTemplatesOpen(false)} className="px-3 py-1.5 text-xs rounded hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)]">Close</button>
                        </div>
                    </div>
                </div>
            )}
        </motion.div>
    )
}

export function IdsGraphEditor(props) {
    return (
        <ReactFlowProvider>
            <IdsGraphEditorInner {...props} />
        </ReactFlowProvider>
    )
}
