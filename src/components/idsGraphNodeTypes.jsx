import { Handle, Position, useReactFlow, useNodes, useEdges } from '@xyflow/react'
import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { SearchableCombobox } from './SearchableCombobox'
import { getBsddEntityProperties, searchBsddDictionaries, searchBsddClasses } from '../utils/bsddClient'

// Standalone editable card per node type for the IDS visual graph editor.
// Each node writes its own `data` via setNodes (the standard React Flow v12
// pattern for self-editing custom nodes — no parent callback prop-drilling).
// The exact `data` keys read by each type are dictated by
// ../utils/idsGraphToXml.js's converter, not chosen freely here.

// Exported so the palette in IdsGraphEditor.jsx can color each entry to
// match its node on canvas. Chosen to sit ~45-60° apart around the hue
// wheel (0 red, 38 amber, 82 lime, 142 green, 189 cyan, 221 blue, 271
// purple, 330 pink) so all eight stay distinguishable at a glance, not just
// pairwise-different from whichever neighbor prompted the last tweak — the
// original spec/entity blues were near-identical (#276FE5 vs #3b82f6), and
// the entity/property fix that followed just swapped entity to cyan without
// checking it against property's teal, landing two different-but-adjacent
// blue-greens 14° apart. property now sits in the (previously empty) gap
// between amber and green instead of next to entity's cyan.
export const ACCENTS = {
    spec: '#276FE5',
    entity: '#06b6d4',
    property: '#84cc16',
    attribute: '#ef4444',
    classification: '#f59e0b',
    material: '#22c55e',
    partOf: '#ec4899',
    restriction: '#a855f7',
}

const LABELS = {
    spec: 'Specification',
    entity: 'Entity',
    property: 'Property',
    attribute: 'Attribute',
    classification: 'Classification',
    material: 'Material',
    partOf: 'Part Of',
    restriction: 'Restriction',
}

function useNodeField(id) {
    const { setNodes } = useReactFlow()
    return (key, value) => {
        setNodes(nodes => nodes.map(n => (n.id === id ? { ...n, data: { ...n.data, [key]: value } } : n)))
    }
}

function useRemoveNode(id) {
    const { setNodes, setEdges } = useReactFlow()
    return () => {
        setNodes(nodes => nodes.filter(n => n.id !== id))
        setEdges(edges => edges.filter(e => e.source !== id && e.target !== id))
    }
}

// Finds the IFC class of an Entity node wired into the same spec as this
// node, so Property/Classification nodes can narrow their bSDD suggestions
// to the entity actually being checked instead of the whole IFC schema.
// Entity/property/etc. nodes don't connect to each other directly — they're
// siblings converging on the same Specification node — so this walks
// source->spec->sibling-sources rather than a direct edge.
//
// Deliberately matches siblings by target NODE only (`e.target ===
// edge.target`), not target handle — an Entity always wires into the spec's
// "applicability" handle while a Property/Classification/etc. wires into
// "requirements" (see SpecHandleRow's handle ids), so a same-node *and*
// same-handle match (the previous condition here) could never find the
// Entity from a Property's edge at all: the two are siblings on the same
// spec but never share a handle. This is exactly why "Connect an Entity
// node to filter suggestions" kept showing even with a real
// Entity->Specification connection in place.
function useConnectedEntityClass(id) {
    const nodes = useNodes()
    const edges = useEdges()
    for (const edge of edges) {
        if (edge.source !== id) continue
        const siblings = edges.filter(e => e.target === edge.target)
        for (const sibling of siblings) {
            const node = nodes.find(n => n.id === sibling.source)
            if (node?.type === 'entity' && node.data?.name) return node.data.name
        }
    }
    return null
}

// bSDD's IFC 4.3 property-set data per entity class, cached module-wide
// (keyed by class name) since it's shared across every Property node in the
// canvas and never changes within a session.
const bsddEntityPropsCache = new Map()

