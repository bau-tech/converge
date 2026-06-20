// Port of louistrue/ids-flow's lib/ids-xml-converter.ts (MIT-style open-source
// IDS visual editor — https://github.com/louistrue/ids-flow). That tool's
// "Export Canvas (.json)" button writes { version, metadata, nodes, edges },
// where nodes/edges are a ReactFlow graph: one "spec" node per IDS
// specification, with "entity"/"property"/"attribute"/"classification"/
// "material"/"partOf"/"restriction" nodes wired to it via edges whose
// targetHandle is "applicability" or "requirements". This file reproduces
// that tool's graph -> IDS XML conversion so a canvas exported there can be
// pasted here and turned into a spec our backend can run.
//
// Known simplification vs the original: ids-flow normalizes property
// baseNames against a bundled IFC pset schema (normalizePropertyName); we
// upload the baseName as typed instead. Everything else mirrors the
// upstream converter element-for-element.

function esc(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

function attr(name, value) {
    return value !== undefined && value !== null && value !== '' ? ` ${name}="${esc(value)}"` : ''
}

function idsSimple(tag, text) {
    return `<${tag}><ids:simpleValue>${esc(text)}</ids:simpleValue></${tag}>`
}

// ids:info's children (title, description, author, ...) are plain xs:string
// elements — unlike facet name/value fields, they are NOT wrapped in
// <ids:simpleValue>.
function plainText(tag, text) {
    return `<${tag}>${esc(text)}</${tag}>`
}

function occursFromCardinality(cardinality) {
    if (!cardinality || cardinality === 'required') return { minOccurs: '1', maxOccurs: 'unbounded' }
    if (cardinality === 'optional') return { minOccurs: '0', maxOccurs: 'unbounded' }
    if (cardinality === 'prohibited') return { minOccurs: '0', maxOccurs: '0' }
    return { minOccurs: '1', maxOccurs: 'unbounded' }
}

function buildValueRestrictionXml(data) {
    let inner = ''
    switch (data.restrictionType) {
        case 'enumeration': {
            const values = [...(data.values || [])].sort()
            inner = values.map(v => `<xs:enumeration value="${esc(v)}"/>`).join('')
            break
        }
        case 'pattern':
            if (data.pattern) inner = `<xs:pattern value="${esc(data.pattern)}"/>`
            break
        case 'bounds':
            if (data.minValue) inner += `<xs:minInclusive value="${esc(data.minValue)}"/>`
            if (data.maxValue) inner += `<xs:maxInclusive value="${esc(data.maxValue)}"/>`
            break
        case 'length':
            if (data.minLength) inner += `<xs:minLength value="${esc(data.minLength)}"/>`
            if (data.maxLength) inner += `<xs:maxLength value="${esc(data.maxLength)}"/>`
            break
    }
    return `<xs:restriction base="xs:string">${inner}</xs:restriction>`
}

// A facet node has two distinct outgoing edges: one to its owning
// specification (source=facet, target=spec) and, optionally, one to a
// restriction node (source=facet, target=restriction). Filter specifically
// for the restriction target — picking the first same-source edge
// regardless of target type (as upstream's `edges.find` does) silently
// drops the restriction whenever the spec-edge happens to come first in
// the array.
function findRestrictionNode(node, edges, nodes) {
    for (const edge of edges) {
        if (edge.source !== node.id) continue
        const candidate = nodes.find(n => n.id === edge.target)
        if (candidate && candidate.type === 'restriction') return candidate
    }
    return null
}

function buildValueXml(tag, node, edges, nodes) {
    const restrictionNode = findRestrictionNode(node, edges, nodes)
    if (restrictionNode) return `<${tag}>${buildValueRestrictionXml(restrictionNode.data)}</${tag}>`
    if (node.data.value) return idsSimple(tag, node.data.value)
    return ''
}

function buildEntityFacetXml(node, instructions) {
    const data = node.data
    let xml = `<ids:entity${attr('instructions', instructions)}>`
    xml += idsSimple('ids:name', String(data.name).toUpperCase())
    if (data.predefinedType) xml += idsSimple('ids:predefinedType', data.predefinedType)
    return xml + '</ids:entity>'
}

function buildPropertyFacetXml(node, cardinality, instructions, edges, nodes) {
    const data = node.data
    const attrs = attr('dataType', data.dataType) + attr('cardinality', cardinality) +
        attr('uri', data.uri) + attr('instructions', instructions || data.instructions)
    let xml = `<ids:property${attrs}>`
    xml += idsSimple('ids:propertySet', data.propertySet)
    xml += idsSimple('ids:baseName', data.baseName)
    xml += buildValueXml('ids:value', node, edges, nodes)
    return xml + '</ids:property>'
}

function buildAttributeFacetXml(node, cardinality, instructions, edges, nodes) {
    const data = node.data
    const attrs = attr('cardinality', cardinality) + attr('instructions', instructions || data.instructions)
    let xml = `<ids:attribute${attrs}>`
    xml += idsSimple('ids:name', data.name)
    xml += buildValueXml('ids:value', node, edges, nodes)
    return xml + '</ids:attribute>'
}

function buildClassificationFacetXml(node, cardinality, instructions, edges, nodes) {
    const data = node.data
    const attrs = attr('cardinality', cardinality) + attr('uri', data.uri) + attr('instructions', instructions || data.instructions)
    let xml = `<ids:classification${attrs}>`
    xml += buildValueXml('ids:value', node, edges, nodes)
    // system is XSD-required; a ".+" pattern restriction stands in for "any system" when unset.
    xml += data.system
        ? idsSimple('ids:system', data.system)
        : '<ids:system><xs:restriction base="xs:string"><xs:pattern value=".+"/></xs:restriction></ids:system>'
    return xml + '</ids:classification>'
}

function buildMaterialFacetXml(node, cardinality, instructions, edges, nodes) {
    const data = node.data
    const attrs = attr('cardinality', cardinality) + attr('uri', data.uri) + attr('instructions', instructions || data.instructions)
    let xml = `<ids:material${attrs}>`
    xml += buildValueXml('ids:value', node, edges, nodes)
    return xml + '</ids:material>'
}

function buildPartOfFacetXml(node, cardinality, instructions) {
    const data = node.data
    const attrs = attr('cardinality', cardinality) + attr('relation', data.relation) + attr('instructions', instructions || data.instructions)
    return `<ids:partOf${attrs}><ids:entity>${idsSimple('ids:name', String(data.entity).toUpperCase())}</ids:entity></ids:partOf>`
}

const APPLICABILITY_TYPE_ORDER = { entity: 1, partOf: 2, classification: 3, attribute: 4, property: 5, material: 6 }

function buildFacetXml(node, section, edges, nodes) {
    if (section === 'applicability') {
        switch (node.type) {
            case 'entity': return buildEntityFacetXml(node)
            case 'partOf': return buildPartOfFacetXml(node)
            case 'classification': return buildClassificationFacetXml(node, undefined, undefined, edges, nodes)
            case 'attribute': return buildAttributeFacetXml(node, undefined, undefined, edges, nodes)
            case 'property': return buildPropertyFacetXml(node, undefined, undefined, edges, nodes)
            case 'material': return buildMaterialFacetXml(node, undefined, undefined, edges, nodes)
            default: return ''
        }
    }
    const cardinality = node.data.cardinality || 'required'
    const instructions = node.data.instructions
    switch (node.type) {
        case 'entity': return buildEntityFacetXml(node, instructions)
        case 'property': return buildPropertyFacetXml(node, cardinality, instructions, edges, nodes)
        case 'attribute': return buildAttributeFacetXml(node, cardinality, instructions, edges, nodes)
        case 'classification': return buildClassificationFacetXml(node, cardinality, instructions, edges, nodes)
        case 'material': return buildMaterialFacetXml(node, cardinality, instructions, edges, nodes)
        case 'partOf': return buildPartOfFacetXml(node, cardinality, instructions)
        default: return ''
    }
}

function groupNodesBySpecification(nodes, edges, specNode) {
    const applicabilityNodes = edges
        .filter(e => e.target === specNode.id && e.targetHandle === 'applicability')
        .map(e => nodes.find(n => n.id === e.source))
        .filter(Boolean)

    const requirementEdges = edges.filter(e => e.target === specNode.id && e.targetHandle === 'requirements')
    const seen = new Set()
    const requirementNodes = []
    for (const edge of requirementEdges) {
        let sourceNode = nodes.find(n => n.id === edge.source)
        if (sourceNode && sourceNode.type === 'restriction') {
            const facetEdge = edges.find(e => e.target === sourceNode.id)
            sourceNode = facetEdge ? nodes.find(n => n.id === facetEdge.source) : null
        }
        if (sourceNode && !seen.has(sourceNode.id)) {
            seen.add(sourceNode.id)
            requirementNodes.push(sourceNode)
        }
    }
    return { applicabilityNodes, requirementNodes }
}

function buildSpecificationXml(specNode, applicabilityNodes, requirementNodes, edges, nodes) {
    const specData = specNode.data
    const specAttrs = attr('name', specData.name || 'Generated Specification') +
        attr('ifcVersion', specData.ifcVersion || 'IFC4X3_ADD2') +
        attr('description', specData.description) +
        attr('identifier', specData.identifier) +
        attr('instructions', specData.instructions)

    let xml = `<ids:specification${specAttrs}>`

    if (applicabilityNodes.length > 0) {
        const sorted = [...applicabilityNodes].sort(
            (a, b) => (APPLICABILITY_TYPE_ORDER[a.type] || 99) - (APPLICABILITY_TYPE_ORDER[b.type] || 99)
        )
        xml += '<ids:applicability>'
        for (const node of sorted) xml += buildFacetXml(node, 'applicability', edges, nodes)
        xml += '</ids:applicability>'
    } else if (specData.hasEmptyApplicability) {
        let applAttrs
        if (specData.applicabilityCardinality) {
            const occ = occursFromCardinality(specData.applicabilityCardinality)
            applAttrs = attr('minOccurs', occ.minOccurs) + attr('maxOccurs', occ.maxOccurs)
        } else {
            applAttrs = attr('minOccurs', specData.applicabilityMinOccurs) + attr('maxOccurs', specData.applicabilityMaxOccurs)
        }
        xml += `<ids:applicability${applAttrs}/>`
    }
    // else: no applicability facets and no wildcard flag — matches upstream,
    // which silently omits <ids:applicability> here too. The backend's IDS
    // schema validation will reject the result with a clear error, which is
    // the right outcome: a spec needs at least one applicability facet.

    xml += `<ids:requirements${attr('description', specData.requirementsDescription)}>`
    for (const node of requirementNodes) xml += buildFacetXml(node, 'requirements', edges, nodes)
    xml += '</ids:requirements>'

    return xml + '</ids:specification>'
}

function cleanAuthorEmail(author) {
    const cleaned = String(author).replace(/\s+/g, '').toLowerCase()
    if (cleaned.includes('@')) return /^[^@]+@[^.]+\..+$/.test(cleaned) ? cleaned : null
    return `${cleaned}@idsedit.com`
}

function buildInfoXml(metadata, firstSpecData) {
    const title = metadata?.title || firstSpecData?.name || 'Untitled IDS'
    let xml = `<ids:info>${plainText('ids:title', title)}`
    if (metadata?.copyright) xml += plainText('ids:copyright', metadata.copyright)
    if (metadata?.version) xml += plainText('ids:version', metadata.version)
    const description = metadata?.description || firstSpecData?.description
    if (description) xml += plainText('ids:description', description)
    if (metadata?.author) {
        const email = cleanAuthorEmail(metadata.author)
        if (email) xml += plainText('ids:author', email)
    }
    if (metadata?.date) xml += plainText('ids:date', metadata.date)
    if (metadata?.purpose) xml += plainText('ids:purpose', metadata.purpose)
    if (metadata?.milestone) xml += plainText('ids:milestone', metadata.milestone)
    return xml + '</ids:info>'
}

// Lightweight structural check for the editor's validation panel — not a
// substitute for the backend's real ids_check.validate_ids_xml, just enough
// to catch the obvious "this can't generate a meaningful spec yet" states
// before the user bothers saving. Each issue carries the offending node's id
// so the UI can jump to + select it, mirroring (independently implemented,
// not copied) the per-issue "click to go to node" pattern from ids-flow's own
// client-side validator — minus its IFC-schema-driven data-type checks, which
// would require bundling the same generated schema dataset we've kept out of
// scope for this editor.
export function validateGraph(nodes, edges) {
    const issues = []
    const push = (severity, message, nodeId) => issues.push({ severity, message, nodeId })

    const specNodes = nodes.filter(n => n.type === 'spec')
    if (specNodes.length === 0) {
        push('error', 'Add at least one Specification node')
        return { valid: false, issues }
    }

    for (const node of nodes) {
        if (node.type === 'entity' && !node.data.name) {
            push('error', 'Entity node is missing an IFC class name', node.id)
        }
        if (node.type === 'property') {
            if (!node.data.propertySet) push('warning', 'Property node is missing a Property Set', node.id)
            if (!node.data.baseName) push('warning', 'Property node is missing a Base Name', node.id)
        }
    }

    for (const spec of specNodes) {
        const name = spec.data.name || 'Untitled specification'
        if (!spec.data.name) push('warning', `"${name}": missing a name`, spec.id)

        const applicabilityEdges = edges.filter(e => e.target === spec.id && e.targetHandle === 'applicability')
        if (applicabilityEdges.length === 0 && !spec.data.hasEmptyApplicability) {
            push('error', `"${name}": needs at least one node connected to its "applic." port`, spec.id)
        } else if (applicabilityEdges.length > 0) {
            const hasEntity = applicabilityEdges.some(e => nodes.find(n => n.id === e.source)?.type === 'entity')
            if (!hasEntity) push('warning', `"${name}": applicability should include an Entity node`, spec.id)
        }
    }

    return { valid: !issues.some(i => i.severity === 'error'), issues }
}

export function convertGraphToIdsXml(nodes, edges, options = {}) {
    if (!nodes || nodes.length === 0) throw new Error('No nodes provided for conversion')
    const specNodes = nodes.filter(n => n.type === 'spec')
    if (specNodes.length === 0) throw new Error('No specification ("spec") nodes found in this canvas')

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    xml += '<ids:ids xmlns:ids="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" '
    xml += 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">'
    xml += buildInfoXml(options.metadata, specNodes[0].data)
    xml += '<ids:specifications>'
    for (const specNode of specNodes) {
        const { applicabilityNodes, requirementNodes } = groupNodesBySpecification(nodes, edges, specNode)
        xml += buildSpecificationXml(specNode, applicabilityNodes, requirementNodes, edges, nodes)
    }
    xml += '</ids:specifications></ids:ids>'
    return xml
}

// Wraps a live graph (from the native IdsGraphEditor) into the same
// { version, metadata, nodes, edges } shape ids-flow's own "Export Canvas
// (.json)" produces, so files round-trip between this editor and ids-flow.
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

// Parses an ids-flow "Export Canvas (.json)" file's contents
// ({ version, metadata, nodes, edges }) and validates its basic shape.
export function parseCanvasJson(text) {
    const data = JSON.parse(text)
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        throw new Error('Expected an ids-flow canvas export with "nodes" and "edges" arrays')
    }
    return data
}

// Minimal indenter for displaying generated XML — not a full pretty-printer,
// just enough to make the preview readable.
export function formatXmlPreview(xml) {
    const withBreaks = xml.replace(/></g, '>\n<')
    let depth = 0
    return withBreaks.split('\n').map(line => {
        const isClosing = /^<\//.test(line)
        const isSelfClosing = /\/>$/.test(line) || /^<\?/.test(line)
        if (isClosing) depth = Math.max(depth - 1, 0)
        const indented = '  '.repeat(depth) + line
        if (!isClosing && !isSelfClosing && /^<[^!?]/.test(line)) depth += 1
        return indented
    }).join('\n')
}
