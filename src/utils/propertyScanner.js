// Property Scanner - Discovers all available properties from fullData elements
// and aggregates them for chart creation

// Properties to skip (usually not useful for charting)
const SKIP_PROPERTIES = [
    'id', 'speckle_type', 'applicationId', 'totalChildrenCount',
    'sourceApplication', 'units', '__closure', 'renderMaterial',
    'displayValue', 'displayStyle', 'elements', '@elements'
]

// Known dimensional properties to prioritize
const DIMENSIONAL_PROPERTIES = [
    'width', 'height', 'length', 'depth', 'thickness',
    'area', 'volume', 'weight', 'mass',
    'Width', 'Height', 'Length', 'Depth', 'Thickness',
    'Area', 'Volume', 'Weight', 'Mass'
]

// Format property name for display
export function formatPropertyName(path) {
    const parts = path.split('.')
    const lastName = parts[parts.length - 1]
    return lastName
        .replace(/([A-Z])/g, ' $1')
        .replace(/_/g, ' ')
        .trim()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ')
}

// Get nested value from object using path like "properties.Material"
export function getNestedValue(obj, path) {
    const parts = path.split('.')
    let current = obj
    for (const part of parts) {
        if (current === null || current === undefined) return undefined
        current = current[part]
    }
    return current
}

// Flatten a nested object key-values
export function flattenObject(obj, prefix = '', depth = 0, maxDepth = 4) {
    if (!obj || typeof obj !== 'object' || depth > maxDepth) return {}

    const flattened = {}

    for (const [key, value] of Object.entries(obj)) {
        // Skip internal properties
        if (key.startsWith('@') || key.startsWith('_') || key === '__closure') continue
        if (SKIP_PROPERTIES.includes(key)) continue

        const path = prefix ? `${prefix}.${key}` : key

        if (value === null || value === undefined) {
            // skip
        } else if (Array.isArray(value)) {
            // skip arrays for now in flattening (too complex for charts usually)
        } else if (typeof value === 'object') {
            // Recurse
            const children = flattenObject(value, path, depth + 1, maxDepth)
            Object.assign(flattened, children)
        } else {
            // Value
            flattened[path] = value
        }
    }

    return flattened
}

// Scan a single element for string properties (recursive)
function scanElementProperties(element, prefix = '', depth = 0, foundPaths = new Set()) {
    if (!element || typeof element !== 'object' || depth > 5) return // Increased depth to 5

    for (const [key, value] of Object.entries(element)) {
        // Skip internal and non-useful properties
        if (key.startsWith('@') || key.startsWith('_')) continue
        if (SKIP_PROPERTIES.includes(key)) continue

        const path = prefix ? `${prefix}.${key}` : key

        if (value === null || value === undefined) continue

        if (typeof value === 'string' && value.trim() !== '') {
            foundPaths.add(path)
        } else if (typeof value === 'object' && !Array.isArray(value)) {
            // Recurse into nested objects - expanded list of keys to traverse
            const traverseKeys = ['properties', 'parameters', 'raw_properties', 'quantities', 'dimensions', 'geometry', 'attributes', 'data', 'Pset_', 'Element']
            const shouldTraverse = traverseKeys.some(tk => key.includes(tk)) || depth < 2 // Always traverse first 2 levels
            if (shouldTraverse) {
                scanElementProperties(value, path, depth + 1, foundPaths)
            }
        }
    }

    return foundPaths
}

// Scan a single element for numeric properties (recursive)
function scanNumericProperties(element, prefix = '', depth = 0, foundPaths = new Set()) {
    if (!element || typeof element !== 'object' || depth > 6) return // Increased depth to 6

    for (const [key, value] of Object.entries(element)) {
        // Skip internal properties
        if (key.startsWith('@') || key.startsWith('_')) continue
        if (SKIP_PROPERTIES.includes(key)) continue

        const path = prefix ? `${prefix}.${key}` : key

        if (value === null || value === undefined) continue

        if (typeof value === 'number' && isFinite(value)) {
            foundPaths.add(path)
        } else if (typeof value === 'object' && !Array.isArray(value)) {
            // Recurse into nested objects - expanded list of keys to traverse
            const traverseKeys = ['properties', 'parameters', 'raw_properties', 'quantities', 'dimensions', 'geometry', 'attributes', 'data', 'Pset_', 'Element', 'value']
            const shouldTraverse = traverseKeys.some(tk => key.includes(tk)) || depth < 2 // Always traverse first 2 levels
            if (shouldTraverse) {
                scanNumericProperties(value, path, depth + 1, foundPaths)
            }
        }
    }

    return foundPaths
}