function useBsddEntityProperties(entityClass) {
    const [result, setResult] = useState(null)
    useEffect(() => {
        if (!entityClass) { setResult(null); return }
        const cached = bsddEntityPropsCache.get(entityClass)
        if (cached) { setResult(cached); return }
        let cancelled = false
        getBsddEntityProperties(entityClass)
            .then(res => {
                bsddEntityPropsCache.set(entityClass, res)
                if (!cancelled) setResult(res)
            })
            .catch(() => { if (!cancelled) setResult({ resolved: false, propertySets: [] }) })
        return () => { cancelled = true }
    }, [entityClass])
    return result
}

function NodeShell({ id, type, children, minWidth = 220, selected }) {
    const remove = useRemoveNode(id)
    const accent = ACCENTS[type] || '#888'
    return (
        <div
            className="rounded-lg border text-xs group"
            style={{
                minWidth,
                borderColor: selected ? accent : 'var(--speckle-outline-3)',
                background: 'var(--speckle-foundation)',
                borderLeft: `3px solid ${accent}`,
                boxShadow: selected ? `0 0 0 2px ${accent}66` : 'none',
            }}
        >
            <div
                className="flex items-center justify-between px-2.5 py-1.5 border-b"
                style={{ borderColor: 'var(--speckle-outline-3)' }}
            >
                <span className="font-semibold uppercase tracking-wider text-[10px]" style={{ color: accent }}>
                    {LABELS[type]}
                </span>
                <button
                    onClick={remove}
                    className="nodrag opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] hover:text-red-400 transition-opacity"
                    title="Delete node"
                >
                    <Trash2 className="w-3 h-3" />
                </button>
            </div>
            <div className="p-2.5 space-y-1.5">{children}</div>
        </div>
    )
}

let fieldDatalistCounter = 0

function Field({ label, value, onChange, placeholder, mono, suggestions, multiline }) {
    const listId = suggestions ? `field-list-${(fieldDatalistCounter += 1)}` : undefined
    const className = `nodrag w-full px-1.5 py-1 rounded text-[11px] bg-[var(--speckle-foundation-page)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none ${mono ? 'font-mono' : ''}`
    return (
        <label className="block">
            <span className="block text-[9px] uppercase tracking-wide text-[var(--speckle-foreground-3)] mb-0.5">{label}</span>
            {multiline ? (
                <textarea
                    value={value || ''}
                    onChange={e => onChange(e.target.value)}
                    placeholder={placeholder}
                    rows={2}
                    className={`${className} resize-y`}
                />
            ) : (
                <input
                    value={value || ''}
                    onChange={e => onChange(e.target.value)}
                    placeholder={placeholder}
                    list={listId}
                    className={className}
                />
            )}
            {suggestions && (
                <datalist id={listId}>
                    {suggestions.map(s => <option key={s} value={s} />)}
                </datalist>
            )}
        </label>
    )
}

// Instructions are supported on every facet type (free-text guidance shown
// to whoever runs the IDS check) — a thin wrapper to keep call sites short.
function InstructionsField({ value, onChange }) {
    return <Field label="Instructions (optional)" value={value} onChange={onChange} placeholder="Guidance shown to whoever runs this check" multiline />
}

// Common IFC simple/measure types — suggestions only (via <datalist>, not a
// restrictive <select>), since IDS allows any IFC-defined type and this list
// can't be exhaustive.
const COMMON_DATA_TYPES = [
    'IFCBOOLEAN', 'IFCLABEL', 'IFCTEXT', 'IFCIDENTIFIER', 'IFCINTEGER', 'IFCREAL',
    'IFCLENGTHMEASURE', 'IFCAREAMEASURE', 'IFCVOLUMEMEASURE', 'IFCCOUNTMEASURE',
    'IFCTHERMALTRANSMITTANCEMEASURE', 'IFCTHERMODYNAMICTEMPERATUREMEASURE',
    'IFCVOLUMETRICFLOWRATEMEASURE', 'IFCPOWERMEASURE', 'IFCPRESSUREMEASURE',
    'IFCMASSMEASURE', 'IFCTIMEMEASURE', 'IFCPOSITIVELENGTHMEASURE',
]

