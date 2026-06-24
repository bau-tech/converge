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

// Priority is free-text at the wire level (no bcf_extensions constraint, same
// as topic_status/stage above) — these are client-owned constants for the
// same reason columns are: BcfKanbanBoard, BcfStatsWidget, and BcfTopicPanel
// all need to agree on the same values/colors/ordering.
export const PRIORITIES = ['Low', 'Normal', 'High', 'Critical']

export const PRIORITY_RANK = { Critical: 3, High: 2, Normal: 1, Low: 0 }

// Unset priority sorts after every known value.
export function priorityRank(topic) {
    return PRIORITY_RANK[topic.priority] ?? -1
}

export const PRIORITY_COLOR = {
    Critical: 'bg-red-500/20 text-red-400',
    High: 'bg-orange-500/20 text-orange-400',
    Normal: 'bg-blue-500/20 text-blue-400',
    Low: 'bg-zinc-500/20 text-zinc-400',
}

// Border-accent variant of PRIORITY_COLOR, for the kanban card's left-edge
// stripe — same palette, different CSS property so Critical/High issues are
// scannable without opening a card.
export const PRIORITY_BORDER = {
    Critical: 'border-l-red-500',
    High: 'border-l-orange-500',
    Normal: 'border-l-blue-500',
    Low: 'border-l-zinc-500',
}

// due_date set, not in the Done column, and in the past — same definition
// BcfStatsWidget's "Overdue" tile already counted inline; shared here so card
// rendering can't drift from that count.
export function isOverdue(topic) {
    if (!topic.due_date) return false
    if (topicToColumn(topic) === 'Done') return false
    return new Date(topic.due_date).getTime() < Date.now()
}
