import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Globe, FolderOpen, GitBranch, GitCommit, ChevronRight, Check, Plus, X, Search, Loader2 } from 'lucide-react'

function Popover({ open, children }) {
    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0, y: -6, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.97 }}
                    transition={{ duration: 0.12 }}
                    className="absolute top-full left-0 mt-1 z-[100] glass-card shadow-2xl"
                    style={{ minWidth: '240px', maxWidth: '340px', maxHeight: '400px', overflowY: 'auto' }}
                >
                    {children}
                </motion.div>
            )}
        </AnimatePresence>
    )
}

function Segment({ id, icon: Icon, label, sublabel, description, active, loading, disabled, open, onToggle, children }) {
    return (
        <div className="relative">
            <button
                onClick={() => !disabled && onToggle(id)}
                disabled={disabled}
                title={disabled ? 'Select previous step first' : description}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm transition-all select-none
                    ${open ? 'bg-white/10' : 'hover:bg-white/5'}
                    ${disabled ? 'opacity-35 cursor-not-allowed' : 'cursor-pointer'}
                    ${active && !disabled ? 'text-[var(--speckle-foreground)]' : 'text-[var(--speckle-foreground-3)]'}
                `}
            >
                {loading
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500 shrink-0" />
                    : <Icon className="w-3.5 h-3.5 shrink-0 text-zinc-500" />
                }
                <span className="max-w-[160px] truncate font-medium">{label}</span>
                {sublabel && (
                    <span className="text-zinc-600 text-[11px] hidden xl:inline truncate max-w-[80px]">{sublabel}</span>
                )}
            </button>
            <Popover open={open}>{children}</Popover>
        </div>
    )
}

export function BreadcrumbSelector({
    allServers,
    activeServer,
    onSwitchServer,
    customServers,
    onAddServer,
    onRemoveServer,
    projects,
    selectedProject,
    loadingProjects,
    onSelectProject,
    models,
    selectedModel,
    loadingModels,
    onSelectModel,
    versions,
    selectedVersion,
    loadingVersions,
    onSelectVersion,
}) {
    const [openSeg, setOpenSeg] = useState(null)
    const [showAddServer, setShowAddServer] = useState(false)
    const [serverForm, setServerForm] = useState({ name: '', url: '', token: '' })
    const [projectSearch, setProjectSearch] = useState('')
    const containerRef = useRef(null)

    useEffect(() => {
        if (!openSeg) return
        const handler = (e) => {
            if (containerRef.current && !containerRef.current.contains(e.target))
                setOpenSeg(null)
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [openSeg])

    const toggle = (id) => {
        setOpenSeg(v => v === id ? null : id)
        if (openSeg !== 'project') setProjectSearch('')
    }

    const close = () => setOpenSeg(null)

    const filteredProjects = projectSearch
        ? projects.filter(p => p.name.toLowerCase().includes(projectSearch.toLowerCase()))
        : projects

    const handleAddServer = () => {
        if (!serverForm.url.trim()) return
        onAddServer(serverForm)
        setServerForm({ name: '', url: '', token: '' })
        setShowAddServer(false)
        close()
    }

    return (
        <div ref={containerRef} className="flex items-center gap-0.5 min-w-0">
            {/* Server */}
            <Segment
                id="server" icon={Globe}
                label={activeServer.name}
                description="Speckle server — switch or add a connection"
                active={true}
                open={openSeg === 'server'}
                onToggle={toggle}
            >
                <div className="p-2">
                    <p className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider px-2 pb-1.5">Speckle Server</p>
                    <div className="space-y-0.5">
                        {allServers.map(s => (
                            <button
                                key={s.id}
                                onClick={() => { onSwitchServer(s); close() }}
                                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors text-left
                                    ${s.id === activeServer.id ? 'bg-primary/15 text-primary' : 'hover:bg-white/5 text-[var(--speckle-foreground-2)]'}`}
                            >
                                {s.id === activeServer.id
                                    ? <Check className="w-3 h-3 shrink-0" />
                                    : <span className="w-3 shrink-0" />
                                }
                                <span className="flex-1 truncate font-medium">{s.name}</span>
                                <span className="text-[var(--speckle-foreground-3)] text-[10px] font-mono truncate max-w-[100px]">
                                    {s.url.replace(/^https?:\/\//, '')}
                                </span>
                                {customServers.some(c => c.id === s.id) && (
                                    <button
                                        onClick={e => { e.stopPropagation(); onRemoveServer(s.id) }}
                                        className="text-[var(--speckle-foreground-3)] hover:text-red-400 transition-colors shrink-0 p-0.5"
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                )}
                            </button>
                        ))}
                    </div>
                    <div className="border-t border-white/5 mt-2 pt-2">
                        {!showAddServer ? (
                            <button
                                onClick={() => setShowAddServer(true)}
                                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] hover:bg-white/5 transition-colors"
                            >
                                <Plus className="w-3 h-3" /> Add server
                            </button>
                        ) : (
                            <div className="space-y-2 px-1">
                                <input
                                    type="text" placeholder="Display name" value={serverForm.name}
                                    onChange={e => setServerForm(p => ({ ...p, name: e.target.value }))}
                                    className="w-full glass px-2.5 py-1.5 rounded-md text-xs bg-[var(--speckle-foundation-page)] text-[var(--speckle-foreground)] placeholder:text-[var(--speckle-foreground-3)]"
                                    autoFocus
                                />
                                <input
                                    type="url" placeholder="https://speckle.example.com" value={serverForm.url}
                                    onChange={e => setServerForm(p => ({ ...p, url: e.target.value }))}
                                    className="w-full glass px-2.5 py-1.5 rounded-md text-xs bg-[var(--speckle-foundation-page)] text-[var(--speckle-foreground)] placeholder:text-[var(--speckle-foreground-3)]"
                                />
                                <input
                                    type="password" placeholder="API token (optional)" value={serverForm.token}
                                    onChange={e => setServerForm(p => ({ ...p, token: e.target.value }))}
                                    className="w-full glass px-2.5 py-1.5 rounded-md text-xs bg-[var(--speckle-foundation-page)] text-[var(--speckle-foreground)] placeholder:text-[var(--speckle-foreground-3)]"
                                />
                                <div className="flex gap-2 pt-1">
                                    <button
                                        onClick={handleAddServer}
                                        disabled={!serverForm.url.trim()}
                                        className="flex-1 py-1.5 rounded-md text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 transition-colors"
                                    >
                                        Add &amp; switch
                                    </button>
                                    <button
                                        onClick={() => { setShowAddServer(false); setServerForm({ name: '', url: '', token: '' }) }}
                                        className="px-3 py-1.5 rounded-md text-xs text-[var(--speckle-foreground-3)] hover:text-[var(--speckle-foreground)] transition-colors"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </Segment>

            <ChevronRight className="w-3.5 h-3.5 text-[var(--speckle-foreground-3)] shrink-0 mx-0.5" />

            {/* Project */}
            <Segment
                id="project" icon={FolderOpen}
                label={selectedProject?.name || (loadingProjects ? 'Loading…' : 'Project')}
                description="Project — the Speckle project (stream) to work with"
                active={!!selectedProject}
                loading={loadingProjects}
                open={openSeg === 'project'}
                onToggle={toggle}
            >
                <div className="p-2">
                    <div className="relative mb-2">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--speckle-foreground-3)] pointer-events-none" />
                        <input
                            type="text" placeholder="Search projects…" value={projectSearch}
                            onChange={e => setProjectSearch(e.target.value)}
                            className="w-full glass pl-7 pr-2.5 py-1.5 rounded-md text-xs bg-[var(--speckle-foundation-page)] text-[var(--speckle-foreground)] placeholder:text-[var(--speckle-foreground-3)]"
                            autoFocus
                        />
                    </div>
                    <div className="space-y-0.5 max-h-60 overflow-y-auto">
                        {loadingProjects ? (
                            <div className="flex items-center gap-2 px-2 py-2 text-xs text-[var(--speckle-foreground-3)]">
                                <Loader2 className="w-3 h-3 animate-spin" /> Loading projects…
                            </div>
                        ) : filteredProjects.length === 0 ? (
                            <div className="px-2 py-3 text-xs text-[var(--speckle-foreground-3)] text-center">No projects found</div>
                        ) : filteredProjects.map(p => (
                            <button
                                key={p.id}
                                onClick={() => { onSelectProject(p); close(); setProjectSearch('') }}
                                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors text-left
                                    ${p.id === selectedProject?.id ? 'bg-primary/15 text-primary' : 'hover:bg-white/5 text-[var(--speckle-foreground-2)]'}`}
                            >
                                {p.id === selectedProject?.id
                                    ? <Check className="w-3 h-3 shrink-0" />
                                    : <span className="w-3 shrink-0" />
                                }
                                <span className="flex-1 truncate">{p.name}</span>
                            </button>
                        ))}
                    </div>
                </div>
            </Segment>

            {selectedProject && (<>
                <ChevronRight className="w-3.5 h-3.5 text-[var(--speckle-foreground-3)] shrink-0 mx-0.5" />

                {/* Model */}
                <Segment
                    id="model" icon={GitBranch}
                    label={selectedModel?.name || (loadingModels ? 'Loading…' : 'Model')}
                    description="Model — the branch/model within the project"
                    active={!!selectedModel}
                    loading={loadingModels}
                    disabled={!loadingModels && models.length === 0}
                    open={openSeg === 'model'}
                    onToggle={toggle}
                >
                    <div className="p-2">
                        <p className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider px-2 pb-1.5">Models</p>
                        <div className="space-y-0.5 max-h-60 overflow-y-auto">
                            {loadingModels ? (
                                <div className="flex items-center gap-2 px-2 py-2 text-xs text-[var(--speckle-foreground-3)]">
                                    <Loader2 className="w-3 h-3 animate-spin" /> Loading models…
                                </div>
                            ) : models.map(m => (
                                <button
                                    key={m.name}
                                    onClick={() => { onSelectModel(m); close() }}
                                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors text-left
                                        ${m.name === selectedModel?.name ? 'bg-primary/15 text-primary' : 'hover:bg-white/5 text-[var(--speckle-foreground-2)]'}`}
                                >
                                    {m.name === selectedModel?.name
                                        ? <Check className="w-3 h-3 shrink-0" />
                                        : <span className="w-3 shrink-0" />
                                    }
                                    <span className="flex-1 truncate">{m.name}</span>
                                    <span className="text-[var(--speckle-foreground-3)] text-xs shrink-0">{m.commits.totalCount}v</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </Segment>
            </>)}

            {selectedModel && (<>
                <ChevronRight className="w-3.5 h-3.5 text-[var(--speckle-foreground-3)] shrink-0 mx-0.5" />

                {/* Version */}
                <Segment
                    id="version" icon={GitCommit}
                    label={selectedVersion ? new Date(selectedVersion.createdAt).toLocaleDateString() : 'Latest'}
                    sublabel={selectedVersion?.message?.slice(0, 25)}
                    description="Version — a specific commit, or the latest"
                    active={true}
                    loading={loadingVersions}
                    open={openSeg === 'version'}
                    onToggle={toggle}
                >
                    <div className="p-2">
                        <p className="text-[10px] text-[var(--speckle-foreground-3)] uppercase tracking-wider px-2 pb-1.5">Versions</p>
                        <div className="space-y-0.5 max-h-72 overflow-y-auto">
                            <button
                                onClick={() => { onSelectVersion(null); close() }}
                                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors text-left
                                    ${!selectedVersion ? 'bg-primary/15 text-primary' : 'hover:bg-white/5 text-[var(--speckle-foreground-2)]'}`}
                            >
                                {!selectedVersion
                                    ? <Check className="w-3 h-3 shrink-0" />
                                    : <span className="w-3 shrink-0" />
                                }
                                <span className="font-medium">Latest</span>
                            </button>
                            {loadingVersions ? (
                                <div className="flex items-center gap-2 px-2 py-2 text-xs text-[var(--speckle-foreground-3)]">
                                    <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                                </div>
                            ) : versions.map(v => (
                                <button
                                    key={v.id}
                                    onClick={() => { onSelectVersion(v); close() }}
                                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors text-left
                                        ${v.id === selectedVersion?.id ? 'bg-primary/15 text-primary' : 'hover:bg-white/5 text-[var(--speckle-foreground-2)]'}`}
                                >
                                    {v.id === selectedVersion?.id
                                        ? <Check className="w-3 h-3 shrink-0" />
                                        : <span className="w-3 shrink-0" />
                                    }
                                    <div className="flex-1 min-w-0">
                                        <div className="text-xs">{new Date(v.createdAt).toLocaleDateString()}</div>
                                        {v.message && (
                                            <div className="text-[var(--speckle-foreground-3)] text-[10px] truncate">{v.message}</div>
                                        )}
                                    </div>
                                    {v.sourceApplication && (
                                        <span className="text-[var(--speckle-foreground-3)] text-[10px] shrink-0">{v.sourceApplication}</span>
                                    )}
                                </button>
                            ))}
                        </div>
                    </div>
                </Segment>
            </>)}
        </div>
    )
}
