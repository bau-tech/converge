// REST wrapper for our self-hosted bcf-server (bim-normalizer/bcf_server.py).
// Uses the static BCF_API_KEY shared credential — separate from the fake
// OAuth2/OIDC shim that external clients like BIMcollab ZOOM go through.
const BCF_URL = import.meta.env.VITE_BCF_URL || '/bcf'
// Non-spec helper endpoints (project resolve, .bcfzip export/import) live on
// a sibling path, proxied by nginx as its own location block — see
// nginx.conf.template's /bcf-bridge/ block.
const BCF_BRIDGE_URL = BCF_URL.replace(/\/bcf$/, '/bcf-bridge')
const BCF_API_KEY = import.meta.env.VITE_BCF_API_KEY || ''
const BCF_VERSION = '2.1'

async function bcfFetch(baseUrl, path, options = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${BCF_API_KEY}`,
            ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
        },
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`bcf-server ${options.method || 'GET'} ${path} failed: ${res.status} ${text}`)
    }
    if (res.status === 204) return null
    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('application/json')) return res.json()
    return res.blob()
}

const bcf = (path, options) => bcfFetch(BCF_URL, path, options)
const bridge = (path, options) => bcfFetch(BCF_BRIDGE_URL, path, options)

export async function resolveBcfProject(streamId) {
    try {
        return await bridge(`/projects/resolve?stream_id=${encodeURIComponent(streamId)}`)
    } catch {
        return null // no model ingested for this stream yet — BCF panel stays disabled
    }
}

export function listTopics(projectId) {
    return bcf(`/${BCF_VERSION}/projects/${projectId}/topics`)
}

export function createTopic(projectId, body) {
    return bcf(`/${BCF_VERSION}/projects/${projectId}/topics`, {
        method: 'POST',
        body: JSON.stringify(body),
    })
}

export function updateTopic(projectId, topicGuid, body) {
    return bcf(`/${BCF_VERSION}/projects/${projectId}/topics/${topicGuid}`, {
        method: 'PUT',
        body: JSON.stringify(body),
    })
}

export function deleteTopic(projectId, topicGuid) {
    return bcf(`/${BCF_VERSION}/projects/${projectId}/topics/${topicGuid}`, { method: 'DELETE' })
}

// Per-project configurable value lists (topic_status, topic_type, priority, ...)
// — used to render Kanban columns that match whatever statuses this project
// actually uses instead of a hardcoded guess.
export function getExtensions(projectId) {
    return bcf(`/${BCF_VERSION}/projects/${projectId}/extensions`)
}

export function listComments(projectId, topicGuid) {
    return bcf(`/${BCF_VERSION}/projects/${projectId}/topics/${topicGuid}/comments`)
}

export function createComment(projectId, topicGuid, body) {
    return bcf(`/${BCF_VERSION}/projects/${projectId}/topics/${topicGuid}/comments`, {
        method: 'POST',
        body: JSON.stringify(body),
    })
}

export function listViewpoints(projectId, topicGuid) {
    return bcf(`/${BCF_VERSION}/projects/${projectId}/topics/${topicGuid}/viewpoints`)
}

export function createViewpoint(projectId, topicGuid, body) {
    return bcf(`/${BCF_VERSION}/projects/${projectId}/topics/${topicGuid}/viewpoints`, {
        method: 'POST',
        body: JSON.stringify(body),
    })
}

// Returns a blob: object URL for an <img> src — the raw endpoint requires a
// Bearer header that a plain <img src> can't send, so we fetch it ourselves.
// Caller is responsible for URL.revokeObjectURL() once done with it.
export async function getSnapshotUrl(projectId, topicGuid, viewpointGuid) {
    const blob = await bcf(`/${BCF_VERSION}/projects/${projectId}/topics/${topicGuid}/viewpoints/${viewpointGuid}/snapshot`)
    return URL.createObjectURL(blob)
}

export async function exportBcfzip(projectId) {
    const blob = await bridge(`/projects/${projectId}/export`)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${projectId}.bcfzip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
}

export function importBcfzip(projectId, file) {
    const formData = new FormData()
    formData.append('file', file)
    return bridge(`/projects/${projectId}/import`, { method: 'POST', body: formData })
}

// Persistent Speckle<->BCF sync bookkeeping — survives topic deletion (unlike
// bcf_topics.labels), so a deleted topic's source comment is never re-pulled.
export function listSyncRecords(projectId) {
    return bridge(`/projects/${projectId}/sync`)
}

export function recordSync(projectId, { speckleCommentId, topicGuid, direction }) {
    return bridge(`/projects/${projectId}/sync`, {
        method: 'POST',
        body: JSON.stringify({ speckle_comment_id: speckleCommentId, topic_guid: topicGuid, direction }),
    })
}

// Per-comment sync bookkeeping (separate from the topic-level table above) —
// tracks which individual BCF comments have already been relayed as a
// Speckle reply, so re-syncing doesn't duplicate replies on every load.
export function listCommentSync(projectId) {
    return bridge(`/projects/${projectId}/comment-sync`)
}

export function recordCommentSync(projectId, commentGuid, speckleReplyId) {
    return bridge(`/projects/${projectId}/comment-sync`, {
        method: 'POST',
        body: JSON.stringify({ comment_guid: commentGuid, speckle_reply_id: speckleReplyId }),
    })
}
