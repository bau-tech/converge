import { useEffect, useRef, useState } from 'react'
import { useAuthedImage } from '../utils/useAuthedImage'

const FRAME_COUNT = 24
// Reference frame dimensions the offset math below is built around — match
// Speckle server's own preview-service sprite layout (see frontend-2's
// calculatePanoramaStyle in components/preview/Image.vue).
const FRAME_REFERENCE_WIDTH = 700
const FRAME_REFERENCE_HEIGHT = 400

// Reproduces Speckle's own web app hover-preview (frontend-2's
// components/preview/Image.vue + lib/projects/composables/previewImage.ts):
// on hover, lazily fetch a 24-frame sprite sheet from the preview service's
// `{previewUrl}/all` endpoint, then use horizontal mouse position within the
// thumbnail to pick which frame to show via background-position — a
// mouse-driven turntable illusion, NOT a live 3D viewer or automatic
// rotation. No WebGL, and zero extra network cost until actually hovered.
export function PanoramaThumbnail({ baseUrl, panoramaUrl, token, alt = '' }) {
    const containerRef = useRef(null)
    const [hovered, setHovered] = useState(false)
    const [wantPanorama, setWantPanorama] = useState(false)
    const [panoramaReady, setPanoramaReady] = useState(false)
    const [isPlaceholder, setIsPlaceholder] = useState(false)
    const [bgPosX, setBgPosX] = useState(0)

    const baseBlobUrl = useAuthedImage(baseUrl, token)
    // Only starts fetching once wantPanorama flips true on first hover — and
    // stays true afterwards, so re-hovering never re-fetches the sprite sheet.
    const panoramaBlobUrl = useAuthedImage(wantPanorama ? panoramaUrl : null, token)

    useEffect(() => {
        if (hovered && panoramaUrl) setWantPanorama(true)
    }, [hovered, panoramaUrl])

    useEffect(() => {
        if (!panoramaBlobUrl) { setPanoramaReady(false); return }
        const img = new Image()
        img.onload = () => {
            // Speckle server returns a small placeholder (<=700px wide, a
            // single frame) if the panorama hasn't been generated yet for
            // this commit — fall back to the static thumbnail in that case.
            setIsPlaceholder(img.naturalWidth <= FRAME_REFERENCE_WIDTH)
            setPanoramaReady(true)
        }
        img.src = panoramaBlobUrl
    }, [panoramaBlobUrl])

    const handleMouseMove = (e) => {
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect || !rect.width) return
        const x = e.clientX - rect.left
        const step = rect.width / FRAME_COUNT
        let index = Math.abs(FRAME_COUNT - Math.round(x / step))
        if (index >= FRAME_COUNT) index = FRAME_COUNT - 1

        const scaleFactor = rect.height / FRAME_REFERENCE_HEIGHT
        const actualWidth = scaleFactor * FRAME_REFERENCE_WIDTH
        const widthDiff = (rect.width - actualWidth) * 0.5
        setBgPosX(-(actualWidth * (2 * index + 1) - widthDiff))
    }

    const showPanorama = hovered && panoramaReady && !isPlaceholder && !!panoramaBlobUrl

    return (
        <div
            ref={containerRef}
            className="relative w-full h-full"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onMouseMove={handleMouseMove}
        >
            <img
                src={baseBlobUrl}
                className={`w-full h-full object-cover transition-opacity duration-150 ${showPanorama ? 'opacity-0' : 'opacity-100'}`}
                alt={alt}
            />
            {showPanorama && (
                <div
                    className="absolute inset-0 bg-cover bg-no-repeat"
                    style={{ backgroundImage: `url('${panoramaBlobUrl}')`, backgroundPosition: `${bgPosX}px 0` }}
                />
            )}
        </div>
    )
}
