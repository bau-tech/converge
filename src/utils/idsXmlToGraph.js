// Reverse of convertGraphToIdsXml in idsGraphToXml.js — parses an IDS XML
// spec (as stored by bim-normalizer / produced by this editor) back into the
// { nodes, edges } graph shape, so an existing saved spec can be reopened
// and edited on the canvas instead of only ever starting from scratch.
//
// Only needs to understand documents shaped the way our own converter (and
// ifctester-compatible IDS files in general) writes them — namespace-aware
// lookups (getElementsByTagNameNS) handle any ids:/xs: prefix choice.

const IDS_NS = 'http://standards.buildingsmart.org/IDS'
const XS_NS = 'http://www.w3.org/2001/XMLSchema'

function children(el, ns, localName) {
    if (!el) return []
    return Array.from(el.getElementsByTagNameNS(ns, localName)).filter(c => c.parentNode === el)
}

function child(el, ns, localName) {
    return children(el, ns, localName)[0] || null
}

function simpleValueText(el) {
    if (!el) return undefined
    const simple = child(el, IDS_NS, 'simpleValue')
    return (simple || el).textContent?.trim() || undefined
}

function attrOf(el, name) {
    const v = el.getAttribute(name)
    return v === null || v === '' ? undefined : v
}

// Parses the <xs:restriction> a facet's <ids:value> (or <ids:system>) may
// contain — the exact inverse of buildValueRestrictionXml.
function parseRestriction(restrictionEl) {
    const enumerations = Array.from(restrictionEl.getElementsByTagNameNS(XS_NS, 'enumeration'))
    if (enumerations.length > 0) {
        return { restrictionType: 'enumeration', values: enumerations.map(e => e.getAttribute('value')) }
    }
    const pattern = restrictionEl.getElementsByTagNameNS(XS_NS, 'pattern')[0]
    if (pattern) {
        const value = pattern.getAttribute('value')
        if (value === '.+') return null // the "any system" wildcard — not a real user-authored restriction
        return { restrictionType: 'pattern', pattern: value }
    }
    const minInclusive = restrictionEl.getElementsByTagNameNS(XS_NS, 'minInclusive')[0]
    const maxInclusive = restrictionEl.getElementsByTagNameNS(XS_NS, 'maxInclusive')[0]
    if (minInclusive || maxInclusive) {
        return { restrictionType: 'bounds', minValue: minInclusive?.getAttribute('value'), maxValue: maxInclusive?.getAttribute('value') }
    }
    const minLength = restrictionEl.getElementsByTagNameNS(XS_NS, 'minLength')[0]
    const maxLength = restrictionEl.getElementsByTagNameNS(XS_NS, 'maxLength')[0]
    if (minLength || maxLength) {
        return { restrictionType: 'length', minLength: minLength?.getAttribute('value'), maxLength: maxLength?.getAttribute('value') }
    }
    return null
}

// Reads a facet's <ids:value> child: either a literal <ids:simpleValue> or
// an <xs:restriction>. Returns { value, restriction } — at most one is set.
function parseValueFacet(facetEl, tag) {
    const valueEl = child(facetEl, IDS_NS, tag)
    if (!valueEl) return {}
    const restrictionEl = child(valueEl, XS_NS, 'restriction')
    if (restrictionEl) return { restriction: parseRestriction(restrictionEl) }
    return { value: simpleValueText(valueEl) }
}

function parseFacetNode(facetEl) {
    const tag = facetEl.localName
    const cardinality = attrOf(facetEl, 'cardinality')
    const instructions = attrOf(facetEl, 'instructions')
    switch (tag) {
        case 'entity':
            return {
                type: 'entity',
                data: {
                    name: simpleValueText(child(facetEl, IDS_NS, 'name')),
                    predefinedType: simpleValueText(child(facetEl, IDS_NS, 'predefinedType')),
                },
            }
        case 'attribute': {
            const { value, restriction } = parseValueFacet(facetEl, 'value')
            return { type: 'attribute', data: { name: simpleValueText(child(facetEl, IDS_NS, 'name')), value, cardinality, instructions }, restriction }
        }
        case 'property': {
            const { value, restriction } = parseValueFacet(facetEl, 'value')
            return {
                type: 'property',
                data: {
                    propertySet: simpleValueText(child(facetEl, IDS_NS, 'propertySet')),
                    baseName: simpleValueText(child(facetEl, IDS_NS, 'baseName')),
                    dataType: attrOf(facetEl, 'dataType'),
                    uri: attrOf(facetEl, 'uri'),
                    value, cardinality, instructions,
                },
                restriction,
            }
        }
        case 'classification': {
            const { value, restriction } = parseValueFacet(facetEl, 'value')
            const systemEl = child(facetEl, IDS_NS, 'system')
            const systemRestriction = systemEl && child(systemEl, XS_NS, 'restriction')
            const system = systemRestriction ? undefined : simpleValueText(systemEl)
            return { type: 'classification', data: { system, uri: attrOf(facetEl, 'uri'), value, cardinality, instructions }, restriction }
        }
        case 'material': {
            const { value, restriction } = parseValueFacet(facetEl, 'value')
            return { type: 'material', data: { uri: attrOf(facetEl, 'uri'), value, cardinality, instructions }, restriction }
        }
        case 'partOf': {
            const entityEl = child(facetEl, IDS_NS, 'entity')
            return {
                type: 'partOf',
                data: {
                    entity: simpleValueText(child(entityEl, IDS_NS, 'name')),
                    relation: attrOf(facetEl, 'relation'),
                    cardinality, instructions,
                },
            }
        }
        default:
            return null
    }
}