// Scan all elements and return discovered properties with sample values.
// minUniqueValues excludes properties with too little variation to be a
// useful chart grouping (default 2) — callers like ValidationWidget, where
// checking whether a rare-but-uniform property (e.g. every fire-rated wall
// sharing the same "F 120" fire rating class) is even *defined* is the whole
// point, should pass 1 so a single-valued real property isn't treated the
// same as "not discovered at all".
export function discoverProperties(fullData, { minUniqueValues = 2 } = {}) {
    if (!fullData?.elements || !Array.isArray(fullData.elements)) {
        return []
    }

    const pathCounts = new Map() // path -> count of elements with this property
    const pathValues = new Map() // path -> Set of unique values

    // Sample max 500 elements for performance
    const sampleSize = Math.min(fullData.elements.length, 500)
    const sample = fullData.elements.slice(0, sampleSize)

    for (const element of sample) {
        const paths = new Set()
        scanElementProperties(element, '', 0, paths)

        for (const path of paths) {
            const count = pathCounts.get(path) || 0
            pathCounts.set(path, count + 1)

            const value = getNestedValue(element, path)
            if (value !== undefined && value !== null && value !== '') {
                if (!pathValues.has(path)) {
                    pathValues.set(path, new Set())
                }
                // Only add if not too many unique values (increased from 100 to 500)
                const values = pathValues.get(path)
                if (values.size < 500) {
                    values.add(String(value))
                }
            }
        }
    }

    // Convert to array and filter useful properties
    const properties = []

    for (const [path, count] of pathCounts.entries()) {
        // Only include properties that appear in at least 1% of elements
        const coverage = count / sampleSize
        if (coverage < 0.01) continue

        const uniqueValues = pathValues.get(path)
        if (!uniqueValues || uniqueValues.size < minUniqueValues) continue
        if (uniqueValues.size > 500) continue // Too many values = not good for charts

        properties.push({
            path,
            name: formatPropertyName(path),
            coverage: Math.round(coverage * 100),
            uniqueValues: uniqueValues.size,
            isDiscovered: true
        })
    }

    // Also scan for pre-flattened useful properties from "properties" and "parameters"
    // This helps catch deep properties that might be missed or hard to find
    const flattenedSample = sample.map(el => flattenObject(el))
    const flatPathCounts = new Map()

    for (const flatEl of flattenedSample) {
        for (const [path, value] of Object.entries(flatEl)) {
            // Skip if we already found it in the normal scan
            if (pathCounts.has(path)) continue

            // Only care about deep paths usually
            if (!path.includes('.')) continue

            const count = flatPathCounts.get(path) || 0
            flatPathCounts.set(path, count + 1)
        }
    }

    // Add high-coverage flattened paths
    for (const [path, count] of flatPathCounts.entries()) {
        const coverage = count / sampleSize
        if (coverage < 0.01) continue

        // Add if not already present
        if (!properties.some(p => p.path === path)) {
            properties.push({
                path,
                name: formatPropertyName(path),
                coverage: Math.round(coverage * 100),
                uniqueValues: 0, // calc on demand or approx
                isDiscovered: true
            })
        }
    }

    // Sort by coverage (most common first)
    return properties.sort((a, b) => b.coverage - a.coverage)
}

// Aggregate values for a discovered property from fullData
export function aggregateProperty(fullData, propertyPath) {
    if (!fullData?.elements || !Array.isArray(fullData.elements)) {
        return {}
    }

    const counts = {}

    for (const element of fullData.elements) {
        const value = getNestedValue(element, propertyPath)
        if (value !== undefined && value !== null && value !== '') {
            const strValue = String(value)
            counts[strValue] = (counts[strValue] || 0) + 1
        }
    }

    return counts
}

// Discover numeric properties from fullData (width, height, length, etc.).
// minCount parallels discoverProperties' minUniqueValues — see its comment.
export function discoverNumericProperties(fullData, { minCount = 2 } = {}) {
    if (!fullData?.elements || !Array.isArray(fullData.elements)) {
        return []
    }

    const pathCounts = new Map() // path -> count of elements with this property
    const pathStats = new Map()  // path -> { sum, min, max, values[] }

    // Sample max 500 elements for performance
    const sampleSize = Math.min(fullData.elements.length, 500)
    const sample = fullData.elements.slice(0, sampleSize)

    for (const element of sample) {
        const paths = new Set()
        scanNumericProperties(element, '', 0, paths)

        for (const path of paths) {
            const count = pathCounts.get(path) || 0
            pathCounts.set(path, count + 1)

            const value = getNestedValue(element, path)
            if (typeof value === 'number' && isFinite(value) && value !== 0) {
                if (!pathStats.has(path)) {
                    pathStats.set(path, { sum: 0, min: Infinity, max: -Infinity, count: 0, values: [] })
                }
                const stats = pathStats.get(path)
                stats.sum += value
                stats.min = Math.min(stats.min, value)
                stats.max = Math.max(stats.max, value)
                stats.count++
                if (stats.values.length < 500) { // Increased from 100 to 500
                    stats.values.push(value)
                }
            }
        }
    }

    // Convert to array and filter useful properties
    const properties = []

    for (const [path, count] of pathCounts.entries()) {
        // Only include properties that appear in at least 1% of elements
        const coverage = count / sampleSize
        if (coverage < 0.01) continue

        const stats = pathStats.get(path)
        if (!stats || stats.count < minCount) continue

        const avg = stats.sum / stats.count
        const name = formatPropertyName(path)

        // Prioritize dimensional properties
        const isDimensional = DIMENSIONAL_PROPERTIES.some(dim =>
            path.toLowerCase().includes(dim.toLowerCase())
        )

        properties.push({
            path,
            name,
            coverage: Math.round(coverage * 100),
            elementCount: stats.count,
            sum: stats.sum,
            average: avg,
            min: stats.min,
            max: stats.max,
            isDimensional,
            isNumeric: true
        })
    }

    // Sort: dimensional properties first, then by coverage
    return properties.sort((a, b) => {
        if (a.isDimensional && !b.isDimensional) return -1
        if (!a.isDimensional && b.isDimensional) return 1
        return b.coverage - a.coverage
    })
}