function SelectField({ label, value, onChange, options }) {
    return (
        <label className="block">
            <span className="block text-[9px] uppercase tracking-wide text-[var(--speckle-foreground-3)] mb-0.5">{label}</span>
            <select
                value={value || ''}
                onChange={e => onChange(e.target.value)}
                className="nodrag w-full px-1.5 py-1 rounded text-[11px] bg-[var(--speckle-foundation-page)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none"
            >
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
        </label>
    )
}

const CARDINALITY_OPTIONS = [
    { value: 'required', label: 'Required' },
    { value: 'optional', label: 'Optional' },
    { value: 'prohibited', label: 'Prohibited' },
]

// Only meaningful when this node is wired into a spec's "requirements" port —
// harmless/unused if wired into "applicability" instead, since the converter
// ignores cardinality there.
function CardinalityField({ value, onChange }) {
    return <SelectField label="Cardinality (if used as requirement)" value={value || 'required'} onChange={onChange} options={CARDINALITY_OPTIONS} />
}

// Common IFC element classes — suggestions only, same rationale as COMMON_DATA_TYPES.
const COMMON_IFC_CLASSES = [
    'IFCWALL', 'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM', 'IFCDOOR', 'IFCWINDOW', 'IFCROOF',
    'IFCSTAIR', 'IFCSPACE', 'IFCCOVERING', 'IFCRAILING', 'IFCFURNISHINGELEMENT',
    'IFCBUILDINGSTOREY', 'IFCBUILDING', 'IFCSITE', 'IFCPIPESEGMENT', 'IFCDUCTSEGMENT',
]

// Shared connection-point styling — react-flow's default handle is a bare
// 6px square in a low-contrast grey, easy to miss against this dark theme.
// A larger circle with a page-colored ring gives every handle a clear "this
// is a plug, drag from here" affordance regardless of which node it's on.
const HANDLE_STYLE = {
    width: 12,
    height: 12,
    borderRadius: '50%',
    border: '2px solid var(--speckle-foundation)',
    zIndex: 1,
}

function SourceHandle() {
    return <Handle type="source" position={Position.Right} style={{ ...HANDLE_STYLE, background: 'var(--speckle-foreground-3)' }} />
}

// Fixed-height row per handle instead of percentage-based `top` — the
// previous version wrapped both handles in a bare `position: relative` div
// with no content of its own, which collapses to zero height (absolutely-
// positioned children don't contribute to their parent's height). `top:
// 30%`/`70%` of a 0px-tall box are both ~0, so the two handles (and their
// "applic."/"req." labels) landed stacked on top of each other and
// overlapping into the Name field right below — this gives the wrapper a
// real height so each row gets its own unambiguous space.
function SpecHandleRow({ handleId, label }) {
    return (
        <div className="relative flex items-center h-4">
            {/* Position.Left's own default (vertically centered, flush with
                this row's left edge) would park the dot ~13px inside the
                node's actual border (NodeShell's 3px border-left + this
                content area's 10px padding, p-2.5) — visible but reading as
                "just some UI element" rather than a connector. -12px centers
                it ON the border line instead, measured directly against the
                rendered node/handle boxes (getBoundingClientRect) rather than
                assumed from the padding/border CSS values, since react-flow's
                own zoom transform and Handle default styling both affect the
                final on-screen offset in ways the raw box-model numbers alone
                don't capture. Gray (not blue/red) to match every other
                handle in this editor (Entity/Property/etc. all use the same
                neutral --speckle-foreground-3) — color-coding just these two
                made them look like a different kind of control. */}
            <Handle type="target" position={Position.Left} id={handleId} style={{ ...HANDLE_STYLE, left: -12, background: 'var(--speckle-foreground-3)' }} />
            <span className="text-[10px] font-medium text-[var(--speckle-foreground-2)] pl-3">{label}</span>
        </div>
    )
}

