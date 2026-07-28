import { useState } from 'react'
import { Upload, X, Loader2, CheckCircle2, ExternalLink } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'

/**
 * Floating button + inline dialog to publish the current viewer filter/selection
 * as a new Speckle commit via the normalizer filter-publish API.
 *
 * Visible only when speckleIds is non-empty and modelId is known.
 */
export default function PublishSelectionButton({ normalizerUrl, modelId, speckleIds }) {
    const [open,    setOpen]   = useState(false)
    const [branch,  setBranch] = useState('filtered/selection')
    const [message, setMessage]= useState('')
    const [status,  setStatus] = useState('idle')   // idle | publishing | done | error
    const [result,  setResult] = useState(null)
    const [error,   setError]  = useState(null)

    const count = speckleIds?.length || 0
    if (!modelId || count === 0) return null

    const openDialog = () => {
        setOpen(true)
        setStatus('idle')
        setResult(null)
        setError(null)
    }

    const closeDialog = () => {
        if (status === 'publishing') return
        setOpen(false)
    }

    const handlePublish = async () => {
        setStatus('publishing')
        setError(null)
        try {
            const res = await fetch(`${normalizerUrl}/models/${modelId}/filter-publish`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    speckle_ids: speckleIds,
                    target_branch: branch.trim() || 'filtered/selection',
                    message: message.trim() || `Filtered: ${count} elements`,
                }),
            })
            if (!res.ok) throw new Error(`Server error ${res.status}`)
            const job = await res.json()

            for (let i = 0; i < 60; i++) {
                await new Promise(r => setTimeout(r, 3000))
                const sr = await fetch(`${normalizerUrl}/filter-publish/${job.job_id}/status`)
                if (!sr.ok) throw new Error(`Status check failed (${sr.status})`)
                const s = await sr.json()
                if (s.status === 'complete') { setResult(s.result); setStatus('done'); return }
                if (s.status === 'failed')   throw new Error(s.error || 'Publish failed')
            }
            throw new Error('Timed out waiting for publish job')
        } catch (e) {
            setError(e.message)
            setStatus('error')
        }
    }

    const popoverAnim = {
        initial:    { opacity: 0, y: 8, scale: 0.96 },
        animate:    { opacity: 1, y: 0, scale: 1    },
        exit:       { opacity: 0, y: 8, scale: 0.96 },
        transition: { duration: 0.15 },
    }

    return (
        <>
            {/* Floating trigger pill */}
            <AnimatePresence>
                {!open && (
                    <motion.button
                        {...popoverAnim}
                        onClick={openDialog}
                        title={`Publish ${count} selected element(s) as a new Speckle version`}
                        className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-6 z-50 flex items-center gap-2 px-3 py-2 rounded-full bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-xs font-semibold shadow-lg transition-colors"
                    >
                        <Upload className="w-3.5 h-3.5" />
                        Publish {count} element{count !== 1 ? 's' : ''}
                    </motion.button>
                )}
            </AnimatePresence>

            {/* Inline dialog */}
            <AnimatePresence>
                {open && (
                    <motion.div
                        {...popoverAnim}
                        className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-6 z-50 w-72 max-w-[calc(100vw-3rem)] max-h-[calc(100vh-8rem)] overflow-y-auto rounded-xl border border-white/15 bg-zinc-900 shadow-2xl"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-3 pt-3 pb-2 border-b border-white/8">
                            <span className="text-xs font-semibold text-blue-400 flex items-center gap-1.5">
                                <Upload className="w-3.5 h-3.5" />
                                Publish Selection
                            </span>
                            <button
                                onClick={closeDialog}
                                disabled={status === 'publishing'}
                                className="text-zinc-500 hover:text-white transition-colors disabled:opacity-30"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>

                        <div className="p-3 space-y-3">
                            {status === 'done' ? (
                                /* Success state */
                                <div className="space-y-2">
                                    <div className="flex items-center gap-2 text-emerald-400">
                                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                                        <span className="text-xs font-medium">
                                            Published {result.element_count} element{result.element_count !== 1 ? 's' : ''}
                                        </span>
                                    </div>
                                    <p className="text-[11px] text-zinc-400">
                                        Branch: <span className="text-zinc-300 font-mono">{result.branch_name}</span>
                                    </p>
                                    <a
                                        href={result.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="flex items-center gap-1.5 text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
                                    >
                                        <ExternalLink className="w-3 h-3" />
                                        Open in Speckle viewer
                                    </a>
                                    <button
                                        onClick={closeDialog}
                                        className="w-full py-1.5 rounded-lg text-[11px] text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
                                    >
                                        Close
                                    </button>
                                </div>
                            ) : (
                                /* Input state */
                                <>
                                    <p className="text-[11px] text-zinc-400">
                                        Publishing{' '}
                                        <span className="text-zinc-200 font-semibold">{count}</span>{' '}
                                        element{count !== 1 ? 's' : ''} as a new model version.
                                    </p>

                                    <div className="space-y-1">
                                        <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-medium">
                                            Branch
                                        </label>
                                        <input
                                            value={branch}
                                            onChange={e => setBranch(e.target.value)}
                                            placeholder="filtered/selection"
                                            disabled={status === 'publishing'}
                                            className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-white/10 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500/50 disabled:opacity-50"
                                        />
                                    </div>

                                    <div className="space-y-1">
                                        <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-medium">
                                            Message{' '}
                                            <span className="normal-case text-zinc-600">(optional)</span>
                                        </label>
                                        <input
                                            value={message}
                                            onChange={e => setMessage(e.target.value)}
                                            placeholder={`Filtered: ${count} elements`}
                                            disabled={status === 'publishing'}
                                            className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-white/10 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500/50 disabled:opacity-50"
                                        />
                                    </div>

                                    {status === 'error' && (
                                        <p className="text-[11px] text-red-400 break-words">{error}</p>
                                    )}

                                    <button
                                        onClick={handlePublish}
                                        disabled={status === 'publishing' || !branch.trim()}
                                        className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors flex items-center justify-center gap-2"
                                    >
                                        {status === 'publishing' ? (
                                            <>
                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                Publishing…
                                            </>
                                        ) : (
                                            <>
                                                <Upload className="w-3.5 h-3.5" />
                                                Publish to Speckle
                                            </>
                                        )}
                                    </button>
                                </>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    )
}
