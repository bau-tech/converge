import { useEffect, useState } from 'react'

function useDebouncedValue(value, delay) {
    const [debounced, setDebounced] = useState(value)
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), delay)
        return () => clearTimeout(t)
    }, [value, delay])
    return debounced
}

// Free-text input with a suggestion dropdown — always editable (IDS accepts
// any string for these fields), suggestions are just an accelerator. Two
// sourcing modes: a static `options` array (filtered locally on every
// keystroke) for suggestions already in memory, or an async `loadOptions(query)`
// for remote sources (e.g. the bSDD proxy) — debounced and only queried while
// the dropdown is open. `onSelect(option)` fires in addition to `onChange`
// when a suggestion is explicitly picked, for callers that need the full
// option object (e.g. a bSDD class's URI), not just its `value`.
export function SearchableCombobox({
    label, hint, value, onChange, onSelect, placeholder, mono, disabled,
    options, loadOptions, emptyHint,
}) {
    const [open, setOpen] = useState(false)
    const [highlighted, setHighlighted] = useState(0)
    const [asyncOptions, setAsyncOptions] = useState(null)
    const [loading, setLoading] = useState(false)
    const [loadError, setLoadError] = useState(null)
    const debouncedQuery = useDebouncedValue(value || '', 250)

    useEffect(() => {
        if (!loadOptions || !open) return
        let cancelled = false
        setLoading(true)
        setLoadError(null)
        loadOptions(debouncedQuery)
            .then(opts => { if (!cancelled) setAsyncOptions(opts) })
            .catch(err => { if (!cancelled) setLoadError(err.message) })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [loadOptions, debouncedQuery, open])

    const filtered = loadOptions
        ? (asyncOptions || [])
        : (options || []).filter(o => {
            if (!value) return true
            const needle = value.toLowerCase()
            return o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle)
        })

    const commit = (opt) => {
        onChange(opt.value)
        onSelect?.(opt)
        setOpen(false)
    }

    const handleKeyDown = (e) => {
        if (!open) return
        if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted(h => Math.min(h + 1, filtered.length - 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)) }
        else if (e.key === 'Enter') { if (filtered[highlighted]) { e.preventDefault(); commit(filtered[highlighted]) } }
        else if (e.key === 'Escape') { setOpen(false) }
    }

    const showDropdown = open && (loading || loadError || filtered.length > 0 || emptyHint)

    return (
        <label className="block relative">
            <span className="flex items-center justify-between gap-1.5 text-[9px] uppercase tracking-wide text-[var(--speckle-foreground-3)] mb-0.5">
                <span className="truncate">{label}</span>
                {hint && <span className="normal-case tracking-normal opacity-80 truncate">{hint}</span>}
            </span>
            <input
                value={value || ''}
                disabled={disabled}
                onChange={e => { onChange(e.target.value); setOpen(true); setHighlighted(0) }}
                onFocus={() => setOpen(true)}
                onBlur={() => setTimeout(() => setOpen(false), 150)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                className={`nodrag w-full px-1.5 py-1 rounded text-[11px] bg-[var(--speckle-foundation-page)] text-[var(--speckle-foreground)] border border-[var(--speckle-outline-3)] outline-none disabled:opacity-40 ${mono ? 'font-mono' : ''}`}
            />
            {showDropdown && (
                <div
                    className="nodrag nowheel absolute z-10 mt-0.5 w-full max-h-36 overflow-y-auto rounded border border-[var(--speckle-outline-3)] shadow-lg"
                    style={{ background: 'var(--speckle-foundation)' }}
                >
                    {loading && <div className="px-2 py-1 text-[10px] text-[var(--speckle-foreground-3)]">Loading…</div>}
                    {!loading && loadError && <div className="px-2 py-1 text-[10px] text-red-400">{loadError} — type freely</div>}
                    {!loading && !loadError && filtered.length === 0 && emptyHint && (
                        <div className="px-2 py-1 text-[10px] text-[var(--speckle-foreground-3)]">{emptyHint}</div>
                    )}
                    {!loading && filtered.map((opt, i) => (
                        <div
                            key={`${opt.value}-${i}`}
                            onMouseDown={e => { e.preventDefault(); commit(opt) }}
                            className={`px-2 py-1 text-[11px] cursor-pointer flex items-center justify-between gap-2 ${i === highlighted ? 'bg-[var(--speckle-outline-3)]' : 'hover:bg-[var(--speckle-outline-3)]'}`}
                        >
                            <span className="truncate text-[var(--speckle-foreground)]">{opt.label}</span>
                            {opt.meta && (
                                <span className={`text-[9px] shrink-0 ${opt.recommended ? 'text-amber-400 font-medium' : 'text-[var(--speckle-foreground-3)]'}`}>
                                    {opt.meta}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </label>
    )
}