export function SpecNode({ id, data, selected }) {
    const set = useNodeField(id)
    return (
        <NodeShell id={id} type="spec" minWidth={260} selected={selected}>
            <div className="space-y-1 mb-1.5">
                <SpecHandleRow handleId="applicability" label="Applicability" />
                <SpecHandleRow handleId="requirements" label="Requirements" />
            </div>
            <Field label="Name" value={data.name} onChange={v => set('name', v)} placeholder="Walls — FireRating" />
            <SelectField
                label="IFC Version"
                value={data.ifcVersion || 'IFC4X3_ADD2'}
                onChange={v => set('ifcVersion', v)}
                options={[
                    { value: 'IFC2X3', label: 'IFC2X3' },
                    { value: 'IFC4', label: 'IFC4' },
                    { value: 'IFC4X3_ADD2', label: 'IFC4X3_ADD2' },
                ]}
            />
            <Field label="Description" value={data.description} onChange={v => set('description', v)} placeholder="Fire rating requirements for walls" />
            <Field label="Identifier (optional)" value={data.identifier} onChange={v => set('identifier', v)} mono />
            <Field label="Requirements section description (optional)" value={data.requirementsDescription} onChange={v => set('requirementsDescription', v)} />
            <label className="nodrag flex items-center gap-1.5 text-[10px] text-[var(--speckle-foreground-3)]">
                <input
                    type="checkbox"
                    checked={!!data.hasEmptyApplicability}
                    onChange={e => set('hasEmptyApplicability', e.target.checked)}
                />
                Apply to all elements (no entity/property filter)
            </label>
            {data.hasEmptyApplicability && (
                <SelectField
                    label="Applicability cardinality"
                    value={data.applicabilityCardinality || 'required'}
                    onChange={v => set('applicabilityCardinality', v)}
                    options={CARDINALITY_OPTIONS}
                />
            )}
            <InstructionsField value={data.instructions} onChange={v => set('instructions', v)} />
        </NodeShell>
    )
}

export function EntityNode({ id, data }) {
    const set = useNodeField(id)
    return (
        <NodeShell id={id} type="entity">
            <SourceHandle />
            <Field label="IFC Class" value={data.name} onChange={v => set('name', v.toUpperCase())} placeholder="IFCWALL" mono suggestions={COMMON_IFC_CLASSES} />
            <Field label="Predefined Type (optional)" value={data.predefinedType} onChange={v => set('predefinedType', v)} placeholder="e.g. USERDEFINED" mono />
            <InstructionsField value={data.instructions} onChange={v => set('instructions', v)} />
        </NodeShell>
    )
}

