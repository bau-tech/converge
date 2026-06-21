// Converts this editor's ReactFlow graph ({ nodes, edges }) into a
// buildingSMART IDS 1.0 specification document (the standard's own XSD is
// authoritative — http://standards.buildingsmart.org/IDS/1.0/ids.xsd).
//
// Graph shape: one "spec" node per <ids:specification>. Facet nodes
// (entity/property/attribute/classification/material/partOf) attach to a
// spec via an edge whose targetHandle is "applicability" or "requirements";
// a facet's value can additionally point at a "restriction" node (a plain
// node-to-node edge, no handle) to render an <xs:restriction> instead of a
// literal <ids:simpleValue>.
//
// Per-facet XML shape is declared in FACET_SCHEMAS below and driven through
// one generic emitter (emitFacetXml) rather than bespoke per-type code, so
// adding a facet type only means adding a table entry.

function esc(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

// xs:string attribute, only rendered when there's a real value to write.
function xmlAttr(name, value) {
    return value !== undefined && value !== null && value !== '' ? ` ${name}="${esc(value)}"` : ''
}

function xmlAttrs(names, source) {
    return names.map(n => xmlAttr(n, source[n])).join('')
}

// Facet name/value fields (ids:name, ids:value, ids:propertySet, ...) wrap
// their literal text in <ids:simpleValue> per the IDS facet schema.
function simpleValueEl(tag, text) {
    return `<${tag}><ids:simpleValue>${esc(text)}</ids:simpleValue></${tag}>`
}

// ids:info's children are plain xs:string elements (no simpleValue wrapper).
function textEl(tag, text) {
    return `<${tag}>${esc(text)}</${tag}>`
}

// IDS facet cardinality ("required" | "optional" | "prohibited") only maps
// to applicability minOccurs/maxOccurs for the *specification's own* wildcard
// <ids:applicability/> element (used when a spec has no applicability facets
// at all but should still validate against every element of the model) —
// everywhere else cardinality is written verbatim as a facet attribute.
function applicabilityOccursFor(cardinality) {
    if (cardinality === 'optional') return { minOccurs: '0', maxOccurs: 'unbounded' }
    if (cardinality === 'prohibited') return { minOccurs: '0', maxOccurs: '0' }
    return { minOccurs: '1', maxOccurs: 'unbounded' } // default + 'required'
}

const RESTRICTION_BUILDERS = {
    enumeration: (data) => [...(data.values || [])].sort()
        .map(v => `<xs:enumeration value="${esc(v)}"/>`).join(''),
    pattern: (data) => data.pattern ? `<xs:pattern value="${esc(data.pattern)}"/>` : '',
    bounds: (data) => (data.minValue ? `<xs:minInclusive value="${esc(data.minValue)}"/>` : '') +
        (data.maxValue ? `<xs:maxInclusive value="${esc(data.maxValue)}"/>` : ''),
    length: (data) => (data.minLength ? `<xs:minLength value="${esc(data.minLength)}"/>` : '') +
        (data.maxLength ? `<xs:maxLength value="${esc(data.maxLength)}"/>` : ''),
}

function restrictionXml(data) {
    const build = RESTRICTION_BUILDERS[data.restrictionType]
    return `<xs:restriction base="xs:string">${build ? build(data) : ''}</xs:restriction>`
}

// A facet can have a same-source edge to its owning spec AND, separately, a
// same-source edge to a "restriction" node — both are plain edges with no
// targetHandle, so the only way to tell them apart is the target node's
// type. Must check every outgoing edge (not just the first) since either
// edge can come first in the array.
function findRestrictionFor(facetNode, edges, nodes) {
    for (const edge of edges) {
        if (edge.source !== facetNode.id) continue
        const target = nodes.find(n => n.id === edge.target)
        if (target?.type === 'restriction') return target
    }
    return null
}

function valueChildXml(tag, facetNode, edges, nodes) {
    const restriction = findRestrictionFor(facetNode, edges, nodes)
    if (restriction) return `<${tag}>${restrictionXml(restriction.data)}</${tag}>`
    if (facetNode.data.value) return simpleValueEl(tag, facetNode.data.value)
    return ''
}

// One entry per facet node type. `attrs` lists which XML attributes the
// facet carries (read from the merged { ...node.data, cardinality,
// instructions } context); `body` renders the facet's child elements.
// `appliesTo` lets a facet opt out of carrying cardinality/instructions
// when used in <ids:applicability> (only "requirements" facets do).
const FACET_SCHEMAS = {
    entity: {
        tag: 'ids:entity',
        attrs: ['instructions'],
        body: (data) => simpleValueEl('ids:name', String(data.name ?? '').toUpperCase()) +
            (data.predefinedType ? simpleValueEl('ids:predefinedType', data.predefinedType) : ''),
    },
    property: {
        tag: 'ids:property',
        attrs: ['dataType', 'cardinality', 'uri', 'instructions'],
        body: (data, ctx) => simpleValueEl('ids:propertySet', data.propertySet) +
            simpleValueEl('ids:baseName', data.baseName) +
            valueChildXml('ids:value', ctx.node, ctx.edges, ctx.nodes),
    },
    attribute: {
        tag: 'ids:attribute',
        attrs: ['cardinality', 'instructions'],
        body: (data, ctx) => simpleValueEl('ids:name', data.name) +
            valueChildXml('ids:value', ctx.node, ctx.edges, ctx.nodes),
    },
    classification: {
        tag: 'ids:classification',
        attrs: ['cardinality', 'uri', 'instructions'],
        body: (data, ctx) => {
            const value = valueChildXml('ids:value', ctx.node, ctx.edges, ctx.nodes)
            // ids:system is XSD-required on this facet; when the user hasn't
            // picked one, "any non-empty string" via a wildcard pattern keeps
            // the document valid without forcing a specific system.
            const system = data.system
                ? simpleValueEl('ids:system', data.system)
                : '<ids:system><xs:restriction base="xs:string"><xs:pattern value=".+"/></xs:restriction></ids:system>'
            return value + system
        },
    },
    material: {
        tag: 'ids:material',
        attrs: ['cardinality', 'uri', 'instructions'],
        body: (data, ctx) => valueChildXml('ids:value', ctx.node, ctx.edges, ctx.nodes),
    },
    partOf: {
        tag: 'ids:partOf',
        attrs: ['cardinality', 'relation', 'instructions'],
        body: (data) => `<ids:entity>${simpleValueEl('ids:name', String(data.entity ?? '').toUpperCase())}</ids:entity>`,
    },
}

// Renders one facet node as XML. `section` is 'applicability' or
// 'requirements' — applicability facets never carry cardinality/instructions
// (those only constrain *requirements*), so this only mixes them in for the
// requirements section.
function emitFacetXml(node, section, edges, nodes) {
    const schema = FACET_SCHEMAS[node.type]
    if (!schema) return ''
    const data = node.data
    const ctx = { node, edges, nodes }

    const attrSource = section === 'requirements'
        ? { ...data, cardinality: data.cardinality || 'required', instructions: data.instructions }
        : { ...data, cardinality: undefined, instructions: undefined } // applicability never carries these two, everything else (dataType, uri, relation, ...) still comes from node data

    return `<${schema.tag}${xmlAttrs(schema.attrs, attrSource)}>${schema.body(data, ctx)}</${schema.tag}>`
}

// Applicability facets render in a fixed, spec-mandated reading order
// (entity/partOf first, value-bearing facets after) rather than graph order.
const APPLICABILITY_ORDER = ['entity', 'partOf', 'classification', 'attribute', 'property', 'material']

function collectSpecFacets(specNode, nodes, edges) {
    const applicability = edges
        .filter(e => e.target === specNode.id && e.targetHandle === 'applicability')
        .map(e => nodes.find(n => n.id === e.source))
        .filter(Boolean)

    // Requirement edges can originate from the facet directly, or from a
    // restriction node sitting between the facet and the spec — resolve
    // back to the owning facet either way, and de-duplicate (a facet with
    // both an explicit requirements edge and a restriction edge should only
    // appear once).
    const seen = new Set()
    const requirements = []
    for (const edge of edges) {
        if (edge.target !== specNode.id || edge.targetHandle !== 'requirements') continue
        let source = nodes.find(n => n.id === edge.source)
        if (source?.type === 'restriction') {
            const ownerEdge = edges.find(e => e.target === source.id)
            source = ownerEdge ? nodes.find(n => n.id === ownerEdge.source) : null
        }
        if (source && !seen.has(source.id)) {
            seen.add(source.id)
            requirements.push(source)
        }
    }
    return { applicability, requirements }
}

function applicabilityXml(specNode, applicability, edges, nodes) {
    if (applicability.length > 0) {
        const ordered = [...applicability].sort(
            (a, b) => (APPLICABILITY_ORDER.indexOf(a.type) + 1 || 99) - (APPLICABILITY_ORDER.indexOf(b.type) + 1 || 99)
        )
        return `<ids:applicability>${ordered.map(n => emitFacetXml(n, 'applicability', edges, nodes)).join('')}</ids:applicability>`
    }

    const data = specNode.data
    if (!data.hasEmptyApplicability) {
        // No applicability facets and no explicit wildcard flag: write
        // nothing here and let the backend's IDS schema validation surface
        // the (correct) "a specification needs an applicability" error.
        return ''
    }

    const occurs = data.applicabilityCardinality
        ? applicabilityOccursFor(data.applicabilityCardinality)
        : { minOccurs: data.applicabilityMinOccurs, maxOccurs: data.applicabilityMaxOccurs }
    return `<ids:applicability${xmlAttr('minOccurs', occurs.minOccurs)}${xmlAttr('maxOccurs', occurs.maxOccurs)}/>`
}

function specificationXml(specNode, nodes, edges) {
    const { applicability, requirements } = collectSpecFacets(specNode, nodes, edges)
    const data = specNode.data

    const attrs = xmlAttrs(['name', 'ifcVersion', 'description', 'identifier', 'instructions'], {
        ...data,
        name: data.name || 'Generated Specification',
        ifcVersion: data.ifcVersion || 'IFC4X3_ADD2',
    })

    const requirementsXml = requirements.map(n => emitFacetXml(n, 'requirements', edges, nodes)).join('')

    return `<ids:specification${attrs}>` +
        applicabilityXml(specNode, applicability, edges, nodes) +
        `<ids:requirements${xmlAttr('description', data.requirementsDescription)}>${requirementsXml}</ids:requirements>` +
        `</ids:specification>`
}

// IDS authors are recorded as an email address. Most users just type a
// display name, so a plausible placeholder address is synthesized from it;
// a string that already looks like an email passes through (after light
// normalization) and an unsalvageable one is dropped rather than written
// as invalid xs:string content the backend would reject.
function authorEmail(author) {
    const normalized = String(author).replace(/\s+/g, '').toLowerCase()
    if (!normalized.includes('@')) return `${normalized}@idsedit.com`
    return /^[^@]+@[^.]+\..+$/.test(normalized) ? normalized : null
}

function infoXml(metadata, firstSpecData) {
    const title = metadata?.title || firstSpecData?.name || 'Untitled IDS'
    const description = metadata?.description || firstSpecData?.description
    const email = metadata?.author ? authorEmail(metadata.author) : null

    const fields = [
        ['ids:title', title],
        ['ids:copyright', metadata?.copyright],
        ['ids:version', metadata?.version],
        ['ids:description', description],
        ['ids:author', email],
        ['ids:date', metadata?.date],
        ['ids:purpose', metadata?.purpose],
        ['ids:milestone', metadata?.milestone],
    ]
    return `<ids:info>${fields.filter(([, v]) => v).map(([tag, v]) => textEl(tag, v)).join('')}</ids:info>`
}

// Lightweight structural check for the editor's validation panel — not a
// substitute for the backend's real ids_check.validate_ids_xml, just enough
// to flag "this can't produce a meaningful spec yet" before the user saves.
// Each issue carries the offending node's id so the UI can select it.
export function validateGraph(nodes, edges) {
    const issues = []
    const flag = (severity, message, nodeId) => issues.push({ severity, message, nodeId })

    const specNodes = nodes.filter(n => n.type === 'spec')
    if (specNodes.length === 0) {
        flag('error', 'Add at least one Specification node')
        return { valid: false, issues }
    }

    for (const node of nodes) {
        if (node.type === 'entity' && !node.data.name) {
            flag('error', 'Entity node is missing an IFC class name', node.id)
        }
        if (node.type === 'property') {
            if (!node.data.propertySet) flag('warning', 'Property node is missing a Property Set', node.id)
            if (!node.data.baseName) flag('warning', 'Property node is missing a Base Name', node.id)
        }
    }

    for (const spec of specNodes) {
        const name = spec.data.name || 'Untitled specification'
        if (!spec.data.name) flag('warning', `"${name}": missing a name`, spec.id)

        const applicabilityEdges = edges.filter(e => e.target === spec.id && e.targetHandle === 'applicability')
        if (applicabilityEdges.length === 0 && !spec.data.hasEmptyApplicability) {
            flag('error', `"${name}": needs at least one node connected to its "applic." port`, spec.id)
        } else if (applicabilityEdges.length > 0) {
            const hasEntity = applicabilityEdges.some(e => nodes.find(n => n.id === e.source)?.type === 'entity')
            if (!hasEntity) flag('warning', `"${name}": applicability should include an Entity node`, spec.id)
        }
    }

    return { valid: !issues.some(i => i.severity === 'error'), issues }
}

export function convertGraphToIdsXml(nodes, edges, options = {}) {
    if (!nodes || nodes.length === 0) throw new Error('No nodes provided for conversion')
    const specNodes = nodes.filter(n => n.type === 'spec')
    if (specNodes.length === 0) throw new Error('No specification ("spec") nodes found in this canvas')

    const header = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<ids:ids xmlns:ids="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" ' +
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">'

    const body = specNodes.map(spec => specificationXml(spec, nodes, edges)).join('')

    return header +
        infoXml(options.metadata, specNodes[0].data) +
        `<ids:specifications>${body}</ids:specifications>` +
        '</ids:ids>'
}

// Wraps a live graph into a { version, metadata, nodes, edges } envelope —
// a plain data-interchange shape (not specific to any one tool) that's
// convenient for saving/loading canvases outside the backend's IDS storage.
export function graphToCanvasJson(nodes, edges, metadata = {}) {
    return {
        version: '1.0',
        metadata: {
            exportedAt: new Date().toISOString(),
            nodeCount: nodes.length,
            edgeCount: edges.length,
            ifcVersion: nodes.find(n => n.type === 'spec')?.data?.ifcVersion || 'IFC4X3_ADD2',
            ...metadata,
        },
        nodes,
        edges,
    }
}

export function parseCanvasJson(text) {
    const data = JSON.parse(text)
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        throw new Error('Expected a canvas export with "nodes" and "edges" arrays')
    }
    return data
}

// Minimal indenter for the editor's XML preview — not a full pretty-printer,
// just enough to make the generated document readable at a glance.
export function formatXmlPreview(xml) {
    let depth = 0
    return xml.replace(/></g, '>\n<').split('\n').map(line => {
        const isClosing = /^<\//.test(line)
        const isSelfClosing = /\/>$/.test(line) || /^<\?/.test(line)
        if (isClosing) depth = Math.max(depth - 1, 0)
        const indented = '  '.repeat(depth) + line
        if (!isClosing && !isSelfClosing && /^<[^!?]/.test(line)) depth += 1
        return indented
    }).join('\n')
}
