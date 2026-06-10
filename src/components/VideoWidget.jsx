import { useState } from 'react'
import { Video, Link2, Pencil, X } from 'lucide-react'

function toEmbedUrl(raw) {
    if (!raw?.trim()) return null
    try {
        const u = new URL(raw.trim())
        // Already an embed URL
        if (u.pathname.startsWith('/videos/embed/')) return raw.trim()
        // /videos/watch/ID
        const watchMatch = u.pathname.match(/^\/videos\/watch\/([^/?#]+)/)
        if (watchMatch) return `${u.origin}/videos/embed/${watchMatch[1]}`
        // /w/ID  (short link)
        const shortMatch = u.pathname.match(/^\/w\/([^/?#]+)/)
        if (shortMatch) return `${u.origin}/videos/embed/${shortMatch[1]}`
        // Return as-is for generic iframe URLs
        return raw.trim()
    } catch {
        return null
    }
}

export function VideoWidget({ url, onUpdateUrl }) {
    const [editing, setEditing] = useState(!url)
    const [draft, setDraft] = useState(url || '')

    const embedUrl = toEmbedUrl(url)

    const handleSave = () => {
        const embed = toEmbedUrl(draft)
        if (embed) {
            onUpdateUrl(draft.trim())
            setEditing(false)
        }
    }

    if (editing) {
        return (
            <div className="h-full flex flex-col items-center justify-center gap-4 p-6">
                <div className="flex flex-col items-center gap-2 text-center">
                    <Video className="w-8 h-8 text-[var(--speckle-foreground-3)]" />
                    <p className="text-sm font-medium text-[var(--speckle-foreground)]">PeerTube Video</p>
                    <p className="text-xs text-[var(--speckle-foreground-3)]">Paste a PeerTube video URL to embed it</p>
                </div>
                <div className="w-full max-w-sm flex gap-2">
                    <div className="relative flex-1">
                        <Link2 className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--speckle-foreground-3)] pointer-events-none" />
                        <input
                            autoFocus
                            type="url"
                            value={draft}
                            onChange={e => setDraft(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                            placeholder="https://peertube.example.com/w/abc123"
                            className="w-full glass pl-8 pr-3 py-1.5 rounded-lg text-sm bg-[var(--speckle-foundation-page)] text-[var(--speckle-foreground)] placeholder:text-[var(--speckle-foreground-3)] border border-white/10 focus:outline-none focus:ring-1 focus:ring-[var(--speckle-outline-1)]"
                        />
                    </div>
                    <button
                        onClick={handleSave}
                        disabled={!draft.trim()}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 transition-colors"
                    >
                        Embed
                    </button>
                    {url && (
                        <button
                            onClick={() => { setDraft(url); setEditing(false) }}
                            className="p-1.5 rounded-lg text-[var(--speckle-foreground-3)] hover:bg-white/5 transition-colors"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>
            </div>
        )
    }

    return (
        <div className="relative h-full group">
            <iframe
                src={embedUrl}
                className="w-full h-full border-0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
                sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                title="PeerTube video"
            />
            <button
                onClick={() => { setDraft(url); setEditing(true) }}
                className="absolute top-2 right-2 p-1.5 rounded-lg glass-card opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/10"
                title="Change video URL"
            >
                <Pencil className="w-3.5 h-3.5 text-[var(--speckle-foreground-2)]" />
            </button>
        </div>
    )
}
