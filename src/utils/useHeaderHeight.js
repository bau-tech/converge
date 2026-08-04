import { useEffect, useState } from 'react'

// Measures the live <header> element via ResizeObserver so callers can
// offset fixed-position UI (sticky viewer pins, full-height drawers) below
// it without hardcoding a height that drifts across mobile/desktop or when
// the header's row count changes (e.g. metrics strip visibility).
export function useHeaderHeight() {
    const [height, setHeight] = useState(0)
    useEffect(() => {
        const headerEl = document.querySelector('header')
        if (!headerEl) return
        const update = () => setHeight(headerEl.getBoundingClientRect().height)
        update()
        const ro = new ResizeObserver(update)
        ro.observe(headerEl)
        return () => ro.disconnect()
    }, [])
    return height
}
