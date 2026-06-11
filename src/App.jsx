import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Box,
    RotateCcw,
    Sun,
    Moon,
    X,
    Search,
    Loader2,
    Clock,
    Share2,
    Check,
    AlertCircle,
    List,
    Trash2,
    Copy,
    ExternalLink,
} from 'lucide-react'
import { CompareVersionToggle } from './components/CompareVersionToggle'
import SpeckleViewer from './components/SpeckleViewer'
import { ErrorBoundary } from './components/ErrorBoundary'
import ElementPanel from './components/ElementPanel'
import { AdaptiveCharts, DynamicChart, discoverChartFields, CHART_CONFIG } from './components/AdaptiveCharts'
import { AdaptiveMetrics } from './components/AdaptiveMetrics'
import { ElementTable } from './components/ElementTable'
import { ActiveFilters } from './components/ActiveFilters'
import { MarkdownWidget } from './components/MarkdownWidget'
import { GridDashboard, GridPanel } from './components/DashboardGrid'
import { ChatWidget } from './components/ChatWidget'
import PivotTableWidget from './components/PivotTableWidget'
import ValidationWidget from './components/ValidationWidget'
import ScheduleWidget from './components/ScheduleWidget'
import QuantityWidget from './components/QuantityWidget'
import { VideoWidget } from './components/VideoWidget'
import { StandaloneChartWidget } from './components/StandaloneChartWidget'
import { IfcLogoIcon } from './components/IfcLogoIcon'
import { BreadcrumbSelector } from './components/BreadcrumbSelector'
import { WidgetFAB } from './components/WidgetFAB'
import PublishSelectionButton from './components/PublishSelectionButton'
import { IngestProgress } from './components/IngestProgress'
import { flattenObject } from './utils/propertyScanner'
import { generateSummaryFromElements } from './utils/propertyScanner'

const CONFIG = {
    normalizerUrl: import.meta.env.VITE_NORMALIZER_URL || 'http://localhost:8002',
    speckleServer: import.meta.env.VITE_SPECKLE_SERVER || 'https://speckle.example.com',
    speckleToken: import.meta.env.VITE_SPECKLE_TOKEN || ''
}

// Parse share-link URL param once at module load so useState initialisers can read it
const _urlSeed = (() => {
    try {
        const param = new URLSearchParams(window.location.search).get('layout')
        if (!param) return null
        let binary = ''
        const raw = atob(param)
        for (let i = 0; i < raw.length; i++) binary += raw[i]
        const seed = JSON.parse(new TextDecoder().decode(
            Uint8Array.from(raw, c => c.charCodeAt(0))
        ))
        if (seed?.v !== 1) return null
        // Immediately update CONFIG so the first gqlFetch uses the seeded server
        if (seed.server?.url) {
            CONFIG.speckleServer = seed.server.url
            CONFIG.speckleToken  = seed.server.token || ''
        }
        return seed
    } catch { return null }
})()

// Parse VITE_EXTRA_SPECKLE_SERVERS at module load — baked in by Vite, works without backend
const ENV_EXTRA_SERVERS = ((raw) => {
    if (!raw) return []
    return raw.split(',').flatMap((entry, i) => {
        const parts = entry.trim().split('|')
        const url = parts[1]?.trim().replace(/\/$/, '')
        if (!url) return []
        return [{ id: `env_${i}`, name: parts[0]?.trim() || url, url, token: parts[2]?.trim() || '' }]
    })
})(import.meta.env.VITE_EXTRA_SPECKLE_SERVERS)

// GraphQL helper: uses variables (no string interpolation), checks HTTP status + GraphQL errors
async function gqlFetch(query, variables = {}, signal) {
    const response = await fetch(`${CONFIG.speckleServer}/graphql`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${CONFIG.speckleToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, variables }),
        signal
    })
    if (!response.ok) {
        throw new Error(`Speckle API ${response.status}: ${response.statusText}`)
    }
    const result = await response.json()
    if (result.errors?.length) {
        throw new Error(result.errors[0].message)
    }
    return result.data
}

// ---------------------------------------------------------------------------
// Normalizer adapters — map normalizer API shapes to the shapes
// that AdaptiveCharts, AdaptiveMetrics, ElementTable and viewer sync expect.
// ---------------------------------------------------------------------------

function adaptNormalizerElement(el) {
    return {
        ...el,
        // Field aliases so existing chart filter keys work without changes
        level:        el.storey    || '',
        ifc_type:     el.ifc_class || '',
        profile_name: el.profile   || '',
        grade_short:  el.grade     || '',
        profile_type: el.profile_type || '',
        material_category: el.material_category || '',
        // Fields not yet in normalizer — set neutral defaults
        weight_kg:    null,
        length_mm:    null,
        discipline:   null,
        family:       null,
        type:         null,
        phase:        null,
        workset:      null,
        status:       null,
        validation_issues: [],
    }
}

function adaptNormalizerSummary(norm) {
    const countOnly = obj => Object.fromEntries(
        Object.entries(obj || {}).map(([k, v]) => [k, typeof v === 'object' ? v.count : v])
    )
    const volOnly = obj => Object.fromEntries(
        Object.entries(obj || {})
            .map(([k, v]) => [k, typeof v === 'object' ? (v.volume_m3 || 0) : 0])
            .filter(([, v]) => v > 0)
    )
    const areaOnly = obj => Object.fromEntries(
        Object.entries(obj || {})
            .map(([k, v]) => [k, typeof v === 'object' ? (v.area_m2 || 0) : 0])
            .filter(([, v]) => v > 0)
    )
    return {
        total_elements:  norm.total_count    || 0,
        total_volume:    norm.total_volume_m3 || 0,
        total_area:      norm.total_area_m2   || 0,
        total_weight:    0,
        total_length:    0,
        geo_coverage:    norm.geo_coverage   || 0,
        by_category:     countOnly(norm.by_category),
        by_ifc_type:     countOnly(norm.by_ifc_class),
        by_level:        countOnly(norm.by_storey),
        by_material:     norm.by_material    || {},
        by_profile:      norm.by_profile     || {},
        by_grade:        norm.by_grade       || {},
        // 5D quantity fields — volume/area per group (only non-zero entries)
        by_ifc_class_vol: volOnly(norm.by_ifc_class),
        by_storey_vol:    volOnly(norm.by_storey),
        by_category_area: areaOnly(norm.by_category),
        // Not yet available from normalizer
        by_family:       {},
        by_type:         {},
        by_discipline:   {},
        by_status:       {},
        by_phase:        {},
        by_section_class: norm.by_section_class || {},
        by_workset:      {},
        by_validation_issues: {},
        steel_summary:   { total_weight_kg: 0, total_length_m: 0, profiles: {} },
        // Model metadata passthrough
        source_app:      norm.source      || '',
        author:          norm.author      || '',
        branch_name:     norm.branch_name || '',
        commit_message:  norm.message     || '',
        ingested_at:     norm.ingested_at || null,
    }
}


