import { motion } from 'framer-motion'
import { X, Layers, Eye, EyeOff } from 'lucide-react'

// Overlay shown while "combine models" (federated viewing) is active — lists
// each combined discipline model with its tint color and an independent
// show/hide toggle, mirroring DiffBar's structure/positioning for the other
// viewer "mode" overlay (Diff/Compare).
//
// Controlled by `models[].hidden` (App.jsx's combinedModels state, flipped
// via onToggleVisibility -> setCombinedModelHidden) rather than owning its
// own hidden-set state — a model's hidden flag drives SpeckleViewer's
// federated-loading effect to genuinely unload/reload its geometry, the
// same mechanism CombineModelsPicker's checkboxes use, instead of a
// separate hide/show-on-already-loaded-geometry path that silently no-oped
// once 3+ models were combined.
export function FederatedBar({ models = [], onToggleVisibility, onExit }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="absolute top-3 left-3 right-3 z-20"
        >
            <div className="rounded-xl border border-amber-500/20 bg-[var(--speckle-foundation-2)] shadow-2xl p-2 flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-400 pr-1">
                    <Layers className="w-3.5 h-3.5" />
                    Combined View
                </div>

                <div className="w-px h-4 bg-[var(--speckle-outline-3)] flex-shrink-0" />

                {models.map((m) => {
                    const isHidden = !!m.hidden
                    return (
                        <button
                            key={m.branchName}
                            onClick={() => onToggleVisibility?.(m.branchName, !isHidden)}
                            title={isHidden ? `Show ${m.branchName}` : `Hide ${m.branchName}`}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all border ${
                                isHidden
                                    ? 'bg-[var(--speckle-outline-3)] border-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] opacity-50'
                                    : 'border-transparent text-[var(--speckle-foreground)]'
                            }`}
                            style={!isHidden ? { backgroundColor: `${m.color}22`, borderColor: `${m.color}55` } : undefined}
                        >
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: m.color }} />
                            {m.branchName}
                            {isHidden ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                        </button>
                    )
                })}

                <div className="flex-1" />

                <button
                    onClick={onExit}
                    title="Exit combined view"
                    className="p-1 rounded-lg hover:bg-[var(--speckle-outline-3)] text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] transition-colors flex-shrink-0"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
        </motion.div>
    )
}
