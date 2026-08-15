import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Box,
    RotateCcw,
    Sun,
    Moon,
    X,
    Search,
    Loader2,
    CalendarClock,
    Share2,
    Save,
    Check,
    AlertCircle,
    List,
    Trash2,
    Copy,
    ExternalLink,
    ChevronDown,
    MoreHorizontal,
    FileText,
    LogOut,
    Play,
    MapPin,
} from 'lucide-react'
import { ClashLogoIcon } from './components/ClashLogoIcon'
import { CompareVersionToggle } from './components/CompareVersionToggle'
import SpeckleViewer from './components/SpeckleViewer'
import { ErrorBoundary } from './components/ErrorBoundary'
import ElementPanel from './components/ElementPanel'
import { AdaptiveCharts, DynamicChart, discoverChartFields, CHART_CONFIG, COMBINED_MODEL_KEY } from './components/AdaptiveCharts'
import { AdaptiveMetrics } from './components/AdaptiveMetrics'
import { ElementTable } from './components/ElementTable'
import { ActiveFilters } from './components/ActiveFilters'
import { MarkdownWidget } from './components/MarkdownWidget'
import { GridDashboard, GridPanel } from './components/DashboardGrid'
import { ChatWidget } from './components/ChatWidget'
import PivotTableWidget from './components/PivotTableWidget'
import ValidationWidget, { ValidationModeToggle } from './components/ValidationWidget'
import FilterWidget from './components/FilterWidget'
import QuantityWidget from './components/QuantityWidget'
import GeoMapWidget from './components/GeoMapWidget'
import { VideoWidget } from './components/VideoWidget'
import { StandaloneChartWidget } from './components/StandaloneChartWidget'
import { IfcLogoIcon } from './components/IfcLogoIcon'
import { IfcExportMenu } from './components/IfcExportMenu'
import { BreadcrumbSelector } from './components/BreadcrumbSelector'
import { SemanticSearchStatus } from './components/SemanticSearchStatus'
import { WidgetFAB } from './components/WidgetFAB'
import { BcfTopicPanel } from './components/BcfTopicPanel'
import { BcfKanbanBoard } from './components/BcfKanbanBoard'
import { BcfStatsWidget } from './components/BcfStatsWidget'
import { BcfLogoIcon } from './components/BcfLogoIcon'
import { IdsLogoIcon } from './components/IdsLogoIcon'
import { IdsCheckPanel } from './components/IdsCheckPanel'
import { ElementConnectivityPanel } from './components/ElementConnectivityPanel'
import { CombineModelsPicker, nextCombineColor } from './components/CombineModelsPicker'
import { DocumentsPanel } from './components/DocumentsPanel'
import { NotificationBell } from './components/NotificationBell'
import { SchedulePanel } from './components/SchedulePanel'
import PublishSelectionButton from './components/PublishSelectionButton'
import { IngestProgress } from './components/IngestProgress'
import { flattenObject, getNestedValue } from './utils/propertyScanner'
import { generateSummaryFromElements } from './utils/propertyScanner'
import { listTopics, listViewpoints } from './utils/bcfClient'
import { pullFromSpeckle, pushToSpeckle } from './utils/bcfSync'
import { useAuth } from './contexts/AuthContext'
import { LoginScreen } from './components/LoginScreen'
import { ResetPasswordScreen } from './components/ResetPasswordScreen'
import { LandingPage } from './components/LandingPage'
import { RUNTIME_CONFIG } from './runtimeConfig'

// Lazy-loaded: each is a substantial, rarely-opened panel gated behind its
// own condition (showClashCheck/showFederatedClash/alignmentDoc/
// playbackBarOpen below) — dynamic import() keeps them out of the initial
// bundle download entirely until a user actually opens one, instead of
// every visitor paying for code most sessions never touch. Named exports
// need the .then(m => ({ default: m.X })) adapter since React.lazy() only
// resolves a module's default export.
const ClashCheckPanel = lazy(() => import('./components/ClashCheckPanel').then(m => ({ default: m.ClashCheckPanel })))
const FederatedClashPanel = lazy(() => import('./components/FederatedClashPanel').then(m => ({ default: m.FederatedClashPanel })))
const AlignmentPanel = lazy(() => import('./components/AlignmentPanel').then(m => ({ default: m.AlignmentPanel })))
const SchedulePlaybackView = lazy(() => import('./components/SchedulePlaybackView').then(m => ({ default: m.SchedulePlaybackView })))

const CONFIG = {
    normalizerUrl: RUNTIME_CONFIG.NORMALIZER_URL,
    speckleServer: RUNTIME_CONFIG.SPECKLE_SERVER,
    speckleToken: RUNTIME_CONFIG.SPECKLE_TOKEN,
    // 'full' | 'readonly' — see .env.example. Decides what an anonymous
    // /shareXXX visitor gets once the auth gate (App(), below) would
    // otherwise have sent them to the sign-in screen before Dashboard's own
    // share-resolution effect ever got a chance to run.
    shareLinkMode: RUNTIME_CONFIG.SHARE_LINK_MODE,
}

// Detected at module load — same timing as _urlSeed below — so App()'s auth
// gate can decide whether to let an anonymous visitor through *before* it
// commits to rendering LandingPage. Only checks for *presence* of a share id
// (cheap regex, no fetch); the actual payload fetch still happens in
// Dashboard's existing share-resolution effect once it mounts.
const _shareId = (() => {
    const pathMatch = window.location.pathname.match(/^\/(share[A-Za-z0-9_-]+)$/)
    return pathMatch ? pathMatch[1] : new URLSearchParams(window.location.search).get('share')
})()

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

// Parsed the same way as _shareId above — from a BCF "assigned to" email's
// deep link (?layout=...&topic=<guid>, built server-side by
// notifications/dispatch.py's notify_bcf_assignment). _urlSeed above gets
// the project/model/version loaded; this guid is threaded down to
// BcfTopicPanel so it can auto-open once that topic actually shows up in
// its (async-loaded) topics list.
const _topicGuidSeed = new URLSearchParams(window.location.search).get('topic') || null

// From a password-reset email's link (routers/auth.py's /auth/forgot-password
// builds "{PUBLIC_APP_URL}/?resetToken=..."). Read into App()'s own state
// (not just used bare like the seeds above) because, unlike those, this one
// needs to un-set itself once the reset succeeds and hand control back to
// the normal authUser gate below — see App()'s resetToken branch.
const _resetTokenSeed = new URLSearchParams(window.location.search).get('resetToken') || null

// Parse EXTRA_SPECKLE_SERVERS at module load — works without backend
const ENV_EXTRA_SERVERS = ((raw) => {
    if (!raw) return []
    return raw.split(',').flatMap((entry, i) => {
        const parts = entry.trim().split('|')
        const url = parts[1]?.trim().replace(/\/$/, '')
        if (!url) return []
        return [{ id: `env_${i}`, name: parts[0]?.trim() || url, url, token: parts[2]?.trim() || '' }]
    })
})(RUNTIME_CONFIG.EXTRA_SPECKLE_SERVERS)

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
        // phase/workset are now provided by the normalizer (canonical_key
        // resolution added to db/query.py's get_elements_flat) — falling
        // back to the spread value instead of hard-nulling it, the same
        // pattern material_category/profile_type already use above. The
        // rest genuinely aren't supplied under these exact field names yet.
        weight_kg:    null,
        length_mm:    null,
        discipline:   null,
        family:       null,
        type:         null,
        phase:        el.phase   || null,
        workset:      el.workset || null,
        status:       null,
        validation_issues: [],
    }
}

// Layers viewer selection → Filter Builder → chart-click filters, applied on
// top of a given base element pool. Factored out of the chartSummary/
// contextElements memos below so both the dashboard-wide default (single
// model, or the merged federated set while combined) and a single chart's
// per-model override (see chartModelFilters) can share the same narrowing
// logic instead of duplicating it.
function narrowElementPool(baseElements, { viewerSelectedIds, viewerFilteredIds, chartFilters }) {
    if (!baseElements) return null
    if (viewerSelectedIds?.length > 0) {
        const sel = baseElements.filter(el => viewerSelectedIds.includes(el.id))
        if (sel.length > 0) return sel
    }
    let pool = viewerFilteredIds?.length > 0
        ? baseElements.filter(el => viewerFilteredIds.includes(el.id))
        : baseElements
    if (Object.keys(chartFilters).length > 0) {
        const filtered = pool.filter(el =>
            Object.entries(chartFilters).every(([field, value]) => {
                const elVal = el[field]
                return elVal != null && String(elVal) === String(value)
            })
        )
        if (filtered.length > 0) pool = filtered
    }
    return pool
}