function App() {
    const [darkMode, setDarkMode] = useState(_urlSeed?.ui?.darkMode ?? true)


    // Dropdown states
    const [projects, setProjects] = useState([])
    const [selectedProject, setSelectedProject] = useState(null)
    const [models, setModels] = useState([])
    const [selectedModel, setSelectedModel] = useState(null)
    const [versions, setVersions] = useState([])
    const [selectedVersion, setSelectedVersion] = useState(null)
    const [loadingVersions, setLoadingVersions] = useState(false)

    // Data states
    const [data, setData] = useState(null)              // Summary data (fast)
    const [fullData, setFullData] = useState(null)      // Full data (for highlighting)
    const [loading, setLoading] = useState(false)
    const [loadingProjects, setLoadingProjects] = useState(true)
    const [loadingModels, setLoadingModels] = useState(false)
    const [exportingIfc, setExportingIfc] = useState(false)
    const [reIngesting, setReIngesting] = useState(false)
    const [showTimeline, setShowTimeline] = useState(_urlSeed?.ui?.showTimeline ?? false)
    const [loadError, setLoadError] = useState(null)    // User-visible error message

    // Multi-server support
    const [backendServers, setBackendServers]   = useState([])
    const [customServers,  setCustomServers]    = useState(() => {
        try { return JSON.parse(localStorage.getItem('speckle-custom-servers') || '[]') }
        catch { return [] }
    })
    const [activeServer, setActiveServer] = useState(
        _urlSeed?.server ?? { id: 'default', name: 'Default', url: CONFIG.speckleServer, token: CONFIG.speckleToken }
    )

    // Ingest progress phase: null | 'connecting' | 'ingesting' | 'parsing' | 'ready'
    const [ingestPhase, setIngestPhase] = useState(null)

    // Merged, deduplicated server list — priority: default → env vars → backend → localStorage
    const allServers = useMemo(() => {
        const seed = { id: 'default', name: 'Default', url: CONFIG.speckleServer, token: CONFIG.speckleToken }
        const seen = new Set([seed.url])
        const list = [seed]
        for (const s of [...ENV_EXTRA_SERVERS, ...backendServers, ...customServers]) {
            if (s.url && !seen.has(s.url)) { seen.add(s.url); list.push(s) }
        }
        return list
    }, [backendServers, customServers])

    // Persist custom servers
    useEffect(() => {
        localStorage.setItem('speckle-custom-servers', JSON.stringify(customServers))
    }, [customServers])

    const fullDataAbortRef = useRef(null) // Cancel in-flight background unified fetch on model switch
    const searchInputRef = useRef(null)
    const pendingSelectionRef = useRef(_urlSeed ? {
        projectId: _urlSeed.projectId,
        modelName: _urlSeed.modelName,
        versionId: _urlSeed.versionId,
    } : null)

    // Version diff / compare state
    const [diffResult, setDiffResult] = useState(null)
    const [compareVersionId, setCompareVersionId] = useState(null)
    const [compareLoading, setCompareLoading] = useState(false)

    // Speckle comments
    const [comments, setComments] = useState([])

    // Parameter keys available for pivot grouping (populated after model ingestion)
    const [paramKeys, setParamKeys] = useState([])

    // Visualization states
    const [highlightedField, setHighlightedField] = useState(null)
    const [highlightedValue, setHighlightedValue] = useState(null)
    const [searchFilteredIds, setSearchFilteredIds] = useState(null)   // search/AI filter → table input
    const [viewerFilteredIds, setViewerFilteredIds] = useState(null)   // viewer-driven isolation (charts, search, schedule…)
    const [tableOwnFilterIds, setTableOwnFilterIds] = useState(null)   // table's own search/column filters → further narrows viewer
    const [chartFilters, setChartFilters] = useState({}) // Filters from chart clicks
    // Direct imperative ref to SpeckleViewer — used to push filter IDs without
    // going through the React prop/memo chain (which proved unreliable for search).
    const speckleViewerRef = useRef(null)
    // Stable ref so handleTableFilteredIds can read viewerFilteredIds without a
    // stale closure (needed when the table clears its own filter and we must revert).
    const viewerFilteredIdsRef = useRef(null)
    useEffect(() => { viewerFilteredIdsRef.current = viewerFilteredIds }, [viewerFilteredIds])

    // UI states
    const [selectedElement, setSelectedElement] = useState(null)
    const [selectedElementDetails, setSelectedElementDetails] = useState(null)
    const [showViewer, setShowViewer] = useState(_urlSeed?.ui?.showViewer ?? true)
    const [searchQuery, setSearchQuery] = useState('')
    const [isSearching, setIsSearching] = useState(false)
    const [viewerSelectedIds, setViewerSelectedIds] = useState(null) // State for Viewer -> Table sync
    const [viewerSelectedElement, setViewerSelectedElement] = useState(null) // Element clicked in 3D viewer → drives chart cross-highlight

    // Active element subset: viewer selection → chart filters → all elements.
    // Used by StandaloneChartWidget to keep discovered/numeric fields in sync.
    const contextElements = useMemo(() => {
        if (!fullData?.elements) return null
        if (viewerSelectedIds?.length > 0) {
            const sel = fullData.elements.filter(el => viewerSelectedIds.includes(el.id))
            if (sel.length > 0) return sel
        }
        if (Object.keys(chartFilters).length > 0) {
            const filtered = fullData.elements.filter(el =>
                Object.entries(chartFilters).every(([field, value]) => {
                    const elVal = el[field]
                    return elVal != null && String(elVal) === String(value)
                })
            )
            if (filtered.length > 0) return filtered
        }
        return fullData.elements
    }, [viewerSelectedIds, chartFilters, fullData])

    // Dynamic Chart Summary Selection
    const chartSummary = useMemo(() => {
        // 1. Viewer selection narrows to selected elements only
        if (viewerSelectedIds && viewerSelectedIds.length > 0 && fullData?.elements) {
            const selectedElements = fullData.elements.filter(el => viewerSelectedIds.includes(el.id))
            if (selectedElements.length > 0) {
                return generateSummaryFromElements(selectedElements)
            }
        }

        // 2. Active chart filters cross-filter all other charts:
        //    re-aggregate only the elements that match every active filter.
        //    This makes every chart react to bar/slice clicks in any other chart.
        if (Object.keys(chartFilters).length > 0 && fullData?.elements) {
            const filtered = fullData.elements.filter(el =>
                Object.entries(chartFilters).every(([field, value]) => {
                    const elVal = el[field]
                    return elVal != null && String(elVal) === String(value)
                })
            )
            // If the filter matches nothing fall through to the full summary so
            // charts still render (avoids a blank dashboard on mis-click)
            if (filtered.length > 0) {
                return generateSummaryFromElements(filtered)
            }
        }

        // 3. Full project summary from backend
        return data?.summary
    }, [viewerSelectedIds, chartFilters, fullData, data?.summary])


    // Extra widgets (Dynamic)
    const [extraWidgets, setExtraWidgets] = useState(() => {
        try {
            const stored = localStorage.getItem('dashboard-extra-widgets')
            return stored ? JSON.parse(stored) : []
        } catch {
            return []
        }
    })

    // Save extra widgets persistence
    useEffect(() => {
        localStorage.setItem('dashboard-extra-widgets', JSON.stringify(extraWidgets))
    }, [extraWidgets])

    // Visible individual chart panels (array of chart keys, e.g. ['by_category', 'by_level'])
    const [visibleChartPanels, setVisibleChartPanels] = useState(() => {
        try {
            const saved = localStorage.getItem('dashboard-visible-chart-panels')
            if (saved) return JSON.parse(saved)
        } catch { /* ignore */ }
        return []
    })

    // When data loads for a new model, initialise visible charts from discovered fields
    useEffect(() => {
        if (!data?.summary) return
        const discovered = discoverChartFields(data.summary).map(f => f.key)
        setVisibleChartPanels(prev => {
            const matching = prev.filter(k => discovered.includes(k))
            const next = matching.length > 0 ? matching : discovered.slice(0, 6)
            localStorage.setItem('dashboard-visible-chart-panels', JSON.stringify(next))
            return next
        })
    }, [data?.summary])

    const handleToggleChartPanel = useCallback((chartKey) => {
        setVisibleChartPanels(prev => {
            const next = prev.includes(chartKey)
                ? prev.filter(k => k !== chartKey)
                : [...prev, chartKey]
            localStorage.setItem('dashboard-visible-chart-panels', JSON.stringify(next))
            return next
        })
    }, [])

    const handleAddWidget = (type) => {
        const newWidget = {
            id: `widget-${Date.now()}`,
            type,
            title: type === 'chart'
                ? 'Custom Analysis'
                : type === 'table'
                    ? 'Element Data Table'
                    : type === 'pivot'
                        ? 'Data Pivot'
                        : type === 'text'
                            ? 'Notes'
                            : type === 'schedule'
                                ? '4D Schedule'
                                : type === 'quantities'
                                    ? '5D Quantities'
                                    : type === 'video'
                                        ? 'PeerTube Video'
                                        : 'New Panel',
            content: type === 'text' ? '## New Note\n\nClick edit to add content.' : undefined,
            noPadding: type === 'table' || type === 'text' || type === 'pivot' || type === 'schedule' || type === 'video',
            autoSize: type === 'chart' || type === 'validation' || type === 'quantities'
        }
        setExtraWidgets(prev => [...prev, newWidget])
    }

    const handleUpdateWidget = useCallback((id, updates) => {
        setExtraWidgets(prev => prev.map(w =>
            w.id === id ? { ...w, ...updates } : w
        ))
    }, [])

    const handleRemoveWidget = useCallback((id) => {
        setExtraWidgets(prev => prev.filter(w => w.id !== id))
    }, [])

    // Pre-built search index: one string per element, built once when fullData arrives.
    // Avoids calling flattenObject on every element on every keystroke.
    const searchIndexRef = useRef(null)
    useEffect(() => {
        if (!fullData?.elements) { searchIndexRef.current = null; return }
        searchIndexRef.current = fullData.elements.map(el => ({
            id: el.id || el.speckle_id,
            text: Object.values(flattenObject(el))
                .filter(v => typeof v === 'string' || typeof v === 'number')
                .join(' ')
                .toLowerCase()
        }))
    }, [fullData])

    // Handle Search — O(n) scan of pre-built strings, no re-flattening per keystroke
    useEffect(() => {
        if (!searchQuery.trim()) {
            setSearchFilteredIds(null)
            return
        }

        setIsSearching(true)
        const delaySearch = setTimeout(() => {
            const index = searchIndexRef.current
            if (index) {
                const lowerQuery = searchQuery.toLowerCase()
                const matches = index
                    .filter(entry => entry.text.includes(lowerQuery))
                    .map(entry => entry.id)
                setSearchFilteredIds(matches)
            }
            setIsSearching(false)
        }, 300)

        return () => clearTimeout(delaySearch)
    }, [searchQuery])


    // Ctrl+K / Cmd+K → focus search; Escape → blur and clear
    useEffect(() => {
        const handler = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault()
                searchInputRef.current?.focus()
                searchInputRef.current?.select()
            }
            if (e.key === 'Escape' && document.activeElement === searchInputRef.current) {
                setSearchQuery('')
                searchInputRef.current?.blur()
            }
        }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [])

    // layoutKey: incrementing this forces GridDashboard to remount, re-reading localStorage
    const [layoutKey, setLayoutKey] = useState(0)

    // Resolve share links on mount — supports /share_xxx path and legacy ?share=share_xxx
    useEffect(() => {
        // Detect path-based share (/share_xxx) or legacy query param (?share=share_xxx)
        const pathMatch = window.location.pathname.match(/^\/(share[A-Za-z0-9_-]+)$/)
        const shareId = pathMatch
            ? pathMatch[1]
            : new URLSearchParams(window.location.search).get('share')
        if (!shareId) return

        // Clean URL immediately (restore to /)
        const cleanUrl = new URL(window.location.href)
        cleanUrl.pathname = '/'
        cleanUrl.search = ''
        window.history.replaceState({}, '', cleanUrl)

        fetch(`${CONFIG.normalizerUrl}/share/${shareId}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!data?.payload) return
                const payload = data.payload
                const ls = (payload.v === 1 && payload.ls) ? payload.ls : payload
                // Seed localStorage
                Object.entries(ls).forEach(([k, v]) => {
                    try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)) } catch {}
                })
                // Apply ui state
                if (payload.ui?.darkMode     !== undefined) setDarkMode(payload.ui.darkMode)
                if (payload.ui?.showViewer   !== undefined) setShowViewer(payload.ui.showViewer)
                if (payload.ui?.showTimeline !== undefined) setShowTimeline(payload.ui.showTimeline)
                // Apply extra widgets + chart panel visibility from ls
                if (ls['dashboard-extra-widgets'])        setExtraWidgets(JSON.parse(typeof ls['dashboard-extra-widgets'] === 'string' ? ls['dashboard-extra-widgets'] : JSON.stringify(ls['dashboard-extra-widgets'])))
                if (ls['dashboard-visible-chart-panels']) setVisibleChartPanels(typeof ls['dashboard-visible-chart-panels'] === 'string' ? JSON.parse(ls['dashboard-visible-chart-panels']) : ls['dashboard-visible-chart-panels'])
                // Restore custom servers so allServers memo includes the shared server
                if (ls['speckle-custom-servers']) {
                    const servers = typeof ls['speckle-custom-servers'] === 'string'
                        ? JSON.parse(ls['speckle-custom-servers'])
                        : ls['speckle-custom-servers']
                    setCustomServers(servers)
                }
                // Queue server/project/model/version cascade
                pendingSelectionRef.current = {
                    projectId: payload.projectId ?? null,
                    modelName: payload.modelName ?? null,
                    versionId: payload.versionId ?? null,
                }
                if (payload.server?.url) {
                    CONFIG.speckleServer = payload.server.url
                    CONFIG.speckleToken  = payload.server.token || ''
                    setActiveServer(payload.server)  // triggers loadProjects via useEffect
                } else {
                    loadProjects()
                }
                // Force GridDashboard remount so it re-reads freshly seeded localStorage
                setLayoutKey(k => k + 1)
            })
            .catch(() => {})
    }, [])

    // Fetch backend-configured servers on mount (best-effort, UI works without it)
    useEffect(() => {
        fetch(`${CONFIG.normalizerUrl}/servers`)
            .then(r => r.ok ? r.json() : [])
            .then(servers => { if (servers.length > 0) setBackendServers(servers) })
            .catch(() => {})
    }, [])

    // Reload projects whenever the active server changes
    useEffect(() => {
        loadProjects()
    }, [activeServer])

    // Load models when project changes
    useEffect(() => {
        if (selectedProject) {
            loadModels(selectedProject.id)
            fetchComments(selectedProject.id)
        } else {
            setModels([])
            setSelectedModel(null)
            setData(null)
            setFullData(null)
            setComments([])
        }
    }, [selectedProject])

    // Load version list when model changes; also clear any active diff
    useEffect(() => {
        setDiffResult(null)
        if (selectedProject && selectedModel) {
            setSelectedVersion(null)
            setVersions([])
            loadVersions(selectedProject.id, selectedModel.name)
        } else {
            setVersions([])
            setSelectedVersion(null)
        }
    }, [selectedModel])

    // Auto-select version from URL seed once versions are loaded
    useEffect(() => {
        const pending = pendingSelectionRef.current
        if (!pending?.versionId || versions.length === 0) return
        const match = versions.find(v => v.id === pending.versionId)
        if (match) {
            setSelectedVersion(match)
            pendingSelectionRef.current = null
        }
    }, [versions])

    // Load data when model, version, or raw-mode toggle changes
    useEffect(() => {
        if (selectedProject && selectedModel) {
            loadModelData(selectedProject.id, selectedModel.name, selectedVersion?.id ?? null)
        } else {
            setData(null)
            setFullData(null)
        }
        setSelectedElement(null)
        setSelectedElementDetails(null)
    }, [selectedModel, selectedVersion])

    // Fetch full element details (parameters) when an element is selected in the viewer
    useEffect(() => {
        if (!selectedElement?.element_id) {
            setSelectedElementDetails(selectedElement)
            return
        }
        setSelectedElementDetails(selectedElement)  // show immediately, enrich below
        fetch(`${CONFIG.normalizerUrl}/elements/${selectedElement.element_id}`)
            .then(r => r.ok ? r.json() : null)
            .then(detail => {
                if (!detail) return
                // Transform flat [{pset, key, value}] into {pset: {key: value}}
                const props = {}
                for (const p of detail.parameters || []) {
                    const group = p.pset || 'General'
                    if (!props[group]) props[group] = {}
                    if (p.key) props[group][p.key] = p.value ?? ''
                }
                setSelectedElementDetails(prev => prev
                    ? { ...prev, properties: Object.keys(props).length ? props : null }
                    : prev
                )
            })
            .catch(() => {})
    }, [selectedElement?.element_id])

    // Viewer-driven filter (charts / search / schedule / etc.) combined with any
    // table-own filter (column filters, table search). Table-own always narrows
    // within the viewer-driven set; when cleared it reverts to viewer-driven.
    const effectiveFilterIds = useMemo(
        () => tableOwnFilterIds || viewerFilteredIds,
        [tableOwnFilterIds, viewerFilteredIds]
    )

    // Table filter callback: the table's own search/column filters set tableOwnFilterIds
    // (not viewerFilteredIds) to keep viewer-driven and table-driven state separate.
    // We also push to the viewer imperatively so isolation is immediate.
    const handleTableFilteredIds = useCallback((ids) => {
        setTableOwnFilterIds(ids)
        // When the table clears its own filter (ids=null) revert to the viewer-driven
        // filter; when it has a filter, apply that narrower set.
        speckleViewerRef.current?.setFilter(ids ?? viewerFilteredIdsRef.current)
    }, [])

    // Chart filters → viewer selection (direct path, independent of ElementTable being mounted)
    useEffect(() => {
        if (!fullData?.elements) return

        const filters = Object.entries(chartFilters)
        if (filters.length === 0) {
            // When chart filters are cleared, the search effect will re-apply search filter
            setViewerFilteredIds(null)
            return
        }

        const ids = fullData.elements
            .filter(el => filters.every(([field, value]) => String(el[field] ?? '') === String(value)))
            .map(el => el.speckle_id || el.id)
            .filter(Boolean)

        const result = ids.length > 0 ? ids : null
        speckleViewerRef.current?.setFilter(result)
        setViewerFilteredIds(result)
    }, [chartFilters, fullData])

    // Search → viewer ghosting (direct path via imperative ref + state fallback)
    useEffect(() => {
        if (!fullData?.elements) return

        // Compute the effective filter IDs (chart filters take priority over search)
        let ids = null
        if (Object.keys(chartFilters).length > 0) {
            // Already set by the chart-filter effect above via viewerFilteredIds
            return
        } else if (searchFilteredIds?.length) {
            const idSet = new Set(searchFilteredIds)
            ids = fullData.elements
                .filter(el => idSet.has(el.id) || idSet.has(el.speckle_id))
                .map(el => el.speckle_id || el.id)
                .filter(Boolean)
            if (!ids.length) ids = null
        }

        // Push directly to the viewer (imperative — bypasses the React memo chain)
        speckleViewerRef.current?.setFilter(ids)
        // Also update state so the prop path stays in sync (fallback)
        setViewerFilteredIds(ids)
    }, [searchFilteredIds, fullData, chartFilters])

    // Fetch projects from Speckle
    const loadProjects = async () => {
        setLoadingProjects(true)
        setLoadError(null)
        try {
            const gqlData = await gqlFetch(`{
                streams(limit: 100) {
                    items { id name description updatedAt }
                }
            }`)
            const streamList = gqlData.streams.items
            setProjects(streamList)
            const pending = pendingSelectionRef.current
            if (pending?.projectId) {
                const match = streamList.find(p => p.id === pending.projectId)
                if (match) { setSelectedProject(match); return }
            }
            if (streamList.length > 0) setSelectedProject(streamList[0])
        } catch (error) {
            console.error('Error loading projects:', error)
            setLoadError(`Could not load projects: ${error.message}`)
        } finally {
            setLoadingProjects(false)
        }
    }

    // Fetch models for selected project
    const loadModels = async (projectId) => {
        setLoadingModels(true)
        setSelectedModel(null)
        setLoadError(null)
        try {
            const gqlData = await gqlFetch(
                `query GetBranches($projectId: String!) {
                    stream(id: $projectId) {
                        branches {
                            items {
                                name description
                                commits { totalCount items { id message createdAt } }
                            }
                        }
                    }
                }`,
                { projectId }
            )
            const branchList = gqlData.stream.branches.items
            setModels(branchList)

            const branchesWithCommits = branchList.filter(b => b.commits.totalCount > 0)
            setSelectedVersion(null)
            setVersions([])
            const pending = pendingSelectionRef.current
            if (pending?.modelName) {
                const match = branchesWithCommits.find(b => b.name === pending.modelName)
                if (match) { setSelectedModel(match); return }
            }
            const mainBranch = branchesWithCommits.find(b => b.name === 'main')
            if (mainBranch) {
                setSelectedModel(mainBranch)
            } else if (branchesWithCommits.length > 0) {
                setSelectedModel(branchesWithCommits[0])
            }
        } catch (error) {
            console.error('Error loading models:', error)
            setLoadError(`Could not load models: ${error.message}`)
        } finally {
            setLoadingModels(false)
        }
    }

    // V2 compare: ingest both commits into bim-normalizer then call /diff
    const activateCompareV2 = useCallback(async (compareVersionId) => {
        const currentVersionId = data?.version_id
        const streamId = selectedProject?.id
        if (!currentVersionId || !compareVersionId || !streamId) return
        setCompareLoading(true)
        try {
            const ingestBoth = await Promise.all([
                fetch(`${CONFIG.normalizerUrl}/ingest`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        stream_id: streamId,
                        commit_id: currentVersionId,
                        server_url: activeServer.url,
                        token: activeServer.token || undefined,
                    })
                }),
                fetch(`${CONFIG.normalizerUrl}/ingest`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        stream_id: streamId,
                        commit_id: compareVersionId,
                        server_url: activeServer.url,
                        token: activeServer.token || undefined,
                    })
                }),
            ])
            if (!ingestBoth[0].ok || !ingestBoth[1].ok) {
                throw new Error(`Ingest failed: ${ingestBoth[0].status} / ${ingestBoth[1].status}`)
            }

            // Resolve model_id from an ingest response.
            // Fast path (already ingested): response contains model_id directly.
            // Background job: poll /ingest/status/{job_id} until complete.
            const resolveModelId = async (res) => {
                const body = await res.json()
                if (body.model_id) return body.model_id
                if (!body.job_id) throw new Error('Unexpected ingest response')
                for (let i = 0; i < 120; i++) {
                    await new Promise(r => setTimeout(r, 1500))
                    const statusRes = await fetch(`${CONFIG.normalizerUrl}/ingest/status/${body.job_id}`)
                    const status = await statusRes.json()
                    if (status.status === 'complete') return status.model_id
                    if (status.status === 'failed') throw new Error(status.error || 'Ingest failed')
                }
                throw new Error('Ingest timed out after 3 minutes')
            }

            const [currentModelId, compareModelId] = await Promise.all(ingestBoth.map(resolveModelId))
            // endpoint: /diff/{model_a}/{model_b} where A=older base, B=current (newer)
            const res = await fetch(`${CONFIG.normalizerUrl}/diff/${compareModelId}/${currentModelId}`)
            if (!res.ok) throw new Error(`Diff request failed: ${res.status}`)
            const result = await res.json()
            setDiffResult(result)
            setCompareVersionId(compareVersionId)
        } catch (e) {
            setLoadError(e.message)
        } finally {
            setCompareLoading(false)
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data?.version_id, selectedProject?.id, activeServer.url, activeServer.token])

    const deactivateCompare = useCallback(() => {
        setDiffResult(null)
        setCompareVersionId(null)
    }, [])

    const switchServer = (server) => {
        if (server.id === activeServer.id) return
        CONFIG.speckleServer = server.url
        CONFIG.speckleToken  = server.token
        setActiveServer(server)
        setSelectedProject(null); setModels([]); setSelectedModel(null)
        setVersions([]); setSelectedVersion(null)
        setData(null); setFullData(null)
        setDiffResult(null); setCompareVersionId(null); setLoadError(null)
    }

    const addCustomServer = ({ name, url: rawUrl, token }) => {
        const url = rawUrl.trim().replace(/\/$/, '')
        if (!url) return
        const server = {
            id:    `custom_${Date.now()}`,
            name:  name?.trim() || new URL(url).hostname,
            url,
            token: token?.trim() || '',
        }
        setCustomServers(prev => [...prev, server])
        switchServer(server)
    }

    const removeCustomServer = (id) => {
        setCustomServers(prev => prev.filter(s => s.id !== id))
        if (activeServer.id === id) switchServer(allServers[0])
    }

    // Parse JSON from a fetch Response; on failure include the HTTP status and
    // a snippet of the body so proxy HTML error pages produce readable messages.
    const safeJson = async (res, label) => {
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            const snippet = text.replace(/<[^>]+>/g, ' ').trim().slice(0, 120)
            throw new Error(`${label}: HTTP ${res.status}${snippet ? ` — ${snippet}` : ''}`)
        }
        return res.json()
    }

    const reIngestModel = async () => {
        const streamId = selectedProject?.id
        const commitId = data?.version_id
        if (!streamId || !commitId) return
        setReIngesting(true)
        setLoadError(null)
        try {
            const res = await fetch(`${CONFIG.normalizerUrl}/ingest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    stream_id: streamId,
                    commit_id: commitId,
                    force: true,
                    server_url: activeServer.url,
                    token: activeServer.token || undefined,
                }),
            })
            const body = await safeJson(res, 'Ingest')
            let jobId = body.job_id
            if (jobId) {
                for (let i = 0; i < 120; i++) {
                    await new Promise(r => setTimeout(r, 1500))
                    const s = await fetch(`${CONFIG.normalizerUrl}/ingest/status/${jobId}`).then(r => r.json())
                    if (s.status === 'complete') break
                    if (s.status === 'failed') throw new Error(s.error || 'Ingest failed')
                }
            }
            // Reload dashboard data after forced re-ingest
            if (selectedProject && selectedModel && data?.version_id) {
                await loadModelDataFromNormalizer(
                    selectedProject.id, data.version_id,
                    selectedProject.id, selectedModel.id,
                    selectedModel.name, null
                )
            }
        } catch (e) {
            setLoadError(`Re-ingest failed: ${e.message}`)
        } finally {
            setReIngesting(false)
        }
    }

    const isIfcSource = (data?.summary?.source_app || '').toLowerCase().includes('ifc')

    // Attempt to fetch and download the original IFC blob stored on the Speckle server.
    // Returns true if the download was triggered, false if no IFC blob was found.
    const _downloadOriginalIfc = async (streamId, modelName) => {
        const gql = `query($id: String!) {
            stream(id: $id) {
                blobs(limit: 25) {
                    items { id fileName fileSize uploadStatus }
                }
            }
        }`
        const gqlRes = await fetch(`${CONFIG.speckleServer}/graphql`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${CONFIG.speckleToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: gql, variables: { id: streamId } }),
        })
        const gqlBody = await gqlRes.json()
        const blobs = (gqlBody?.data?.stream?.blobs?.items || [])
            .filter(b => b.uploadStatus === 1 && /\.ifc$/i.test(b.fileName))
        if (!blobs.length) return false

        // Use the most recently listed IFC blob (Speckle returns newest first)
        const { id: blobId, fileName } = blobs[0]
        const dlRes = await fetch(
            `${CONFIG.speckleServer}/api/stream/${streamId}/blob/${blobId}`,
            { headers: { 'Authorization': `Bearer ${CONFIG.speckleToken}` } }
        )
        if (!dlRes.ok) throw new Error(`Blob download failed: HTTP ${dlRes.status}`)

        const blob = await dlRes.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = fileName || `${modelName}.ifc`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        return true
    }

    const exportIfc = async () => {
        const streamId  = selectedProject?.id
        const commitId  = data?.version_id
        const modelName = selectedModel?.name || 'model'
        if (!streamId || !commitId) return

        setExportingIfc(true)
        try {
            // IFC source: try to serve the original file stored on the Speckle server first
            if (isIfcSource) {
                const served = await _downloadOriginalIfc(streamId, modelName)
                if (served) return
                // No blob found — fall through to normalizer re-export
            }

            // 1. Ingest (fast-path if already done, otherwise poll until complete)
            const ingestRes = await fetch(`${CONFIG.normalizerUrl}/ingest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    stream_id: streamId,
                    commit_id: commitId,
                    server_url: activeServer.url,
                    token: activeServer.token || undefined,
                })
            })
            const ingestBody = await safeJson(ingestRes, 'Ingest')
            let modelId = ingestBody.model_id
            if (!modelId && ingestBody.job_id) {
                for (let i = 0; i < 120; i++) {
                    await new Promise(r => setTimeout(r, 1500))
                    const statusRes = await fetch(`${CONFIG.normalizerUrl}/ingest/status/${ingestBody.job_id}`)
                    const s = await safeJson(statusRes, 'Ingest status')
                    if (s.status === 'complete') { modelId = s.model_id; break }
                    if (s.status === 'failed') throw new Error(s.error || 'Ingest failed')
                }
                if (!modelId) throw new Error('Ingest timed out after 3 minutes')
            }

            // 2. Start async IFC export
            const startRes = await fetch(`${CONFIG.normalizerUrl}/models/${modelId}/export/ifc`, { method: 'POST' })
            const { job_id } = await safeJson(startRes, 'Export start')

            // 3. Poll until complete
            for (let i = 0; i < 180; i++) {
                await new Promise(r => setTimeout(r, 2000))
                const statusRes = await fetch(`${CONFIG.normalizerUrl}/models/${modelId}/export/ifc/${job_id}/status`)
                const s = await safeJson(statusRes, 'Export status')
                if (s.status === 'complete') break
                if (s.status === 'failed') throw new Error(s.error || 'Export generation failed')
                if (i === 179) throw new Error('Export timed out after 6 minutes')
            }

            // 4. Download
            const dlRes = await fetch(`${CONFIG.normalizerUrl}/models/${modelId}/export/ifc/${job_id}/download`)
            if (!dlRes.ok) {
                const text = await dlRes.text().catch(() => '')
                throw new Error(`Download failed: HTTP ${dlRes.status} — ${text.slice(0, 120)}`)
            }
            const blob = await dlRes.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `${modelName}_${commitId.slice(0, 8)}.ifc`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
        } catch (e) {
            setLoadError(`IFC export failed: ${e.message}`)
        } finally {
            setExportingIfc(false)
        }
    }

    // Extract plain text from a Speckle rich-text doc (Prosemirror JSON)
    const _commentText = (comment) => {
        if (comment.rawText) return comment.rawText
        try {
            const doc = comment.text?.doc
            if (!doc) return ''
            const extractText = (node) => {
                if (node.type === 'text') return node.text || ''
                return (node.content || []).map(extractText).join('')
            }
            return extractText(doc)
        } catch { return '' }
    }

    const fetchComments = async (projectId) => {
        if (!projectId) return
        try {
            // Use the v3 project { commentThreads } API — falls back to legacy if unsupported
            const gqlData = await gqlFetch(
                `query GetCommentThreads($projectId: String!, $filter: ProjectCommentsFilter) {
                    project(id: $projectId) {
                        id
                        commentThreads(filter: $filter, limit: 100) {
                            totalCount
                            totalArchivedCount
                            items {
                                id
                                rawText
                                text { doc }
                                archived
                                hasParent
                                author { id name avatar }
                                createdAt
                                updatedAt
                                viewedAt
                                viewerState
                                screenshot
                                resources { resourceId resourceType }
                                viewerResources { modelId versionId objectId }
                                replies {
                                    totalCount
                                    items {
                                        id
                                        rawText
                                        text { doc }
                                        author { id name avatar }
                                        createdAt
                                        archived
                                    }
                                }
                            }
                        }
                    }
                }`,
                { projectId, filter: { includeArchived: false } }
            )
            const threads = (gqlData?.project?.commentThreads?.items || [])
                .filter(c => !c.archived && !c.hasParent)
                .map(c => ({ ...c, _text: _commentText(c) }))
            setComments(threads)
        } catch (e) {
            // Fallback to legacy v2 API
            try {
                const gqlData = await gqlFetch(
                    `query GetCommentsLegacy($streamId: String!) {
                        comments(streamId: $streamId, limit: 100, archived: false) {
                            totalCount
                            items {
                                id
                                rawText
                                archived
                                author { id name avatar }
                                createdAt
                                updatedAt
                                viewerState
                                screenshot
                                resources { resourceId resourceType }
                                replies {
                                    totalCount
                                    items {
                                        id
                                        rawText
                                        author { id name }
                                        createdAt
                                    }
                                }
                            }
                        }
                    }`,
                    { streamId: projectId }
                )
                const threads = (gqlData?.comments?.items || [])
                    .filter(c => !c.archived)
                    .map(c => ({ ...c, _text: c.rawText || '' }))
                setComments(threads)
            } catch (e2) {
                console.warn('Could not fetch comments:', e2)
                setComments([])
            }
        }
    }

    const loadVersions = async (projectId, modelName) => {
        setLoadingVersions(true)
        try {
            const gqlData = await gqlFetch(
                `query GetVersions($projectId: String!, $branchName: String!) {
                    stream(id: $projectId) {
                        branch(name: $branchName) {
                            commits(limit: 25) {
                                items { id message createdAt sourceApplication }
                            }
                        }
                    }
                }`,
                { projectId, branchName: modelName }
            )
            setVersions(gqlData.stream.branch.commits.items)
        } catch (error) {
            console.error('Error loading versions:', error)
            setVersions([])
        } finally {
            setLoadingVersions(false)
        }
    }

    // ---------------------------------------------------------------------------
    // Normalizer-based data load — ingest → summary → flat elements
    // ---------------------------------------------------------------------------
    const loadModelDataFromNormalizer = async (streamId, commitId, projectId, branchId, modelName, abortSignal) => {
        // Phase 1: Ingest — returns immediately if already done, or a job_id for polling
        const ingestRes = await fetch(`${CONFIG.normalizerUrl}/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                stream_id: streamId,
                commit_id: commitId,
                server_url: activeServer.url,
                token: activeServer.token || undefined,
            }),
            signal: abortSignal,
        })
        if (!ingestRes.ok) {
            let detail = `HTTP ${ingestRes.status}`
            try { const b = await ingestRes.json(); detail = b.detail || JSON.stringify(b) } catch {}
            throw new Error(`Normalizer ingest failed: ${detail}`)
        }

        let ingestData = await ingestRes.json()
        let normModelId = ingestData.model_id

        // Large/first-time model: ingest runs in background — poll until complete
        if (ingestData.status === 'pending') {
            setIngestPhase('ingesting')
            const jobId = ingestData.job_id
            while (true) {
                await new Promise(r => setTimeout(r, 4000))
                if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError')
                const statusRes = await fetch(
                    `${CONFIG.normalizerUrl}/ingest/status/${jobId}`,
                    { signal: abortSignal }
                )
                if (!statusRes.ok) continue  // retry on transient error
                const statusData = await statusRes.json()
                if (statusData.status === 'complete') { normModelId = statusData.model_id; break }
                if (statusData.status === 'failed') throw new Error(`Ingest failed: ${statusData.error || 'Unknown error'}`)
                // still running — keep polling
            }
        }

        setIngestPhase('parsing')
        const summaryRes = await fetch(
            `${CONFIG.normalizerUrl}/models/${normModelId}/summary`,
            { signal: abortSignal }
        )
        if (!summaryRes.ok) throw new Error(`Normalizer summary failed: ${summaryRes.status}`)
        const normSummary = await summaryRes.json()

        setData({
            success: true,
            summary: adaptNormalizerSummary(normSummary),
            version_id:           commitId,
            project_id:           projectId,
            model_id:             branchId,
            model_name:           modelName,
            normalizer_model_id:  normModelId,
        })
        setLoading(false)
        setIngestPhase(null)

        // Phase 2: Flat elements + parameter keys in background

        // Fetch parameter keys for pivot (fire-and-forget, non-blocking)
        fetch(`${CONFIG.normalizerUrl}/models/${normModelId}/parameters/keys`, { signal: abortSignal })
            .then(res => res.ok ? res.json() : [])
            .then(keys => setParamKeys(Array.isArray(keys) ? keys : []))
            .catch(() => setParamKeys([]))

        fetch(
            `${CONFIG.normalizerUrl}/models/${normModelId}/elements/flat?limit=10000`,
            { signal: abortSignal }
        )
            .then(res => {
                if (!res.ok) throw new Error(`Normalizer elements failed: ${res.status}`)
                return res.json()
            })
            .then(flatData => {
                const elements = (flatData.elements || []).map(adaptNormalizerElement)
                setFullData({ success: true, elements })
            })
            .catch(err => {
                if (err.name !== 'AbortError') console.warn('Normalizer elements load failed:', err)
            })
            .finally(() => {
                fullDataAbortRef.current = null
            })
    }

    const loadModelData = async (projectId, modelName, specificVersionId = null) => {
        // Cancel any in-flight background unified fetch from a previous model
        if (fullDataAbortRef.current) {
            fullDataAbortRef.current.abort()
            fullDataAbortRef.current = null
        }

        setLoading(true)
        setData(null)
        setFullData(null)
        setParamKeys([])
        setLoadError(null)
        setIngestPhase('connecting')

        try {
            // Resolve branch ID and latest commit via GraphQL variables (no interpolation)
            const gqlData = await gqlFetch(
                `query GetBranch($projectId: String!, $branchName: String!) {
                    stream(id: $projectId) {
                        branch(name: $branchName) {
                            id
                            commits(limit: 1) {
                                items { id message createdAt sourceApplication }
                            }
                        }
                    }
                }`,
                { projectId, branchName: modelName }
            )

            const branch = gqlData.stream.branch
            const branchId = branch.id
            const versionId = specificVersionId || branch.commits?.items[0]?.id

            if (!branchId) {
                throw new Error('Branch not found or has no commits')
            }

            // Create abort controller for background phase-2 fetch
            const abortCtrl = new AbortController()
            fullDataAbortRef.current = abortCtrl

            await loadModelDataFromNormalizer(
                projectId, versionId, projectId, branchId, modelName, abortCtrl.signal
            )

        } catch (error) {
            if (error.name === 'AbortError') return
            console.error('Error loading model data:', error)
            setLoadError(`Failed to load model data: ${error.message}`)
            setData(null)
            setLoading(false)
            setIngestPhase(null)
        }
    }

    // Generic handler for adaptive charts - enhanced with bidirectional filtering
    const handleChartValueClick = useCallback((field, value) => {
        const categoricalFields = ['category', 'family', 'type', 'level', 'material', 'discipline', 'phase', 'status', 'ifc_type', 'grade_short', 'profile_name', 'profile_type', 'workset']
        setHighlightedField(prev => {
            const same = prev === field
            return same ? null : field
        })
        setHighlightedValue(prev => {
            const same = prev === value
            return same ? null : value
        })
        setChartFilters(prev => {
            if (prev[field] === value) {
                const { [field]: _, ...rest } = prev
                return rest
            }
            if (categoricalFields.includes(field)) return { ...prev, [field]: value }
            return prev
        })
    }, [])

    const handleRemoveChartFilter = useCallback((field) => {
        setChartFilters(prev => {
            const { [field]: _, ...rest } = prev
            return rest
        })
        setHighlightedField(prev => {
            if (prev === field) { setHighlightedValue(null); return null }
            return prev
        })
    }, [])

    const handleClearAllChartFilters = useCallback(() => {
        setChartFilters({})
        setHighlightedField(null)
        setHighlightedValue(null)
    }, [])


    const handleViewerSelection = useCallback((selectedIds) => {
        if (!selectedIds || selectedIds.length === 0) {
            setViewerSelectedIds(null)
            setViewerSelectedElement(null)
            setSelectedElement(null)
            setSelectedElementDetails(null)
            setSearchFilteredIds(null)
        } else {
            setViewerSelectedIds(selectedIds)
        }
    }, [])

    // 4D Timeline "sync charts" — narrows charts/tables to the elements built
    // up to the current timeline step, reusing the viewer-selection mechanism
    // (without the extra side effects handleViewerSelection applies on clear).
    const handleTimelineSync = useCallback((ids) => {
        setViewerSelectedIds(ids)
    }, [])

    // Handle single element click from table — select and fly to the element in
    // the viewer without touching viewerFilteredIds (which would clear any active
    // filter and confusingly refilter the table to the single clicked row).
    const handleElementClick = useCallback((elementId) => {
        setHighlightedField(null)
        setHighlightedValue(null)
        speckleViewerRef.current?.selectObject(elementId)
    }, [])

    // Structural fields handled by /models/{id}/elements query params
    const STRUCTURAL_FIELDS = new Set(['category', 'ifc_class', 'storey', 'name', 'speckle_type'])

    // Handle attribute-based filtering from ElementPanel filter buttons.
    // filters = { "path.to.prop": value } e.g. { "category": "Walls" }
    //            or { "properties.FireRating": "REI 90" }
    const handlePropertyFilters = async (filters) => {
        if (!filters || Object.keys(filters).length === 0) {
            setViewerFilteredIds(null)
            setTableOwnFilterIds(null)
            speckleViewerRef.current?.setFilter(null)
            return
        }

        const normModelId = data?.normalizer_model_id
        if (!normModelId) return

        const base = CONFIG.normalizerUrl.replace(/\/$/, '')

        try {
            // Process each filter key — typically there's just one from ElementPanel
            const allSpeckleIds = new Set()

            for (const [rawPath, value] of Object.entries(filters)) {
                // Determine the leaf key (last segment of dot-path)
                const leafKey = rawPath.split('.').pop()
                let url

                if (STRUCTURAL_FIELDS.has(leafKey)) {
                    // Structural field: use the flat element endpoint with query params
                    const params = new URLSearchParams({ [leafKey]: String(value), limit: '5000' })
                    url = `${base}/models/${normModelId}/elements?${params}`
                } else {
                    // BIM parameter: use the by-parameter endpoint
                    const params = new URLSearchParams({ key: leafKey, value: String(value), op: 'eq', limit: '5000' })
                    url = `${base}/models/${normModelId}/elements/by-parameter?${params}`
                }

                const res = await fetch(url)
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                const rows = await res.json()
                rows.forEach(r => { if (r.speckle_id) allSpeckleIds.add(r.speckle_id) })
            }

            const ids = [...allSpeckleIds]
            const result = ids.length > 0 ? ids : null
            // Write directly to viewerFilteredIds so the table stays in sync
            // regardless of whether chart filters are also active.
            setViewerFilteredIds(result)
            setTableOwnFilterIds(null)
            speckleViewerRef.current?.setFilter(result)

        } catch (err) {
            console.warn('[handlePropertyFilters] query failed, falling back to local filter:', err)
            // Fallback: local in-memory filter for offline/error scenarios
            if (!fullData?.elements) return
            const filterEntries = Object.entries(filters)
            const matches = fullData.elements.filter(el => {
                const flat = flattenObject(el)
                return filterEntries.every(([key, val]) =>
                    flat[key] == val || String(el[key] ?? '') === String(val)
                )
            })
            const result = matches.length > 0
                ? matches.map(el => el.speckle_id || el.id).filter(Boolean)
                : null
            setViewerFilteredIds(result)
            setTableOwnFilterIds(null)
            speckleViewerRef.current?.setFilter(result)
        }
    }

    const resetView = () => {
        setHighlightedField(null)
        setHighlightedValue(null)
        setSearchFilteredIds(null)
        setViewerFilteredIds(null)
        setTableOwnFilterIds(null)
    }

    // ── Viewer panel — memoized independently so chart/filter state changes
    //    don't trigger SpeckleViewer re-initialization via WebGL
    const viewerPanelContent = useMemo(() => (
        <GridPanel
            title="3D Viewer"
            icon={<Box className="w-3.5 h-3.5" />}
            contentClassName="overflow-hidden"
        >
            <div className="h-full relative overflow-hidden">
                <SpeckleViewer
                    ref={speckleViewerRef}
                    key={activeServer.id}
                    projectId={selectedProject?.id}
                    versionId={data?.version_id}
                    config={CONFIG}
                    fullData={fullData}
                    onElementClick={(element) => {
                        setSelectedElement(element)
                        setViewerSelectedElement(element)
                    }}
                    onSelectionChange={handleViewerSelection}
                    filteredElementIds={showTimeline ? null : effectiveFilterIds}
                    diffResult={diffResult}
                    compareVersionId={compareVersionId}
                    onExitCompare={deactivateCompare}
                    showTimeline={showTimeline}
                    normalizerModelId={data?.normalizer_model_id}
                    onCloseTimeline={() => setShowTimeline(false)}
                    onTimelineSync={handleTimelineSync}
                    comments={comments}
                />
            </div>
        </GridPanel>
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ), [activeServer.id, selectedProject?.id, data?.version_id, data?.normalizer_model_id,
        fullData, effectiveFilterIds, diffResult, compareVersionId,
        comments, showTimeline, handleViewerSelection, handleTimelineSync, deactivateCompare])

    // ── Canvas panels ─────────────────────────────────────────────────────
    const panels = useMemo(() => {
        const result = []
        if (showViewer) result.push({ id: 'viewer', type: 'viewer' })
        const discovered = data?.summary ? discoverChartFields(data.summary) : []
        visibleChartPanels
            .filter(k => discovered.some(f => f.key === k))
            .forEach(chartKey => result.push({ id: `chart-${chartKey}`, type: 'chart', chartKey }))
        extraWidgets.forEach(w => result.push({ id: w.id, type: w.type, widget: w }))
        return result
    }, [showViewer, visibleChartPanels, data?.summary, extraWidgets])

    const renderPanel = useCallback((panel, displayOptions) => {
        if (panel.type === 'viewer') {
            return viewerPanelContent
        }

        if (panel.type === 'chart' && !panel.widget) {
            const { chartKey } = panel
            if (!chartKey) return null   // guard: malformed panel with no chartKey
            const cfg = CHART_CONFIG[chartKey] || {
                type: 'bar',
                title: chartKey.replace(/^by_/, '').replace(/_/g, ' '),
                orientation: 'h', clickable: false,
                field: chartKey.replace(/^by_/, '')
            }
            const chartData = chartSummary?.[chartKey]
            if (!chartData || Object.keys(chartData).length === 0) return null
            // displayOptions.type / orientation come from DashboardGrid's chart-type buttons
            const effectiveCfg = displayOptions
                ? {
                    ...cfg,
                    type:        displayOptions.type,
                    orientation: displayOptions.orientation,
                    ...(displayOptions.title      != null  && { title:       displayOptions.title      }),
                    ...(displayOptions.maxItems              && { maxItems:   displayOptions.maxItems   }),
                    ...(displayOptions.colorScheme           && { colorScheme:displayOptions.colorScheme}),
                    ...(displayOptions.sortOrder             && { sortOrder:  displayOptions.sortOrder  }),
                    minCount:     displayOptions.minCount     ?? 0,
                    showLabels:   displayOptions.showLabels   ?? true,
                    donut:        displayOptions.donut        ?? true,
                    tickFontSize:   displayOptions.tickFontSize   ?? 11,
                    tickFontColor:  displayOptions.tickFontColor  ?? (darkMode ? '#e4e4e7' : '#18181b'),
                    tickAngle:      displayOptions.tickAngle      ?? -45,
                    valueFontSize:  displayOptions.valueFontSize  ?? 11,
                    valueFontColor: displayOptions.valueFontColor ?? (darkMode ? '#e4e4e7' : '#18181b'),
                    labelFontSize:  displayOptions.labelFontSize  ?? 11,
                    labelFontColor: displayOptions.labelFontColor ?? (darkMode ? '#e4e4e7' : '#18181b'),
                  }
                : cfg
            return (
                <DynamicChart
                    standalone
                    fieldKey={chartKey}
                    data={chartData}
                    config={effectiveCfg}
                    highlightedField={highlightedField}
                    highlightedValue={highlightedValue}
                    viewerSelectedElement={viewerSelectedElement}
                    onValueClick={handleChartValueClick}
                    fullDataReady={!!fullData}
                    darkMode={darkMode}
                />
            )
        }

        const w = panel.widget
        if (!w) return null

        // Chart widget: standalone single chart with its own header — no GridPanel wrapper
        if (w.type === 'chart') {
            return (
                <StandaloneChartWidget
                    widget={w}
                    onUpdateWidget={updates => handleUpdateWidget(w.id, updates)}
                    chartSummary={chartSummary}
                    fullData={fullData}
                    contextElements={contextElements}
                    displayOptions={displayOptions}
                    fullDataReady={!!fullData}
                    highlightedField={highlightedField}
                    highlightedValue={highlightedValue}
                    onValueClick={handleChartValueClick}
                    viewerSelectedElement={viewerSelectedElement}
                    darkMode={darkMode}
                />
            )
        }

        const content = (() => {
            if (w.type === 'text') return <MarkdownWidget content={w.content} onUpdate={c => handleUpdateWidget(w.id, { content: c })} />
            if (w.type === 'table') return <ElementTable fullData={fullData} onElementClick={handleElementClick} viewerSelectedIds={viewerSelectedIds} onFilteredIdsChange={handleTableFilteredIds} chartFilters={chartFilters} filteredIds={viewerFilteredIds} />
            if (w.type === 'pivot') return <PivotTableWidget fullData={fullData} paramKeys={paramKeys} />
            if (w.type === 'validation') return <ValidationWidget widgetId={w.id} fullData={fullData} title={w.title} onUpdateTitle={t => handleUpdateWidget(w.id, { title: t })} />
            if (w.type === 'schedule') return <ScheduleWidget normalizerModelId={data?.normalizer_model_id} normalizerUrl={CONFIG.normalizerUrl} onFilterElements={ids => setViewerFilteredIds(ids)} />
            if (w.type === 'quantities') return <QuantityWidget normalizerModelId={data?.normalizer_model_id} normalizerUrl={CONFIG.normalizerUrl} />
            if (w.type === 'video') return <VideoWidget url={w.url} onUpdateUrl={url => handleUpdateWidget(w.id, { url })} />
            return null
        })()

        return (
            <GridPanel title={w.title || 'Panel'}>
                {content}
            </GridPanel>
        )
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewerPanelContent, chartSummary, contextElements, highlightedField, highlightedValue, viewerSelectedElement,
        fullData, handleChartValueClick, handleElementClick, handleUpdateWidget, handleRemoveWidget,
        data, searchFilteredIds, viewerSelectedIds, chartFilters, paramKeys,
        visibleChartPanels, handleToggleChartPanel, darkMode])

    const [layoutCopied, setLayoutCopied] = useState(false)  // false | true | 'error'

    const [showShareAdmin, setShowShareAdmin] = useState(false)
    const [sharesList, setSharesList] = useState([])
    const [sharesLoading, setSharesLoading] = useState(false)
    const [copiedShareId, setCopiedShareId] = useState(null)

    const openShareAdmin = useCallback(() => {
        setShowShareAdmin(true)
        setSharesLoading(true)
        fetch(`${CONFIG.normalizerUrl}/share`)
            .then(r => r.ok ? r.json() : [])
            .then(list => { setSharesList(list); setSharesLoading(false) })
            .catch(() => setSharesLoading(false))
    }, [])

    const deleteShare = useCallback((id) => {
        fetch(`${CONFIG.normalizerUrl}/share/${id}`, { method: 'DELETE' })
            .then(r => r.ok ? r.json() : null)
            .then(() => setSharesList(prev => prev.filter(s => s.id !== id)))
            .catch(() => {})
    }, [])

    const copyShareLink = useCallback((id) => {
        const url = `${window.location.origin}/${id}`
        navigator.clipboard.writeText(url).then(() => {
            setCopiedShareId(id)
            setTimeout(() => setCopiedShareId(null), 2000)
        })
    }, [])

    const shareLayout = useCallback(() => {
        // Sweep all dashboard-* keys + speckle-custom-servers from localStorage
        const ls = {}
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (!key) continue
            if (key.startsWith('dashboard-') || key === 'speckle-custom-servers') {
                try { ls[key] = JSON.parse(localStorage.getItem(key)) }
                catch { ls[key] = localStorage.getItem(key) }
            }
        }
        const payload = {
            v: 1,
            server: activeServer,
            projectId: selectedProject?.id ?? null,
            modelName: selectedModel?.name ?? null,
            versionId: selectedVersion?.id ?? null,
            ui: { darkMode, showViewer, showTimeline },
            ls,
        }
        fetch(`${CONFIG.normalizerUrl}/share`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload }),
        })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!data?.id) return
                const url = new URL(window.location.href)
                url.pathname = `/${data.id}`
                url.search = ''
                navigator.clipboard.writeText(url.toString()).then(() => {
                    setLayoutCopied(true)
                    setTimeout(() => setLayoutCopied(false), 2000)
                })
            })
            .catch(() => {
            setLayoutCopied('error')
            setTimeout(() => setLayoutCopied(false), 3000)
        })
    }, [activeServer, selectedProject, selectedModel, selectedVersion, darkMode, showViewer, showTimeline])

    return (
        <div className={`min-h-screen ${darkMode ? 'dark' : 'light'}`}>
            <div className={`min-h-screen transition-colors duration-300 ${darkMode ? 'bg-zinc-950 text-zinc-50' : 'bg-gradient-to-br from-slate-100 to-slate-200 text-zinc-900'}`}>
                {/* Header */}
                <header className={`glass sticky top-0 z-50 transition-colors duration-300 ${
                    diffResult ? 'border-b border-amber-500/40 shadow-[0_1px_8px_rgba(245,158,11,0.08)]' : 'border-b border-white/5'
                }`}>
                    {/* Row 1 — Logo + Breadcrumb + Search + Actions */}
                    <div className="w-full max-w-[2400px] mx-auto px-4 lg:px-6 py-3">
                        <div className="flex items-center gap-3">
                            {/* Logo */}
                            <motion.div
                                className="flex items-center gap-2.5 shrink-0"
                                initial={{ opacity: 0, x: -20 }}
                                animate={{ opacity: 1, x: 0 }}
                            >
                                <img src="/bim-dashboard-logo2.avif" alt="BIM Analytics" className="w-9 h-9 shrink-0 object-contain" />
                                <div className="hidden sm:block">
                                    <h1 className="text-2xl font-bold gradient-text leading-none">BIM Analytics</h1>
                                </div>
                            </motion.div>

                            <div className="w-px h-6 bg-white/10 shrink-0" />

                            {/* Breadcrumb navigation */}
                            <BreadcrumbSelector
                                allServers={allServers}
                                activeServer={activeServer}
                                onSwitchServer={switchServer}
                                customServers={customServers}
                                onAddServer={addCustomServer}
                                onRemoveServer={removeCustomServer}
                                projects={projects}
                                selectedProject={selectedProject}
                                loadingProjects={loadingProjects}
                                onSelectProject={(p) => setSelectedProject(p)}
                                models={models}
                                selectedModel={selectedModel}
                                loadingModels={loadingModels}
                                onSelectModel={(m) => setSelectedModel(m)}
                                versions={versions}
                                selectedVersion={selectedVersion}
                                loadingVersions={loadingVersions}
                                onSelectVersion={(v) => setSelectedVersion(v)}
                            />

                            <div className="flex-1" />

                            {/* Search — only when element data is ready */}
                            {fullData && (
                                <div className="relative hidden md:block w-56 lg:w-64">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                        <Search className={`w-3.5 h-3.5 ${isSearching ? 'text-primary animate-pulse' : 'text-zinc-500'}`} />
                                    </div>
                                    <input
                                        ref={searchInputRef}
                                        type="text"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        placeholder="Search… (Ctrl+K)"
                                        className="w-full glass pl-9 pr-8 py-1.5 rounded-lg text-sm bg-zinc-900/20 focus:bg-zinc-900/40 focus:ring-1 focus:ring-primary/50 transition-all placeholder:text-zinc-600"
                                    />
                                    {searchQuery && (
                                        <button
                                            onClick={() => setSearchQuery('')}
                                            className="absolute inset-y-0 right-0 pr-2 flex items-center text-zinc-500 hover:text-zinc-300"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    )}
                                    {searchFilteredIds && (
                                        <div className="absolute top-full left-0 w-full mt-1 glass-card px-2 py-1.5 text-xs text-zinc-400 z-50">
                                            {searchFilteredIds.length} match{searchFilteredIds.length !== 1 ? 'es' : ''}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* System action buttons */}
                            <div className="flex gap-1 shrink-0">
                                {/* Compare toggle — only when versions are loaded */}
                                {data && versions.length >= 1 && (
                                    <>
                                        <CompareVersionToggle
                                            versions={versions}
                                            compareVersionId={compareVersionId}
                                            compareLoading={compareLoading}
                                            diffResult={diffResult}
                                            currentVersionId={data?.version_id}
                                            onCompare={activateCompareV2}
                                            onExit={deactivateCompare}
                                            disabled={!data}
                                        />
                                        <div className="w-px bg-white/10 self-stretch mx-0.5" />
                                    </>
                                )}
                                <motion.button whileHover={{ scale: reIngesting ? 1 : 1.05 }} whileTap={{ scale: reIngesting ? 1 : 0.95 }}
                                    onClick={reIngestModel}
                                    disabled={!data || reIngesting}
                                    className={`glass-card p-2 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed ${reIngesting ? 'text-primary' : ''}`}
                                    title="Force re-ingest model"
                                >
                                    {reIngesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                                </motion.button>
                                <motion.button whileHover={{ scale: exportingIfc ? 1 : 1.05 }} whileTap={{ scale: exportingIfc ? 1 : 0.95 }}
                                    onClick={exportIfc}
                                    disabled={!data || exportingIfc}
                                    className={`glass-card p-2 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed ${exportingIfc ? 'opacity-60' : ''}`}
                                    title={isIfcSource ? 'Download original IFC from Speckle' : 'Export IFC4X3'}
                                >
                                    {exportingIfc ? <Loader2 className="w-4 h-4 animate-spin" /> : <IfcLogoIcon className="w-4 h-4" />}
                                </motion.button>
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    onClick={() => setShowTimeline(v => !v)}
                                    disabled={!data?.normalizer_model_id}
                                    className={`glass-card p-2 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed ${showTimeline ? 'text-amber-400 bg-amber-400/10' : ''}`}
                                    title="4D Timeline"
                                >
                                    <Clock className="w-4 h-4" />
                                </motion.button>

                                <motion.button whileHover={{ scale: layoutCopied ? 1 : 1.05 }} whileTap={{ scale: layoutCopied ? 1 : 0.95 }}
                                    onClick={shareLayout}
                                    className={`glass-card p-2 hover:bg-white/10 transition-colors ${layoutCopied === true ? 'text-emerald-400' : layoutCopied === 'error' ? 'text-red-400' : ''}`}
                                    title={layoutCopied === 'error' ? 'Share failed — is the backend running?' : 'Copy share link'}
                                >
                                    {layoutCopied === true ? <Check className="w-4 h-4" /> : layoutCopied === 'error' ? <AlertCircle className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
                                </motion.button>
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    onClick={openShareAdmin}
                                    className="glass-card p-2 hover:bg-white/10 transition-colors"
                                    title="Manage share links"
                                >
                                    <List className="w-4 h-4" />
                                </motion.button>
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    onClick={() => setDarkMode(!darkMode)}
                                    className="glass-card p-2 hover:bg-white/10"
                                    title={darkMode ? 'Light mode' : 'Dark mode'}
                                >
                                    {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                                </motion.button>
                            </div>
                        </div>
                    </div>

                    {/* Ingest progress bar */}
                    <IngestProgress phase={ingestPhase} />

                    {/* Row 2 — Metrics strip */}
                    {data && (
                        <div className="border-t border-white/5 px-4 lg:px-6 py-1.5">
                            <AdaptiveMetrics data={data} strip />
                        </div>
                    )}

                    {/* Active filter tray — sticky with header */}
                    <AnimatePresence>
                        {Object.keys(chartFilters).length > 0 && (
                            <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                            >
                                <ActiveFilters
                                    chartFilters={chartFilters}
                                    onRemoveFilter={handleRemoveChartFilter}
                                    onClearAll={handleClearAllChartFilters}
                                />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </header>

                {/* Main Content */}
                <main className="w-full max-w-[2400px] mx-auto px-4 lg:px-6 py-2">
                    {/* Error Banner */}
                    {loadError && (
                        <motion.div
                            initial={{ opacity: 0, y: -8 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="mb-4 flex items-center gap-3 px-4 py-3 rounded-lg bg-red-500/15 border border-red-500/40 text-red-400"
                        >
                            <span className="text-sm flex-1">{loadError}</span>
                            <button
                                onClick={() => setLoadError(null)}
                                className="text-red-400 hover:text-red-200 transition-colors ml-2"
                                aria-label="Dismiss error"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </motion.div>
                    )}

                    {!selectedProject || !selectedModel ? (
                        <motion.div
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="flex flex-col items-center justify-center h-96 text-center gap-6"
                        >
                            <img src="/bim-dashboard-logo2-rotating.webp" alt="" className="w-24 h-24" />
                            <h2 className="text-xl font-semibold text-zinc-300">Opening BIM Model from your Speckle Server</h2>
                        </motion.div>
                    ) : loading ? (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="flex flex-col items-center justify-center h-96 gap-4 text-center"
                        >
                            <img src="/bim-dashboard-logo2-rotating.webp" alt="" className="w-24 h-24" />
                            <p className="text-zinc-400 text-sm">
                                {ingestPhase === 'ingesting' ? 'Ingesting model data — this may take a minute for large models…'
                                    : ingestPhase === 'parsing' ? 'Parsing elements and building analytics…'
                                    : 'Connecting to Speckle…'}
                            </p>
                        </motion.div>
                    ) : !data ? (
                        <div className="flex flex-col items-center justify-center h-96 text-center">
                            <Box className="w-16 h-16 text-zinc-700 mb-4" />
                            <h2 className="text-2xl font-bold mb-2">No Data Available</h2>
                            <p className="text-zinc-500">This model has no data or failed to load</p>
                        </div>
                    ) : (
                        <>

                        <ErrorBoundary>
                        <GridDashboard
                            key={layoutKey}
                            panels={panels}
                            renderPanel={renderPanel}
                            onClosePanel={(panel) => {
                                if (panel.type === 'chart' && !panel.widget) handleToggleChartPanel(panel.chartKey)
                                else if (panel.widget) handleRemoveWidget(panel.widget.id)
                            }}
                        />
                        </ErrorBoundary>
                        </>
                    )}
                </main>

                {/* Floating action button for adding widgets */}
                <WidgetFAB
                    onAddWidget={handleAddWidget}
                    disabled={!data}
                    availableCharts={data?.summary ? discoverChartFields(data.summary) : []}
                    visibleChartPanels={visibleChartPanels}
                    onToggleChart={handleToggleChartPanel}
                />

                {/* Publish current filter / selection as a new Speckle version */}
                <PublishSelectionButton
                    normalizerUrl={CONFIG.normalizerUrl}
                    modelId={data?.normalizer_model_id}
                    speckleIds={viewerFilteredIds?.length > 0 ? viewerFilteredIds : viewerSelectedIds}
                />

                {/* Element Properties Panel */}
                <AnimatePresence>
                    {selectedElement && (
                        <ElementPanel
                            element={selectedElementDetails || selectedElement}
                            onClose={() => {
                                setSelectedElement(null)
                                setSelectedElementDetails(null)
                                // Clear any property filter that was applied from this panel
                                setSearchFilteredIds(null)
                                speckleViewerRef.current?.setFilter(null)
                            }}
                            onFilter={handlePropertyFilters}
                            darkMode={darkMode}
                        />
                    )}
                </AnimatePresence>



                <ChatWidget
                    normalizerUrl={CONFIG.normalizerUrl}
                    onFilter={(ids) => {
                        setSearchFilteredIds(ids)
                        setViewerFilteredIds(ids && ids.length > 0 ? ids : null)
                    }}
                    projectId={data?.project_id}
                    modelId={data?.normalizer_model_id}
                    modelContext={data?.summary ? {
                        modelName:     data.model_name     || '',
                        sourceApp:     data.summary.source_app  || '',
                        author:        data.summary.author      || '',
                        totalElements: data.summary.total_elements || 0,
                        categories:    Object.keys(data.summary.by_category  || {}),
                        levels:        Object.keys(data.summary.by_level     || {}),
                        materials:     Object.keys(data.summary.by_material  || {}),
                        families:      Object.keys(data.summary.by_family    || {}),
                        phases:        Object.keys(data.summary.by_phase     || {}),
                        worksets:      Object.keys(data.summary.by_workset   || {}),
                        profiles:      Object.keys(data.summary.by_profile   || {}),
                        grades:        Object.keys(data.summary.by_grade     || {}),
                        ifcClasses:    Object.keys(data.summary.by_ifc_type  || {}),
                    } : null}
                />

                {/* Share links admin modal */}
                <AnimatePresence>
                    {showShareAdmin && (
                        <motion.div
                            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="fixed inset-0 z-[200] flex items-center justify-center p-4"
                            style={{ background: 'rgba(0,0,0,0.6)' }}
                            onClick={e => { if (e.target === e.currentTarget) setShowShareAdmin(false) }}
                        >
                            <motion.div
                                initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                                transition={{ duration: 0.15 }}
                                className="glass-card w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
                            >
                                {/* Header */}
                                <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
                                    <div>
                                        <h2 className="font-semibold text-sm">Shared Links</h2>
                                        <p className="text-xs text-zinc-500 mt-0.5">Slots share01–share99, rolling. Deleted slots are reused.</p>
                                    </div>
                                    <button onClick={() => setShowShareAdmin(false)} className="p-1.5 hover:bg-white/10 rounded-lg transition-colors">
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>

                                {/* Body */}
                                <div className="overflow-y-auto flex-1 p-4">
                                    {sharesLoading ? (
                                        <div className="flex items-center justify-center py-12 text-zinc-500">
                                            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
                                        </div>
                                    ) : sharesList.length === 0 ? (
                                        <div className="text-center py-12 text-zinc-500 text-sm">No active share links.</div>
                                    ) : (
                                        <div className="space-y-2">
                                            {sharesList.map(s => (
                                                <div key={s.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/5 hover:bg-white/8 group">
                                                    {/* Slot badge */}
                                                    <span className="font-mono text-xs font-bold text-primary bg-primary/15 px-2 py-0.5 rounded shrink-0">{s.id}</span>
                                                    {/* Info */}
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-xs font-medium truncate">
                                                            {s.model_name || '—'}
                                                            {s.server_name && <span className="text-zinc-500 ml-1.5">· {s.server_name}</span>}
                                                        </div>
                                                        <div className="text-[10px] text-zinc-500 truncate mt-0.5">
                                                            {s.server_url?.replace(/^https?:\/\//, '') || ''}
                                                            {s.created_at && <span className="ml-2">{s.created_at.replace('T', ' ').replace('Z', ' UTC')}</span>}
                                                        </div>
                                                    </div>
                                                    {/* Actions */}
                                                    <div className="flex items-center gap-1 shrink-0">
                                                        <a
                                                            href={`/${s.id}`}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="p-1.5 hover:bg-white/10 rounded transition-colors text-zinc-400 hover:text-zinc-200"
                                                            title="Open link"
                                                        >
                                                            <ExternalLink className="w-3.5 h-3.5" />
                                                        </a>
                                                        <button
                                                            onClick={() => copyShareLink(s.id)}
                                                            className="p-1.5 hover:bg-white/10 rounded transition-colors text-zinc-400 hover:text-zinc-200"
                                                            title="Copy link"
                                                        >
                                                            {copiedShareId === s.id
                                                                ? <Check className="w-3.5 h-3.5 text-emerald-400" />
                                                                : <Copy className="w-3.5 h-3.5" />
                                                            }
                                                        </button>
                                                        <button
                                                            onClick={() => deleteShare(s.id)}
                                                            className="p-1.5 hover:bg-red-500/20 rounded transition-colors text-zinc-500 hover:text-red-400"
                                                            title="Delete link"
                                                        >
                                                            <Trash2 className="w-3.5 h-3.5" />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* Footer */}
                                {!sharesLoading && sharesList.length > 0 && (
                                    <div className="px-5 py-3 border-t border-white/10 shrink-0 text-xs text-zinc-500">
                                        {sharesList.length} active link{sharesList.length !== 1 ? 's' : ''}
                                    </div>
                                )}
                            </motion.div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div >
        </div >
    )
}

export default App
