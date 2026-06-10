import { useEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquare, X } from 'lucide-react'
import {
    Viewer,
    DefaultViewerParams,
    SpeckleLoader,
    LoaderEvent,
    HybridCameraController,
    SelectionExtension,
    FilteringExtension,
    ViewerEvent,
    SectionTool,
    SectionOutlines,
    DiffExtension,
    VisualDiffMode,
    ViewModes,
    ViewMode,
    ExplodeExtension,
    MeasurementsExtension,
    MeasurementEvent,
} from '@speckle/viewer'
import { AnimatePresence } from 'framer-motion'
import ViewerToolbar from './ViewerToolbar'
import { DiffBar } from './DiffBar'
import { TimelinePlayer } from './TimelinePlayer'

const MeasurementType = { PERPENDICULAR: 0, POINTTOPOINT: 1, AREA: 2, POINT: 3 }
const DEFAULT_LIGHT = { enabled: true, castShadow: false, elevation: 1.33, azimuth: 0.75 }

/**
 * Modern SpeckleViewer component using latest Speckle Viewer API
 * Handles 3D model loading, viewing, diffing, timeline, and comments overlay
 */
const SpeckleViewer = forwardRef(function SpeckleViewer({
    projectId,
    versionId,
    config,
    fullData,
    filteredElementIds,
    onReady,
    onElementClick,
    onSelectionChange,
    diffResult,
    compareVersionId,
    onExitCompare,
    showTimeline = false,
    normalizerModelId = null,
    onCloseTimeline,
    onTimelineSync,
    comments = [],
}, ref) {
    // Refs for viewer instance and container
    const containerRef = useRef(null)
    const viewerRef = useRef(null)
    // rootRef tracks the SpeckleViewer outer div so the toolbar portal can be
    // positioned with fixed coordinates that match the viewer's on-screen location.
    const rootRef = useRef(null)
    const [toolbarRect, setToolbarRect] = useState(null)
    const initializingRef = useRef(false)
    // Tracks the objectId that initializeViewer is currently (or last) loading.
    // Used to detect stale retries when the user switches versions rapidly.
    const activeObjectIdRef = useRef(null)
    // Tracks the Speckle ID of the most-recently selected scene object so that
    // handleHideSelected can use it directly instead of querying getSelectedNodes()
    // (which may return stale/cleared state if the portal toolbar click interferes).
    const lastSelectedSceneIdRef = useRef(null)
    // Stable ref for onReady — prevents initializeViewer from being recreated
    // every time the parent passes a new onReady arrow function reference.
    const onReadyRef = useRef(onReady)
    useEffect(() => { onReadyRef.current = onReady }, [onReady])
    const commentRafRef = useRef(null)
    const timelinePlayRef = useRef(null)
    const timelineAbortRef = useRef(null)

    // Fix #1: Dispose the viewer and release the WebGL context on clean unmount.
    // Without this the render loop and GPU resources keep running indefinitely,
    // eventually exhausting the browser's WebGL context limit (~8–16 contexts).
    useEffect(() => {
        return () => {
            try { viewerRef.current?.dispose() } catch {}
            viewerRef.current = null
        }
    }, [])

    // Cached data refs for click handlers and diff operations
    const projectIdRef = useRef(projectId)
    const configRef = useRef(config)
    const elementMapRef = useRef(new Map())
    const speckleIdsRef = useRef([])

    // State
    const [objectId, setObjectId] = useState(null)
    const [isViewerReady, setIsViewerReady] = useState(false)
    const [loadProgress, setLoadProgress] = useState(null)
    const [viewerError, setViewerError] = useState(null)
    const [sectionBoxVisible, setSectionBoxVisible] = useState(false)
    const [isOrtho, setIsOrtho] = useState(false)
    const [isFlyMode, setIsFlyMode] = useState(false)
    const [hiddenIds, setHiddenIds] = useState([])
    const [selectionCount, setSelectionCount] = useState(0)
    const [activeColorField, setActiveColorField] = useState(null)
    const [measurementsActive, setMeasurementsActive] = useState(false)
    const [measurements, setMeasurements] = useState([])
    const [measurementOptions, setMeasurementOptions] = useState({
        visible: true,
        type: MeasurementType.POINTTOPOINT,
        vertexSnap: true,
        units: 'm',
        precision: 2,
        chain: false,
    })
    const [explodeValue, setExplodeValue] = useState(0)
    const [currentViewMode, setCurrentViewMode] = useState(ViewMode.DEFAULT)
    const [edgesEnabled, setEdgesEnabled] = useState(false)
    const [lightConfig, setLightConfig] = useState(DEFAULT_LIGHT)
    const [namedViews, setNamedViews] = useState([])
    const [isDiffing, setIsDiffing] = useState(false)

    // Timeline state
    const [timelineLoading, setTimelineLoading] = useState(false)
    const [timelineParams, setTimelineParams] = useState([])
    const [selectedTimelineParam, setSelectedTimelineParam] = useState(null)
    const [timelineData, setTimelineData] = useState(null)
    const [timelineStep, setTimelineStep] = useState(0)
    const [isTimelinePlaying, setIsTimelinePlaying] = useState(false)
    const [timelineSpeed, setTimelineSpeed] = useState(1)
    const [syncCharts, setSyncCharts] = useState(false)

    // Comments state
    const [showComments, setShowComments] = useState(false)
    const [selectedComment, setSelectedComment] = useState(null)
    const [pinPositions, setPinPositions] = useState({})
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

    // Imperative API — lets App.jsx call setFilter(ids) directly, bypassing the
    // React prop/memo chain which can be unreliable for real-time filter updates.
    useImperativeHandle(ref, () => ({
        setFilter(ids) {
            try {
                const filterExt = viewerRef.current?.getExtension(FilteringExtension)
                if (!filterExt) return
                if (ids?.length) filterExt.isolateObjects(ids, 'search', true, true)
                else filterExt.resetFilters()
            } catch (e) { console.warn('[SpeckleViewer] setFilter error:', e) }
        },
        resetFilter() {
            try { viewerRef.current?.getExtension(FilteringExtension)?.resetFilters() }
            catch (e) { console.warn('[SpeckleViewer] resetFilter error:', e) }
        },
        // Select a single element by ID and fly the camera to it.
        // Unlike ObjectClicked (where SelectionExtension auto-selects),
        // external callers must invoke selectObjects explicitly.
        selectObject(id) {
            if (!id || !viewerRef.current) return
            try {
                viewerRef.current.getExtension(SelectionExtension)?.selectObjects([id])
                viewerRef.current.getExtension(HybridCameraController)?.setCameraView([id], true)
            } catch (e) { console.warn('[SpeckleViewer] selectObject error:', e) }
        }
    }), [])

    // ─────────────────────────────────────────────────────────────
    // Refs syncing
    // ─────────────────────────────────────────────────────────────
    useEffect(() => { projectIdRef.current = projectId }, [projectId])
    useEffect(() => { configRef.current = config }, [config])

    // Build cached element lookup map
    useEffect(() => {
        const map = new Map()
        const ids = []
        const elements = Array.isArray(fullData?.elements) ? fullData.elements : []
        for (const el of elements) {
            if (el.speckle_id) {
                map.set(el.speckle_id, el)
                ids.push(el.speckle_id)
            }
            if (el.id) map.set(el.id, el)
        }
        elementMapRef.current = map
        speckleIdsRef.current = ids
    }, [fullData])

    // Track container size for comment projection
    useEffect(() => {
        if (!containerRef.current) return
        const observer = new ResizeObserver((entries) => {
            const rect = entries[0]?.contentRect
            if (rect) setContainerSize({ width: rect.width, height: rect.height })
        })
        observer.observe(containerRef.current)
        return () => observer.disconnect()
    }, [])

    // Track bounding rect of the viewer root so the fixed-position portal toolbar
    // stays aligned with the viewer even when the panel moves or resizes.
    useEffect(() => {
        if (!rootRef.current) return
        const update = () => {
            const r = rootRef.current?.getBoundingClientRect()
            if (r) setToolbarRect({ top: r.top, left: r.left, width: r.width, height: r.height })
        }
        update()
        const obs = new ResizeObserver(update)
        obs.observe(rootRef.current)
        window.addEventListener('scroll', update, true)
        return () => { obs.disconnect(); window.removeEventListener('scroll', update, true) }
    }, [])

    // ─────────────────────────────────────────────────────────────
    // Speckle object ID resolution
    // ─────────────────────────────────────────────────────────────
    const resolveObjectId = useCallback(async (vid, signal) => {
        if (!projectId || !vid) return null
        try {
            const headers = configRef.current.speckleToken 
                ? { Authorization: `Bearer ${configRef.current.speckleToken}` }
                : {}
            const res = await fetch(`${configRef.current.speckleServer}/graphql`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: `query($projectId:String!,$vid:String!){stream(id:$projectId){commit(id:$vid){referencedObject}}}`,
                    variables: { projectId, vid },
                }),
                signal,
            })
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
            const json = await res.json()
            if (json.errors?.length) throw new Error(json.errors[0].message)
            return json.data?.stream?.commit?.referencedObject || null
        } catch (err) {
            if (err.name !== 'AbortError') console.warn('resolveObjectId failed:', err)
            return null
        }
    }, [projectId])

    // Resolve object when version changes
    useEffect(() => {
        if (!projectId || !versionId) return
        setObjectId(null)
        setIsViewerReady(false)
        setLoadProgress(null)
        setViewerError(null)

        const controller = new AbortController()
        let active = true

        resolveObjectId(versionId, controller.signal).then((id) => {
            if (!active) return
            if (id) {
                setObjectId(id)
            } else {
                setViewerError({
                    type: 'resolve',
                    message: `Could not resolve version ${versionId}. Check that it exists and the Speckle token can access it.`,
                })
            }
        })

        return () => {
            active = false
            controller.abort()
        }
    }, [projectId, versionId, resolveObjectId])

    // Reset comments on version change
    useEffect(() => {
        setShowComments(false)
        setSelectedComment(null)
        setPinPositions({})
    }, [projectId, versionId])

    // ─────────────────────────────────────────────────────────────
    // Viewer initialization
    // ─────────────────────────────────────────────────────────────
    const createViewer = useCallback(async () => {
        if (!containerRef.current) throw new Error('No container')

        // Guard: never create a second viewer while one is already initialising.
        if (viewerRef.current) return viewerRef.current

        // Remove any orphaned canvas elements left by previous failed attempts.
        // new Viewer() appends a <canvas> to the container BEFORE calling
        // new THREE.WebGLRenderer(). If the renderer constructor throws (context
        // creation failed), the canvas stays in the DOM still holding its context
        // slot. Accumulated orphaned canvases exhaust the per-page WebGL limit,
        // causing every subsequent attempt to fail with "Error creating WebGL context".
        const orphaned = containerRef.current.querySelectorAll('canvas')
        if (orphaned.length > 0) {
            orphaned.forEach(canvas => {
                ['webgl2', 'webgl'].forEach(type => {
                    try {
                        const ctx = canvas.getContext(type)
                        ctx?.getExtension('WEBGL_lose_context')?.loseContext()
                    } catch { /* ignore */ }
                })
                canvas.remove()
            })
            // Give the GPU driver time to reclaim freed context slots
            await new Promise(r => setTimeout(r, 150))
            if (!containerRef.current) return viewerRef.current
        }

        const viewer = new Viewer(containerRef.current, {
            ...DefaultViewerParams,
            showStats: false,
            verbose: false,
        })

        // Set viewerRef IMMEDIATELY so concurrent initializeViewer calls see the
        // in-progress viewer and take the loadObject fast-path instead of calling
        // createViewer() again.
        viewerRef.current = viewer

        // Yield one frame so the browser lays out the canvas element before the
        // viewer's render loop starts — prevents GL_INVALID_FRAMEBUFFER_OPERATION
        // zero-size errors on the first few frames.
        await new Promise(r => requestAnimationFrame(r))

        await viewer.init()

        // Create extensions
        viewer.createExtension(HybridCameraController)
        const selectionExt = viewer.createExtension(SelectionExtension)
        viewer.createExtension(FilteringExtension)
        viewer.createExtension(SectionTool)
        viewer.createExtension(SectionOutlines)
        viewer.createExtension(DiffExtension)
        viewer.createExtension(ViewModes)
        viewer.createExtension(ExplodeExtension)
        const measurementExt = viewer.createExtension(MeasurementsExtension)

        // Configure selection colors.
        // isRenderMaterial() check in setMaterial() requires color+opacity+roughness+metalness+vertexColors
        // — missing any one of those fields makes the check return false and the material is never applied.
        try {
            selectionExt.options = {
                selectionMaterialData: { color: 0x04d9ff, opacity: 1, roughness: 1, metalness: 0, vertexColors: false },
                hoverMaterialData:     { color: 0x80efff, opacity: 0.8, roughness: 1, metalness: 0, vertexColors: false },
            }
        } catch {}

        // Measurement event
        measurementExt.on(MeasurementEvent.MeasurementsChanged, (list) => {
            setMeasurements(list ? [...list] : [])
        })

        // Light config
        try {
            viewer.setLightConfiguration(DEFAULT_LIGHT)
        } catch {}

        // Performance tuning
        try {
            const renderer = viewer.getRenderer()
            const passes = renderer?.pipeline?.getPass?.('ProgressiveAOPass')
            if (passes?.length) passes.forEach((p) => { p.enabled = false })
            if (renderer?.shadowcatcher) renderer.shadowcatcher.shadowcatcherPass.enabled = false
            if (renderer?.setMaximumFPS) renderer.setMaximumFPS(30)
        } catch {}

        // Click handler
        viewer.on(ViewerEvent.ObjectClicked, (event) => {
            const hits = event?.hits || []
            if (!hits.length) {
                // SelectionExtension's own ObjectClicked listener already called
                // clearSelection() when the event fired with null. Don't call it
                // again — just update React state.
                setSelectionCount(0)
                lastSelectedSceneIdRef.current = null
                if (onSelectionChange) onSelectionChange(null)
                return
            }

            const hit    = hits[0]
            const rawId  = hit.node?.model?.raw?.id
            const nodeId = hit.node?.model?.id
            const id     = rawId || nodeId
            if (!id) { log('ObjectClicked — no id on hit', hit); return }

            // Do NOT call selectObjects here. SelectionExtension registers its own
            // ObjectClicked listener in its constructor and auto-highlights the hit
            // node via applySelection(). Calling selectObjects([id]) afterward
            // resets selectedNodes=[] and re-runs applySelection on a potentially
            // empty set — silently clearing the highlight the extension just applied.
            viewer.requestRender()  // ensure the auto-selection paints immediately at 30 FPS

            setSelectionCount(1)
            // FilteringExtension's visibilityWalk matches against node.model.id
            // (= nodeId), not model.raw.id (= rawId). For instanced/duplicated
            // objects these differ, so hideObjects needs nodeId to take effect.
            lastSelectedSceneIdRef.current = nodeId || rawId

            const element = elementMapRef.current.get(id)
                         || elementMapRef.current.get(rawId)
                         || elementMapRef.current.get(nodeId)
            if (element) {
                if (onElementClick) onElementClick(element)
                if (onSelectionChange) onSelectionChange([element.id || element.speckle_id])
            } else if (onElementClick && hit.node?.model?.raw) {
                onElementClick({ id, speckle_type: hit.node.model.raw.speckle_type, ...hit.node.model.raw })
            }
        })

        // Double-click to zoom
        viewer.on(ViewerEvent.ObjectDoubleClicked, (event) => {
            const id = event?.hits?.[0]?.node?.model?.raw?.id || event?.hits?.[0]?.object?.id
            if (id) {
                try {
                    viewer.getExtension(HybridCameraController)?.setCameraView([id], true)
                } catch {}
            }
        })

        return viewer
    }, [onElementClick, onSelectionChange])

    const loadObject = useCallback(async (viewer, oid) => {
        if (!oid || !projectIdRef.current) throw new Error('Missing oid or projectId')
        const url = `${configRef.current.speckleServer}/streams/${projectIdRef.current}/objects/${oid}`
        const loader = new SpeckleLoader(viewer.getWorldTree(), url, configRef.current.speckleToken)
        const onProgress = ({ progress }) => setLoadProgress(progress)
        setLoadProgress(0)
        loader.on(LoaderEvent.LoadProgress, onProgress)
        try {
            // loadObject returns Promise<void> in @speckle/viewer v2+ — do NOT check return value
            await viewer.loadObject(loader, true)
        } finally {
            // Always remove the listener (fix: listener accumulation across retries/version switches)
            // and always clear progress (fix: frozen 0% bar on error path)
            try { loader.off(LoaderEvent.LoadProgress, onProgress) } catch {}
            setLoadProgress(null)
        }
    }, [])

    const retryCountRef = useRef(0)

    // initializeViewer reads objectId from the ref instead of closing over the
    // prop value. This makes the function stable (no objectId dep) so retries
    // scheduled via setTimeout always call the *same* function reference, which
    // reads the *current* objectId at fire time rather than a stale captured one.
    const initializeViewer = useCallback(async () => {
        const oid = activeObjectIdRef.current
        if (!oid || initializingRef.current) return
        const c = containerRef.current
        if (!c || !c.offsetWidth || !c.offsetHeight) {
            setTimeout(initializeViewer, 300)
            return
        }

        initializingRef.current = true
        setIsViewerReady(false)
        setViewerError(null)

        try {
            let viewer = viewerRef.current
            if (!viewer) {
                viewer = await createViewer()
            }
            // Abort if the user switched versions while we were creating the viewer
            if (activeObjectIdRef.current !== oid) return
            await loadObject(viewer, oid)
            if (activeObjectIdRef.current !== oid) return

            retryCountRef.current = 0
            setNamedViews(viewer.getViews() || [])
            setIsViewerReady(true)
            setMeasurements([])
            setExplodeValue(0)
            setCurrentViewMode(ViewMode.DEFAULT)
            setEdgesEnabled(false)
            setLightConfig(DEFAULT_LIGHT)
            setMeasurementsActive(false)
            setSectionBoxVisible(false)
            setIsOrtho(false)
            setIsFlyMode(false)
            setHiddenIds([])
            setActiveColorField(null)
            lastSelectedSceneIdRef.current = null
            if (onReadyRef.current) onReadyRef.current()
        } catch (error) {
            if (activeObjectIdRef.current !== oid) return
            console.error('[SpeckleViewer] init error:', error)

            // Purge all orphaned canvases so the next attempt starts with a clean slate
            try { viewerRef.current?.dispose() } catch {}
            viewerRef.current = null
            if (containerRef.current) {
                containerRef.current.querySelectorAll('canvas').forEach(canvas => {
                    ['webgl2', 'webgl'].forEach(type => {
                        try { canvas.getContext(type)?.getExtension('WEBGL_lose_context')?.loseContext() } catch {}
                    })
                    canvas.remove()
                })
            }

            if (retryCountRef.current < 2) {
                retryCountRef.current += 1
                const delay = retryCountRef.current * 800
                console.warn(`[SpeckleViewer] Retrying in ${delay}ms (attempt ${retryCountRef.current})`)
                initializingRef.current = false
                setTimeout(initializeViewer, delay)
                return
            }

            retryCountRef.current = 0
            setViewerError({ type: 'load', message: error?.message || 'Failed to load the 3D model' })
        } finally {
            initializingRef.current = false
        }
    }, [createViewer, loadObject]) // objectId intentionally omitted — read via activeObjectIdRef

    useEffect(() => {
        activeObjectIdRef.current = objectId  // must be set before initializeViewer reads it
        retryCountRef.current = 0
        if (!objectId) return
        initializeViewer()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [objectId]) // only re-run when the resolved object changes, not on function ref changes

    // ─────────────────────────────────────────────────────────────
    // Filtering by element IDs
    // ─────────────────────────────────────────────────────────────
    useEffect(() => {
        if (!isViewerReady || !viewerRef.current) return
        const filteringExt = viewerRef.current.getExtension(FilteringExtension)
        if (!filteringExt) return

        if (filteredElementIds?.length) {
            try {
                // isolateObjects already ghosts non-matching elements — no need to
                // also call selectObjects, which would incorrectly turn every matching
                // element cyan as if the user had clicked them all.
                filteringExt.isolateObjects(filteredElementIds, 'filter', true, true)
            } catch (err) {
                console.warn('[SpeckleViewer] isolateObjects error:', err)
            }
        } else {
            try {
                filteringExt.resetFilters()
                // Do NOT call clearSelection() here — resetting filters does not
                // mean the user deselected an element; clearing it would silently
                // kill the cyan highlight every time any filter is removed.
            } catch {}
        }
    }, [filteredElementIds, isViewerReady])

    // ─────────────────────────────────────────────────────────────
    // Diff/Compare
    // ─────────────────────────────────────────────────────────────
    const applyManualDiffColors = useCallback(() => {
        if (!viewerRef.current || !diffResult) return
        const filteringExt = viewerRef.current.getExtension(FilteringExtension)
        if (!filteringExt) return

        const addedIds = diffResult.element_ids || []
        const addedSet = new Set(addedIds)
        const unchangedIds = speckleIdsRef.current.filter((id) => !addedSet.has(id))

        try {
            filteringExt.setUserObjectColors([
                { objectIds: addedIds, color: '#22c55e' },
                { objectIds: unchangedIds, color: '#3f3f46' },
            ])
        } catch {}
    }, [diffResult])

    useEffect(() => {
        if (!isViewerReady || !viewerRef.current) return
        const diffExt = viewerRef.current.getExtension(DiffExtension)
        if (!diffExt) return

        if (!compareVersionId) {
            if (isDiffing) {
                setIsDiffing(false)
                try { diffExt.undiff() } catch {}
            }
            return
        }

        const controller = new AbortController()

        const runDiff = async () => {
            try {
                setIsDiffing(true)
                const currUrl = `${configRef.current.speckleServer}/streams/${projectIdRef.current}/objects/${objectId}`
                const compareObjId = await resolveObjectId(compareVersionId, controller.signal)
                if (controller.signal.aborted) return
                if (!compareObjId) throw new Error('Could not resolve compare object')
                const compareUrl = `${configRef.current.speckleServer}/streams/${projectIdRef.current}/objects/${compareObjId}`
                await diffExt.diff(currUrl, compareUrl, VisualDiffMode.COLORED, configRef.current.speckleToken)
            } catch (err) {
                if (controller.signal.aborted) return
                console.warn('[SpeckleViewer] diff error:', err)
                setIsDiffing(false)
                applyManualDiffColors()
            }
        }

        runDiff()
        return () => controller.abort()
    }, [compareVersionId, objectId, isViewerReady, resolveObjectId, applyManualDiffColors])

    // ─────────────────────────────────────────────────────────────
    // Timeline (4D)
    // ─────────────────────────────────────────────────────────────
    const loadTimelineData = useCallback((paramKey) => {
        if (!normalizerModelId) return
        if (timelineAbortRef.current) timelineAbortRef.current.abort()

        const controller = new AbortController()
        timelineAbortRef.current = controller
        setTimelineLoading(true)
        setSelectedTimelineParam(paramKey)
        setTimelineStep(0)
        setIsTimelinePlaying(false)

        fetch(`${config.normalizerUrl}/models/${normalizerModelId}/timeline/data?param_key=${encodeURIComponent(paramKey)}`, {
            signal: controller.signal,
        })
            .then((res) => res.ok ? res.json() : Promise.reject(new Error(`${res.status}`)))
            .then((data) => {
                if (!controller.signal.aborted) {
                    setTimelineData(data)
                    setTimelineLoading(false)
                }
            })
            .catch((err) => {
                if (err.name !== 'AbortError') setTimelineLoading(false)
            })
    }, [normalizerModelId, config.normalizerUrl])

    useEffect(() => {
        if (!showTimeline || !normalizerModelId) return
        if (timelineAbortRef.current) timelineAbortRef.current.abort()

        const controller = new AbortController()
        timelineAbortRef.current = controller
        setTimelineLoading(true)
        setTimelineParams([])
        setSelectedTimelineParam(null)
        setTimelineData(null)
        setTimelineStep(0)
        setIsTimelinePlaying(false)

        fetch(`${config.normalizerUrl}/models/${normalizerModelId}/timeline/params`, {
            signal: controller.signal,
        })
            .then((res) => res.ok ? res.json() : Promise.reject(new Error(`${res.status}`)))
            .then((params) => {
                if (!controller.signal.aborted) {
                    setTimelineParams(params)
                    if (params.length > 0) loadTimelineData(params[0].key)
                    else setTimelineLoading(false)
                }
            })
            .catch((err) => {
                if (err.name !== 'AbortError') setTimelineLoading(false)
            })

        return () => controller.abort()
    }, [showTimeline, normalizerModelId, config.normalizerUrl, loadTimelineData])

    useEffect(() => {
        if (!isViewerReady || !viewerRef.current || !showTimeline || !timelineData?.steps?.length) return
        const filteringExt = viewerRef.current.getExtension(FilteringExtension)
        if (!filteringExt) return

        const steps = timelineData.steps
        const pastIds = steps.slice(0, timelineStep).flatMap((s) => s.element_ids || [])
        const currentIds = steps[timelineStep]?.element_ids || []
        const allIds = [...pastIds, ...currentIds]

        try {
            filteringExt.isolateObjects(allIds, 'timeline', true, true)
            filteringExt.setUserObjectColors([
                { objectIds: pastIds, color: '#4ade80' },
                { objectIds: currentIds, color: '#fbbf24' },
            ])
        } catch {}
    }, [isViewerReady, showTimeline, timelineData, timelineStep])

    // "Sync charts" — when enabled, narrow the dashboard charts/tables to the
    // elements built up to (and including) the current timeline step, the same
    // way a viewer selection does.
    useEffect(() => {
        if (!onTimelineSync) return
        if (!syncCharts || !showTimeline || !timelineData?.steps?.length) {
            onTimelineSync(null)
            return
        }

        const steps = timelineData.steps
        const pastIds = steps.slice(0, timelineStep).flatMap((s) => s.element_ids || [])
        const currentIds = steps[timelineStep]?.element_ids || []
        const elementIds = [...pastIds, ...currentIds]
            .map((speckleId) => elementMapRef.current.get(speckleId))
            .filter(Boolean)
            .map((el) => el.id || el.speckle_id)

        onTimelineSync(elementIds.length ? elementIds : null)
    }, [syncCharts, showTimeline, timelineData, timelineStep, onTimelineSync])

    useEffect(() => {
        if (showTimeline) return
        setSyncCharts(false)
        try {
            viewerRef.current?.getExtension(FilteringExtension)?.resetFilters()
        } catch {}
    }, [showTimeline])

    useEffect(() => {
        if (!isTimelinePlaying || !timelineData?.steps?.length) return
        const interval = Math.max(100, Math.round(timelineSpeed * 1000))
        timelinePlayRef.current = setInterval(() => {
            setTimelineStep((prev) => {
                if (prev >= timelineData.steps.length - 1) {
                    setIsTimelinePlaying(false)
                    return prev
                }
                return prev + 1
            })
        }, interval)
        return () => {
            if (timelinePlayRef.current) clearInterval(timelinePlayRef.current)
        }
    }, [isTimelinePlaying, timelineSpeed, timelineData])

    // ─────────────────────────────────────────────────────────────
    // Toolbar actions
    // ─────────────────────────────────────────────────────────────
    const log = (label, err) => console.warn(`[SpeckleViewer] ${label}:`, err)

    const handleSectionBox = useCallback(() => {
        const sectionTool = viewerRef.current?.getExtension(SectionTool)
        if (!sectionTool) return
        const next = !sectionBoxVisible
        if (next) {
            // Fit the section box to the scene BEFORE enabling so the model
            // is never clipped at an intermediate zero-size position.
            try {
                const box = viewerRef.current?.getRenderer()?.sceneBox
                if (box && !box.isEmpty()) sectionTool.setBox(box, 0.05)
            } catch (e) { log('setBox', e) }
        }
        try { sectionTool.toggle() } catch (e) { log('sectionTool.toggle', e) }
        setSectionBoxVisible(next)
    }, [sectionBoxVisible])

    const handleZoomExtents = useCallback(() => {
        try { viewerRef.current?.getExtension(HybridCameraController)?.setCameraView([], true) }
        catch (e) { log('zoomExtents', e) }
    }, [])

    const handleCameraView = useCallback((view) => {
        try { viewerRef.current?.getExtension(HybridCameraController)?.setCameraView(view, true) }
        catch (e) { log('cameraView', e) }
    }, [])

    const handleToggleCameraProjection = useCallback(() => {
        try {
            const cam = viewerRef.current?.getExtension(HybridCameraController)
            if (!cam) return
            const isOrtho = viewerRef.current?.getRenderer()?.renderingCamera?.isOrthographicCamera
            if (isOrtho) cam.setPerspectiveCameraOn()
            else cam.setOrthoCameraOn()
            setIsOrtho(!isOrtho)
        } catch (e) { log('toggleProjection', e) }
    }, [])

    // ── Fly-through mode ─────────────────────────────────────────────────────
    const handleToggleFlyMode = useCallback(() => {
        try {
            viewerRef.current?.getExtension(HybridCameraController)?.toggleControls()
            setIsFlyMode(prev => !prev)
        } catch (e) { log('toggleFlyMode', e) }
    }, [])

    // ── Hide / Show objects ──────────────────────────────────────────────────
    // viewerSelectedIds comes from App.jsx selection sync → prop
    const handleHideSelected = useCallback(() => {
        try {
            // Use the ref tracked at click time — avoids querying getSelectedNodes()
            // which can return stale/cleared data if the toolbar portal click
            // triggers the viewer's document-level orbit-control listeners first.
            const id = lastSelectedSceneIdRef.current
            if (!id) return

            const filterExt = viewerRef.current?.getExtension(FilteringExtension)
            const selExt    = viewerRef.current?.getExtension(SelectionExtension)
            if (!filterExt) return

            filterExt.hideObjects([id], 'user-hidden', true, false)
            setHiddenIds(prev => [...new Set([...prev, id])])
            selExt?.clearSelection()
            setSelectionCount(0)
            lastSelectedSceneIdRef.current = null
            viewerRef.current?.requestRender()
        } catch (e) { log('hideSelected', e) }
    }, [])

    const handleShowAllHidden = useCallback(() => {
        try {
            const filterExt = viewerRef.current?.getExtension(FilteringExtension)
            if (!filterExt) return
            filterExt.showObjects(hiddenIds, 'user-hidden', true)
            setHiddenIds([])
        } catch (e) { log('showAllHidden', e) }
    }, [hiddenIds])

    // ── Colour by property ───────────────────────────────────────────────────
    // Assigns a distinct colour to each unique value of `field` across all elements.
    const handleColorByProperty = useCallback((field) => {
        try {
            const filterExt = viewerRef.current?.getExtension(FilteringExtension)
            if (!filterExt) return

            if (!field) {
                filterExt.removeUserObjectColors()
                setActiveColorField(null)
                return
            }

            // Group speckle IDs by field value using existing elementMapRef data
            const groups = {}
            for (const el of (speckleIdsRef.current.map(id => elementMapRef.current.get(id)).filter(Boolean))) {
                const val = String(el[field] ?? 'Unknown')
                if (!groups[val]) groups[val] = []
                if (el.speckle_id) groups[val].push(el.speckle_id)
            }

            const palette = ['#A855F7','#3B82F6','#10B981','#F59E0B','#EC4899',
                             '#6366F1','#0EA5E9','#EF4444','#14B8A6','#F97316',
                             '#8B5CF6','#22D3EE','#4ADE80','#FB923C','#F472B6']
            const colorGroups = Object.entries(groups).map(([, ids], i) => ({
                objectIds: ids,
                color: palette[i % palette.length],
            }))

            filterExt.setUserObjectColors(colorGroups)
            setActiveColorField(field)
        } catch (e) { log('colorByProperty', e) }
    }, [])

    const handleRemoveColorFilter = useCallback(() => {
        try {
            viewerRef.current?.getExtension(FilteringExtension)?.removeUserObjectColors()
            setActiveColorField(null)
        } catch (e) { log('removeColorFilter', e) }
    }, [])

    const handleScreenshot = useCallback(async () => {
        try {
            const url = await viewerRef.current?.screenshot()
            if (!url) return
            const a = document.createElement('a')
            a.href = url
            a.download = `speckle-${Date.now()}.png`
            a.click()
        } catch (e) { log('screenshot', e) }
    }, [])

    const handleViewMode = useCallback((mode) => {
        try {
            viewerRef.current?.getExtension(ViewModes)?.setViewMode(mode, { edges: edgesEnabled })
            setCurrentViewMode(mode)
        } catch (e) { log('viewMode', e) }
    }, [edgesEnabled])

    const handleToggleEdges = useCallback(() => {
        try {
            const next = !edgesEnabled
            viewerRef.current?.getExtension(ViewModes)?.setViewMode(currentViewMode, { edges: next })
            setEdgesEnabled(next)
        } catch (e) { log('toggleEdges', e) }
    }, [currentViewMode, edgesEnabled])

    const handleLighting = useCallback((updates) => {
        try {
            const next = { ...lightConfig, ...updates }
            viewerRef.current?.setLightConfiguration(next)
            setLightConfig(next)
        } catch (e) { log('lighting', e) }
    }, [lightConfig])

    const handleToggleMeasurements = useCallback(() => {
        try {
            const measurementExt = viewerRef.current?.getExtension(MeasurementsExtension)
            if (!measurementExt) return
            const next = !measurementsActive
            measurementExt.enabled = next
            measurementExt.options = { ...measurementOptions, visible: next }
            setMeasurementsActive(next)
        } catch (e) { log('toggleMeasurements', e) }
    }, [measurementsActive, measurementOptions])

    const handleMeasurementOptions = useCallback((updates) => {
        try {
            const next = { ...measurementOptions, ...updates }
            setMeasurementOptions(next)
            const measurementExt = viewerRef.current?.getExtension(MeasurementsExtension)
            if (measurementExt && measurementsActive) measurementExt.options = { ...next, visible: true }
        } catch (e) { log('measurementOptions', e) }
    }, [measurementsActive, measurementOptions])

    const handleDeleteMeasurement = useCallback((data) => {
        try { viewerRef.current?.getExtension(MeasurementsExtension)?.removeMeasurement(data) }
        catch (e) { log('deleteMeasurement', e) }
    }, [])

    const handleClearMeasurements = useCallback(() => {
        try {
            viewerRef.current?.getExtension(MeasurementsExtension)?.clearMeasurements()
            setMeasurements([])
        } catch (e) { log('clearMeasurements', e) }
    }, [])

    const handleExplode = useCallback((value) => {
        try {
            viewerRef.current?.getExtension(ExplodeExtension)?.setExplode(value)
            setExplodeValue(value)
        } catch {}
    }, [])

    // ─────────────────────────────────────────────────────────────
    // Comments overlay
    // ─────────────────────────────────────────────────────────────
    const projectWorldPoint = useCallback((wx, wy, wz) => {
        const viewer = viewerRef.current
        if (!viewer || !containerSize.width) return null
        try {
            const camera = viewer.getRenderer()?.renderingCamera
            if (!camera) return null
            const mv = camera.matrixWorldInverse.elements
            const pr = camera.projectionMatrix.elements
            const vx = mv[0] * wx + mv[4] * wy + mv[8] * wz + mv[12]
            const vy = mv[1] * wx + mv[5] * wy + mv[9] * wz + mv[13]
            const vz = mv[2] * wx + mv[6] * wy + mv[10] * wz + mv[14]
            const vw = mv[3] * wx + mv[7] * wy + mv[11] * wz + mv[15]
            if (vw <= 0) return null
            const cx = pr[0] * vx + pr[4] * vy + pr[8] * vz + pr[12] * vw
            const cy = pr[1] * vx + pr[5] * vy + pr[9] * vz + pr[13] * vw
            const cz = pr[2] * vx + pr[6] * vy + pr[10] * vz + pr[14] * vw
            const cw = pr[3] * vx + pr[7] * vy + pr[11] * vz + pr[15] * vw
            if (cw <= 0 || cz > 1) return null
            const ndcX = cx / cw, ndcY = cy / cw
            return {
                x: (ndcX * 0.5 + 0.5) * containerSize.width,
                y: (-ndcY * 0.5 + 0.5) * containerSize.height,
                visible: ndcX > -1 && ndcX < 1 && ndcY > -1 && ndcY < 1,
            }
        } catch {
            return null
        }
    }, [containerSize])

    useEffect(() => {
        if (!showComments || !isViewerReady || !comments.length) {
            if (commentRafRef.current) cancelAnimationFrame(commentRafRef.current)
            setPinPositions({})
            return
        }

        const loop = () => {
            const nextPins = {}
            for (const comment of comments) {
                try {
                    const state = typeof comment.viewerState === 'string' ? JSON.parse(comment.viewerState) : comment.viewerState
                    const target = state?.ui?.camera?.target || state?.camera?.target
                    if (!target) continue
                    const [tx, ty, tz] = Array.isArray(target) ? target : [target.x, target.y, target.z]
                    const pos = projectWorldPoint(tx, ty, tz)
                    if (pos?.visible) nextPins[comment.id] = pos
                } catch {}
            }
            setPinPositions(nextPins)
            commentRafRef.current = requestAnimationFrame(loop)
        }

        commentRafRef.current = requestAnimationFrame(loop)
        return () => {
            if (commentRafRef.current) cancelAnimationFrame(commentRafRef.current)
        }
    }, [showComments, isViewerReady, comments, projectWorldPoint])

    const handleCommentClick = useCallback((comment) => {
        setSelectedComment((prev) => (prev?.id === comment.id ? null : comment))
        if (!viewerRef.current) return
        try {
            const state = typeof comment.viewerState === 'string' ? JSON.parse(comment.viewerState) : comment.viewerState
            const resourceIds = (comment.viewerResources || []).map((r) => r.objectId).filter(Boolean)
            const selectedIds = resourceIds.length > 0 ? resourceIds : (state?.selection?.objects || state?.selectedObjects || [])
            if (selectedIds?.length) {
                viewerRef.current.getExtension(FilteringExtension)?.isolateObjects(selectedIds, 'comment', true, true)
                viewerRef.current.getExtension(SelectionExtension)?.selectObjects(selectedIds)
                // Only zoom to the linked elements — skip if empty to avoid zooming to extents
                viewerRef.current.getExtension(HybridCameraController)?.setCameraView(selectedIds, true)
            } else if (state?.camera) {
                // Restore the saved camera position even when no elements are linked
                try {
                    viewerRef.current.getExtension(HybridCameraController)?.setCameraView(state.camera, false)
                } catch {}
            }
        } catch (err) {
            console.warn('Comment navigation error:', err)
        }
    }, [])

    // ─────────────────────────────────────────────────────────────
    // Render
    // ─────────────────────────────────────────────────────────────
    if (viewerError) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-4 p-6 text-center">
                <div className="w-14 h-14 rounded-full bg-amber-500/10 flex items-center justify-center">!</div>
                <div>
                    <p className="text-sm font-semibold text-zinc-200 mb-1">3D model could not be loaded</p>
                    <p className="text-xs text-zinc-500 max-w-sm">{viewerError.message}</p>
                </div>
                <button
                    onClick={() => {
                        setViewerError(null)
                        initializeViewer()
                    }}
                    className="px-4 py-2 text-xs rounded bg-primary/20 text-primary hover:bg-primary/30"
                >
                    Retry
                </button>
            </div>
        )
    }

    // All interactive overlays (toolbar, timeline, diffbar) are rendered into a
    // portal on document.body so they are completely outside the viewer's DOM tree
    // and cannot be blocked by the THREE.js canvas event system.
    const overlayJSX = toolbarRect ? createPortal(
        <div style={{
            position: 'fixed',
            top: toolbarRect.top,
            left: toolbarRect.left,
            width: toolbarRect.width,
            height: toolbarRect.height,
            pointerEvents: 'none',
            zIndex: 99999,
        }}>
            {/* DiffBar */}
            <AnimatePresence>
                {isViewerReady && diffResult && (
                    <div style={{ pointerEvents: 'auto' }}>
                        <DiffBar
                            diffResult={diffResult}
                            onExit={onExitCompare}
                            onIsolateAdded={(ids) => {
                                try { viewerRef.current?.getExtension(FilteringExtension)?.isolateObjects(ids, 'diff', true, true) } catch {}
                            }}
                            onIsolateUnchanged={() => {
                                const addedSet = new Set(diffResult.element_ids || [])
                                const unchangedIds = speckleIdsRef.current.filter((id) => !addedSet.has(id))
                                try { viewerRef.current?.getExtension(FilteringExtension)?.isolateObjects(unchangedIds, 'diff', true, true) } catch {}
                            }}
                            onShowAll={() => {
                                try {
                                    if (isDiffing) viewerRef.current?.getExtension(FilteringExtension)?.resetFilters()
                                    else applyManualDiffColors()
                                } catch {}
                            }}
                        />
                    </div>
                )}
            </AnimatePresence>

            {/* 4D Timeline — at the bottom; toolbar moves to top when timeline is active */}
            <AnimatePresence>
                {isViewerReady && showTimeline && (
                    <div style={{ pointerEvents: 'auto', position: 'absolute', bottom: 12, left: 12, right: 12 }}>
                        <TimelinePlayer
                            steps={timelineData?.steps || []}
                            currentStep={timelineStep}
                            isPlaying={isTimelinePlaying}
                            totalElements={timelineData?.total_elements || 0}
                            speed={timelineSpeed}
                            loading={timelineLoading}
                            params={timelineParams}
                            selectedParam={selectedTimelineParam}
                            syncCharts={syncCharts}
                            onToggleSync={() => setSyncCharts((v) => !v)}
                            onStepChange={(step) => { setTimelineStep(step); setIsTimelinePlaying(false) }}
                            onTogglePlay={() => {
                                if (timelineStep >= (timelineData?.steps?.length ?? 1) - 1) setTimelineStep(0)
                                setIsTimelinePlaying((v) => !v)
                            }}
                            onClose={onCloseTimeline}
                            onSpeedChange={setTimelineSpeed}
                            onParamSelect={loadTimelineData}
                        />
                    </div>
                )}
            </AnimatePresence>

            {/* Toolbar — moves to top when timeline is active, back to bottom otherwise */}
            {isViewerReady && (
                <ViewerToolbar
                    isTimelineActive={showTimeline}
                    onSectionBoxClick={handleSectionBox}
                    isSectionBoxEnabled={sectionBoxVisible}
                    onZoomExtents={handleZoomExtents}
                    onCameraView={handleCameraView}
                    namedViews={namedViews}
                    onScreenshot={handleScreenshot}
                    viewMode={currentViewMode}
                    onViewMode={handleViewMode}
                    edgesEnabled={edgesEnabled}
                    onToggleEdges={handleToggleEdges}
                    isOrtho={isOrtho}
                    onToggleProjection={handleToggleCameraProjection}
                    isFlyMode={isFlyMode}
                    onToggleFlyMode={handleToggleFlyMode}
                    selectionCount={selectionCount}
                    hiddenCount={hiddenIds.length}
                    onHideSelected={handleHideSelected}
                    onShowAllHidden={handleShowAllHidden}
                    activeColorField={activeColorField}
                    onColorByProperty={handleColorByProperty}
                    onRemoveColorFilter={handleRemoveColorFilter}
                    lightConfig={lightConfig}
                    onSetLighting={handleLighting}
                    measurementsActive={measurementsActive}
                    onToggleMeasurements={handleToggleMeasurements}
                    measurements={measurements}
                    measurementOptions={measurementOptions}
                    onMeasurementOptions={handleMeasurementOptions}
                    onDeleteMeasurement={handleDeleteMeasurement}
                    onClearMeasurements={handleClearMeasurements}
                    explodeValue={explodeValue}
                    onExplode={handleExplode}
                    isViewerReady={isViewerReady}
                />
            )}

            {/* Comments toggle button — top-right corner */}
            {isViewerReady && comments.length > 0 && (
                <button
                    style={{ position: 'absolute', top: 12, right: 12, pointerEvents: 'auto' }}
                    onClick={() => {
                        setShowComments((v) => {
                            const next = !v
                            if (!next) setSelectedComment(null)
                            return next
                        })
                    }}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shadow transition-all ${
                        showComments
                            ? 'bg-primary text-black'
                            : 'bg-zinc-800/80 border border-white/10 text-zinc-400 hover:text-zinc-200'
                    }`}
                >
                    <MessageSquare className="w-3.5 h-3.5" />
                    {comments.length}
                </button>
            )}

            {/* Comment pins — rendered over the viewer area */}
            {isViewerReady && showComments && (
                <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: '0.75rem', pointerEvents: 'none' }}>
                    {comments.map((comment, idx) => {
                        const pos = pinPositions[comment.id]
                        return pos ? (
                            <button
                                key={comment.id}
                                onClick={() => handleCommentClick(comment)}
                                style={{ position: 'absolute', left: pos.x, top: pos.y, transform: 'translate(-50%, -50%)', pointerEvents: 'auto' }}
                                className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shadow-lg border-2 transition-transform ${
                                    selectedComment?.id === comment.id
                                        ? 'bg-primary border-white text-black scale-125'
                                        : 'bg-zinc-900 border-primary text-primary hover:scale-110'
                                }`}
                            >
                                {idx + 1}
                            </button>
                        ) : null
                    })}
                </div>
            )}

            {/* Selected comment popup — bottom-left */}
            {isViewerReady && showComments && selectedComment && (
                <div style={{ position: 'absolute', bottom: 56, left: 12, width: 288, pointerEvents: 'auto', zIndex: 1 }}
                    className="rounded-xl shadow-2xl overflow-hidden bg-zinc-900 border border-white/10"
                >
                    <div className="p-3 border-b border-white/10 flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-primary/30 flex items-center justify-center text-[10px] font-bold text-primary shrink-0">
                            {(selectedComment.author?.name || '?')[0].toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-zinc-200 truncate">{selectedComment.author?.name || 'Unknown'}</p>
                            <p className="text-[10px] text-zinc-500">{new Date(selectedComment.createdAt).toLocaleDateString()}</p>
                        </div>
                        <button onClick={() => setSelectedComment(null)} className="text-zinc-500 hover:text-zinc-300 shrink-0">
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                    <div className="p-3 max-h-48 overflow-y-auto">
                        <p className="text-sm text-zinc-300 whitespace-pre-wrap">
                            {selectedComment._text || selectedComment.rawText || '(No text)'}
                        </p>
                        {selectedComment.screenshot && (
                            <img src={selectedComment.screenshot} className="mt-2 w-full rounded-lg border border-white/10" alt="Comment" />
                        )}
                    </div>
                </div>
            )}
        </div>,
        document.body
    ) : null

    return (
        <>
        <div ref={rootRef} className="relative w-full h-full text-foreground">
            <div
                ref={containerRef}
                className="w-full h-full rounded-xl overflow-hidden bg-zinc-900"
            />

            {!isViewerReady && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
                    <div className="w-48 flex flex-col items-center gap-2">
                        <div className="w-full h-1 rounded-full bg-white/10 overflow-hidden">
                            {loadProgress !== null ? (
                                <div
                                    className="h-full rounded-full bg-primary transition-all duration-150"
                                    style={{ width: `${Math.round(loadProgress * 100)}%` }}
                                />
                            ) : (
                                <div className="h-full w-full rounded-full bg-primary/40 animate-pulse" />
                            )}
                        </div>
                        {loadProgress !== null && (
                            <span className="text-[11px] text-zinc-400 tabular-nums">
                                {Math.round(loadProgress * 100)}%
                            </span>
                        )}
                    </div>
                </div>
            )}

            {/* All interactive overlays (toolbar, timeline, diffbar, comments)
                are rendered via the overlayJSX portal below — outside the viewer DOM. */}
        </div>
        {overlayJSX}
        </>
    )
})

export default SpeckleViewer
