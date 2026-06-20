// Shared BCF Kanban workflow mapping — single source of truth for
// BcfKanbanBoard.jsx and BcfStatsWidget.jsx so the two views can't drift.
//
// Columns are derived from two raw BCF fields (topic_status + stage), which
// has no value constraint in the schema, so these are free-text values we
// own rather than something configured via bcf_extensions.
export const COLUMNS = ['Backlog', 'To Do', 'In Progress', 'Review', 'Done']

export const COLUMN_HEX = {
    Backlog: '#71717a',       // zinc-500
    'To Do': '#f59e0b',       // amber-500
    'In Progress': '#3b82f6', // blue-500
    Review: '#a855f7',        // purple-500
    Done: '#10b981',          // emerald-500
}

// status/stage -> column. Closed always wins (a closed topic is Done
// regardless of whatever stage it was last in). Otherwise stage drives the
// column; `topic_status === 'In Progress'` is a fallback for topics created
// by the old 3-status flow (or an external BCF-API client) that have no
// `stage` set yet. Open with no recognized stage is fresh, unstarted work.
export function topicToColumn(topic) {
    if (topic.topic_status === 'Closed') return 'Done'
    if (topic.stage === 'Review') return 'Review'
    if (topic.stage === 'InProgress') return 'In Progress'
    if (topic.stage === 'Requested') return 'To Do'
    if (topic.topic_status === 'In Progress') return 'In Progress'
    return 'Backlog'
}

// Column -> the status/stage update to send on drop.
export function columnToUpdates(column) {
    switch (column) {
        case 'Backlog':     return { topic_status: 'Open', stage: null }
        case 'To Do':       return { topic_status: 'Open', stage: 'Requested' }
        case 'In Progress': return { topic_status: 'Open', stage: 'InProgress' }
        case 'Review':      return { topic_status: 'Open', stage: 'Review' }
        case 'Done':        return { topic_status: 'Closed' }
        default:            return {}
    }
}
