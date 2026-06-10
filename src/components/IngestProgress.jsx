import { motion, AnimatePresence } from 'framer-motion'
import { Loader2 } from 'lucide-react'

const PHASES = [
    { id: 'connecting', label: 'Connecting' },
    { id: 'ingesting',  label: 'Ingesting model' },
    { id: 'parsing',    label: 'Loading analytics' },
    { id: 'ready',      label: 'Ready' },
]

export function IngestProgress({ phase }) {
    const currentIdx = PHASES.findIndex(p => p.id === phase)
    const isReady = phase === 'ready'
    const progressPct = phase === null ? 0
        : isReady ? 100
        : Math.round((currentIdx / (PHASES.length - 1)) * 100)

    return (
        <AnimatePresence>
            {phase && (
                <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden border-t border-white/5"
                >
                    <div className="px-4 lg:px-6 py-2">
                        <div className="flex items-center gap-4 mb-1.5">
                            {PHASES.map((p, i) => {
                                const done = i < currentIdx
                                const active = i === currentIdx
                                return (
                                    <div key={p.id} className="flex items-center gap-1.5">
                                        <div className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                                            done   ? 'bg-green-500' :
                                            active ? 'bg-primary animate-pulse' :
                                                     'bg-zinc-700'
                                        }`} />
                                        <span className={`text-xs transition-colors duration-300 hidden sm:block ${
                                            done   ? 'text-green-500' :
                                            active ? 'text-zinc-200' :
                                                     'text-zinc-700'
                                        }`}>
                                            {p.label}
                                        </span>
                                        {i < PHASES.length - 1 && (
                                            <div className={`w-5 h-px ml-1 hidden sm:block transition-colors duration-500 ${
                                                done ? 'bg-green-500/40' : 'bg-zinc-800'
                                            }`} />
                                        )}
                                    </div>
                                )
                            })}
                            <div className="ml-auto shrink-0">
                                {!isReady && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />}
                            </div>
                        </div>
                        <div className="h-0.5 bg-zinc-800 rounded-full overflow-hidden">
                            <motion.div
                                className="h-full rounded-full"
                                style={{ background: 'linear-gradient(90deg, #136CFF 0%, #4B40C9 100%)' }}
                                initial={{ width: '0%' }}
                                animate={{ width: `${progressPct}%` }}
                                transition={{ duration: 0.5, ease: 'easeOut' }}
                            />
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}
