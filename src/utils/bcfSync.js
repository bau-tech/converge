// Bidirectional sync between Speckle's native comments and our BCF topics.
// Both directions are idempotent via the persistent bcf_speckle_sync table
// (tracked server-side, independent of bcf_topics rows), so this is safe to
// call on every model load without creating duplicates — even across topic
// deletion or push/pull round-trips. See listSyncRecords/recordSync below.
import {
    createTopic, createViewpoint, createComment, updateTopic, getSnapshotUrl, listComments,
    listSyncRecords, recordSync, listCommentSync, recordCommentSync,
} from './bcfClient'

// Fallback only — this app supports switching between multiple Speckle
// servers at runtime (see App.jsx's activeServer/allServers), so every call
// below takes an explicit { serverUrl, token } and only falls back to these
// env defaults when the caller doesn't supply one. Hardcoding the env values
// directly (as this used to do) sends every request to whichever server
// happens to be the build-time default, regardless of which server the
// current project actually lives on — Speckle then replies "Project not
// found" for any project that lives on a different server.
const DEFAULT_SPECKLE_URL = import.meta.env.VITE_SPECKLE_SERVER || ''
const DEFAULT_SPECKLE_TOKEN = import.meta.env.VITE_SPECKLE_TOKEN || ''

// Also tags the BCF topic itself with the Speckle thread id, purely for
// human-readable display (e.g. the "Synced to Speckle" badge) — the actual
// idempotency gate is the persistent bcf_speckle_sync table (see
// bcfClient.js's listSyncRecords/recordSync), because labels live on the
// topic row and are lost the moment a user deletes that topic. Without a
// gate that survives deletion, a deleted topic's source comment would be
// re-pulled on the very next model load.
export const PUSHED_LABEL_PREFIX = 'speckle-pushed:'

async function speckleGqlFetch(query, variables = {}, { serverUrl, token } = {}) {
    const url = serverUrl || DEFAULT_SPECKLE_URL
    const tok = token || DEFAULT_SPECKLE_TOKEN
    const res = await fetch(`${url}/graphql`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) throw new Error(`Speckle API ${res.status}: ${res.statusText}`)
    const result = await res.json()
    if (result.errors?.length) throw new Error(result.errors[0].message)
    return result.data
}

// speckle_id/id -> element (for resolving comment selections to IFC GUIDs)
function buildElementMap(elements) {
    const map = new Map()
    for (const el of elements || []) {
        if (el.speckle_id) map.set(el.speckle_id, el)
        if (el.id) map.set(el.id, el)
    }
    return map
}

// application_id (IFC GUID) -> speckle scene id (the reverse lookup, for push)
function buildSceneIdMap(elements) {
    const map = new Map()
    for (const el of elements || []) {
        if (el.application_id) map.set(el.application_id, el.speckle_id || el.id)
    }
    return map
}

function vecFrom(v) {
    if (!v) return null
    if (Array.isArray(v)) return { x: v[0], y: v[1], z: v[2] }
    if (typeof v.x === 'number') return { x: v.x, y: v.y, z: v.z }
    return null
}

function normalizeVec(v) {
    const len = Math.hypot(v.x, v.y, v.z) || 1
    return { x: v.x / len, y: v.y / len, z: v.z / len }
}

function docFromText(text) {
    return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: text || '' }] }] }
}

async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result) // "data:image/png;base64,..."
        reader.onerror = reject
        reader.readAsDataURL(blob)
    })
}

// --------------------------------------------------------------------------
// Pull: Speckle comment threads -> BCF topics + viewpoints + comments
// --------------------------------------------------------------------------

