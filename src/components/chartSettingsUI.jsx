// Shared style tokens for the chart "properties window" surfaces — the
// settings popover in DashboardGrid.jsx and the ChartBuilder modal both
// import these so an active/selected state always looks identical
// regardless of which surface it appears in.
export const settingBtnCls = "px-1.5 py-1 rounded-md text-[11px] font-medium cursor-pointer transition-colors border"
export const settingBtnInactive = "border-[var(--speckle-outline-3)] bg-[var(--speckle-foundation)] text-[var(--speckle-foreground-3)] hover:border-[var(--speckle-outline-2)]"
export const settingBtnActive = "border-[var(--speckle-outline-1)] bg-[var(--speckle-outline-1)]/15 text-[var(--speckle-outline-1)]"
export const settingInputCls = "w-full glass rounded-md px-2 py-1 text-xs text-[var(--speckle-foreground)] outline-none focus:ring-1 focus:ring-[var(--speckle-outline-1)]/50 transition-colors"

export function ColorRow({ label, value, onChange }) {
    return (
        <div className="flex items-center justify-between">
            <span className="text-[11px] text-[var(--speckle-foreground-3)]">{label}</span>
            <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-[var(--speckle-foreground-3)] font-mono">{value}</span>
                <input type="color" value={value} onChange={e => onChange(e.target.value)}
                    className="w-7 h-[22px] border border-[var(--speckle-outline-3)] rounded cursor-pointer bg-transparent p-px" />
            </div>
        </div>
    )
}