// Same narrowing as narrowElementPool, but returns a chart summary object
// (field -> value -> count) instead of the raw element list, falling back to
// a precomputed backend summary when nothing narrows the pool (fast path —
// avoids recomputing from scratch on every render when no filter is active).
function summaryForPool(baseElements, { viewerSelectedIds, viewerFilteredIds, chartFilters, fallbackSummary }) {
    if (viewerSelectedIds?.length > 0 && baseElements) {
        const selectedElements = baseElements.filter(el => viewerSelectedIds.includes(el.id))
        if (selectedElements.length > 0) return generateSummaryFromElements(selectedElements)
    }
    if (baseElements && (viewerFilteredIds?.length > 0 || Object.keys(chartFilters).length > 0)) {
        let pool = viewerFilteredIds?.length > 0
            ? baseElements.filter(el => viewerFilteredIds.includes(el.id))
            : baseElements
        if (Object.keys(chartFilters).length > 0) {
            const filtered = pool.filter(el =>
                Object.entries(chartFilters).every(([field, value]) => {
                    const elVal = el[field]
                    return elVal != null && String(elVal) === String(value)
                })
            )
            if (filtered.length > 0) pool = filtered
        }
        if (pool.length > 0) return generateSummaryFromElements(pool)
    }
    if (fallbackSummary !== undefined) return fallbackSummary
    return baseElements ? generateSummaryFromElements(baseElements) : null
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
        total_concrete_volume_m3: norm.total_concrete_volume_m3 || 0,
        total_steel_weight_kg:    norm.total_steel_weight_kg    || 0,
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


// Only ever mounted once AuthGate below has confirmed a logged-in user, or
// for an anonymous /shareXXX visit (see App()'s gate) — and remounted fresh
// (via the gate's `key`) on every login/logout, so none of this component's
// data-fetching effects can leak a prior user's state into a new session.
//
// readOnly: true only for an anonymous visitor under VITE_SHARE_LINK_MODE=readonly
// (see App()). Locks layout editing, project/model switching, and hides
// chat/share-admin — on top of `anonymous` below, which independently hides
// BCF/Documents for *any* logged-out visit (both share-link modes), since
// those already 401 server-side regardless of this flag.
function Dashboard({ readOnly = false }) {
    const [darkMode, setDarkMode] = useState(_urlSeed?.ui?.darkMode ?? true)

    // Mirror the theme onto <html> so content portaled to document.body
    // (3D viewer toolbar, timeline, diff bar) picks up the correct
    // --speckle-* variable values, since .light/.dark only lives on an
    // inner div otherwise.
    useEffect(() => {
        const root = document.documentElement
        root.classList.toggle('light', !darkMode)
        root.classList.toggle('dark', darkMode)
    }, [darkMode])

    // Mobile header: Row 1's breadcrumb + search + action icons don't fit a
    // ~375px-wide screen, so below `sm` they're replaced with a compact model
    // name button (opens a full-screen picker sheet) and a "more" button
    // (opens an actions drawer) — see showMobileNav/showMobileActions below.
    const [showMobileNav, setShowMobileNav] = useState(false)
    const [showMobileActions, setShowMobileActions] = useState(false)
    const [showMobileMetrics, setShowMobileMetrics] = useState(false)

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
    const [exportingIfcx, setExportingIfcx] = useState(false)
    const [reIngesting, setReIngesting] = useState(false)
    const [schedulePanelOpen, setSchedulePanelOpen] = useState(_urlSeed?.ui?.showTimeline ?? false)
    const [playbackBarOpen, setPlaybackBarOpen] = useState(false)
    const [timelinePlaybackIds, setTimelinePlaybackIds] = useState(null)
    const [timelineSyncEnabled, setTimelineSyncEnabled] = useState(false)
    // Whether the bottom playback bar is both open and actually producing a
    // build-up state — the meaning every existing consumer below (share-link
    // payload, viewer prop deps) already expects from this name.
    const showTimeline = playbackBarOpen && Boolean(timelinePlaybackIds)

    // Reports the 4D playback bar's build-up state into the shared
    // timelinePlaybackIds/timelineSyncEnabled state above so SpeckleViewer
    // can isolate/color it — a ref-backed callback in SchedulePlaybackView
    // means this identity churning every render is harmless.
    const handleSchedulePlaybackChange = useCallback((pastIds, currentIds, syncCharts) => {
        setTimelinePlaybackIds(pastIds || currentIds ? { pastIds: pastIds || [], currentIds: currentIds || [] } : null)
        setTimelineSyncEnabled(!!syncCharts)
    }, [])
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
    // In-flight-request cache for resolveBranch() below, keyed by server+project+model.
    // loadVersions and loadModelData both need the same branch/commits data and fire
    // in the same render pass when a model is selected — this dedupes that into one
    // GraphQL round trip instead of two near-identical ones. Entries are removed as
    // soon as the shared promise settles, so it only ever covers that brief overlap
    // rather than risking stale data on a later, genuinely new load.
    const branchResolveCacheRef = useRef(new Map())
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

    // BCF topics — owned/fetched by BcfTopicPanel, mirrored here so SpeckleViewer can render pins
    const [bcfTopics, setBcfTopics] = useState([])
    // Topic guid from a BCF-assignment email's deep link (see _topicGuidSeed
    // above) — cleared once BcfTopicPanel has auto-opened it, so it doesn't
    // re-trigger the auto-open on later topic-list refreshes.
    const [pendingBcfTopicGuid, setPendingBcfTopicGuid] = useState(_topicGuidSeed)
    const clearPendingBcfTopicGuid = useCallback(() => setPendingBcfTopicGuid(null), [])

    // Elements with a linked document (bim_documents.linked_element) — { speckle_id, centroid, doc_count }[],
    // used to render the "has a document" pin overlay in SpeckleViewer.
    const [documentPins, setDocumentPins] = useState([])
    // Bumped every time refreshDocumentPins runs, regardless of source
    // (model load, ElementPanel link/unlink, DocumentsPanel delete) — lets
    // ElementPanel's own Documents section (which may be mounted but
    // hidden behind DocumentsPanel's full-screen overlay, so it has no
    // other way to hear about changes made there) refetch its list too,
    // instead of only reacting to the element it's currently showing.
    const [documentLinksVersion, setDocumentLinksVersion] = useState(0)

    // Parameter keys available for pivot grouping (populated after model ingestion)
    const [paramKeys, setParamKeys] = useState([])

    // Visualization states
    const [highlightedField, setHighlightedField] = useState(null)
    const [highlightedValue, setHighlightedValue] = useState(null)
    const [searchFilteredIds, setSearchFilteredIds] = useState(null)   // search/AI filter → table input
    const [viewerFilteredIds, setViewerFilteredIds] = useState(null)   // viewer-driven isolation (charts, search, schedule…)
    const [tableOwnFilterIds, setTableOwnFilterIds] = useState(null)   // table's own search/column filters → further narrows viewer
    const [chartFilters, setChartFilters] = useState({}) // Filters from chart clicks
    // Which chart panel (fieldKey / widget id), if any, is currently driving the
    // 3D viewer's object colours via its own "colour viewer by this chart" toggle.
    const [colorSourceKey, setColorSourceKey] = useState(null)
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

    // contextElements/chartSummary (dashboard-wide default chart data pool) are
    // declared further down, right after combineMode/federatedElementData —
    // they need to read those to default to the merged federated set while
    // combined, and combineMode is itself declared late (see the comment at
    // its declaration for why).

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
                                        : type === 'filter'
                                            ? 'Filter Builder'
                                            : type === 'bcf_stats'
                                                ? 'BCF Issue Stats'
                                                : type === 'geo_map'
                                                    ? 'Location Map'
                                                    : 'New Panel',
            content: type === 'text' ? '## New Note\n\nClick edit to add content.' : undefined,
            noPadding: type === 'table' || type === 'text' || type === 'pivot' || type === 'video' || type === 'geo_map',
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

    // Stable reference so GridDashboard (memoized) doesn't get a fresh
    // function identity, and thus re-render, on every unrelated App render.
    const handleClosePanel = useCallback((panel) => {
        if (panel.type === 'chart' && !panel.widget) handleToggleChartPanel(panel.chartKey)
        else if (panel.widget) handleRemoveWidget(panel.widget.id)
    }, [handleToggleChartPanel, handleRemoveWidget])

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

    // Applies a dashboard snapshot (from /share or /dashboard-layout) to local
    // state: seeds localStorage, then mirrors the relevant keys into the React
    // state that reads them only once on mount (extra widgets, chart panel
    // visibility), and forces GridDashboard to remount so it re-reads the rest.
    const applyDashboardPayload = useCallback((payload) => {
        const ls = (payload.v === 1 && payload.ls) ? payload.ls : payload
        Object.entries(ls).forEach(([k, v]) => {
            try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)) } catch {}
        })
        if (payload.ui?.darkMode     !== undefined) setDarkMode(payload.ui.darkMode)
        if (payload.ui?.showViewer   !== undefined) setShowViewer(payload.ui.showViewer)
        if (payload.ui?.showTimeline !== undefined) setPlaybackBarOpen(payload.ui.showTimeline)
        if (ls['dashboard-extra-widgets'])        setExtraWidgets(JSON.parse(typeof ls['dashboard-extra-widgets'] === 'string' ? ls['dashboard-extra-widgets'] : JSON.stringify(ls['dashboard-extra-widgets'])))
        if (ls['dashboard-visible-chart-panels']) setVisibleChartPanels(typeof ls['dashboard-visible-chart-panels'] === 'string' ? JSON.parse(ls['dashboard-visible-chart-panels']) : ls['dashboard-visible-chart-panels'])
        setLayoutKey(k => k + 1)
        return ls
    }, [])

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
                const ls = applyDashboardPayload(payload)
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
            })
            .catch(() => {})
    }, [])

    // First-time visitor for this project (no local dashboard-* state yet):
    // load whatever was last saved via "Save as default" for this project,
    // instead of leaving them on the bare grid defaults. Runs once per project.
    const triedDefaultLayoutRef = useRef(new Set())
    useEffect(() => {
        const projectId = selectedProject?.id
        if (!projectId || triedDefaultLayoutRef.current.has(projectId)) return
        triedDefaultLayoutRef.current.add(projectId)

        let hasLocalLayout = false
        for (let i = 0; i < localStorage.length; i++) {
            if (localStorage.key(i)?.startsWith('dashboard-')) { hasLocalLayout = true; break }
        }
        if (hasLocalLayout) return

        fetch(`${CONFIG.normalizerUrl}/dashboard-layout/${projectId}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => { if (data?.payload) applyDashboardPayload(data.payload) })
            .catch(() => {})
    }, [selectedProject, applyDashboardPayload])

    // Fetch backend-configured servers on mount (best-effort, UI works without it)
    useEffect(() => {
        fetch(`${CONFIG.normalizerUrl}/servers`)
            .then(r => r.ok ? r.json() : [])
            .then(servers => { if (servers.length > 0) setBackendServers(servers) })
            .catch(() => {})
    }, [])

    // Trigger an on-demand auto-sync scan on app load — registers webhooks for
    // any brand-new project immediately, instead of waiting for the backend's
    // hourly background pass. Fire-and-forget: the backend returns right away
    // and the scan runs in the background, so this never blocks page load.
    useEffect(() => {
        fetch(`${CONFIG.normalizerUrl}/auto-sync/scan`, { method: 'POST' }).catch(() => {})
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
        // A chart's colour mapping is only valid for the data it was built
        // from — drop it rather than risk painting the new model with a
        // stale/mismatched value → colour map from the previous one.
        setColorSourceKey(null)
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
            .filter(el => filters.every(([field, value]) => String(getNestedValue(el, field) ?? '') === String(value)))
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
                                commits(limit: 1) { totalCount items { id message createdAt } }
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

    // Attempt to fetch and download the original IFC blob stored on the Speckle server,
    // proxied through the normalizer (browsers can't call Speckle's blob REST endpoint
    // directly due to CORS). Returns true if the download was triggered, false if no
    // IFC blob was found.
    const _downloadOriginalIfc = async (streamId, modelName) => {
        const res = await fetch(`${CONFIG.normalizerUrl}/streams/${streamId}/original-ifc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                server_url: activeServer.url,
                token: activeServer.token || undefined,
            }),
        })
        if (res.status === 404) return false
        if (!res.ok) throw new Error(`Blob download failed: HTTP ${res.status}`)

        const disposition = res.headers.get('Content-Disposition') || ''
        const match = disposition.match(/filename="?([^"]+)"?/)
        const fileName = match ? match[1] : `${modelName}.ifc`

        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = fileName
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
        setLoadError(null)
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

            // 2. Start async IFC export (include_schedule is a no-op when the model has no 4D tasks)
            const startRes = await fetch(`${CONFIG.normalizerUrl}/models/${modelId}/export/ifc?include_schedule=true`, { method: 'POST' })
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

            // 4. Download — hand the URL straight to the browser's native download
            // manager instead of fetch()+blob(). Buffering a 100MB+ response into a
            // JS Blob is exactly the pattern that trips a Chromium bug where large
            // fetch() downloads fail with net::ERR_FAILED even though the server
            // completed the response with 200 OK (confirmed server-side clean via
            // direct testing — the failure is Chrome's blob materialization, not
            // the network transfer). The endpoint already sets Content-Disposition:
            // attachment, so a plain anchor click downloads it correctly without
            // any JS ever touching the response bytes.
            const downloadUrl = `${CONFIG.normalizerUrl}/models/${modelId}/export/ifc/${job_id}/download`
            const a = document.createElement('a')
            a.href = downloadUrl
            a.download = `${modelName}_${commitId.slice(0, 8)}.ifc`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
        } catch (e) {
            setLoadError(`IFC export failed: ${e.message}`)
        } finally {
            setExportingIfc(false)
        }
    }

    // EXPERIMENTAL — IFC5 (.ifcx), buildingSMART's still-unratified alpha
    // spec. Same ingest→start→poll→download shape as exportIfc() above, but
    // deliberately skips the original-IFC-passthrough fast path (that only
    // applies to the mature IFC4X3 format) and the include_schedule param
    // (4D schedule isn't part of this exporter's v1 scope — see
    // ifc/export_ifcx.py).
    const exportIfcx = async () => {
        const streamId  = selectedProject?.id
        const commitId  = data?.version_id
        const modelName = selectedModel?.name || 'model'
        if (!streamId || !commitId) return

        setExportingIfcx(true)
        setLoadError(null)
        try {
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

            const startRes = await fetch(`${CONFIG.normalizerUrl}/models/${modelId}/export/ifcx`, { method: 'POST' })
            const { job_id } = await safeJson(startRes, 'Export start')

            for (let i = 0; i < 180; i++) {
                await new Promise(r => setTimeout(r, 2000))
                const statusRes = await fetch(`${CONFIG.normalizerUrl}/models/${modelId}/export/ifcx/${job_id}/status`)
                const s = await safeJson(statusRes, 'Export status')
                if (s.status === 'complete') break
                if (s.status === 'failed') throw new Error(s.error || 'Export generation failed')
                if (i === 179) throw new Error('Export timed out after 6 minutes')
            }

            const downloadUrl = `${CONFIG.normalizerUrl}/models/${modelId}/export/ifcx/${job_id}/download`
            const a = document.createElement('a')
            a.href = downloadUrl
            a.download = `${modelName}_${commitId.slice(0, 8)}.ifcx`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
        } catch (e) {
            setLoadError(`IFC5 (.ifcx) export failed: ${e.message}`)
        } finally {
            setExportingIfcx(false)
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

    // Bidirectional BCF<->Speckle comment sync, run automatically and
    // silently whenever a model finishes loading (per user direction — no
    // buttons, no UI feedback, console logging only). Both directions are
    // idempotent via the persistent bcf_speckle_sync table (see bcfSync.js),
    // so safe to re-run on every load without creating duplicates.
    // useCallback so triggerBcfSync (and BcfTopicPanel's onRequestSync prop
    // below) doesn't get a fresh identity on every unrelated App render —
    // it still changes when fullData/comments/activeServer actually do,
    // which is correct (those are real inputs to the sync), just not on
    // every single render like a plain function declaration would.
    const syncBcfWithSpeckle = useCallback(async (bcfProjectId) => {
        if (!bcfProjectId) return
        try {
            const list = await listTopics(bcfProjectId)
            const withViewpoints = await Promise.all(
                list.map(async (t) => {
                    try {
                        const vps = await listViewpoints(bcfProjectId, t.guid)
                        return { ...t, viewpoint: vps[vps.length - 1] || null } // most recently added viewpoint, not the first
                    } catch {
                        return { ...t, viewpoint: null }
                    }
                })
            )

            const elements = fullData?.elements || []
            const speckleServer = { serverUrl: activeServer.url, token: activeServer.token }
            const pulled = await pullFromSpeckle(bcfProjectId, comments, elements, speckleServer)
            let topics = [...withViewpoints, ...pulled]

            const pushed = await pushToSpeckle(bcfProjectId, topics, {
                streamId: data?.project_id,
                modelId: data?.model_id,
                versionId: data?.version_id,
                ...speckleServer,
            })
            if (pushed.length) {
                const pushedByGuid = new Map(pushed.map((t) => [t.guid, t]))
                topics = topics.map((t) => pushedByGuid.get(t.guid) || t)
            }

            setBcfTopics(topics)
            if (pulled.length || pushed.length) {
                console.log(`BCF<->Speckle sync: pulled ${pulled.length}, pushed ${pushed.length}`)
            }
        } catch (e) {
            console.warn('BCF<->Speckle sync failed:', e)
        }
    }, [fullData, activeServer.url, activeServer.token, comments, data?.project_id, data?.model_id, data?.version_id])

    // Trigger the sync once per model load — gated on fullData.elements being
    // populated. `comments` loads via a separate fetch (fetchComments,
    // triggered off `selectedProject`) with no ordering guarantee relative to
    // fullData finishing — if it's still empty at this exact instant, pull
    // would (harmlessly) just find nothing new to pull this one time. A
    // permanent comments.length-keyed gate was tried here before and caused
    // a worse bug: since `comments` doesn't change again until a NEW native
    // Speckle comment appears, push (which rides along in the same
    // syncBcfWithSpeckle call) silently stopped running on every other
    // reload/panel reopen too — "only updates when Speckle gets a comment".
    // Re-syncing is now also triggered directly by user actions (see
    // triggerBcfSync, wired to the panel opening and to comment/topic
    // submission) so passive staleness here matters far less; this effect's
    // job is just "run once when the model itself loads".
    const lastSyncedModelRef = useRef(null)
    useEffect(() => {
        const bcfProjectId = data?.normalizer_model_id
        if (!bcfProjectId) { lastSyncedModelRef.current = null; setBcfTopics([]); return }
        if (!fullData?.elements?.length) return
        if (lastSyncedModelRef.current === bcfProjectId) return
        lastSyncedModelRef.current = bcfProjectId
        // Drop the previous model's topics immediately — otherwise there's a
        // window (while this model's sync is in flight, or if it fails) where
        // the panel shows topics belonging to a different project_id, and any
        // action on them (open/delete/comment) 404s against the new project.
        setBcfTopics([])
        syncBcfWithSpeckle(bcfProjectId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data?.normalizer_model_id, fullData])

    // Manual re-sync trigger for action-driven moments (panel opened, a
    // comment/topic just submitted) — unlike the model-load effect above,
    // this is NOT gated by lastSyncedModelRef, since pull/push are fully
    // idempotent and these are infrequent, deliberate calls, not a passive
    // polling loop. useCallback so BcfTopicPanel's onRequestSync prop stays
    // stable across renders that don't actually change the sync target.
    const triggerBcfSync = useCallback(() => {
        const bcfProjectId = data?.normalizer_model_id
        if (bcfProjectId) syncBcfWithSpeckle(bcfProjectId)
    }, [data?.normalizer_model_id, syncBcfWithSpeckle])

    // Document-pin positions for the current model — refetched on model load and
    // whenever ElementPanel links/unlinks a document (see onDocumentLinksChanged).
    const refreshDocumentPins = useCallback(async () => {
        const streamId = data?.project_id
        const modelId = data?.normalizer_model_id
        if (!streamId || !modelId) { setDocumentPins([]); return }
        try {
            const base = CONFIG.normalizerUrl.replace(/\/$/, '')
            const res = await fetch(`${base}/projects/${streamId}/documents/linked-positions?model_id=${modelId}`)
            setDocumentPins(res.ok ? await res.json() : [])
        } catch (e) {
            console.warn('[documentPins] fetch failed:', e)
            setDocumentPins([])
        } finally {
            setDocumentLinksVersion(v => v + 1)
        }
    }, [data?.project_id, data?.normalizer_model_id])

    useEffect(() => { refreshDocumentPins() }, [refreshDocumentPins])

    // Resolves a branch's id + recent commits once, sharing the in-flight request
    // between whichever of loadVersions/loadModelData asks first — see
    // branchResolveCacheRef above for why this exists.
    const resolveBranch = (projectId, modelName) => {
        const key = `${activeServer.url}:${projectId}:${modelName}`
        const cache = branchResolveCacheRef.current
        const cached = cache.get(key)
        if (cached) return cached

        const promise = gqlFetch(
            `query GetBranch($projectId: String!, $branchName: String!) {
                stream(id: $projectId) {
                    branch(name: $branchName) {
                        id
                        commits(limit: 25) {
                            items { id message createdAt sourceApplication }
                        }
                    }
                }
            }`,
            { projectId, branchName: modelName }
        ).then(gqlData => {
            const branch = gqlData.stream.branch
            return { branchId: branch.id, commits: branch.commits?.items || [] }
        })
        promise.finally(() => cache.delete(key))
        cache.set(key, promise)
        return promise
    }

    const loadVersions = async (projectId, modelName) => {
        setLoadingVersions(true)
        try {
            const { commits } = await resolveBranch(projectId, modelName)
            setVersions(commits)
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
    // Ingests one commit into bim-normalizer (idempotent — returns immediately
    // if already ingested) and returns its normalizer model_id, polling if the
    // backend reports the ingest as still running in the background. Shared by
    // the single-model load path below and the federated "combine models" path
    // (see loadCombinedModels) — onPending lets the single-model caller drive
    // its ingestPhase UI without coupling that state into this helper.
    const ingestModelToNormalizer = async (streamId, commitId, abortSignal, onPending) => {
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
            try {
                const b = await ingestRes.json()
                // FastAPI's own request-validation errors (422) shape detail
                // as an array of {loc, msg, ...} objects, not a string — that
                // silently rendered as the useless literal "[object Object]"
                // when interpolated directly (b.detail is truthy so the
                // JSON.stringify(b) fallback below never ran for this case).
                detail = typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail ?? b)
            } catch {}
            throw new Error(`Normalizer ingest failed: ${detail}`)
        }

        let ingestData = await ingestRes.json()
        let normModelId = ingestData.model_id
        // Only set on the "already ingested" fast path (see routers/ingest.py) —
        // lets loadModelDataFromNormalizer skip a separate GET /summary round trip
        // for the common case of reopening an already-ingested model/version.
        let summary = ingestData.summary ?? null

        // Large/first-time model: ingest runs in background — poll until complete
        if (ingestData.status === 'pending') {
            onPending?.()
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
        return { modelId: normModelId, summary }
    }

    // Flat per-element rows for an already-ingested model, adapted to the
    // dashboard's element shape. Shared by the single-model and federated paths.
    const fetchFlatElements = async (normModelId, abortSignal) => {
        const res = await fetch(
            `${CONFIG.normalizerUrl}/models/${normModelId}/elements/flat?limit=50000`,
            { signal: abortSignal }
        )
        if (!res.ok) throw new Error(`Normalizer elements failed: ${res.status}`)
        const flatData = await res.json()
        return (flatData.elements || []).map(adaptNormalizerElement)
    }

    const loadModelDataFromNormalizer = async (streamId, commitId, projectId, branchId, modelName, abortSignal) => {
        const { modelId: normModelId, summary: inlineSummary } =
            await ingestModelToNormalizer(streamId, commitId, abortSignal, () => setIngestPhase('ingesting'))

        setIngestPhase('parsing')
        let normSummary = inlineSummary
        if (!normSummary) {
            const summaryRes = await fetch(
                `${CONFIG.normalizerUrl}/models/${normModelId}/summary`,
                { signal: abortSignal }
            )
            if (!summaryRes.ok) throw new Error(`Normalizer summary failed: ${summaryRes.status}`)
            normSummary = await summaryRes.json()
        }

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

        fetchFlatElements(normModelId, abortSignal)
            .then(elements => setFullData({ success: true, elements }))
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
            // Resolve branch ID + latest commit — shared via resolveBranch() with
            // loadVersions, which fires in the same render pass and needs the same
            // data, instead of both issuing separate GraphQL queries to Speckle.
            const { branchId, commits } = await resolveBranch(projectId, modelName)
            const versionId = specificVersionId || commits?.[0]?.id

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

    // Chart hover → highlight matching elements in 3D viewer without moving the camera.
    // Uses a ref for fullData so the callback stays stable across data updates.
    const fullDataRef = useRef(fullData)
    useEffect(() => { fullDataRef.current = fullData }, [fullData])

    const handleChartHover = useCallback((field, value) => {
        const elements = fullDataRef.current?.elements
        if (!elements || !field || !value) return
        const ids = elements
            .filter(el => String(getNestedValue(el, field) ?? '') === String(value))
            .map(el => el.speckle_id || el.id)
            .filter(Boolean)
        if (ids.length) speckleViewerRef.current?.highlightObjects(ids)
    }, [])

    const handleChartHoverEnd = useCallback(() => {
        speckleViewerRef.current?.clearHover()
    }, [])

    // "Colour viewer by this chart" toggle — only one chart panel can drive the
    // viewer's colours at a time, so selecting a new one replaces the last.
    const handleToggleColorSource = useCallback((fieldKey, field, colorMap) => {
        setColorSourceKey(prev => {
            if (prev === fieldKey) {
                speckleViewerRef.current?.clearChartColors()
                return null
            }
            speckleViewerRef.current?.applyChartColors(field, colorMap)
            return fieldKey
        })
    }, [])

    // Generic handler for adaptive charts - enhanced with bidirectional filtering
    const handleChartValueClick = useCallback((field, value) => {
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
            return { ...prev, [field]: value }
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
            // Multi-selection: close the single-element side panel (it would
            // otherwise keep showing stale data for whichever element was
            // clicked first, and ctrl/shift-clicking more elements should
            // build up the selection, not fight the panel for focus).
            if (selectedIds.length > 1) {
                setViewerSelectedElement(null)
                setSelectedElement(null)
                setSelectedElementDetails(null)
            }
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

    // ---------------------------------------------------------------------------
    // Federated ("combine models") mode — lets the user load several discipline
    // branches (ARC/STR/FM, etc.) of the current project into one viewer at
    // once for coordination + N-way clash checking. Layered on top of the
    // single-model state above exactly like compareVersionId/diffResult are;
    // none of the single-model state (selectedModel/data/fullData) is touched.
    // Declared here (before viewerPanelContent below) since that memo's
    // callback closes over combineMode/federatedModelsArray/etc. — declaring
    // them later in the component body would reference them before their
    // own initialization on first render (useMemo's factory runs synchronously).
    // ---------------------------------------------------------------------------
    const [combineMode, setCombineMode] = useState(false)
    const [combinedModels, setCombinedModels] = useState(new Map())   // branchName -> {branchName, versionId, color, normalizerModelId}
    const [combiningLoading, setCombiningLoading] = useState(false)
    const [federatedElementData, setFederatedElementData] = useState(null)  // { elements: [...] } each tagged with _modelKey
    const [showFederatedClash, setShowFederatedClash] = useState(false)
    const combineAbortRef = useRef(null)
    // Per-chart override: panelId -> branchName, so an individual chart can show
    // just one combined model's data instead of the merged default. Absent/
    // undefined entry (or COMBINED_MODEL_KEY) means "use the merged set".
    const [chartModelFilters, setChartModelFilters] = useState({})

    // Validation widgets' edit-rules/view-results mode, keyed by widget id —
    // lifted up here (rather than local state inside ValidationWidget) so the
    // toggle button can be rendered in the panel's own title bar via
    // GridPanel's headerActions instead of a second header row inside the
    // widget. A widget id absent from the set means "editing" (the original
    // default), matching ValidationWidget's old useState(true) default.
    const [validationResultsView, setValidationResultsView] = useState(() => new Set())
    const handleToggleValidationView = useCallback((widgetId) => {
        setValidationResultsView(prev => {
            const next = new Set(prev)
            next.has(widgetId) ? next.delete(widgetId) : next.add(widgetId)
            return next
        })
    }, [])

    // Pre-check the already-loaded (primary) model in CombineModelsPicker,
    // reflecting reality — it's already in the viewer — and signaling to the
    // user that picking 1-2 more is what "combine" actually means, rather
    // than starting from an empty list that implies picking 2+ unrelated
    // models from scratch. Tracks which key is "the primary's own entry" via
    // a ref so that switching the MODEL dropdown (not just the project) to a
    // different branch migrates that entry's key instead of leaving it
    // behind — leaving it behind was the actual bug: combinedModels kept
    // whatever branch was open FIRST (e.g. "arc") forever, so switching to
    // "hvac" left "arc" sitting in the picker looking checked/combined
    // (colliding with genuinely picking "arc" as an addition — checking its
    // box actually unchecked this stale entry) while "hvac" itself was never
    // a key at all, so combinedModels never reached size >= 2 and "Load
    // combined view" silently did nothing. Doesn't fight the user's own
    // picks for every OTHER (non-primary) entry — those are untouched here.
    const primaryAutoSeedKeyRef = useRef(null)
    useEffect(() => {
        const branchName = data?.summary?.branch_name
        if (!branchName) return
        setCombinedModels(prev => {
            if (primaryAutoSeedKeyRef.current === branchName) return prev
            const next = new Map(prev)
            const existing = primaryAutoSeedKeyRef.current ? next.get(primaryAutoSeedKeyRef.current) : undefined
            if (primaryAutoSeedKeyRef.current) next.delete(primaryAutoSeedKeyRef.current)
            next.set(branchName, {
                branchName,
                // Must be a raw Speckle commit id (what ingestModelToNormalizer/
                // resolveObjectId expect), same field toggleCombinedModel uses
                // for every other entry (branch.commits.items[0].id).
                // selectedVersion is only set once the user explicitly picks a
                // historical version from the dropdown — it stays null while
                // viewing "Latest" (BreadcrumbSelector.jsx's own label falls
                // back to "Latest" for exactly this same null check). data.
                // version_id covers that default case: loadModelDataFromNormalizer
                // sets it to the exact commit id (specificVersionId ||
                // commits[0].id) that was actually used for this model's own
                // successful initial ingest, i.e. the resolved "latest" commit
                // — not a different, normalizer-side identifier as previously
                // assumed here (that assumption was the actual bug: using
                // selectedVersion?.id alone sent a null commit_id to ingest
                // whenever "Latest" was showing, which is the common case).
                versionId: selectedVersion?.id || data?.version_id || null,
                color: existing?.color ?? nextCombineColor(0),
                normalizerModelId: null,
                hidden: false,
            })
            primaryAutoSeedKeyRef.current = branchName
            return next
        })
    }, [data?.summary?.branch_name, selectedVersion?.id, data?.version_id])

    const toggleCombinedModel = useCallback((branch) => {
        setCombinedModels(prev => {
            const next = new Map(prev)
            if (next.has(branch.name)) {
                next.delete(branch.name)
            } else {
                const latestCommit = branch.commits?.items?.[0]
                next.set(branch.name, {
                    branchName: branch.name,
                    versionId: latestCommit?.id || null,
                    color: nextCombineColor(next.size),
                    normalizerModelId: null,
                    hidden: false,
                })
            }
            return next
        })
    }, [])

    // FederatedBar's per-model eye icon (SpeckleViewer.jsx) — unlike
    // toggleCombinedModel above (which adds/removes a model from the
    // combine set entirely, used by CombineModelsPicker's checkboxes), this
    // just flips a `hidden` flag on an already-combined entry so its chip/
    // button stays put and can be toggled back on. SpeckleViewer's
    // federated-loading effect treats hidden entries as "not wanted" and
    // genuinely unloads their geometry (same mechanism toggleCombinedModel
    // triggers), rather than the old hide/show-on-already-loaded-geometry
    // approach that silently no-opped once 3+ models were combined.
    const setCombinedModelHidden = useCallback((branchName, hidden) => {
        setCombinedModels(prev => {
            const entry = prev.get(branchName)
            if (!entry || !!entry.hidden === !!hidden) return prev
            const next = new Map(prev)
            next.set(branchName, { ...entry, hidden })
            return next
        })
    }, [])

    const loadCombinedModels = useCallback(async () => {
        if (!selectedProject?.id || combinedModels.size < 2) return
        combineAbortRef.current?.abort()
        const abortCtrl = new AbortController()
        combineAbortRef.current = abortCtrl
        setCombiningLoading(true)
        try {
            const entries = [...combinedModels.values()]
            const resolved = await Promise.all(entries.map(async (entry) => {
                const { modelId: normModelId } = await ingestModelToNormalizer(selectedProject.id, entry.versionId, abortCtrl.signal)
                const elements = await fetchFlatElements(normModelId, abortCtrl.signal)
                return { ...entry, normalizerModelId: normModelId, elements }
            }))
            if (abortCtrl.signal.aborted) return

            const next = new Map()
            const merged = []
            for (const r of resolved) {
                next.set(r.branchName, { branchName: r.branchName, versionId: r.versionId, color: r.color, normalizerModelId: r.normalizerModelId, hidden: r.hidden ?? false })
                for (const el of r.elements) merged.push({ ...el, _modelKey: r.branchName })
            }
            setCombinedModels(next)
            setFederatedElementData({ elements: merged })
            setChartModelFilters({})  // branch set may have changed — drop any stale per-chart overrides
            setCombineMode(true)
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('Combined model load failed:', err)
                setLoadError(`Failed to load combined models: ${err.message}`)
            }
        } finally {
            setCombiningLoading(false)
        }
    // ingestModelToNormalizer/fetchFlatElements close over activeServer/CONFIG
    // from this same render — listing activeServer here ensures this callback
    // is rebuilt (not served stale from a previous render) whenever the
    // active Speckle server/token changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedProject?.id, combinedModels, activeServer])

    const exitCombineMode = useCallback(() => {
        combineAbortRef.current?.abort()
        setCombineMode(false)
        setShowFederatedClash(false)
        setFederatedElementData(null)
        setChartModelFilters({})
    }, [])

    // Combined/federated view state (picks, tints, active mode) is scoped to
    // one project — CombineModelsPicker's candidate list and every ingest
    // call resolve against selectedProject.id, so an entry picked while
    // viewing a different project carries a commit id that belongs to that
    // OTHER project's stream. Left in place across a project switch, the
    // pre-seed effect above skips re-seeding (its "only seed once" guard
    // checks combinedModels.size, not project identity) and "Load combined
    // view" then sends that stale commit id paired with the NEW project's
    // stream id — ingest fails with "Commit ... not found in stream ..."
    // even though the commit is real, just in a different project. Reset on
    // every project switch; switching models/branches within the same
    // project intentionally leaves combinedModels alone (all its entries
    // still share one valid stream id in that case).
    useEffect(() => {
        exitCombineMode()
        setCombinedModels(new Map())
    }, [selectedProject?.id, exitCombineMode])

    // Stable array reference for SpeckleViewer's federatedModels prop — only
    // changes when the combined set's contents actually change, not on every
    // unrelated App.jsx re-render (avoids re-running the viewer's federated
    // load effect needlessly).
    const federatedModelsArray = useMemo(() => [...combinedModels.values()], [combinedModels])

    // Dashboard-wide default chart data pool: the single primary model normally,
    // but the merged federated set while combined — so charts actually reflect
    // what's federated into the viewer instead of always showing whichever
    // single model happened to be open before combining. Per-chart overrides
    // (see chartModelFilters + panelChartData below) narrow further to one
    // specific branch's elements.
    const combinedBaseElements = combineMode ? federatedElementData?.elements : null

    // Active element subset: viewer selection → Filter Builder → chart filters → all elements.
    // Used by StandaloneChartWidget to keep discovered/numeric fields in sync.
    const contextElements = useMemo(() => {
        const base = combinedBaseElements || fullData?.elements
        return narrowElementPool(base, { viewerSelectedIds, viewerFilteredIds, chartFilters })
    }, [viewerSelectedIds, viewerFilteredIds, chartFilters, fullData, combinedBaseElements])

    // Dynamic Chart Summary Selection
    const chartSummary = useMemo(() => {
        if (combinedBaseElements) {
            // No backend-precomputed summary exists for an ad-hoc merged set —
            // always derive it from the elements themselves.
            return summaryForPool(combinedBaseElements, { viewerSelectedIds, viewerFilteredIds, chartFilters })
        }
        return summaryForPool(fullData?.elements, { viewerSelectedIds, viewerFilteredIds, chartFilters, fallbackSummary: data?.summary })
    }, [viewerSelectedIds, viewerFilteredIds, chartFilters, fullData, data?.summary, combinedBaseElements])

    // Per-panel override lookup — returns the {summary, elements} pair a given
    // chart panel should render with. Only recomputes from scratch when that
    // panel actually has an explicit single-model override selected; otherwise
    // it just reuses the dashboard-wide chartSummary/contextElements above so
    // per-panel overrides don't cost anything for charts left on "combined".
    const panelChartData = useCallback((panelId) => {
        const overrideKey = chartModelFilters[panelId]
        if (!combineMode || !overrideKey || overrideKey === COMBINED_MODEL_KEY || !federatedElementData?.elements) {
            return { summary: chartSummary, elements: contextElements }
        }
        const base = federatedElementData.elements.filter(el => el._modelKey === overrideKey)
        return {
            summary: summaryForPool(base, { viewerSelectedIds, viewerFilteredIds, chartFilters }),
            elements: narrowElementPool(base, { viewerSelectedIds, viewerFilteredIds, chartFilters }),
        }
    }, [combineMode, chartModelFilters, federatedElementData, chartSummary, contextElements, viewerSelectedIds, viewerFilteredIds, chartFilters])

    const handleChangeChartModelFilter = useCallback((panelId, key) => {
        setChartModelFilters(prev => ({ ...prev, [panelId]: key === COMBINED_MODEL_KEY ? undefined : key }))
    }, [])

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
                    filteredElementIds={timelinePlaybackIds ? null : effectiveFilterIds}
                    diffResult={diffResult}
                    compareVersionId={compareVersionId}
                    onExitCompare={deactivateCompare}
                    timelinePlaybackIds={timelinePlaybackIds}
                    timelineSyncEnabled={timelineSyncEnabled}
                    onTimelineSync={handleTimelineSync}
                    bcfTopics={bcfTopics}
                    documentPins={documentPins}
                    darkMode={darkMode}
                    federatedMode={combineMode}
                    federatedModels={federatedModelsArray}
                    federatedFullData={federatedElementData}
                    onExitFederated={exitCombineMode}
                    onSetFederatedModelHidden={setCombinedModelHidden}
                />
                {playbackBarOpen && data?.normalizer_model_id && (
                    <div className="absolute bottom-3 left-3 right-3 z-20">
                        <Suspense fallback={null}>
                            <SchedulePlaybackView
                                normalizerModelId={data.normalizer_model_id}
                                normalizerUrl={CONFIG.normalizerUrl}
                                onPlaybackChange={handleSchedulePlaybackChange}
                                onClose={() => setPlaybackBarOpen(false)}
                            />
                        </Suspense>
                    </div>
                )}
            </div>
        </GridPanel>
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ), [activeServer.id, selectedProject?.id, data?.version_id, data?.normalizer_model_id,
        fullData, effectiveFilterIds, diffResult, compareVersionId,
        bcfTopics, documentPins, timelinePlaybackIds, timelineSyncEnabled, handleViewerSelection, handleTimelineSync, deactivateCompare, darkMode,
        combineMode, federatedModelsArray, federatedElementData, exitCombineMode, setCombinedModelHidden,
        playbackBarOpen, handleSchedulePlaybackChange])

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
            const panelData = panelChartData(panel.id)
            const chartData = panelData.summary?.[chartKey]
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
                    showLegend:   displayOptions.showLegend   ?? false,
                    showGridLines: displayOptions.showGridLines ?? true,
                    tickFontSize:   displayOptions.tickFontSize   ?? 11,
                    tickFontColor:  displayOptions.tickFontColor  ?? (darkMode ? '#e4e4e7' : '#000000'),
                    tickAngle:      displayOptions.tickAngle      ?? (displayOptions.orientation === 'v' ? -45 : 0),
                    valueFontSize:  displayOptions.valueFontSize  ?? 11,
                    valueFontColor: displayOptions.valueFontColor ?? (darkMode ? '#e4e4e7' : '#000000'),
                    labelFontSize:  displayOptions.labelFontSize  ?? 11,
                    labelFontColor: displayOptions.labelFontColor ?? (darkMode ? '#e4e4e7' : '#000000'),
                    ...(displayOptions.unit != null && { unit: displayOptions.unit }),
                    decimals:            displayOptions.decimals            ?? null,
                    thousandsSeparator:  displayOptions.thousandsSeparator  ?? true,
                    axisMin:             displayOptions.axisMin             ?? null,
                    axisMax:             displayOptions.axisMax             ?? null,
                    pieLabelName:        displayOptions.pieLabelName        ?? true,
                    pieLabelValue:       displayOptions.pieLabelValue       ?? true,
                    pieLabelPercent:     displayOptions.pieLabelPercent     ?? true,
                    pieLeaderLine:       displayOptions.pieLeaderLine       ?? true,
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
                    onHoverValue={handleChartHover}
                    onHoverEnd={handleChartHoverEnd}
                    fullDataReady={!!fullData}
                    darkMode={darkMode}
                    isColorSource={colorSourceKey === chartKey}
                    onToggleColorSource={handleToggleColorSource}
                    hasTypeToggle
                    federatedModels={combineMode ? federatedModelsArray : []}
                    modelFilterKey={chartModelFilters[panel.id] || COMBINED_MODEL_KEY}
                    onChangeModelFilter={key => handleChangeChartModelFilter(panel.id, key)}
                />
            )
        }

        const w = panel.widget
        if (!w) return null

        // Chart widget: standalone single chart with its own header — no GridPanel wrapper
        if (w.type === 'chart') {
            const panelData = panelChartData(w.id)
            return (
                <StandaloneChartWidget
                    widget={w}
                    onUpdateWidget={updates => handleUpdateWidget(w.id, updates)}
                    chartSummary={panelData.summary}
                    fullData={fullData}
                    contextElements={panelData.elements}
                    displayOptions={displayOptions}
                    fullDataReady={!!fullData}
                    highlightedField={highlightedField}
                    highlightedValue={highlightedValue}
                    onValueClick={handleChartValueClick}
                    onHoverValue={handleChartHover}
                    onHoverEnd={handleChartHoverEnd}
                    viewerSelectedElement={viewerSelectedElement}
                    darkMode={darkMode}
                    isColorSource={colorSourceKey === w.id}
                    onToggleColorSource={handleToggleColorSource}
                    federatedModels={combineMode ? federatedModelsArray : []}
                    modelFilterKey={chartModelFilters[w.id] || COMBINED_MODEL_KEY}
                    onChangeModelFilter={key => handleChangeChartModelFilter(w.id, key)}
                />
            )
        }

        const content = (() => {
            if (w.type === 'text') return <MarkdownWidget content={w.content} onUpdate={c => handleUpdateWidget(w.id, { content: c })} />
            if (w.type === 'table') return <ElementTable fullData={fullData} onElementClick={handleElementClick} viewerSelectedIds={viewerSelectedIds} onFilteredIdsChange={handleTableFilteredIds} chartFilters={chartFilters} filteredIds={viewerFilteredIds} />
            if (w.type === 'pivot') return <PivotTableWidget fullData={fullData} paramKeys={paramKeys} />
            if (w.type === 'validation') return <ValidationWidget widgetId={w.id} fullData={fullData} title={w.title} onUpdateTitle={t => handleUpdateWidget(w.id, { title: t })} isEditing={!validationResultsView.has(w.id)} onToggleEditing={() => handleToggleValidationView(w.id)} onFilterElements={ids => setViewerFilteredIds(ids)} onHighlightElements={ids => ids ? speckleViewerRef.current?.highlightObjects(ids) : speckleViewerRef.current?.clearHover()} darkMode={darkMode} />
            if (w.type === 'filter') return <FilterWidget widgetId={w.id} fullData={fullData} title={w.title} onUpdateTitle={t => handleUpdateWidget(w.id, { title: t })} onFilterElements={ids => setViewerFilteredIds(ids)} />
            if (w.type === 'quantities') return <QuantityWidget normalizerModelId={data?.normalizer_model_id} normalizerUrl={CONFIG.normalizerUrl} darkMode={darkMode} />
            if (w.type === 'video') return <VideoWidget url={w.url} onUpdateUrl={url => handleUpdateWidget(w.id, { url })} />
            if (w.type === 'bcf_stats') return <BcfStatsWidget topics={bcfTopics} darkMode={darkMode} displayOptions={displayOptions} />
            if (w.type === 'geo_map') return <GeoMapWidget normalizerModelId={data?.normalizer_model_id} normalizerUrl={CONFIG.normalizerUrl} />
            return null
        })()

        return (
            <GridPanel
                title={w.title || 'Panel'}
                icon={w.type === 'bcf_stats' ? <BcfLogoIcon className="w-4 h-4" /> : w.type === 'geo_map' ? <MapPin className="w-4 h-4" /> : undefined}
                headerActions={w.type === 'validation' ? (
                    <ValidationModeToggle isEditing={!validationResultsView.has(w.id)} onToggleEditing={() => handleToggleValidationView(w.id)} />
                ) : undefined}
            >
                {content}
            </GridPanel>
        )
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewerPanelContent, panelChartData, highlightedField, highlightedValue, viewerSelectedElement,
        fullData, handleChartValueClick, handleChartHover, handleChartHoverEnd,
        handleElementClick, handleUpdateWidget, handleRemoveWidget,
        data, searchFilteredIds, viewerSelectedIds, chartFilters, paramKeys,
        visibleChartPanels, handleToggleChartPanel, darkMode, bcfTopics, effectiveFilterIds,
        colorSourceKey, handleToggleColorSource,
        combineMode, federatedModelsArray, chartModelFilters, handleChangeChartModelFilter,
        validationResultsView, handleToggleValidationView])

    const [layoutCopied, setLayoutCopied] = useState(false)  // false | true | 'error'

    const [showBcfBoard, setShowBcfBoard] = useState(false)
    const [showIdsCheck, setShowIdsCheck] = useState(false)
    const [showClashCheck, setShowClashCheck] = useState(false)
    const [showDocuments, setShowDocuments] = useState(false)
    // The drawing (bim_documents row) currently being aligned to the 3D
    // model, or null. Not a boolean like the other show* flags — the panel
    // needs to know *which* drawing, and closes Documents to open (Documents
    // is a full-screen overlay; alignment needs the live 3D viewer visible
    // underneath its own floating panel for 3D point picking).
    const [alignmentDoc, setAlignmentDoc] = useState(null)
    // Presence (not a separate boolean) drives whether ElementConnectivityPanel
    // is shown — { elementId, name } for whichever element opened it.
    const [connectivityTarget, setConnectivityTarget] = useState(null)

    // Distinct IFC classes in this model, for ClashCheckPanel's group dropdowns.
    // Memoized so the array reference is stable across unrelated re-renders
    // while the panel is open (it's a dependency of an effect in there).
    const clashIfcClasses = useMemo(
        () => Object.keys(data?.summary?.by_ifc_type || {}).sort(),
        [data?.summary?.by_ifc_type]
    )

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

    // Sweeps all dashboard-* keys + speckle-custom-servers from localStorage into
    // the same snapshot shape used by both /share links and the per-project default.
    const buildDashboardPayload = useCallback(() => {
        const ls = {}
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (!key) continue
            if (key.startsWith('dashboard-') || key === 'speckle-custom-servers') {
                try { ls[key] = JSON.parse(localStorage.getItem(key)) }
                catch { ls[key] = localStorage.getItem(key) }
            }
        }
        return {
            v: 1,
            server: activeServer,
            projectId: selectedProject?.id ?? null,
            modelName: selectedModel?.name ?? null,
            versionId: selectedVersion?.id ?? null,
            ui: { darkMode, showViewer, showTimeline },
            ls,
        }
    }, [activeServer, selectedProject, selectedModel, selectedVersion, darkMode, showViewer, showTimeline])

    const shareLayout = useCallback(() => {
        fetch(`${CONFIG.normalizerUrl}/share`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: buildDashboardPayload() }),
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
    }, [buildDashboardPayload])

    // Persists the current dashboard as this project's default — what a
    // first-time visitor (no local dashboard-* state yet) will load instead
    // of the bare grid defaults.
    const [defaultSaved, setDefaultSaved] = useState(false)  // false | true | 'error'
    const saveLayoutAsDefault = useCallback(() => {
        if (!selectedProject?.id) return
        fetch(`${CONFIG.normalizerUrl}/dashboard-layout/${selectedProject.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: buildDashboardPayload() }),
        })
            .then(r => {
                if (!r.ok) throw new Error('save failed')
                setDefaultSaved(true)
                setTimeout(() => setDefaultSaved(false), 2000)
            })
            .catch(() => {
                setDefaultSaved('error')
                setTimeout(() => setDefaultSaved(false), 3000)
            })
    }, [buildDashboardPayload, selectedProject])

    // App()'s gate mounts this component either post-login (authUser always
    // present) or for an anonymous /shareXXX visit (authUser null — see
    // App()) — so, unlike the old post-login-only assumption, authUser can
    // genuinely be absent here. `anonymous` gates BCF/Documents (both 401
    // server-side for a logged-out visitor regardless of this flag) and,
    // together with `readOnly`, the layout-editing/share-admin/chat UI.
    const { user: authUser, logout: authLogout } = useAuth()
    const anonymous = !authUser

    return (
        <div className={`min-h-screen ${darkMode ? 'dark' : 'light'}`}>
            <div className={`min-h-screen transition-colors duration-300 ${darkMode ? 'bg-zinc-950 text-zinc-50' : 'bg-gradient-to-br from-slate-100 to-slate-200 text-zinc-900'}`}>
                {/* Header */}
                {/* z-[150]: must outrank any individual panel's internal z-index scheme
                    (.panel-header is 110, react-grid-layout resize handles are 115) so the
                    page header stays on top regardless of scroll position — those values are
                    only meant to compete locally within one panel, but .panel-thin doesn't
                    establish its own stacking context, so they'd otherwise leak out and beat
                    a plain z-50 header once panels actually scroll past it (mobile's sticky
                    header exposed this; it was likely latent on desktop too). */}
                <header className={`glass sticky top-0 z-[150] transition-colors duration-300 ${
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
                                <img src="/converge-logo2.avif" alt="Converge" className="w-9 h-9 shrink-0 object-contain" />
                                <div className="hidden sm:block">
                                    <h1 className="text-2xl font-bold gradient-text leading-none">Converge</h1>
                                </div>
                            </motion.div>

                            {/* Mobile (< sm): compact model-name button (opens full-screen
                                picker sheet) + a "more" button (opens the actions drawer) —
                                Row 1's breadcrumb/search/action-icon group below doesn't fit
                                a ~375px screen without overlapping. */}
                            <div className="flex sm:hidden items-center gap-2 flex-1 min-w-0">
                                <button
                                    onClick={() => setShowMobileNav(true)}
                                    className="flex-1 min-w-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg glass-card text-left"
                                >
                                    <span className="flex-1 min-w-0 truncate text-sm font-medium text-[var(--speckle-foreground)]">
                                        {selectedModel?.name || selectedProject?.name || (loadingProjects ? 'Loading…' : 'Select model')}
                                    </span>
                                    <ChevronDown className="w-3.5 h-3.5 shrink-0 text-zinc-500" />
                                </button>
                                <button
                                    onClick={() => setShowMobileActions(true)}
                                    className="glass-card icon-btn hover:bg-white/10 shrink-0"
                                    title="More actions"
                                >
                                    <MoreHorizontal className="w-5 h-5" />
                                </button>
                            </div>

                            {/* Desktop (sm+): full breadcrumb + search + action icons, unchanged */}
                            <div className="hidden sm:flex items-center gap-3 flex-1 min-w-0">
                            <div className="w-px h-6 bg-white/10 shrink-0" />

                            {/* Breadcrumb navigation — locked under readOnly (pointer-events-none
                                rather than not rendering it) so the shared project/model/version
                                stays visible as context, just not switchable. BreadcrumbSelector
                                itself has no disabled prop, so this is done at the call site. */}
                            <div className={readOnly ? 'pointer-events-none opacity-60' : ''} title={readOnly ? 'Locked in read-only share view' : undefined}>
                            <BreadcrumbSelector
                                allServers={allServers}
                                activeServer={activeServer}
                                onSwitchServer={switchServer}
                                customServers={customServers}
                                onAddServer={addCustomServer}
                                onRemoveServer={removeCustomServer}
                                normalizerUrl={CONFIG.normalizerUrl}
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
                            </div>

                            <SemanticSearchStatus normalizerUrl={CONFIG.normalizerUrl} modelId={data?.normalizer_model_id} />

                            {data?.project_id && data?.model_id && (
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    onClick={() => window.open(
                                        `${activeServer.url}/projects/${data.project_id}/models/${data.model_id}${data.version_id ? `@${data.version_id}` : ''}`,
                                        '_blank', 'noopener,noreferrer'
                                    )}
                                    className="glass-card icon-btn hover:bg-white/10 shrink-0"
                                    title="Open in Speckle"
                                >
                                    <ExternalLink className="w-5 h-5" />
                                </motion.button>
                            )}

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
                                        className="w-full h-9 glass pl-9 pr-8 rounded-lg text-sm bg-zinc-900/20 focus:bg-zinc-900/40 focus:ring-1 focus:ring-primary/50 transition-all placeholder:text-zinc-600"
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
                                    className={`glass-card icon-btn hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed ${reIngesting ? 'text-primary' : ''}`}
                                    title="Force re-ingest model"
                                >
                                    {reIngesting ? <Loader2 className="w-6 h-6 animate-spin" /> : <RotateCcw className="w-6 h-6" />}
                                </motion.button>
                                <IfcExportMenu
                                    disabled={!data}
                                    exportingIfc={exportingIfc}
                                    exportingIfcx={exportingIfcx}
                                    isIfcSource={isIfcSource}
                                    onExportIfc4x3={exportIfc}
                                    onExportIfcx={exportIfcx}
                                />
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    onClick={() => setSchedulePanelOpen(v => !v)}
                                    disabled={!data?.normalizer_model_id}
                                    className={`glass-card icon-btn hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed ${schedulePanelOpen ? 'text-amber-400 bg-amber-400/10' : ''}`}
                                    title="4D Planner (Gantt)"
                                >
                                    <CalendarClock className="w-6 h-6" />
                                </motion.button>
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    onClick={() => setPlaybackBarOpen(v => !v)}
                                    disabled={!data?.normalizer_model_id}
                                    className={`glass-card icon-btn hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed ${playbackBarOpen ? 'text-amber-400 bg-amber-400/10' : ''}`}
                                    title="4D Build-up Playback"
                                >
                                    <Play className="w-6 h-6" />
                                </motion.button>
                                {/* BCF requires a login server-side (bcf-server's require_bcf_auth) — hidden
                                    entirely for anonymous share visitors rather than left to 401. */}
                                {!anonymous && (
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    onClick={() => setShowBcfBoard(true)}
                                    disabled={!data?.normalizer_model_id}
                                    className="glass-card icon-btn hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                    title="BCF Issue Board (Kanban)"
                                >
                                    <BcfLogoIcon className="w-6 h-6" />
                                </motion.button>
                                )}
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    onClick={() => setShowIdsCheck(true)}
                                    disabled={!data?.normalizer_model_id}
                                    className="glass-card icon-btn hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                    title="IDS Check"
                                >
                                    <IdsLogoIcon className="w-6 h-6" />
                                </motion.button>
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    onClick={() => setShowClashCheck(true)}
                                    disabled={!data?.normalizer_model_id}
                                    className="glass-card icon-btn hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                    title="Clash Detection"
                                >
                                    <ClashLogoIcon className="w-7 h-7" />
                                </motion.button>
                                <CombineModelsPicker
                                    models={models}
                                    primaryBranchName={data?.summary?.branch_name}
                                    combinedModels={combinedModels}
                                    onToggleModel={toggleCombinedModel}
                                    onLoad={loadCombinedModels}
                                    onExit={exitCombineMode}
                                    loading={combiningLoading}
                                    active={combineMode}
                                />
                                {combineMode && (
                                    <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                        onClick={() => setShowFederatedClash(true)}
                                        disabled={combinedModels.size < 2}
                                        className="glass-card icon-btn hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-amber-400"
                                        title="Combined Clash Detection"
                                    >
                                        <ClashLogoIcon className="w-7 h-7" />
                                    </motion.button>
                                )}
                                {/* Documents/notifications both require a login server-side — hidden
                                    entirely for anonymous share visitors rather than left to 401. */}
                                {!anonymous && (
                                <NotificationBell normalizerUrl={CONFIG.normalizerUrl} />
                                )}
                                {!anonymous && (
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    onClick={() => setShowDocuments(true)}
                                    disabled={!data?.project_id}
                                    className="glass-card icon-btn hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                    title="Documents"
                                >
                                    <FileText className="w-6 h-6" />
                                </motion.button>
                                )}
                                {/* Share/save-as-default/share-admin: available to anonymous full-mode
                                    visitors (parity with a logged-in visitor's share-link experience),
                                    hidden under readOnly since that mode locks out layout editing. */}
                                {!readOnly && (
                                <>
                                <motion.button whileHover={{ scale: layoutCopied ? 1 : 1.05 }} whileTap={{ scale: layoutCopied ? 1 : 0.95 }}
                                    onClick={shareLayout}
                                    className={`glass-card icon-btn hover:bg-white/10 transition-colors ${layoutCopied === true ? 'text-emerald-400' : layoutCopied === 'error' ? 'text-red-400' : ''}`}
                                    title={layoutCopied === 'error' ? 'Share failed — is the backend running?' : 'Copy share link'}
                                >
                                    {layoutCopied === true ? <Check className="w-6 h-6" /> : layoutCopied === 'error' ? <AlertCircle className="w-6 h-6" /> : <Share2 className="w-6 h-6" />}
                                </motion.button>
                                <motion.button whileHover={{ scale: defaultSaved ? 1 : 1.05 }} whileTap={{ scale: defaultSaved ? 1 : 0.95 }}
                                    onClick={saveLayoutAsDefault}
                                    disabled={!selectedProject}
                                    className={`glass-card icon-btn hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${defaultSaved === true ? 'text-emerald-400' : defaultSaved === 'error' ? 'text-red-400' : ''}`}
                                    title={defaultSaved === 'error' ? 'Save failed — is the backend running?' : 'Save as project default (what first-time visitors see)'}
                                >
                                    {defaultSaved === true ? <Check className="w-6 h-6" /> : defaultSaved === 'error' ? <AlertCircle className="w-6 h-6" /> : <Save className="w-6 h-6" />}
                                </motion.button>
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    onClick={openShareAdmin}
                                    className="glass-card icon-btn hover:bg-white/10 transition-colors"
                                    title="Manage share links"
                                >
                                    <List className="w-6 h-6" />
                                </motion.button>
                                </>
                                )}
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    onClick={() => setDarkMode(!darkMode)}
                                    className="glass-card icon-btn hover:bg-white/10"
                                    title={darkMode ? 'Light mode' : 'Dark mode'}
                                >
                                    {darkMode ? <Sun className="w-6 h-6" /> : <Moon className="w-6 h-6" />}
                                </motion.button>
                                {!anonymous && (
                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                    onClick={authLogout}
                                    className="glass-card icon-btn hover:bg-white/10"
                                    title={authUser ? `Sign out (${authUser.name})` : 'Sign out'}
                                >
                                    <LogOut className="w-6 h-6" />
                                </motion.button>
                                )}
                            </div>
                            </div>
                        </div>
                    </div>

                    {/* Ingest progress bar */}
                    <IngestProgress phase={ingestPhase} />

                    {/* Row 2 — Metrics strip + active filters share one row so toggling
                        filters changes its content, not the header's height, and the
                        viewer below never shifts up/down. */}
                    {data && (
                        <div className="hidden md:flex border-t border-white/5 px-4 lg:px-6 py-1.5 items-center gap-4 flex-wrap">
                            <AdaptiveMetrics data={data} strip />
                            <AnimatePresence>
                                {Object.keys(chartFilters).length > 0 && (
                                    <motion.div
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.2 }}
                                        className="flex items-center min-w-0 ml-auto"
                                    >
                                        <ActiveFilters
                                            chartFilters={chartFilters}
                                            onRemoveFilter={handleRemoveChartFilter}
                                            onClearAll={handleClearAllChartFilters}
                                        />
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    )}

                    {/* Mobile (< md): metrics strip collapsed behind a tap-to-expand
                        accordion instead of the desktop row above (which is fully
                        hidden via `hidden md:flex`) — keeps the stats reachable
                        without permanently spending vertical space on a small screen. */}
                    {data && (
                        <div className="md:hidden border-t border-white/5">
                            <button
                                onClick={() => setShowMobileMetrics(v => !v)}
                                className="w-full flex items-center justify-between px-4 py-2 text-xs text-[var(--speckle-foreground-3)]"
                            >
                                <span className="font-medium uppercase tracking-wider">Stats</span>
                                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showMobileMetrics ? 'rotate-180' : ''}`} />
                            </button>
                            <AnimatePresence initial={false}>
                                {showMobileMetrics && (
                                    <motion.div
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: 'auto', opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={{ duration: 0.2 }}
                                        className="overflow-hidden"
                                    >
                                        <div className="px-4 pb-3">
                                            {/* `horizontal` (wrapping cards), not `strip` (single-line,
                                                no-wrap labels) — strip overflows a narrow column. */}
                                            <AdaptiveMetrics data={data} horizontal />
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    )}
                </header>

                {/* Mobile model-picker sheet — opened from Row 1's compact model-name
                    button; reuses BreadcrumbSelector in `vertical` mode so the same
                    Server/Project/Model/Version selection logic doesn't need duplicating.
                    Portaled to document.body: react-grid-layout's CSS-transformed grid
                    items create their own stacking contexts, which trapped this sheet's
                    z-index below the viewer's floating toolbar despite a higher value. */}
                {createPortal(
                <AnimatePresence>
                    {showMobileNav && (
                        <motion.div
                            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="fixed inset-0 z-[300] bg-black/60 backdrop-blur-sm sm:hidden"
                            onClick={() => setShowMobileNav(false)}
                        >
                            <motion.div
                                initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                                transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                                className="absolute bottom-0 left-0 right-0 max-h-[80vh] overflow-y-auto glass-card rounded-t-2xl p-4"
                                onClick={e => e.stopPropagation()}
                            >
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-sm font-semibold text-[var(--speckle-foreground)]">Select model</h3>
                                    <button onClick={() => setShowMobileNav(false)} className="text-zinc-500 hover:text-zinc-300">
                                        <X className="w-5 h-5" />
                                    </button>
                                </div>
                                <div className={readOnly ? 'pointer-events-none opacity-60' : ''}>
                                <BreadcrumbSelector
                                    vertical
                                    allServers={allServers}
                                    activeServer={activeServer}
                                    onSwitchServer={switchServer}
                                    customServers={customServers}
                                    onAddServer={addCustomServer}
                                    onRemoveServer={removeCustomServer}
                                    normalizerUrl={CONFIG.normalizerUrl}
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
                                </div>
                            </motion.div>
                        </motion.div>
                    )}
                </AnimatePresence>,
                document.body
                )}

                {/* Mobile actions drawer — the same handlers as Row 1's desktop icon
                    row, laid out as touch-friendly labeled tiles instead of a cramped
                    icon strip. Also portaled — see model-picker sheet's comment above. */}
                {createPortal(
                <AnimatePresence>
                    {showMobileActions && (
                        <motion.div
                            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="fixed inset-0 z-[300] bg-black/60 backdrop-blur-sm sm:hidden"
                            onClick={() => setShowMobileActions(false)}
                        >
                            <motion.div
                                initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                                transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                                className="absolute bottom-0 left-0 right-0 max-h-[80vh] overflow-y-auto glass-card rounded-t-2xl p-4"
                                onClick={e => e.stopPropagation()}
                            >
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-sm font-semibold text-[var(--speckle-foreground)]">Actions</h3>
                                    <button onClick={() => setShowMobileActions(false)} className="text-zinc-500 hover:text-zinc-300">
                                        <X className="w-5 h-5" />
                                    </button>
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                    {data && versions.length >= 1 && (
                                        <div className="flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10">
                                            {/* Compare needs its own dropdown to pick a target version
                                                — reuse the real component instead of a plain button. */}
                                            <CompareVersionToggle
                                                versions={versions}
                                                compareVersionId={compareVersionId}
                                                compareLoading={compareLoading}
                                                diffResult={diffResult}
                                                currentVersionId={data?.version_id}
                                                onCompare={(id) => { activateCompareV2(id); setShowMobileActions(false) }}
                                                onExit={() => { deactivateCompare(); setShowMobileActions(false) }}
                                                disabled={!data}
                                            />
                                            <span className="text-[10px] text-[var(--speckle-foreground-3)]">Compare</span>
                                        </div>
                                    )}
                                    <button
                                        onClick={() => { reIngestModel(); setShowMobileActions(false) }}
                                        disabled={!data || reIngesting}
                                        className={`flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed ${reIngesting ? 'text-primary' : ''}`}
                                    >
                                        {reIngesting ? <Loader2 className="w-6 h-6 animate-spin" /> : <RotateCcw className="w-6 h-6" />}
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">Re-ingest</span>
                                    </button>
                                    <button
                                        onClick={() => { exportIfc(); setShowMobileActions(false) }}
                                        disabled={!data || exportingIfc}
                                        className="flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {exportingIfc ? <Loader2 className="w-6 h-6 animate-spin" /> : <IfcLogoIcon className="w-6 h-6" />}
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">IFC export</span>
                                    </button>
                                    <button
                                        onClick={() => { exportIfcx(); setShowMobileActions(false) }}
                                        disabled={!data || exportingIfcx}
                                        className="flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {exportingIfcx ? <Loader2 className="w-6 h-6 animate-spin" /> : <IfcLogoIcon className="w-6 h-6" />}
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">IFC5 (Alpha)</span>
                                    </button>
                                    <button
                                        onClick={() => { setSchedulePanelOpen(v => !v); setShowMobileActions(false) }}
                                        disabled={!data?.normalizer_model_id}
                                        className={`flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed ${schedulePanelOpen ? 'text-amber-400 bg-amber-400/10' : ''}`}
                                    >
                                        <CalendarClock className="w-6 h-6" />
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">4D Planner</span>
                                    </button>
                                    <button
                                        onClick={() => { setPlaybackBarOpen(v => !v); setShowMobileActions(false) }}
                                        disabled={!data?.normalizer_model_id}
                                        className={`flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed ${playbackBarOpen ? 'text-amber-400 bg-amber-400/10' : ''}`}
                                    >
                                        <Play className="w-6 h-6" />
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">Playback</span>
                                    </button>
                                    {!anonymous && (
                                    <button
                                        onClick={() => { setShowBcfBoard(true); setShowMobileActions(false) }}
                                        disabled={!data?.normalizer_model_id}
                                        className="flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        <BcfLogoIcon className="w-6 h-6" />
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">BCF</span>
                                    </button>
                                    )}
                                    <button
                                        onClick={() => { setShowIdsCheck(true); setShowMobileActions(false) }}
                                        disabled={!data?.normalizer_model_id}
                                        className="flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        <IdsLogoIcon className="w-6 h-6" />
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">IDS</span>
                                    </button>
                                    <button
                                        onClick={() => { setShowClashCheck(true); setShowMobileActions(false) }}
                                        disabled={!data?.normalizer_model_id}
                                        className="flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        <ClashLogoIcon className="w-7 h-7" />
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">Clash</span>
                                    </button>
                                    {!anonymous && (
                                    <button
                                        onClick={() => { setShowDocuments(true); setShowMobileActions(false) }}
                                        disabled={!data?.project_id}
                                        className="flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        <FileText className="w-6 h-6" />
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">Docs</span>
                                    </button>
                                    )}
                                    {!readOnly && (
                                    <>
                                    <button
                                        onClick={() => { shareLayout(); setShowMobileActions(false) }}
                                        className="flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10"
                                    >
                                        <Share2 className="w-6 h-6" />
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">Share link</span>
                                    </button>
                                    <button
                                        onClick={() => { saveLayoutAsDefault(); setShowMobileActions(false) }}
                                        disabled={!selectedProject}
                                        className="flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        <Save className="w-6 h-6" />
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">Save default</span>
                                    </button>
                                    <button
                                        onClick={() => { openShareAdmin(); setShowMobileActions(false) }}
                                        className="flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10"
                                    >
                                        <List className="w-6 h-6" />
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">Manage links</span>
                                    </button>
                                    </>
                                    )}
                                    <button
                                        onClick={() => { setDarkMode(!darkMode); setShowMobileActions(false) }}
                                        className="flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10"
                                    >
                                        {darkMode ? <Sun className="w-6 h-6" /> : <Moon className="w-6 h-6" />}
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">Theme</span>
                                    </button>
                                    {!anonymous && (
                                    <button
                                        onClick={() => { authLogout(); setShowMobileActions(false) }}
                                        className="flex flex-col items-center gap-1.5 py-3 rounded-xl glass-card hover:bg-white/10"
                                    >
                                        <LogOut className="w-6 h-6" />
                                        <span className="text-[10px] text-[var(--speckle-foreground-3)]">Sign out</span>
                                    </button>
                                    )}
                                </div>
                            </motion.div>
                        </motion.div>
                    )}
                </AnimatePresence>,
                document.body
                )}

                {/* Main Content */}
                {/* px-2 below (sm+: px-4/px-6) — GridDashboard's mobile layout adds its
                    own small vertical padding (p-2) but relies on this for its horizontal
                    gutter, so the two don't stack into an oversized ~48px-per-side inset
                    that shrank every mobile dashboard card well below the actual device
                    width. */}
                <main className="w-full max-w-[2400px] mx-auto px-2 sm:px-4 lg:px-6 py-2">
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
                            <img src="/converge-logo2-rotating.webp" alt="" className="w-24 h-24" />
                            <h2 className="text-xl font-semibold text-zinc-300">Opening BIM Model from your Speckle Server</h2>
                        </motion.div>
                    ) : loading ? (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="flex flex-col items-center justify-center h-96 gap-4 text-center"
                        >
                            <img src="/converge-logo2-rotating.webp" alt="" className="w-24 h-24" />
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
                            darkMode={darkMode}
                            readOnly={readOnly}
                            onClosePanel={readOnly ? undefined : handleClosePanel}
                        />
                        </ErrorBoundary>
                        </>
                    )}
                </main>

                {/* Floating action button for adding widgets — hidden under readOnly,
                    which locks out layout editing entirely. */}
                {!readOnly && (
                <WidgetFAB
                    onAddWidget={handleAddWidget}
                    disabled={!data}
                    availableCharts={data?.summary ? discoverChartFields(data.summary) : []}
                    visibleChartPanels={visibleChartPanels}
                    onToggleChart={handleToggleChartPanel}
                />
                )}

                {/* Publish current filter / selection as a new Speckle version */}
                <PublishSelectionButton
                    normalizerUrl={CONFIG.normalizerUrl}
                    modelId={data?.normalizer_model_id}
                    speckleIds={effectiveFilterIds?.length > 0 ? effectiveFilterIds : viewerSelectedIds}
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
                            normalizerUrl={CONFIG.normalizerUrl}
                            streamId={data?.project_id}
                            onDocumentLinksChanged={refreshDocumentPins}
                            documentLinksVersion={documentLinksVersion}
                            onOpenConnectivity={(el) => setConnectivityTarget({ elementId: el.element_id, name: el.name })}
                            onIsolate={(el) => speckleViewerRef.current?.setFilter(el?.id ? [el.id] : null)}
                            // Documents requires a login server-side (every route in
                            // routers/documents.py needs require_login at minimum) — skip
                            // rendering the section entirely for anonymous visitors rather
                            // than let it 401.
                            hideDocuments={anonymous}
                        />
                    )}
                </AnimatePresence>

                {/* BCF requires a login server-side (bcf-server's require_bcf_auth) —
                    hidden entirely for anonymous share visitors rather than left to 401. */}
                {!anonymous && (
                <BcfTopicPanel
                    projectId={data?.normalizer_model_id}
                    viewerRef={speckleViewerRef}
                    topics={bcfTopics}
                    fullData={fullData}
                    streamId={data?.project_id}
                    onTopicsChange={setBcfTopics}
                    onRequestSync={triggerBcfSync}
                    serverUrl={activeServer.url}
                    serverToken={activeServer.token}
                    autoOpenTopicGuid={pendingBcfTopicGuid}
                    onAutoOpenHandled={clearPendingBcfTopicGuid}
                />
                )}

                <AnimatePresence>
                    {showBcfBoard && (
                        <BcfKanbanBoard
                            projectId={data?.normalizer_model_id}
                            viewerRef={speckleViewerRef}
                            topics={bcfTopics}
                            onTopicsChange={setBcfTopics}
                            onClose={() => setShowBcfBoard(false)}
                        />
                    )}
                </AnimatePresence>

                <AnimatePresence>
                    {showIdsCheck && (
                        <IdsCheckPanel
                            projectId={data?.normalizer_model_id}
                            normalizerUrl={CONFIG.normalizerUrl}
                            viewerRef={speckleViewerRef}
                            topics={bcfTopics}
                            onTopicsChange={setBcfTopics}
                            onRequestSync={triggerBcfSync}
                            serverUrl={activeServer.url}
                            serverToken={activeServer.token}
                            onClose={() => setShowIdsCheck(false)}
                        />
                    )}
                </AnimatePresence>

                <AnimatePresence>
                    {showClashCheck && (
                        <Suspense fallback={null}>
                            <ClashCheckPanel
                                projectId={data?.normalizer_model_id}
                                streamId={data?.project_id}
                                normalizerUrl={CONFIG.normalizerUrl}
                                viewerRef={speckleViewerRef}
                                topics={bcfTopics}
                                onTopicsChange={setBcfTopics}
                                onRequestSync={triggerBcfSync}
                                serverUrl={activeServer.url}
                                serverToken={activeServer.token}
                                ifcClasses={clashIfcClasses}
                                onClose={() => setShowClashCheck(false)}
                            />
                        </Suspense>
                    )}
                </AnimatePresence>

                <AnimatePresence>
                    {connectivityTarget && (
                        <ElementConnectivityPanel
                            normalizerUrl={CONFIG.normalizerUrl}
                            elementId={connectivityTarget.elementId}
                            elementName={connectivityTarget.name}
                            viewerRef={speckleViewerRef}
                            onClose={() => setConnectivityTarget(null)}
                        />
                    )}
                </AnimatePresence>

                <AnimatePresence>
                    {showFederatedClash && (
                        <Suspense fallback={null}>
                            <FederatedClashPanel
                                projectId={data?.normalizer_model_id}
                                combinedModels={combinedModels}
                                normalizerUrl={CONFIG.normalizerUrl}
                                viewerRef={speckleViewerRef}
                                topics={bcfTopics}
                                onTopicsChange={setBcfTopics}
                                onRequestSync={triggerBcfSync}
                                serverUrl={activeServer.url}
                                serverToken={activeServer.token}
                                onClose={() => setShowFederatedClash(false)}
                            />
                        </Suspense>
                    )}
                </AnimatePresence>

                <AnimatePresence>
                    {showDocuments && (
                        <ErrorBoundary>
                        <DocumentsPanel
                            streamId={data?.project_id}
                            normalizerUrl={CONFIG.normalizerUrl}
                            serverUrl={activeServer.url}
                            serverToken={activeServer.token}
                            activeModelId={data?.normalizer_model_id}
                            viewerRef={speckleViewerRef}
                            onClose={() => setShowDocuments(false)}
                            onDocumentsChanged={refreshDocumentPins}
                            onLoadModel={(branchName, commitId) => {
                                setShowDocuments(false)
                                loadModelData(data?.project_id, branchName, commitId)
                            }}
                            onAlignDrawing={(doc) => {
                                setShowDocuments(false)
                                setAlignmentDoc(doc)
                            }}
                        />
                        </ErrorBoundary>
                    )}
                </AnimatePresence>

                <AnimatePresence>
                    {alignmentDoc && (
                        <ErrorBoundary>
                        <Suspense fallback={null}>
                            <AlignmentPanel
                                doc={alignmentDoc}
                                streamId={data?.project_id}
                                normalizerUrl={CONFIG.normalizerUrl}
                                modelId={data?.normalizer_model_id}
                                viewerRef={speckleViewerRef}
                                onClose={() => setAlignmentDoc(null)}
                                onSaved={() => { setAlignmentDoc(null); refreshDocumentPins() }}
                            />
                        </Suspense>
                        </ErrorBoundary>
                    )}
                </AnimatePresence>

                <AnimatePresence>
                    {schedulePanelOpen && (
                        <SchedulePanel
                            normalizerUrl={CONFIG.normalizerUrl}
                            normalizerModelId={data?.normalizer_model_id}
                            onFilterElements={ids => setViewerFilteredIds(ids)}
                            viewerSelectedIds={effectiveFilterIds?.length > 0 ? effectiveFilterIds : viewerSelectedIds}
                            onClose={() => setSchedulePanelOpen(false)}
                            // adaptNormalizerSummary (line ~252) renames the backend's
                            // by_storey to by_level and reduces each entry to a plain count.
                            storeyCounts={data?.summary?.by_level}
                        />
                    )}
                </AnimatePresence>

                {/* Chat itself needs no login (chat.py has no auth dependency) so it works
                    for anonymous full-mode visitors — hidden under readOnly for that mode's
                    "locked, view-only" branding rather than a real security requirement. */}
                {!readOnly && (
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
                        selectedElement: viewerSelectedElement ? {
                            name:      viewerSelectedElement.name || null,
                            speckleId: viewerSelectedElement.id || viewerSelectedElement.speckle_id || null,
                            category:  viewerSelectedElement.category || null,
                        } : null,
                    } : null}
                />
                )}

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

// Actual auth gate. Dashboard is only ever mounted once `user` is confirmed
// present OR the visitor arrived via a /shareXXX link (see _shareId above)
// and VITE_SHARE_LINK_MODE allows anonymous access — so none of its other
// data-fetching effects can fire for a plain logged-out visit (the previous
// approach called useAuth() *inside* Dashboard and branched on the result
// after all of Dashboard's own hooks — including its fetch effects — had
// already run on mount). Keying Dashboard on the user's guid (or a fixed key
// for anonymous share visits) also forces a full unmount/remount across a
// login/logout/login cycle, so a new session never inherits the previous
// user's already-loaded state.
function App() {
    const { user: authUser, loading: authLoading } = useAuth()
    const [resetToken, setResetToken] = useState(_resetTokenSeed)

    if (resetToken) {
        return (
            <ResetPasswordScreen
                token={resetToken}
                onDone={() => {
                    const cleanUrl = new URL(window.location.href)
                    cleanUrl.searchParams.delete('resetToken')
                    window.history.replaceState({}, '', cleanUrl)
                    setResetToken(null)
                }}
            />
        )
    }

    if (authLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-zinc-950">
                <Loader2 className="w-6 h-6 text-zinc-500 animate-spin" />
            </div>
        )
    }
    if (!authUser) {
        // Anonymous visitor on a share link: let them through instead of the
        // sign-in wall, per VITE_SHARE_LINK_MODE. BCF and Documents stay
        // blocked regardless of mode — those routers require a login
        // server-side (bim-normalizer/routers/documents.py,
        // bcf-server's require_bcf_auth), independent of this client gate.
        if (_shareId) {
            return <Dashboard key="anon-share" readOnly={CONFIG.shareLinkMode === 'readonly'} />
        }
        return <LandingPage />
    }
    return <Dashboard key={authUser.guid} />
}

export default App