const FACET_TAGS = ['entity', 'partOf', 'classification', 'attribute', 'property', 'material']

// ids:info's children are plain xs:string elements, not wrapped in
// <ids:simpleValue> — the inverse of buildInfoXml's plainText() helper.
function parseInfoMetadata(doc) {
    const infoEl = doc.getElementsByTagNameNS(IDS_NS, 'info')[0]
    if (!infoEl) return {}
    const text = (tag) => child(infoEl, IDS_NS, tag)?.textContent?.trim() || undefined
    const metadata = {
        title: text('title'),
        copyright: text('copyright'),
        version: text('version'),
        description: text('description'),
        author: text('author'),
        date: text('date'),
        purpose: text('purpose'),
        milestone: text('milestone'),
    }
    return Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== undefined))
}

export function parseIdsXmlToGraph(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length > 0) {
        throw new Error('Could not parse this file as XML')
    }

    const specEls = Array.from(doc.getElementsByTagNameNS(IDS_NS, 'specification'))
    if (specEls.length === 0) throw new Error('No <ids:specification> elements found')
    const metadata = parseInfoMetadata(doc)

    const nodes = []
    const edges = []
    let stamp = Date.now()
    const nextId = (prefix) => `${prefix}-${stamp++}`

    specEls.forEach((specEl, specIdx) => {
        const specId = nextId('spec')
        const applicabilityEl = child(specEl, IDS_NS, 'applicability')
        const requirementsEl = child(specEl, IDS_NS, 'requirements')

        const hasEmptyApplicability = !!applicabilityEl && FACET_TAGS.every(t => children(applicabilityEl, IDS_NS, t).length === 0)

        nodes.push({
            id: specId,
            type: 'spec',
            position: { x: 500, y: 100 + specIdx * 400 },
            data: {
                name: attrOf(specEl, 'name'),
                ifcVersion: attrOf(specEl, 'ifcVersion') || 'IFC4X3_ADD2',
                description: attrOf(specEl, 'description'),
                identifier: attrOf(specEl, 'identifier'),
                instructions: attrOf(specEl, 'instructions'),
                hasEmptyApplicability: hasEmptyApplicability || undefined,
                applicabilityMinOccurs: hasEmptyApplicability ? attrOf(applicabilityEl, 'minOccurs') : undefined,
                applicabilityMaxOccurs: hasEmptyApplicability ? attrOf(applicabilityEl, 'maxOccurs') : undefined,
                requirementsDescription: attrOf(requirementsEl, 'description'),
            },
        })

        let facetCol = 0
        const addFacetsFrom = (sectionEl, targetHandle) => {
            if (!sectionEl) return
            for (const tag of FACET_TAGS) {
                for (const facetEl of children(sectionEl, IDS_NS, tag)) {
                    const parsed = parseFacetNode(facetEl)
                    if (!parsed) continue
                    const facetId = nextId(parsed.type)
                    nodes.push({
                        id: facetId,
                        type: parsed.type,
                        position: { x: 100, y: 100 + specIdx * 400 + facetCol * 150 },
                        data: parsed.data,
                    })
                    facetCol += 1
                    edges.push({ id: nextId('e'), source: facetId, target: specId, targetHandle })
                    if (parsed.restriction) {
                        const restrictionId = nextId('restriction')
                        nodes.push({
                            id: restrictionId,
                            type: 'restriction',
                            position: { x: -150, y: 100 + specIdx * 400 + (facetCol - 1) * 150 },
                            data: parsed.restriction,
                        })
                        edges.push({ id: nextId('e'), source: facetId, target: restrictionId })
                    }
                }
            }
        }
        addFacetsFrom(applicabilityEl, 'applicability')
        addFacetsFrom(requirementsEl, 'requirements')
    })

    return { nodes, edges, metadata }
}
