import { Handle, Position, useReactFlow } from '@xyflow/react'
import { useState } from 'react'
import { Trash2 } from 'lucide-react'

// Standalone editable card per node type for the IDS visual graph editor.
// Each node writes its own `data` via setNodes (the standard React Flow v12
// pattern for self-editing custom nodes — no parent callback prop-drilling).
// The exact `data` keys read by each type are dictated by
// ../utils/idsGraphToXml.js's converter, not chosen freely here.

const ACCENTS = {
    spec: '#276FE5',
    entity: '#3b82f6',
    property: '#14b8a6',
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

function SourceHandle() {
    return <Handle type="source" position={Position.Right} style={{ background: 'var(--speckle-foreground-3)' }} />
}

export function SpecNode({ id, data, selected }) {
    const set = useNodeField(id)
    return (
        <NodeShell id={id} type="spec" minWidth={260} selected={selected}>
            <div style={{ position: 'relative' }}>
                <Handle type="target" position={Position.Left} id="applicability" style={{ top: '30%', background: '#60a5fa' }} />
                <span className="absolute text-[8px] text-[var(--speckle-foreground-3)]" style={{ left: -2, top: 'calc(30% - 14px)' }}>applic.</span>
                <Handle type="target" position={Position.Left} id="requirements" style={{ top: '70%', background: '#f87171' }} />
                <span className="absolute text-[8px] text-[var(--speckle-foreground-3)]" style={{ left: -2, top: 'calc(70% + 4px)' }}>req.</span>
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
    return (
        <NodeShell id={id} type="property">
            <SourceHandle />
            <Field label="Property Set" value={data.propertySet} onChange={v => set('propertySet', v)} placeholder="Pset_WallCommon" mono />
            <Field label="Base Name" value={data.baseName} onChange={v => set('baseName', v)} placeholder="IsExternal" mono />
            <Field label="Data Type (optional)" value={data.dataType} onChange={v => set('dataType', v)} placeholder="IFCBOOLEAN" mono suggestions={COMMON_DATA_TYPES} />
            <Field label="Value (optional, ignored if Restriction attached)" value={data.value} onChange={v => set('value', v)} />
            <Field label="URI (optional)" value={data.uri} onChange={v => set('uri', v)} placeholder="https://..." mono />
            <CardinalityField value={data.cardinality} onChange={v => set('cardinality', v)} />
            <InstructionsField value={data.instructions} onChange={v => set('instructions', v)} />
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
    return (
        <NodeShell id={id} type="classification">
            <SourceHandle />
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
            <Handle type="target" position={Position.Left} style={{ background: 'var(--speckle-foreground-3)' }} />
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