export function PropertyNode({ id, data }) {
    const set = useNodeField(id)
    const entityClass = useConnectedEntityClass(id)
    const bsdd = useBsddEntityProperties(entityClass)

    const propertySetOptions = (bsdd?.propertySets || []).map(ps => ({
        value: ps.name, label: ps.name, meta: `${ps.properties.length} props`,
    }))
    const selectedSet = bsdd?.propertySets?.find(ps => ps.name === data.propertySet)
    const baseNameOptions = (selectedSet?.properties || []).map(p => ({
        value: p.baseName, label: p.baseName, meta: p.suggestedIfcType,
    }))
    const selectedProperty = selectedSet?.properties?.find(p => p.baseName === data.baseName)

    const dataTypeOptions = [
        ...(selectedProperty?.suggestedIfcType
            ? [{ value: selectedProperty.suggestedIfcType, label: selectedProperty.suggestedIfcType, meta: 'Recommended', recommended: true }]
            : []),
        ...COMMON_DATA_TYPES.filter(t => t !== selectedProperty?.suggestedIfcType).map(t => ({ value: t, label: t })),
    ]

    return (
        <NodeShell id={id} type="property" minWidth={240}>
            <SourceHandle />
            <SearchableCombobox
                label="Property Set"
                hint={entityClass ? `Filtered for ${entityClass}` : undefined}
                value={data.propertySet}
                onChange={v => set('propertySet', v)}
                placeholder="Pset_WallCommon"
                mono
                options={propertySetOptions}
                emptyHint={entityClass ? 'No bSDD match for this entity — type freely' : 'Connect an Entity node to filter suggestions'}
            />
            <SearchableCombobox
                label="Base Name"
                hint={selectedSet ? `${selectedSet.properties.length} properties available` : undefined}
                value={data.baseName}
                onChange={v => set('baseName', v)}
                onSelect={opt => {
                    if (!data.dataType) {
                        const prop = selectedSet?.properties?.find(p => p.baseName === opt.value)
                        if (prop?.suggestedIfcType) set('dataType', prop.suggestedIfcType)
                    }
                }}
                placeholder="IsExternal"
                mono
                options={baseNameOptions}
                emptyHint="Type freely"
            />
            <SearchableCombobox
                label="Data Type (optional)"
                hint={selectedProperty?.suggestedIfcType ? `Recommended: ${selectedProperty.suggestedIfcType}` : undefined}
                value={data.dataType}
                onChange={v => set('dataType', v)}
                placeholder="IFCBOOLEAN"
                mono
                options={dataTypeOptions}
            />
            {selectedProperty?.description && (
                <p className="text-[9px] text-[var(--speckle-foreground-3)] italic leading-tight">{selectedProperty.description}</p>
            )}
            <Field label="Value (optional, ignored if Restriction attached)" value={data.value} onChange={v => set('value', v)} />
            <details className="nodrag">
                <summary className="cursor-pointer text-[9px] uppercase tracking-wide text-[var(--speckle-foreground-3)] select-none">Advanced options</summary>
                <div className="pt-1.5 space-y-1.5">
                    <Field label="URI (optional)" value={data.uri} onChange={v => set('uri', v)} placeholder="https://..." mono />
                    <CardinalityField value={data.cardinality} onChange={v => set('cardinality', v)} />
                    <InstructionsField value={data.instructions} onChange={v => set('instructions', v)} />
                </div>
            </details>
        </NodeShell>
    )
}

export function AttributeNode({ id, data }) {
    const set = useNodeField(id)
    return (
        <NodeShell id={id} type="attribute">
            <SourceHandle />
            <Field label="Attribute Name" value={data.name} onChange={v => set('name', v)} placeholder="Name / Description / ObjectType" />
            <Field label="Value (optional, ignored if Restriction attached)" value={data.value} onChange={v => set('value', v)} />
            <CardinalityField value={data.cardinality} onChange={v => set('cardinality', v)} />
            <InstructionsField value={data.instructions} onChange={v => set('instructions', v)} />
        </NodeShell>
    )
}

