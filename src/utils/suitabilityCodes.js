// ISO 19650 "purpose of issue" suitability codes — mirrors
// bim-normalizer/naming/suitability.py (keep the two in sync manually, same
// as this repo's other client/server-duplicated constant tables, e.g.
// bcfWorkflow.js's PRIORITY_COLOR has no server-side equivalent to drift
// from, but doc_type/_VALID_STATUSES-style enums are duplicated like this).
export const SUITABILITY_CODES = {
    S0: 'Initial status — work in progress',
    S1: 'Suitable for coordination',
    S2: 'Suitable for information',
    S3: 'Suitable for review and comment',
    S4: 'Suitable for stage approval',
    A1: 'Authorized — no comment',
    A2: 'Authorized with comments',
    B1: 'Authorized with reservations',
    B2: 'Partially authorized, resubmit',
    C1: 'Published for client',
    D1: 'Published for construction',
}

// Same "semantic Tailwind color + /20 opacity bg + matching /300 text"
// convention as DocumentsPanel.jsx's COLUMN_COLOR badges.
export const SUITABILITY_COLOR = {
    S0: 'bg-zinc-400/20 text-zinc-300',
    S1: 'bg-sky-500/20 text-sky-300',
    S2: 'bg-blue-500/20 text-blue-300',
    S3: 'bg-indigo-500/20 text-indigo-300',
    S4: 'bg-violet-500/20 text-violet-300',
    A1: 'bg-emerald-500/20 text-emerald-300',
    A2: 'bg-teal-500/20 text-teal-300',
    B1: 'bg-amber-500/20 text-amber-300',
    B2: 'bg-orange-500/20 text-orange-300',
    C1: 'bg-purple-500/20 text-purple-300',
    D1: 'bg-pink-500/20 text-pink-300',
}
