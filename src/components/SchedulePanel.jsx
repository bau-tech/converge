import { motion } from 'framer-motion'
import { X, CalendarClock } from 'lucide-react'
import { useDrawerWidth } from '../utils/useDrawerWidth'
import { ScheduleGanttView } from './ScheduleGanttView'

// The native 4D planner: a right-docked resizable drawer (not a full-screen
// modal, unlike the Open Planner Studio iframe it replaces) so the 3D viewer
// stays visible and interactive underneath — element<->task linking needs
// to see it. Gantt/WBS authoring only — build-up playback is a separate
// bottom-docked bar over the 3D viewer (see SchedulePlaybackView), since a
// full-height right drawer would otherwise cover the chart panels.
export function SchedulePanel({
    normalizerModelId, normalizerUrl, viewerSelectedIds,
    onFilterElements, onClose, storeyCounts,
}) {
    const [width, startResize] = useDrawerWidth()

    const handleClose = () => {
        onFilterElements?.(null)
        onClose?.()
    }

    return (
        <motion.div
            initial={{ x: width }} animate={{ x: 0 }} exit={{ x: width }}
            transition={{ type: 'tween', duration: 0.2 }}
            className="fixed top-0 right-0 h-full z-[200000] flex flex-col shadow-2xl border-l border-[var(--speckle-outline-3)]"
            style={{ backgroundColor: 'var(--speckle-foundation-page)', width }}
        >
            <div
                onMouseDown={startResize}
                title="Drag to resize"
                className="absolute left-0 top-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-amber-500/40 active:bg-amber-500/60 transition-colors z-10"
            />
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--speckle-outline-3)] shrink-0">
                <div className="flex items-center gap-2">
                    <CalendarClock className="w-5 h-5 text-[var(--speckle-foreground)]" />
                    <h2 className="font-semibold text-sm text-[var(--speckle-foreground)]">4D Planner</h2>
                </div>
                <button onClick={handleClose} className="p-1.5 hover:bg-[var(--speckle-outline-3)] rounded-lg transition-colors">
                    <X className="w-4 h-4 text-[var(--speckle-foreground-3)]" />
                </button>
            </div>

            <div className="flex-1 min-h-0">
                <ScheduleGanttView
                    normalizerModelId={normalizerModelId}
                    normalizerUrl={normalizerUrl}
                    onFilterElements={onFilterElements}
                    viewerSelectedIds={viewerSelectedIds}
                    storeyCounts={storeyCounts}
                />
            </div>
        </motion.div>
    )
}
