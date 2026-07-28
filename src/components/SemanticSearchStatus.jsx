import { useEffect, useRef, useState } from 'react'

// Embeddings now generate as a background step *after* ingest itself
// reports complete (see bim-normalizer's generate_embeddings_for_model) —
// a large model can take a long while to finish indexing even though its
// data is already fully usable. This is the only visible signal that
// semantic search (AI Assistant's "find elements by meaning" tool) is
// actually ready to return results yet, vs. still catching up.
export function SemanticSearchStatus({ normalizerUrl, modelId }) {
    const [status, setStatus] = useState(null)
    const pollRef = useRef(null)

    useEffect(() => {
        setStatus(null)
        if (pollRef.current) clearInterval(pollRef.current)
        if (!normalizerUrl || !modelId) return

        const base = normalizerUrl.replace(/\/$/, '')
        let cancelled = false

        const poll = async () => {
            try {
                const res = await fetch(`${base}/models/${modelId}/embeddings/status`)
                if (!res.ok || cancelled) return
                const data = await res.json()
                if (cancelled) return
                setStatus(data)
                if (data.ready && pollRef.current) {
                    clearInterval(pollRef.current)
                    pollRef.current = null
                }
            } catch {
                // Transient fetch failure — next tick retries, nothing to show for it.
            }
        }

        poll()
        pollRef.current = setInterval(poll, 15000)
        return () => {
            cancelled = true
            if (pollRef.current) clearInterval(pollRef.current)
        }
    }, [normalizerUrl, modelId])

    if (!status || status.total_elements === 0) return null

    const pct = Math.round((status.embedded_count / status.total_elements) * 100)

    // Mirrors BreadcrumbSelector's Segment layout exactly (flex-col with an
    // invisible category-label row above the content row) so this lines up
    // on the same baseline as "Latest" next to it — Segment's real content
    // row sits below a 9px category label, not at the block's top edge, so
    // without a matching placeholder here the two visually mismatch even
    // though both are vertically centered within the same flex row.
    return (
        <div
            className="flex flex-col items-start gap-0.5 px-2.5 py-1 shrink-0"
            title={
                status.ready
                    ? `Semantic search ready — all ${status.total_elements} elements indexed`
                    : `Semantic search indexing… ${status.embedded_count}/${status.total_elements} elements (${pct}%)`
            }
        >
            <span className="text-[9px] leading-none invisible">.</span>
            <span className="flex items-center gap-1.5 leading-none">
                <span className="relative flex w-3.5 h-3.5 shrink-0">
                    {!status.ready && (
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                    )}
                    <span
                        className={`relative inline-flex rounded-full w-3.5 h-3.5 ${status.ready ? 'bg-green-500' : 'bg-amber-400'}`}
                    />
                </span>
                <span className="hidden lg:inline text-sm font-medium text-[var(--speckle-foreground)]">
                    {status.ready ? 'Search ready' : `Indexing ${pct}%`}
                </span>
            </span>
        </div>
    )
}
