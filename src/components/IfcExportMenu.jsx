import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { IfcLogoIcon } from './IfcLogoIcon'

/**
 * IFC export entry point for the header toolbar. The primary icon button
 * keeps exporting IFC4X3 directly on click (unchanged from before this
 * component existed), with a small adjacent chevron opening a popover that
 * additionally offers the EXPERIMENTAL IFC5 (.ifcx) export — kept visually
 * secondary (behind an extra click, clearly labeled Alpha) since IFC5 is
 * still an unratified buildingSMART spec.
 */
export function IfcExportMenu({
    disabled, exportingIfc, exportingIfcx, isIfcSource, onExportIfc4x3, onExportIfcx,
}) {
    const [open, setOpen] = useState(false)
    const rootRef = useRef(null)
    const busy = exportingIfc || exportingIfcx

    useEffect(() => {
        if (!open) return
        const onDocClick = (e) => {
            if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDocClick)
        return () => document.removeEventListener('mousedown', onDocClick)
    }, [open])

    return (
        <div ref={rootRef} className="relative flex items-center gap-1">
            <motion.button whileHover={{ scale: busy ? 1 : 1.05 }} whileTap={{ scale: busy ? 1 : 0.95 }}
                onClick={onExportIfc4x3}
                disabled={disabled || busy}
                className={`glass-card icon-btn hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed ${busy ? 'opacity-60' : ''}`}
                title={
                    exportingIfcx ? 'Exporting IFC5 (.ifcx)…'
                        : isIfcSource ? 'Download original IFC from Speckle' : 'Export IFC4X3'
                }
            >
                {busy ? <Loader2 className="w-6 h-6 animate-spin" /> : <IfcLogoIcon className="w-6 h-6" />}
            </motion.button>

            <button
                onClick={() => setOpen(v => !v)}
                disabled={disabled || busy}
                title="More export formats"
                className="glass-card icon-btn hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed !w-4"
            >
                <ChevronDown className="w-3.5 h-3.5" />
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: 6, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 6, scale: 0.97 }}
                        transition={{ duration: 0.12 }}
                        className="absolute top-full right-0 mt-2 w-64 glass-card rounded-xl border border-white/10 shadow-2xl z-50 overflow-hidden p-0"
                    >
                        <button
                            onClick={() => { setOpen(false); onExportIfc4x3() }}
                            disabled={busy}
                            className="w-full text-left px-3 py-2.5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed border-b border-white/8"
                        >
                            <div className="text-xs font-medium text-zinc-200">
                                {isIfcSource ? 'Download original IFC' : 'Export IFC4X3'}
                            </div>
                            <div className="text-[10px] text-zinc-500 mt-0.5">Stable, widely supported format</div>
                        </button>
                        <button
                            onClick={() => { setOpen(false); onExportIfcx() }}
                            disabled={busy}
                            className="w-full text-left px-3 py-2.5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            <div className="flex items-center gap-1.5">
                                <span className="text-xs font-medium text-zinc-200">Export IFC5 (.ifcx)</span>
                                <span className="text-[9px] font-bold tracking-wide uppercase px-1.5 py-0.5 rounded-full bg-amber-400/15 text-amber-400">
                                    Alpha
                                </span>
                            </div>
                            <div className="text-[10px] text-zinc-500 mt-1">
                                Format may still change — early testing only, not for production deliverables
                            </div>
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