export function ClassificationNode({ id, data }) {
    const set = useNodeField(id)
    const [browsing, setBrowsing] = useState(false)
    const [dictionary, setDictionary] = useState(null) // { uri, name } — picked from the bSDD dictionary search below
    const [dictionaryQuery, setDictionaryQuery] = useState('')
    const [classQuery, setClassQuery] = useState('')

    return (
        <NodeShell id={id} type="classification" minWidth={240}>
            <SourceHandle />
            <button
                type="button"
                onClick={() => setBrowsing(b => !b)}
                className="nodrag w-full text-left px-1.5 py-1 rounded text-[10px] border border-dashed border-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] hover:border-[var(--speckle-outline-2)] transition-colors"
            >
                {browsing ? '▾' : '▸'} Browse bSDD classification…
            </button>
            {browsing && (
                <div className="space-y-1.5 rounded border border-[var(--speckle-outline-3)] p-1.5">
                    <SearchableCombobox
                        label="Dictionary"
                        value={dictionaryQuery}
                        onChange={setDictionaryQuery}
                        onSelect={opt => { setDictionary({ uri: opt.value, name: opt.label }); setDictionaryQuery(opt.label); setClassQuery('') }}
                        placeholder="Search e.g. Uniclass, Omniclass…"
                        loadOptions={async (q) => {
                            const { dictionaries } = await searchBsddDictionaries(q)
                            return dictionaries.map(d => ({
                                value: d.uri,
                                label: `${d.name}${d.version ? ` ${d.version}` : ''}`,
                                meta: d.organizationNameOwner,
                            }))
                        }}
                        emptyHint="Type to search bSDD dictionaries"
                    />
                    <SearchableCombobox
                        label="Class"
                        value={classQuery}
                        onChange={setClassQuery}
                        onSelect={opt => {
                            set('system', dictionary.name)
                            // IDS classification value conventionally holds the
                            // dictionary's reference code (e.g. Uniclass "Ss_25_45_72_02"),
                            // not the free-text display name — that's just shown in the picker.
                            set('value', opt.meta || opt.label)
                            set('uri', opt.value)
                            setBrowsing(false)
                        }}
                        placeholder={dictionary ? `Search within ${dictionary.name}…` : 'Pick a dictionary first'}
                        disabled={!dictionary}
                        loadOptions={dictionary ? async (q) => {
                            if (!q.trim()) return []
                            const { classes } = await searchBsddClasses(dictionary.uri, q, 20)
                            return classes.map(c => ({ value: c.uri, label: c.name, meta: c.referenceCode }))
                        } : undefined}
                        emptyHint={dictionary ? 'Type to search classes in this dictionary' : undefined}
                    />
                </div>
            )}
            <Field label="System (optional)" value={data.system} onChange={v => set('system', v)} placeholder="Uniclass 2015" />
            <Field label="Value (optional, ignored if Restriction attached)" value={data.value} onChange={v => set('value', v)} />
            <Field label="URI (optional)" value={data.uri} onChange={v => set('uri', v)} placeholder="https://..." mono />
            <CardinalityField value={data.cardinality} onChange={v => set('cardinality', v)} />
            <InstructionsField value={data.instructions} onChange={v => set('instructions', v)} />
        </NodeShell>
    )
}

export function MaterialNode({ id, data }) {
    const set = useNodeField(id)
    return (
        <NodeShell id={id} type="material">
            <SourceHandle />
            <Field label="Value (optional, ignored if Restriction attached)" value={data.value} onChange={v => set('value', v)} placeholder="Concrete" />
            <Field label="URI (optional)" value={data.uri} onChange={v => set('uri', v)} placeholder="https://..." mono />
            <CardinalityField value={data.cardinality} onChange={v => set('cardinality', v)} />
            <InstructionsField value={data.instructions} onChange={v => set('instructions', v)} />
        </NodeShell>
    )
}

const PARTOF_RELATIONS = [
    { value: '', label: '(default)' },
    { value: 'IFCRELAGGREGATES', label: 'IfcRelAggregates' },
    { value: 'IFCRELASSIGNSTOGROUP', label: 'IfcRelAssignsToGroup' },
    { value: 'IFCRELCONTAINEDINSPATIALSTRUCTURE', label: 'IfcRelContainedInSpatialStructure' },
    { value: 'IFCRELNESTS', label: 'IfcRelNests' },
    { value: 'IFCRELVOIDSELEMENT', label: 'IfcRelVoidsElement' },
    { value: 'IFCRELFILLSELEMENT', label: 'IfcRelFillsElement' },
]

export function PartOfNode({ id, data }) {
    const set = useNodeField(id)
    return (
        <NodeShell id={id} type="partOf">
            <SourceHandle />
            <Field label="Parent IFC Class" value={data.entity} onChange={v => set('entity', v.toUpperCase())} placeholder="IFCBUILDINGSTOREY" mono suggestions={COMMON_IFC_CLASSES} />
            <SelectField label="Relation" value={data.relation} onChange={v => set('relation', v)} options={PARTOF_RELATIONS} />
            <CardinalityField value={data.cardinality} onChange={v => set('cardinality', v)} />
            <InstructionsField value={data.instructions} onChange={v => set('instructions', v)} />
        </NodeShell>
    )
}

