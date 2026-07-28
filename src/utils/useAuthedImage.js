import { useEffect, useState } from 'react'

// Speckle's preview-service endpoint (`{server}/preview/{streamId}/commits/
// {commitId}[/all]`) only honors an Authorization header — a ?token= query
// param is silently ignored and falls back to its "this stream is private"
// placeholder, confirmed against a real deployment even for a token that
// owns the stream. A plain <img src>, CSS background-image, or `new
// Image()` can't attach a custom header, so fetch the bytes ourselves with
// the header and hand back a local blob: URL instead.
export function useAuthedImage(url, token) {
    const [blobUrl, setBlobUrl] = useState(null)

    useEffect(() => {
        if (!url || !token) {
            setBlobUrl(null)
            return
        }
        let cancelled = false
        let objectUrl = null
        fetch(url, { headers: { Authorization: `Bearer ${token}` } })
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                return res.blob()
            })
            .then(blob => {
                if (cancelled) return
                objectUrl = URL.createObjectURL(blob)
                setBlobUrl(objectUrl)
            })
            .catch(() => { if (!cancelled) setBlobUrl(null) })
        return () => {
            cancelled = true
            if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
    }, [url, token])

    return blobUrl
}