// Aggregate numeric property values across all elements
export function aggregateNumericProperty(fullData, propertyPath, groupByPath = null) {
    if (!fullData?.elements || !Array.isArray(fullData.elements)) {
        return { sum: 0, average: 0, min: 0, max: 0, count: 0 }
    }

    if (groupByPath) {
        // Group by another property (e.g., dimensions by category)
        const groups = {}

        for (const element of fullData.elements) {
            const value = getNestedValue(element, propertyPath)
            const groupValue = getNestedValue(element, groupByPath)

            if (typeof value === 'number' && isFinite(value) && groupValue) {
                const groupKey = String(groupValue)
                if (!groups[groupKey]) {
                    groups[groupKey] = { sum: 0, count: 0 }
                }
                groups[groupKey].sum += value
                groups[groupKey].count++
            }
        }

        return groups
    }

    // Simple aggregation
    let sum = 0, min = Infinity, max = -Infinity, count = 0

    for (const element of fullData.elements) {
        const value = getNestedValue(element, propertyPath)
        if (typeof value === 'number' && isFinite(value)) {
            sum += value
            min = Math.min(min, value)
            max = Math.max(max, value)
            count++
        }
    }

    return {
        sum,
        average: count > 0 ? sum / count : 0,
        min: count > 0 ? min : 0,
        max: count > 0 ? max : 0,
        count
    }
}

// Generate a summary object from a list of elements
export function generateSummaryFromElements(elements) {
    if (!elements || !Array.isArray(elements) || elements.length === 0) return null

    const summary = {
        total_elements: elements.length,
        total_volume: 0,
        total_weight: 0,
        total_area: 0,
        total_length: 0,
        // Standard groupings
        by_category: {},
        by_family: {},
        by_type: {},
        by_level: {},
        by_discipline: {},
        by_material: {},
        by_status: {},
        by_phase: {},
        // Canonical / cross-source groupings
        by_ifc_type: {},
        by_grade: {},
        by_profile: {},
        by_section_class: {},
        by_workset: {},
        // Data quality
        by_validation_issues: {},
        steel_summary: { total_weight_kg: 0, total_length_m: 0, profiles: {} },
    }

    // Compute scalar totals from unified element fields
    elements.forEach(el => {
        summary.total_volume += el.volume_m3 || 0
        summary.total_weight += el.weight_kg || 0
        summary.total_area   += el.area_m2   || 0
        summary.total_length += (el.length_mm || 0) / 1000
    })

    const fieldMap = {
        'category':      'by_category',
        'family':        'by_family',
        'type':          'by_type',
        'level':         'by_level',
        'discipline':    'by_discipline',
        'material':      'by_material',
        'status':        'by_status',
        'phase':         'by_phase',
        'ifc_type':      'by_ifc_type',
        'grade_short':   'by_grade',
        'profile_name':  'by_profile',
        'profile_type':  'by_section_class',
        'workset':       'by_workset',
    }

    Object.keys(fieldMap).forEach(field => {
        const counts = aggregateProperty({ elements }, field)
        if (Object.keys(counts).length > 0) {
            summary[fieldMap[field]] = counts
        }
    })

    // validation_issues (array) and steel_summary — computed per element
    const STEEL_GRADES = ['S235', 'S275', 'S355', 'S420', 'S460', 'S500']
    elements.forEach(el => {
        // validation_issues
        const issues = Array.isArray(el.validation_issues) ? el.validation_issues : []
        issues.forEach(issue => {
            summary.by_validation_issues[issue] = (summary.by_validation_issues[issue] || 0) + 1
        })

        // steel_summary
        const gradeUp = (el.grade_short || el.material || '').toUpperCase()
        const isSteel = STEEL_GRADES.some(g => gradeUp.startsWith(g)) || gradeUp.includes('STEEL')
        if (el.discipline === 'Structure' && isSteel) {
            const w = el.weight_kg || 0
            const l = (el.length_mm || 0) / 1000
            summary.steel_summary.total_weight_kg += w
            summary.steel_summary.total_length_m  += l
            if (el.profile_name) {
                const p = summary.steel_summary.profiles[el.profile_name]
                    || (summary.steel_summary.profiles[el.profile_name] = { count: 0, weight: 0, length: 0 })
                p.count++; p.weight += w; p.length += l
            }
        }
    })

    return summary
}
