import { useState, useMemo, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Search,
    ChevronDown,
    ChevronUp,
    ChevronLeft,
    ChevronRight,
    ArrowUpDown,
    Filter,
    Table,
    Eye,
    X,
    Copy,
    Check
} from 'lucide-react'
import { discoverProperties, discoverNumericProperties } from '../utils/propertyScanner'

// Helper to get nested value safely
function getNestedValue(obj, path) {
    if (!obj || !path) return undefined
    const parts = path.split('.')
    let current = obj
    for (const part of parts) {
        if (current === null || current === undefined) return undefined
        current = current[part]
    }
    return current
}

const FIXED_COLUMNS = [
    { key: 'id', label: 'ID', width: '120px' },
    { key: 'speckle_type', label: 'Type', width: '180px' },
    { key: 'category', label: 'Category', path: 'category', width: '150px' },
    { key: 'family', label: 'Family', path: 'family', width: '150px' },
    { key: 'name', label: 'Name', path: 'name', width: '200px' },
    { key: 'level', label: 'Level', path: 'level', width: '100px' }
]

export function ElementTable({ fullData, onElementClick, viewerSelectedIds, onFilteredIdsChange, chartFilters = {}, filteredIds }) {
    const [searchTerm, setSearchTerm] = useState('')
    const [sortConfig, setSortConfig] = useState({ key: 'category', direction: 'asc' })
    const [page, setPage] = useState(1)
    const [pageSize, setPageSize] = useState(10)

    // Column Filters
    const [showFilters, setShowFilters] = useState(false)
    const [filters, setFilters] = useState({})
    // How multiple column filters combine: 'AND' requires every filter to match,
    // 'OR' requires at least one to match. Only meaningful with 2+ active filters.
    const [filterMode, setFilterMode] = useState('AND')
    const [copied, setCopied] = useState(false)
    const [copyError, setCopyError] = useState(false)
    // Track whether the table previously had its own filters so we only send
    // onFilteredIdsChange(null) when transitioning *away* from own filters —
    // not on every external state change (e.g. viewer selection). Without this
    // guard, every 3-D click triggers setFilter(null) → resetFilters() which
    // races with SelectionExtension's auto-highlight and wipes the cyan outline.
    const hadOwnFiltersRef = useRef(false)

    const handleFilterChange = (key, value) => {
        setFilters(prev => {
            if (value === '' || value === null || value === undefined) {
                const { [key]: _, ...rest } = prev
                return rest
            }
            return { ...prev, [key]: value }
        })
        setPage(1)
    }

    // Discover columns dynamically
    const tableColumns = useMemo(() => {
        if (!fullData?.elements) return FIXED_COLUMNS

        const discovery = discoverProperties(fullData)
        const numericDiscovery = discoverNumericProperties(fullData)

        const dynamicCols = []
        const usedPaths = new Set(FIXED_COLUMNS.map(c => c.path || c.key))

        // Helper to add column
        const addCol = (prop) => {
            // Skip if already in fixed columns
            if (usedPaths.has(prop.path)) return

            // Skip common "Base" props that are usually redundant
            if (prop.path.includes('basePoint') || prop.path.includes('baseLine')) return

            dynamicCols.push({
                key: prop.path,
                label: prop.name,
                path: prop.path,
                width: '150px',
                isNumeric: prop.isNumeric // Flag for right-alignment if needed
            })
            usedPaths.add(prop.path)
        }

        // Add discovered string properties
        discovery.forEach(addCol)

        // Add discovered numeric properties
        numericDiscovery.forEach(prop => {
            // Re-format name for dimensions
            addCol({
                ...prop,
                name: prop.name + (prop.unit ? ` (${prop.unit})` : '')
            })
        })

        return [...FIXED_COLUMNS, ...dynamicCols]
    }, [fullData])

    // Filter and Sort Data
    const processedData = useMemo(() => {
        if (!fullData?.elements) return []

        let data = [...fullData.elements]

        // Viewer sync — single priority-based filter keeps the table in sync with
        // the 3D viewer. 3D selection (direct user intent) wins over any broader
        // isolation filter (charts / search / schedule). When nothing is active the
        // full element list is shown.
        const syncIds = viewerSelectedIds?.length ? viewerSelectedIds
                      : filteredIds?.length       ? filteredIds
                      : null
        if (syncIds) {
            const syncSet = new Set(syncIds)
            data = data.filter(item =>
                syncSet.has(item.id) || syncSet.has(item.speckle_id)
            )
        }

        // 1. Global Search — covers all visible columns, not just the fixed three
        if (searchTerm) {
            const term = searchTerm.toLowerCase()
            data = data.filter(item =>
                tableColumns.some(col => {
                    const raw = col.path ? getNestedValue(item, col.path) : item[col.key]
                    if (raw == null) return false
                    return String(raw).toLowerCase().includes(term)
                })
            )
        }

        // 2. Column Filters — AND requires every filter to match, OR requires any
        const activeFilters = Object.entries(filters)
        if (activeFilters.length > 0) {
            const matchesFilter = (item, [key, filterValue]) => {
                if (!filterValue) return true

                // Find column definition to get correct path
                const col = tableColumns.find(c => c.key === key)
                const path = col?.path || key

                let value = path ? getNestedValue(item, path) : item[key]

                // Handle special cases
                if (key === 'speckle_type') value = value ? value.split('.').pop() : ''

                if (value === undefined || value === null) return false
                return String(value).toLowerCase().includes(filterValue.toLowerCase())
            }

            data = data.filter(item =>
                filterMode === 'OR'
                    ? activeFilters.some(entry => matchesFilter(item, entry))
                    : activeFilters.every(entry => matchesFilter(item, entry))
            )
        }

        // 3. Sort
        if (sortConfig.key) {
            data.sort((a, b) => {
                let aValue = sortConfig.path
                    ? getNestedValue(a, sortConfig.path)
                    : a[sortConfig.key]
                let bValue = sortConfig.path
                    ? getNestedValue(b, sortConfig.path)
                    : b[sortConfig.key]

                // Null/undefined sorts to the end regardless of direction.
                // Use == null (covers both null and undefined) — do NOT use !value,
                // which incorrectly treats 0 and '' as missing.
                const aMissing = aValue == null
                const bMissing = bValue == null
                if (aMissing && bMissing) return 0
                if (aMissing) return 1
                if (bMissing) return -1

                // Numeric sort when both values are numbers
                if (typeof aValue === 'number' && typeof bValue === 'number') {
                    return sortConfig.direction === 'asc' ? aValue - bValue : bValue - aValue
                }

                // String sort (case-insensitive)
                const aStr = String(aValue).toLowerCase()
                const bStr = String(bValue).toLowerCase()
                if (aStr < bStr) return sortConfig.direction === 'asc' ? -1 : 1
                if (aStr > bStr) return sortConfig.direction === 'asc' ? 1 : -1
                return 0
            })
        }

        return data
    }, [fullData, searchTerm, filters, filterMode, sortConfig, tableColumns, viewerSelectedIds, filteredIds])

    // Reset to page 1 whenever the viewer-driven filter changes.
    useEffect(() => { setPage(1) }, [filteredIds, viewerSelectedIds])

    // Notify parent of filtered IDs for viewer isolation.
    // Only fires for TABLE-OWN filters (search box, column filters).
    // Sends null only when transitioning away from own filters — never on
    // external changes — so viewer 3-D selection events don't accidentally
    // trigger resetFilters() and race-wipe the SelectionExtension highlight.
    useEffect(() => {
        if (!onFilteredIdsChange) return
        const hasOwnFilters =
            searchTerm.trim().length > 0 ||
            Object.keys(filters).length > 0
        if (hasOwnFilters) {
            hadOwnFiltersRef.current = true
            onFilteredIdsChange(processedData.map(item => item.speckle_id || item.id))
        } else if (hadOwnFiltersRef.current) {
            // Transitioning from having own filters to none — clear the viewer filter
            hadOwnFiltersRef.current = false
            onFilteredIdsChange(null)
        }
        // hasOwnFilters=false and hadOwnFilters was already false: skip entirely
    }, [processedData, onFilteredIdsChange, searchTerm, filters])

    // Pagination
    const totalPages = Math.ceil(processedData.length / pageSize)
    const paginatedData = useMemo(() => {
        const start = (page - 1) * pageSize
        return processedData.slice(start, start + pageSize)
    }, [processedData, page, pageSize])

    const handleSort = (column) => {
        setSortConfig(current => ({
            key: column.key,
            path: column.path,
            direction: current.key === column.key && current.direction === 'asc' ? 'desc' : 'asc'
        }))
    }

    // Copy table to Excel (TSV format)
    const copyToExcel = async () => {
        if (!processedData || processedData.length === 0) return

        // Create header row with column labels
        const headers = tableColumns.map(col => col.label).join('\t')

        // Create data rows
        const rows = processedData.map(item => {
            return tableColumns.map(col => {
                let value = col.path ? getNestedValue(item, col.path) : item[col.key]

                // Full ID in clipboard (not truncated — useful for cross-referencing in Speckle)
                if (col.key === 'id') value = item.id ?? ''
                else if (col.key === 'speckle_type') value = item.speckle_type ? item.speckle_type.split('.').pop() : ''
                else if (col.isNumeric && typeof value === 'number') value = value.toFixed(2)

                // Reject non-scalar values — object/array in a cell is noise in Excel
                if (value !== null && value !== undefined && typeof value === 'object') value = ''
                if (value === undefined || value === null) value = ''

                // Clean for TSV: tabs and newlines break column layout
                return String(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
            }).join('\t')
        }).join('\n')

        // Combine headers and rows
        const tsvContent = headers + '\n' + rows

        try {
            await navigator.clipboard.writeText(tsvContent)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch (err) {
            console.error('Failed to copy to clipboard', err)
            setCopyError(true)
            setTimeout(() => setCopyError(false), 2000)
        }
    }

    if (!fullData) {
        return (
            <div className="flex items-center justify-center p-12 text-zinc-500">
                <p>Waiting for data...</p>
            </div>
        )
    }

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Toolbar */}
            <div className="flex items-center justify-between p-4 border-b border-white/5">
                <div className="flex items-center gap-3">
                    <Table className="w-5 h-5 text-purple-500" />
                    <h3 className="text-sm font-medium">Element Data</h3>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-zinc-400">
                        {processedData.length} items
                    </span>

                    {/* Toggle Filters */}
                    <button
                        onClick={() => setShowFilters(!showFilters)}
                        aria-label={showFilters ? 'Hide column filters' : 'Show column filters'}
                        aria-expanded={showFilters}
                        className={`ml-2 p-1.5 rounded-lg transition-colors ${showFilters ? 'bg-purple-500/20 text-purple-400' : 'hover:bg-white/5 text-zinc-400'
                            }`}
                        title="Toggle Filters"
                    >
                        <Filter className="w-4 h-4" />
                    </button>
                    {Object.keys(filters).length > 1 && (
                        <button
                            onClick={() => setFilterMode(m => m === 'AND' ? 'OR' : 'AND')}
                            aria-label={`Filter match mode: ${filterMode}. Click to switch to ${filterMode === 'AND' ? 'OR' : 'AND'}`}
                            title={filterMode === 'AND'
                                ? 'Matching ALL filters (AND). Click to match ANY filter (OR).'
                                : 'Matching ANY filter (OR). Click to match ALL filters (AND).'}
                            className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                                filterMode === 'OR'
                                    ? 'border-purple-500/50 bg-purple-500/20 text-purple-300'
                                    : 'border-white/10 text-zinc-400 hover:text-white hover:border-white/20'
                            }`}
                        >
                            Match: {filterMode}
                        </button>
                    )}
                    {(Object.keys(filters).length > 0) && (
                        <button
                            onClick={() => {
                                setFilters({})
                                setShowFilters(false)
                            }}
                            aria-label="Clear all column filters"
                            className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1"
                        >
                            <X className="w-3 h-3" /> Clear
                        </button>
                    )}

                    {/* Copy to Excel Button */}
                    <button
                        onClick={copyToExcel}
                        disabled={processedData.length === 0}
                        aria-label={copyError ? 'Clipboard access denied' : copied ? 'Copied!' : `Copy ${processedData.length} rows to clipboard`}
                        className={`ml-2 p-1.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                            copyError
                                ? 'text-red-400 hover:text-red-300'
                                : 'hover:bg-cyan-500/20 text-cyan-400 hover:text-cyan-300'
                        }`}
                        title={copyError ? 'Clipboard access denied' : `Copy ${processedData.length} rows to clipboard (Excel-friendly)`}
                    >
                        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                </div>

                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                    <input
                        type="text"
                        value={searchTerm}
                        onChange={(e) => {
                            setSearchTerm(e.target.value)
                            setPage(1) // Reset to first page on search
                        }}
                        placeholder="Search elements..."
                        className="bg-zinc-800 border border-white/10 rounded-lg pl-9 pr-4 py-1.5 text-sm focus:outline-none focus:border-purple-500 transition-colors w-64 placeholder:text-zinc-600"
                    />
                </div>
            </div>

            {/* Table Container */}
            <div className="flex-1 overflow-auto">
                <table className="w-full text-left text-sm border-collapse min-w-max">
                    <thead className="sticky top-0 bg-zinc-900 z-10">
                        <tr>
                            {tableColumns.map(col => (
                                <th
                                    key={col.key}
                                    className="p-3 font-medium text-zinc-400 border-b border-white/10 select-none whitespace-nowrap"
                                    style={{ width: col.width }}
                                >
                                    <div
                                        className="flex items-center gap-2 cursor-pointer hover:text-white transition-colors"
                                        onClick={() => handleSort(col)}
                                    >
                                        {col.label}
                                        {sortConfig.key === col.key && (
                                            <ArrowUpDown className={`w-3 h-3 transition-transform ${sortConfig.direction === 'desc' ? 'rotate-180' : ''
                                                }`} />
                                        )}
                                    </div>

                                    {/* Filter Input */}
                                    <AnimatePresence>
                                        {showFilters && (
                                            <motion.div
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{ height: 'auto', opacity: 1 }}
                                                exit={{ height: 0, opacity: 0 }}
                                                className="overflow-hidden mt-2"
                                            >
                                                <input
                                                    type="text"
                                                    value={filters[col.key] || ''}
                                                    onChange={(e) => handleFilterChange(col.key, e.target.value)}
                                                    placeholder={`Filter...`}
                                                    className="w-full bg-zinc-800/50 border border-white/10 rounded px-2 py-1 text-xs focus:outline-none focus:border-purple-500/50 placeholder:text-zinc-700"
                                                    onClick={(e) => e.stopPropagation()}
                                                />
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </th>
                            ))}
                            <th className="p-3 border-b border-white/10 w-10 sticky right-0 bg-zinc-900 z-20 shadow-[-4px_0_8px_-2px_rgba(0,0,0,0.5)]"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {paginatedData.map((item, idx) => (
                            <tr
                                key={`${item.id || item.speckle_id}-${idx}`}
                                onClick={() => onElementClick && onElementClick(item.speckle_id || item.id)}
                                className="group hover:bg-white/5 transition-colors cursor-pointer border-b border-white/5 last:border-0"
                            >
                                {tableColumns.map(col => {
                                    let value = col.path ? getNestedValue(item, col.path) : item[col.key]

                                    // Special formatting
                                    if (col.key === 'id') value = item.id ? item.id.substring(0, 8) + '…' : '-'
                                    else if (col.key === 'speckle_type') value = item.speckle_type ? item.speckle_type.split('.').pop() : '-'

                                    // Formatting for numeric values
                                    if (col.isNumeric && typeof value === 'number') {
                                        value = value.toFixed(2)
                                    }

                                    return (
                                        <td
                                            key={col.key}
                                            className={`p-3 text-zinc-300 truncate ${col.isNumeric ? 'text-right font-mono' : ''}`}
                                            style={{ maxWidth: col.width }}
                                            title={typeof value === 'string' ? value : ''}
                                        >
                                            {/* value || '-' rendered legitimate 0/false property
                                                values (e.g. a boolean IFC property like
                                                IsExternal: false, or a genuinely-zero dimension)
                                                identically to a missing value — only nullish/empty
                                                should fall back to the placeholder. */}
                                            {(value === null || value === undefined || value === '') ? '-' : String(value)}
                                        </td>
                                    )
                                })}
                                <td
                                    className="p-3 text-right sticky right-0 bg-zinc-900 group-hover:bg-zinc-800 transition-colors shadow-[-4px_0_8px_-2px_rgba(0,0,0,0.5)]"
                                    onClick={e => e.stopPropagation()}
                                >
                                    <button
                                        aria-label="View element details"
                                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-purple-500/20 rounded transition-all text-purple-400"
                                    >
                                        <Eye className="w-4 h-4" />
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {paginatedData.length === 0 && (
                            <tr>
                                <td colSpan={tableColumns.length + 1} className="p-8 text-center text-zinc-500">
                                    No elements found matching your search.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Pagination Footer */}
            <div className="flex items-center justify-between p-3 border-t border-white/10 bg-zinc-800/20 text-xs">
                <div className="text-zinc-500">
                    {processedData.length === 0
                        ? 'No results'
                        : `Showing ${((page - 1) * pageSize) + 1}–${Math.min(page * pageSize, processedData.length)} of ${processedData.length}`
                    }
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                        disabled={page === 1}
                        aria-label="Previous page"
                        className="p-1.5 rounded hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="text-zinc-400" aria-live="polite" aria-atomic="true">
                        Page {page} of {totalPages || 1}
                    </span>
                    <button
                        onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                        disabled={page >= totalPages}
                        aria-label="Next page"
                        className="p-1.5 rounded hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        <ChevronRight className="w-4 h-4" />
                    </button>
                    <div className="w-px h-4 bg-white/10 mx-2" />
                    <select
                        value={pageSize}
                        onChange={(e) => {
                            setPageSize(Number(e.target.value))
                            setPage(1)
                        }}
                        className="bg-transparent border-none text-zinc-400 focus:outline-none cursor-pointer hover:text-white"
                    >
                        <option value={10}>10 / page</option>
                        <option value={20}>20 / page</option>
                        <option value={50}>50 / page</option>
                        <option value={100}>100 / page</option>
                    </select>
                </div>
            </div>
        </div>
    )
}
