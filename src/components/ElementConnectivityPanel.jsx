import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
    ReactFlow, ReactFlowProvider, Background, Handle, Position, useReactFlow,
    useNodesState, useEdgesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { X, Loader2, Waypoints } from 'lucide-react'
import { useDrawerWidth } from '../utils/useDrawerWidth'

// Full-screen connectivity panel — same style/size/chrome as ClashCheckPanel/
// IdsCheckPanel (fixed right-docked top-0/h-full, shared resizable width via
// useDrawerWidth), except its z-index (z-[250]) sits below the AI Assistant
// chat FAB (z-[260]) instead of the 200000 tier those panels use, so it
// never hides the chat toggle, while still overlapping ElementPanel
// (z-[245]) per the original ask. Opened via the Waypoints button in
// ElementPanel's header; shows a small
// node-link graph of the selected element's neighbors — see db/query.py's
// get_element_connectivity for what it combines (structural/IFC
// relationships + geometric touching). Nodes are draggable for readability
// (dense graphs otherwise overlap); clicking a node highlights it in the 3D
// viewer and recenters the graph on it.

// bim_relationships carries up to 8 relation_type values (Revit-only
// parent/room/space, real IFC relationships where a model has a usable IFC
// representation, plus geometric touching) — collapsed into 3 visual
// categories so the legend stays readable.
const EDGE_CATEGORY = {
    touches: 'contact', connects: 'contact',
    parent: 'structural', room: 'structural', space: 'structural',
    aggregates: 'structural', contained_in: 'structural',
    voids: 'opening', fills: 'opening',
}
const CATEGORY_COLOR = {
    contact: 'var(--speckle-warning-darker)',
    structural: 'var(--speckle-outline-4)',
    opening: 'var(--speckle-danger)',
}
const CATEGORY_LABEL = {
    contact: 'touching / connects',
    structural: 'structural',
    opening: 'openings',
}
const categoryFor = (type) => EDGE_CATEGORY[type] || 'structural'

// Plain, read-only node card — no delete/edit affordances since this graph
// is never edited, unlike idsGraphNodeTypes.jsx's NodeShell.
function ConnectivityNode({ data }) {
    const accent = data.isCenter ? 'var(--speckle-outline-1)' : (CATEGORY_COLOR[data.category] || 'var(--speckle-outline-3)')
    return (
        <div
            className="rounded-lg border px-3 py-2 text-xs cursor-pointer"
            style={{
                minWidth: 120,
                borderColor: accent,
                borderWidth: data.isCenter ? 1.8 : 1,
                background: 'var(--speckle-foundation-2)',
            }}
            title={`${data.name || '(unnamed)'} — click to focus`}
        >
            <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
            <div className="font-semibold truncate" style={{ color: 'var(--speckle-foreground)' }}>
                {data.category || data.ifcClass || '(unnamed)'}
            </div>
            {data.ifcClass && (
                <div className="truncate text-[10px]" style={{ color: 'var(--speckle-foreground-3)' }}>{data.ifcClass}</div>
            )}
            {data.name && (
                <div className="truncate text-[10px] mt-0.5" style={{ color: 'var(--speckle-foreground-2)' }}>{data.name}</div>
            )}
            <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
        </div>
    )
}

const nodeTypes = { connectivity: ConnectivityNode }

