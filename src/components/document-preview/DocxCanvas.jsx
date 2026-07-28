import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

// .docx (OOXML) only — docx-preview renders straight to HTML/CSS client-side,
// no server round-trip. Legacy binary .doc has no comparable free parser
// (same situation DWG was in before LibreDWG) and isn't handled here.
export function DocxCanvas({ url }) {
    const containerRef = useRef(null)
    const [status, setStatus] = useState('loading') // loading | ready | error
    const [error, setError] = useState(null)

    useEffect(() => {
        let cancelled = false
        async function load() {
            try {
                const { renderAsync } = await import('docx-preview')
                const res = await fetch(url)
                if (!res.ok) throw new Error(`Could not download file (${res.status})`)
                const blob = await res.blob()
                if (cancelled || !containerRef.current) return
                containerRef.current.innerHTML = ''
                await renderAsync(blob, containerRef.current, containerRef.current, {
                    className: 'docx-preview',
                    inWrapper: true,
                    ignoreHeight: true,
                })
                if (!cancelled) setStatus('ready')
            } catch (err) {
                if (!cancelled) { setError(err.message); setStatus('error') }
            }
        }
        load()
        return () => {
            cancelled = true
            if (containerRef.current) containerRef.current.innerHTML = ''
        }
    }, [url])

    return (
        <div className="relative w-full h-full overflow-auto bg-white">
            <div ref={containerRef} className="py-6" />
            {status === 'loading' && (
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-gray-500 bg-white">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading document…
                </div>
            )}
            {status === 'error' && (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-red-500 px-8 text-center bg-white">
                    Could not preview this document: {error}
                </div>
            )}
        </div>
    )
}