function ChipList({ values, onChange }) {
    const [draft, setDraft] = useState('')
    const add = () => {
        const v = draft.trim()
        if (v && !values.includes(v)) onChange([...values, v])
        setDraft('')
    }
    return (
        <div>
            <span className="block text-[9px] uppercase tracking-wide text-[var(--speckle-foreground-3)] mb-0.5">Enumeration values</span>
            <div className="flex flex-wrap gap-1 mb-1">
                {values.map(v => (
                    <span key={v} className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--speckle-outline-3)] text-[10px] text-[var(--speckle-foreground)]">
                        {v}
                        <button onClick={() => onChange(values.filter(x => x !== v))} className="nodrag text-[var(--speckle-foreground-3)] hover:text-red-400">×</button>
                    </span>
                ))}
            </div>
            <input
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
                onBlur={add}
                placeholder="type a value, press Enter"
                className="nodrag w-full px-1.5 py-1 rounded text-[11px] bg-[var(--speckle-foundation-page)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none"
            />
        </div>
    )
}

const RESTRICTION_TYPES = [
    { value: 'enumeration', label: 'Enumeration' },
    { value: 'pattern', label: 'Pattern (regex)' },
    { value: 'bounds', label: 'Bounds (min/max)' },
    { value: 'length', label: 'Length (min/max)' },
]

export function RestrictionNode({ id, data }) {
    const set = useNodeField(id)
    const restrictionType = data.restrictionType || 'enumeration'
    return (
        <NodeShell id={id} type="restriction">
            <Handle type="target" position={Position.Left} style={{ ...HANDLE_STYLE, background: 'var(--speckle-foreground-3)' }} />
            <SelectField label="Type" value={restrictionType} onChange={v => set('restrictionType', v)} options={RESTRICTION_TYPES} />
            {restrictionType === 'enumeration' && (
                <ChipList values={data.values || []} onChange={v => set('values', v)} />
            )}
            {restrictionType === 'pattern' && (
                <Field label="Pattern" value={data.pattern} onChange={v => set('pattern', v)} placeholder=".+" mono />
            )}
            {restrictionType === 'bounds' && (
                <div className="flex gap-1.5">
                    <Field label="Min" value={data.minValue} onChange={v => set('minValue', v)} />
                    <Field label="Max" value={data.maxValue} onChange={v => set('maxValue', v)} />
                </div>
            )}
            {restrictionType === 'length' && (
                <div className="flex gap-1.5">
                    <Field label="Min length" value={data.minLength} onChange={v => set('minLength', v)} />
                    <Field label="Max length" value={data.maxLength} onChange={v => set('maxLength', v)} />
                </div>
            )}
        </NodeShell>
    )
}

export const nodeTypes = {
    spec: SpecNode,
    entity: EntityNode,
    property: PropertyNode,
    attribute: AttributeNode,
    classification: ClassificationNode,
    material: MaterialNode,
    partOf: PartOfNode,
    restriction: RestrictionNode,
}

export const PALETTE_GROUPS = [
    {
        label: 'Core',
        items: [
            { type: 'spec', label: 'Specification', defaultData: { name: '', ifcVersion: 'IFC4X3_ADD2' } },
            { type: 'entity', label: 'Entity', defaultData: { name: 'IFCWALL' } },
            { type: 'property', label: 'Property', defaultData: { propertySet: 'Pset_', baseName: '', cardinality: 'required' } },
        ],
    },
    {
        label: 'Advanced',
        items: [
            { type: 'attribute', label: 'Attribute', defaultData: { name: 'Name', cardinality: 'required' } },
            { type: 'classification', label: 'Classification', defaultData: { cardinality: 'required' } },
            { type: 'material', label: 'Material', defaultData: { cardinality: 'required' } },
            { type: 'partOf', label: 'Part Of', defaultData: { entity: '', cardinality: 'required' } },
        ],
    },
    {
        label: 'Restrictions',
        items: [
            { type: 'restriction', label: 'Restriction', defaultData: { restrictionType: 'enumeration', values: [] } },
        ],
    },
]

// Which source node types are accepted onto a spec's applicability/requirements
// target handles, and onto a restriction node's target handle.
export const VALID_SPEC_SOURCE_TYPES = new Set(['entity', 'partOf', 'classification', 'attribute', 'property', 'material'])
export const VALID_RESTRICTION_SOURCE_TYPES = new Set(['property', 'attribute', 'classification', 'material'])