// Speckle stores a comment's screenshot as an uploaded blob, referenced by a
// URL (e.g. "/api/stream/{streamId}/blob/{blobId}"), not inline base64 — so
// reading it back requires an authenticated fetch, same as getSnapshotUrl()
// does for our own stored snapshots. Returns a bare base64 string (no
// "data:...;base64," prefix), matching snapshot_base64's existing contract.
async function fetchScreenshotBase64(screenshotUrl, { serverUrl, token } = {}) {
    if (!screenshotUrl) return null
    try {
        const base = serverUrl || DEFAULT_SPECKLE_URL
        const url = screenshotUrl.startsWith('http') ? screenshotUrl : `${base}${screenshotUrl}`
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token || DEFAULT_SPECKLE_TOKEN}` } })
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        const blob = await res.blob()
        const dataUrl = await blobToBase64(blob)
        return dataUrl.split(',')[1] || null
    } catch (e) {
        console.warn(`[bcfSync] fetchScreenshotBase64 failed for ${screenshotUrl}:`, e)
        return null
    }
}

// Speckle's native comment viewerState already carries almost everything a
// BCF viewpoint needs (camera position/target, selected object ids, even a
// screenshot) — this maps that shape onto our ViewpointCreate schema.
async function viewpointFromSpeckleComment(comment, elementMap, speckleServer) {
    let state = comment.viewerState
    try { if (typeof state === 'string') state = JSON.parse(state) } catch { state = null }

    // Speckle's real viewerState stores the selection as a map of
    // {sceneId: applicationId} at ui.filters.selectedObjectApplicationIds —
    // the values are already IFC GUIDs, no elementMap lookup needed. Older/
    // other shapes (viewerResources, selection.objects) are kept as a
    // fallback and still need the speckle_id -> application_id lookup.
    const appIdMap = state?.ui?.filters?.selectedObjectApplicationIds
    let selection
    if (appIdMap && typeof appIdMap === 'object') {
        selection = Object.values(appIdMap).filter(Boolean)
    } else {
        const resourceIds = (comment.viewerResources || []).map((r) => r.objectId).filter(Boolean)
        const sceneIds = resourceIds.length > 0 ? resourceIds : (state?.selection?.objects || state?.selectedObjects || [])
        selection = sceneIds.map((id) => elementMap.get(id)?.application_id).filter(Boolean)
    }

    const cameraState = state?.camera || state?.ui?.camera
    const position = vecFrom(cameraState?.position)
    const target = vecFrom(cameraState?.target)

    let camera_view_point = null, camera_direction = null
    if (position && target) {
        camera_view_point = position
        camera_direction = normalizeVec({ x: target.x - position.x, y: target.y - position.y, z: target.z - position.z })
    }

    let snapshot_base64 = null
    if (typeof comment.screenshot === 'string' && comment.screenshot) {
        snapshot_base64 = comment.screenshot.includes(',') && comment.screenshot.startsWith('data:')
            ? comment.screenshot.split(',')[1]   // inline data URI (defensive — not the normal case)
            : await fetchScreenshotBase64(comment.screenshot, speckleServer)   // the normal case: a blob URL
    }

    if (!selection.length && !camera_view_point && !snapshot_base64) return null
    return {
        is_orthogonal: false,
        camera_view_point,
        camera_direction,
        camera_up_vector: camera_view_point ? { x: 0, y: 1, z: 0 } : null,
        field_of_view: camera_view_point ? 60 : null,
        clipping_planes: [],
        selection,
        snapshot_base64,
    }
}

// Returns the newly created topics (each enriched with .viewpoint, matching
// bcfClient's listTopics+listViewpoints enrichment shape).
export async function pullFromSpeckle(projectId, speckleComments, elements, speckleServer = {}) {
    const elementMap = buildElementMap(elements)
    const syncRecords = await listSyncRecords(projectId)
    const pulledIds = new Set(
        syncRecords.filter((r) => r.direction === 'pulled').map((r) => r.speckle_comment_id)
    )
    const pending = speckleComments.filter((c) => !pulledIds.has(c.id))
    const created = []

    // One comment failing to pull (bad viewpoint data, transient network
    // error, etc.) must not block the rest — otherwise a single bad item
    // silently stops sync from ever reaching setBcfTopics() for this model.
    for (const comment of pending) {
        try {
            const text = comment._text || comment.rawText || ''
            const title = text.trim() ? (text.length > 80 ? `${text.slice(0, 80)}…` : text) : '(no text)'
            const topic = await createTopic(projectId, {
                title,
                description: text || null,
                creation_author: comment.author?.name || 'Speckle User',
                topic_type: 'Issue',
                topic_status: comment.archived ? 'Closed' : 'Open',
                priority: 'Normal',
                creation_date: comment.createdAt || null,
            })
            await recordSync(projectId, { speckleCommentId: comment.id, topicGuid: topic.guid, direction: 'pulled' })

            let viewpoint = null
            const vp = await viewpointFromSpeckleComment(comment, elementMap, speckleServer)
            if (vp) viewpoint = await createViewpoint(projectId, topic.guid, vp)

            for (const reply of comment.replies?.items || []) {
                const replyText = reply.rawText || reply.text?.doc || ''
                if (!replyText.trim()) continue
                const newComment = await createComment(projectId, topic.guid, {
                    comment: replyText,
                    author: reply.author?.name || 'Speckle User',
                    date: reply.createdAt || null,
                })
                // This BCF comment IS that Speckle reply — mark it synced
                // immediately so pushToSpeckle never relays it back as a
                // "new" duplicate reply on the very same thread.
                await recordCommentSync(projectId, newComment.guid, reply.id)
            }

            created.push({ ...topic, viewpoint })
        } catch (err) {
            console.warn(`Pull from Speckle failed for comment ${comment.id}:`, err)
        }
    }
    return created
}

// --------------------------------------------------------------------------
// Push: BCF topics -> Speckle comment threads + replies
// --------------------------------------------------------------------------

// Speckle's frontend validates viewerState with isSerializedViewerState()
// before it'll show a 3D marker for a comment — it requires the top-level
// projectId/sessionId/resources/viewer keys to be present, not just `ui`.
// A bare {ui:{camera,filters}} (what we sent before) fails that check
// silently, so the comment renders with no marker and no working "view"
// button at all, even though the data still "looks" plausible to a human.
// camera.position/target and resources.request.resourceIdString are the
// only genuinely required leaves (confirmed against a real comment's stored
// viewerState) — everything else just needs to be present with sane defaults.
async function buildViewerState(viewpoint, sceneIdMap, { streamId, modelId, versionId }) {
    if (!viewpoint?.camera_view_point || !viewpoint?.camera_direction) return null
    const p = viewpoint.camera_view_point
    const d = viewpoint.camera_direction

    const selection = {}
    for (const ifcGuid of viewpoint.selection || []) {
        const sceneId = sceneIdMap.get(ifcGuid)
        if (sceneId) selection[sceneId] = ifcGuid
    }

    return {
        projectId: streamId,
        sessionId: `bcf-sync-${Math.random().toString(36).slice(2)}`,
        viewer: { metadata: { filteringState: null } },
        resources: {
            request: {
                resourceIdString: `${modelId}@${versionId}`,
                threadFilters: { includeArchived: false, loadedVersionsOnly: true },
            },
        },
        ui: {
            threads: { openThread: { threadId: null, isTyping: false, newThreadEditor: false } },
            diff: { command: null, time: 0.5, mode: 1 },
            spotlightUserSessionId: null,
            filters: {
                isolatedObjectIds: [],
                hiddenObjectIds: [],
                selectedObjectApplicationIds: selection,
                propertyFilters: [],
                activeColorFilterId: null,
                filterLogic: 'all',
            },
            camera: {
                position: [p.x, p.y, p.z],
                target: [p.x + d.x * 10, p.y + d.y * 10, p.z + d.z * 10],
                zoom: 1,
                isOrthoProjection: !!viewpoint.is_orthogonal,
            },
            viewMode: { mode: 0, edgesEnabled: true, edgesWeight: 1, outlineOpacity: 0.75, edgesColor: 'DEFAULT_EDGE_COLOR' },
            sectionBox: null,
            lightConfig: {},
            explodeFactor: 0,
            selection: null,
            measurement: { enabled: false, options: null, measurements: [] },
        },
    }
}

// Returns bare base64 (no "data:image/png;base64," prefix) — Speckle's
// CreateCommentInput.screenshot rejects (and fails the whole mutation, not
// just the screenshot) when given a full data URI; the pull-side equivalent
// (fetchScreenshotBase64 above) already strips the prefix for the same reason.
async function snapshotBase64(projectId, topicGuid, viewpointGuid) {
    try {
        const blobUrl = await getSnapshotUrl(projectId, topicGuid, viewpointGuid)
        const blob = await fetch(blobUrl).then((r) => r.blob())
        URL.revokeObjectURL(blobUrl)
        if (blob.size === 0) {
            console.warn(`[bcfSync] snapshotBase64: viewpoint ${viewpointGuid} has a 0-byte snapshot blob`)
        }
        const dataUri = await blobToBase64(blob)
        return dataUri.split(',')[1] || null
    } catch (e) {
        console.warn(`[bcfSync] snapshotBase64 failed for viewpoint ${viewpointGuid} (likely no snapshot stored — backend returns 404):`, e)
        return null
    }
}

const CREATE_COMMENT_MUTATION = `
mutation CreateBcfComment($input: CreateCommentInput!) {
    commentMutations { create(input: $input) { id } }
}`

const REPLY_COMMENT_MUTATION = `
mutation ReplyBcfComment($input: CreateCommentReplyInput!) {
    commentMutations { reply(input: $input) { id } }
}`

// Returns the topics that were pushed this run, each with the
// speckle-pushed:<id> label already applied (mirrors createTopic's response shape).
//
// Two cases per topic, unified into one flow:
//  - No known thread yet (never pushed, never pulled): create a new Speckle
//    thread for it, then relay every current BCF comment onto it as replies.
//  - A thread is already known (this topic was pushed before, OR it
//    originated from a pull — in which case the thread is the ORIGINAL
//    Speckle comment, never a new one): skip creating anything, just relay
//    any BCF comments that haven't been relayed yet. This is what keeps
//    later edits/replies showing up on Speckle instead of being one-shot.
export async function pushToSpeckle(projectId, topics, { streamId, modelId, versionId, elements, serverUrl, token }) {
    const speckleServer = { serverUrl, token }
    const sceneIdMap = buildSceneIdMap(elements)
    const syncRecords = await listSyncRecords(projectId)
    const threadIdByTopic = new Map()
    for (const r of syncRecords) {
        if (!r.topic_guid || (r.direction !== 'pushed' && r.direction !== 'pulled')) continue
        if (!threadIdByTopic.has(r.topic_guid)) threadIdByTopic.set(r.topic_guid, r.speckle_comment_id)
    }
    const syncedCommentGuids = new Set((await listCommentSync(projectId)).map((r) => r.comment_guid))

    const pushed = []
    // One topic failing to push (e.g. Speckle rejects an empty comment body)
    // must not block the rest — otherwise a single bad item silently stops
    // sync from ever reaching setBcfTopics() for this model.
    for (const topic of topics) {
        if (!streamId) continue

        try {
            let threadId = threadIdByTopic.get(topic.guid)
            let updated = null

            if (!threadId) {
                if (!modelId || !versionId) continue // need both for resourceIdString — can't create yet
                const viewerState = await buildViewerState(topic.viewpoint, sceneIdMap, { streamId, modelId, versionId })
                const screenshot = topic.viewpoint
                    ? await snapshotBase64(projectId, topic.guid, topic.viewpoint.guid)
                    : null
                if (topic.viewpoint && !screenshot) {
                    console.warn(`[bcfSync] pushToSpeckle: topic ${topic.guid} has a viewpoint (${topic.viewpoint.guid}) but no usable screenshot — Speckle comment will be created without one`)
                }

                // Speckle's API rejects a comment whose doc has no actual text
                // content ("Attempting to build comment text without document &
                // attachments") — title is required so this is mostly a safety net.
                const text = [topic.title, topic.description].filter(Boolean).join('\n\n').trim() || '(no description)'
                const createResult = await speckleGqlFetch(CREATE_COMMENT_MUTATION, {
                    input: {
                        projectId: streamId,
                        content: { doc: docFromText(text) },
                        viewerState,
                        resourceIdString: `${modelId}@${versionId}`,
                        screenshot,
                    },
                }, speckleServer)
                threadId = createResult.commentMutations.create.id
                await recordSync(projectId, { speckleCommentId: threadId, topicGuid: topic.guid, direction: 'pushed' })
                // Also mark the comment WE just created as already-pulled, otherwise
                // the next pull pass would see it as a brand-new native comment and
                // pull it right back in as a duplicate topic (push -> pull ping-pong).
                await recordSync(projectId, { speckleCommentId: threadId, topicGuid: topic.guid, direction: 'pulled' })
                updated = await updateTopic(projectId, topic.guid, {
                    labels: [...(topic.labels || []), `${PUSHED_LABEL_PREFIX}${threadId}`],
                })
            }

            // Relay any BCF comments not yet relayed — covers both the
            // initial batch (fresh thread, nothing synced yet) and later
            // additions to a topic that was already pushed/pulled before.
            let topicComments = []
            try {
                topicComments = await listComments(projectId, topic.guid)
            } catch { /* no comments to relay */ }
            for (const c of topicComments) {
                if (syncedCommentGuids.has(c.guid)) continue
                if (!c.comment?.trim()) continue // same empty-doc rejection as above
                const replyResult = await speckleGqlFetch(REPLY_COMMENT_MUTATION, {
                    input: { projectId: streamId, threadId, content: { doc: docFromText(c.comment) } },
                }, speckleServer)
                await recordCommentSync(projectId, c.guid, replyResult.commentMutations.reply.id)
                syncedCommentGuids.add(c.guid)
            }

            if (updated) pushed.push({ ...topic, ...updated })
        } catch (err) {
            console.warn(`Push to Speckle failed for topic ${topic.guid}:`, err)
        }
    }
    return pushed
}

// --------------------------------------------------------------------------
// Delete: archive the linked Speckle comment thread when its BCF topic is deleted
// --------------------------------------------------------------------------

const ARCHIVE_COMMENT_MUTATION = `
mutation ArchiveBcfComment($input: ArchiveCommentInput!) {
    commentMutations { archive(input: $input) }
}`

// Speckle has no real comment delete — only archive (soft-hide). Called when
// a BCF topic is deleted in the dashboard, so its linked Speckle comment
// doesn't linger there afterward — regardless of which direction linked it:
// a topic WE pushed (direction='pushed') created that comment, but a topic
// that was itself PULLED from a native Speckle comment (direction='pulled')
// is just as linked to it, and deleting the topic here should remove it
// there too. Returns true if a linked comment was found and archived.
export async function archiveLinkedSpeckleComment(projectId, topicGuid, streamId, speckleServer = {}) {
    if (!streamId) return false
    const syncRecords = await listSyncRecords(projectId)
    const record = syncRecords.find(
        (r) => r.topic_guid === topicGuid && (r.direction === 'pushed' || r.direction === 'pulled')
    )
    if (!record) return false
    await speckleGqlFetch(ARCHIVE_COMMENT_MUTATION, {
        input: { commentId: record.speckle_comment_id, projectId: streamId, archived: true },
    }, speckleServer)
    return true
}