// Small local radial-placement function — center node at the origin, each
// hop on a wider ring. Hop-1 nodes are spread evenly around the full circle;
// later hops cluster near whichever earlier-hop neighbor they connect to, so
// branches fan out near their parent's angle instead of scattering
// independently. No layout library needed given the small bounded node
// count (see max_nodes in db/query.py's get_element_connectivity) — there's
// no existing radial/auto-layout code anywhere in this codebase to reuse.
function layoutRadial(nodes, edges, centerElementId) {
    const byHop = new Map()
    for (const n of nodes) {
        if (!byHop.has(n.hop)) byHop.set(n.hop, [])
        byHop.get(n.hop).push(n)
    }
    const angleOf = new Map([[centerElementId, 0]])
    const positioned = new Map([[centerElementId, { x: 0, y: 0 }]])
    const maxHop = Math.max(0, ...nodes.map((n) => n.hop))

    for (let hop = 1; hop <= maxHop; hop++) {
        const ring = byHop.get(hop) || []
        const radius = hop * 190

        if (hop === 1) {
            ring.forEach((n, i) => {
                const angle = (2 * Math.PI * i) / Math.max(1, ring.length)
                angleOf.set(n.element_id, angle)
                positioned.set(n.element_id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
            })
            continue
        }

        const byParent = new Map()
        for (const n of ring) {
            const parentEdge = edges.find((e) =>
                (e.source === n.element_id && positioned.has(e.target)) ||
                (e.target === n.element_id && positioned.has(e.source))
            )
            const parentId = parentEdge
                ? (parentEdge.source === n.element_id ? parentEdge.target : parentEdge.source)
                : centerElementId
            if (!byParent.has(parentId)) byParent.set(parentId, [])
            byParent.get(parentId).push(n)
        }
        for (const [parentId, siblings] of byParent) {
            const baseAngle = angleOf.get(parentId) ?? 0
            siblings.forEach((n, i) => {
                const spread = 0.5
                const angle = siblings.length === 1 ? baseAngle : baseAngle + spread * (i / (siblings.length - 1) - 0.5)
                angleOf.set(n.element_id, angle)
                positioned.set(n.element_id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
            })
        }
    }
    return positioned
}

function ConnectivityGraphInner({ normalizerUrl, elementId, hops, onCenterChange, viewerRef }) {
    const [graph, setGraph] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [centerElementId, setCenterElementId] = useState(elementId)
    const [nodes, setNodes, onNodesChange] = useNodesState([])
    const [edges, setEdges, onEdgesChange] = useEdgesState([])
    const { fitView } = useReactFlow()

    const base = (normalizerUrl || '').replace(/\/$/, '')

    const load = useCallback(async (id) => {
        if (!base || !id) { setGraph(null); return }
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`${base}/elements/${id}/connectivity?hops=${hops}`)
            if (!res.ok) throw new Error(`Request failed (${res.status})`)
            setGraph(await res.json())
        } catch (err) {
            setError(err.message)
            setGraph(null)
        } finally {
            setLoading(false)
        }
    }, [base, hops])

    useEffect(() => {
        setCenterElementId(elementId)
        load(elementId)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [elementId, hops])

    // Recompute the radial layout only when the underlying graph or center
    // changes — not on every drag — since onNodesChange (wired below) is
    // what actually persists a dragged position; recomputing from graph on
    // every render would snap dragged nodes back.
    useEffect(() => {
        if (!graph || !centerElementId) { setNodes([]); setEdges([]); return }
        const positions = layoutRadial(graph.nodes, graph.edges, centerElementId)
        setNodes(graph.nodes.map((n) => ({
            id: n.element_id,
            type: 'connectivity',
            position: positions.get(n.element_id) || { x: 0, y: 0 },
            data: {
                name: n.name, category: n.category, ifcClass: n.ifc_class,
                speckleId: n.speckle_id, isCenter: n.element_id === centerElementId,
            },
        })))
        setEdges(graph.edges.map((e, i) => ({
            id: `e${i}`,
            source: e.source,
            target: e.target,
            label: e.type,
            labelStyle: { fontSize: 9, fill: 'var(--speckle-foreground-3)' },
            style: { stroke: CATEGORY_COLOR[categoryFor(e.type)], strokeWidth: 1.6 },
        })))
        setTimeout(() => fitView({ padding: 0.25 }), 0)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [graph, centerElementId])

    const handleNodeClick = (_evt, node) => {
        if (node.data?.speckleId) viewerRef?.current?.selectObject(node.data.speckleId)
        if (node.id !== centerElementId) {
            setCenterElementId(node.id)
            onCenterChange?.({ elementId: node.id, name: node.data?.name })
            load(node.id)
        }
    }

    const colorMode = document.documentElement.classList.contains('light') ? 'light' : 'dark'

    if (loading) {
        return (
            <div className="flex-1 flex items-center justify-center gap-2 text-sm text-zinc-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
        )
    }
    if (error) {
        return <div className="flex-1 flex items-center justify-center text-sm text-red-400 px-6 text-center">{error}</div>
    }
    if (graph && nodes.length <= 1) {
        return (
            <div className="flex-1 flex items-center justify-center text-sm text-zinc-600 italic px-6 text-center">
                No connections found within {hops} hop(s)
            </div>
        )
    }

    return (
        <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode={colorMode}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
            onNodeClick={handleNodeClick}
            fitView
        >
            <Background />
        </ReactFlow>
    )
}

export function ElementConnectivityPanel({ normalizerUrl, elementId, elementName, viewerRef, onClose }) {
    const [width, startResize] = useDrawerWidth()
    const [hops, setHops] = useState(2)
    const [center, setCenter] = useState({ elementId, name: elementName })

    useEffect(() => {
        setCenter({ elementId, name: elementName })
    }, [elementId, elementName])

    return (
        <motion.div
            initial={{ x: width }} animate={{ x: 0 }} exit={{ x: width }}
            transition={{ type: 'tween', duration: 0.2 }}
            className="fixed top-0 right-0 h-full z-[250] flex flex-col shadow-2xl border-l border-[var(--speckle-outline-3)]"
            style={{ backgroundColor: 'var(--speckle-foundation-page)', width }}
        >
            <div
                onMouseDown={startResize}
                title="Drag to resize"
                className="absolute left-0 top-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-amber-500/40 active:bg-amber-500/60 transition-colors z-10"
            />

            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--speckle-outline-3)] shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                    <Waypoints className="w-5 h-5 text-[var(--speckle-outline-1)] shrink-0" />
                    <div className="min-w-0">
                        <h2 className="font-semibold text-sm text-[var(--speckle-foreground)]">Connectivity</h2>
                        {center.name && (
                            <p className="text-[11px] text-[var(--speckle-foreground-3)] truncate">{center.name}</p>
                        )}
                    </div>
                </div>
                <button onClick={onClose} className="p-1.5 hover:bg-[var(--speckle-outline-3)] rounded-lg transition-colors shrink-0">
                    <X className="w-4 h-4 text-[var(--speckle-foreground-3)]" />
                </button>
            </div>

            <div className="flex-1 overflow-hidden flex flex-col p-5 gap-3">
                <div className="flex items-center justify-between shrink-0">
                    <div className="inline-flex rounded-md border border-[var(--speckle-outline-3)] overflow-hidden">
                        {[1, 2, 3].map((h) => (
                            <button
                                key={h}
                                onClick={() => setHops(h)}
                                className={`px-3 py-1 text-xs font-mono ${h === hops ? 'bg-[var(--speckle-outline-3)] text-white' : 'text-zinc-500'}`}
                            >
                                {h}
                            </button>
                        ))}
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-zinc-500">
                        {Object.entries(CATEGORY_LABEL).map(([cat, label]) => (
                            <span key={cat} className="flex items-center gap-1.5">
                                <span className="w-3 h-0.5 rounded shrink-0" style={{ background: CATEGORY_COLOR[cat] }} />
                                {label}
                            </span>
                        ))}
                    </div>
                </div>

                <div className="flex-1 rounded-lg border border-[var(--speckle-outline-3)] overflow-hidden flex" style={{ background: 'var(--speckle-foundation)' }}>
                    <ReactFlowProvider>
                        <ConnectivityGraphInner
                            key={elementId}
                            normalizerUrl={normalizerUrl}
                            elementId={elementId}
                            hops={hops}
                            onCenterChange={setCenter}
                            viewerRef={viewerRef}
                        />
                    </ReactFlowProvider>
                </div>

                <p className="text-[10.5px] text-zinc-600 shrink-0">
                    Click a node to recenter the graph on it and highlight it in the 3D view.
                </p>
            </div>
        </motion.div>
    )
}
