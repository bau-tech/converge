import { useState, useCallback, useEffect, useRef } from 'react'

// Shared resizable width for the right-docked Clash/IDS check drawers
// (ClashCheckPanel, IdsCheckPanel) — one persisted setting so both panels
// stay at whatever width the user last dragged them to.
const STORAGE_KEY = 'bim-check-panel-width'
const DEFAULT_WIDTH = 920
const MIN_WIDTH = 420
const MAX_WIDTH = 1400

function loadWidth() {
    const saved = Number(localStorage.getItem(STORAGE_KEY))
    return saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : DEFAULT_WIDTH
}

export function useDrawerWidth() {
    const [width, setWidth] = useState(loadWidth)
    const draggingRef = useRef(false)

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, String(width))
    }, [width])

    const startResize = useCallback((e) => {
        e.preventDefault()
        draggingRef.current = true
        const startX = e.clientX
        const startWidth = width
        const prevUserSelect = document.body.style.userSelect
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'col-resize'

        const onMove = (ev) => {
            if (!draggingRef.current) return
            // Panel is docked to the right edge — dragging the handle left
            // (negative clientX delta) should widen it.
            const next = startWidth + (startX - ev.clientX)
            setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)))
        }
        const onUp = () => {
            draggingRef.current = false
            document.body.style.userSelect = prevUserSelect
            document.body.style.cursor = ''
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
    }, [width])

    return [width, startResize]
}
