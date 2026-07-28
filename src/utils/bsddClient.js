// REST wrapper for bim-normalizer's /bsdd/* proxy (routers/bsdd.py), which
// re-serves the buildingSMART Data Dictionary API server-side — bSDD
// silently refuses real cross-origin browser requests (200 + empty body
// for any non-allow-listed Origin), so this can't call bSDD directly.
import { RUNTIME_CONFIG } from '../runtimeConfig'

const NORMALIZER_URL = RUNTIME_CONFIG.NORMALIZER_URL

async function bsddFetch(path) {
    const res = await fetch(`${NORMALIZER_URL}/bsdd${path}`)
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`bSDD lookup failed: ${res.status} ${text}`)
    }
    return res.json()
}

// { resolved, className, propertySets: [{ name, properties: [{ baseName, bsddDataType, suggestedIfcType, description, propertyUri }] }] }
export function getBsddEntityProperties(ifcClass) {
    return bsddFetch(`/entity-properties?ifc_class=${encodeURIComponent(ifcClass)}`)
}

// { dictionaries: [{ uri, name, version, organizationNameOwner }] }
export function searchBsddDictionaries(search, limit = 20) {
    return bsddFetch(`/dictionaries?search=${encodeURIComponent(search)}&limit=${limit}`)
}

// { classes: [{ uri, name, referenceCode, description, parentClassName }] }
export function searchBsddClasses(dictionaryUri, search, limit = 20) {
    return bsddFetch(`/classes?dictionary_uri=${encodeURIComponent(dictionaryUri)}&search=${encodeURIComponent(search)}&limit=${limit}`)
}
