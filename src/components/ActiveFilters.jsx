import { Filter, X } from 'lucide-react'

export function ActiveFilters({ chartFilters = {}, onRemoveFilter, onClearAll }) {
    const entries = Object.entries(chartFilters)
    if (entries.length === 0) return null

    return (
        <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-1.5 shrink-0">
                <Filter className="w-3.5 h-3.5 text-cyan-500" />
                <span className="text-xs font-semibold text-cyan-500 uppercase tracking-wider">
                    Filters
                </span>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400">
                    {entries.length}
                </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                {entries.map(([field, value]) => (
                    <div
                        key={field}
                        className="flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full
                                   bg-cyan-500/10 border border-cyan-500/25
                                   hover:bg-cyan-500/15 transition-colors group"
                    >
                        <span className="text-xs font-medium text-cyan-400">{formatFieldName(field)}:</span>
                        <span className="text-xs text-zinc-300">{value}</span>
                        <button
                            onClick={() => onRemoveFilter(field)}
                            className="ml-0.5 p-0.5 rounded-full hover:bg-red-500/20 transition-colors"
                            title={`Remove ${formatFieldName(field)} filter`}
                        >
                            <X className="w-2.5 h-2.5 text-zinc-500 group-hover:text-red-400 transition-colors" />
                        </button>
                    </div>
                ))}
            </div>

            {entries.length > 1 && (
                <button
                    onClick={onClearAll}
                    className="shrink-0 text-xs text-zinc-500 hover:text-red-400 transition-colors flex items-center gap-1"
                >
                    <X className="w-3 h-3" /> Clear all
                </button>
            )}
        </div>
    )
}

function formatFieldName(field) {
    return field
        .replace(/_/g, ' ')
        .split(' ')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
}
