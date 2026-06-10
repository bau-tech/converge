import { motion, AnimatePresence } from 'framer-motion'
import { X, ChevronDown, ChevronRight, Copy, Check, Filter, Eye, MoreHorizontal, Loader2 } from 'lucide-react'
import { useState } from 'react'

// Recursive Key-Value Tree Component
const ObjectTreeItem = ({ data, label, depth = 0, path = '', onFilter, onCopy, isAutoWidth = false, activeFilter = null }) => {
    const [isOpen, setIsOpen] = useState(
        // Default open "properties", "Attributes", or top-level items
        depth === 0 || label === 'properties' || label === 'Attributes'
    )
    const [isHovered, setIsHovered] = useState(false)

    // Helper to get type label
    const getTypeLabel = (val) => {
        if (Array.isArray(val)) return `[${val.length}]`
        if (typeof val === 'object' && val !== null) return '{}'
        return ''
    }

    // Handle null/undefined
    if (data === null || data === undefined) {
        return (
            <div className="flex items-center gap-2 py-1 text-xs font- mono text-zinc-500 hover:bg-white/5 px-2 rounded group"
                style={{ paddingLeft: `${(depth * 12) + 8}px` }}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <span className="text-zinc-500">{label}</span>
                <span className="italic text-zinc-600">null</span>
            </div>
        )
    }

    // Handle Primitive Values
    if (typeof data !== 'object') {
        const strVal = String(data)
        const isUrl = strVal.startsWith('http')

        return (
            <div
                className="flex items-center justify-between py-1 text-xs font-mono hover:bg-white/5 rounded px-2 group transition-colors"
                style={{ paddingLeft: `${(depth * 12) + 8}px` }}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <div className="flex items-center gap-4 flex-1 overflow-hidden">
                    <span className="text-zinc-400 whitespace-nowrap">{label}</span>
                    <span className={`text-zinc-200 ${isAutoWidth ? 'break-all whitespace-normal' : 'truncate'}`} title={strVal}>{strVal}</span>
                </div>

                {/* Hover Actions */}
                <div className={`flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity`}>
                    <button
                        onClick={(e) => { e.stopPropagation(); onCopy(strVal); }}
                        aria-label={`Copy value: ${strVal}`}
                        className="p-1 hover:bg-white/10 rounded text-zinc-400 hover:text-white"
                        title="Copy value"
                    >
                        <Copy className="w-3 h-3" />
                    </button>
                    <button
                        onClick={(e) => { e.stopPropagation(); onFilter(path || label, data); }}
                        aria-label={activeFilter?.path === (path || label) && String(activeFilter.value) === String(data)
                            ? `Clear filter: ${label}`
                            : `Filter by ${label}: ${strVal}`}
                        aria-pressed={activeFilter?.path === (path || label) && String(activeFilter.value) === String(data)}
                        className={`p-1 rounded transition-colors ${
                            activeFilter?.path === (path || label) && String(activeFilter.value) === String(data)
                                ? 'bg-cyan-500/30 text-cyan-300'
                                : 'hover:bg-cyan-500/20 text-zinc-400 hover:text-cyan-400'
                        }`}
                        title={activeFilter?.path === (path || label) && String(activeFilter.value) === String(data)
                            ? 'Clear this filter'
                            : 'Filter 3D viewer by this value'}
                    >
                        <Filter className="w-3 h-3" />
                    </button>
                </div>
            </div>
        )
    }

    // Handle Objects / Arrays
    const itemCount = Array.isArray(data) ? data.length : Object.keys(data).length
    if (itemCount === 0) return null

    return (
        <div>
            <div
                className="flex items-center justify-between py-1 text-xs font-mono hover:bg-white/5 rounded px-2 cursor-pointer group select-none"
                style={{ paddingLeft: `${(depth * 12) + 8}px` }}
                onClick={() => setIsOpen(!isOpen)}
            >
                <div className="flex items-center gap-1">
                    {isOpen ? <ChevronDown className="w-3 h-3 text-zinc-500" /> : <ChevronRight className="w-3 h-3 text-zinc-500" />}
                    <span className="text-zinc-300 font-semibold">{label}</span>
                </div>
            </div>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        {Object.entries(data).map(([key, value]) => {
                            // Skip internal keys
                            if (key.startsWith('__') || key.startsWith('@')) return null
                            return (
                                <ObjectTreeItem
                                    key={key}
                                    label={key}
                                    data={value}
                                    depth={depth + 1}
                                    path={path ? `${path}.${key}` : key}
                                    onFilter={onFilter}
                                    onCopy={onCopy}
                                    isAutoWidth={isAutoWidth}
                                    activeFilter={activeFilter}
                                />
                            )
                        })}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

export default function ElementPanel({ element, onClose, onFilter, darkMode = true }) {
    const [width, setWidth] = useState(400)
    const [isAutoWidth, setIsAutoWidth] = useState(false)
    const [isResizing, setIsResizing] = useState(false)
    const [copied, setCopied] = useState(false)
    // Track the currently-active property filter so the user can see what's applied
    const [activeFilter, setActiveFilter] = useState(null)   // { path, value }

    if (!element) return null

    const handleCopy = (text) => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    const handlePropertyFilter = (path, value) => {
        if (!onFilter) return
        // Toggle: clicking the same filter again clears it
        if (activeFilter?.path === path && String(activeFilter.value) === String(value)) {
            setActiveFilter(null)
            onFilter({})   // empty → App clears filter
        } else {
            setActiveFilter({ path, value })
            onFilter({ [path]: value })
        }
    }

    const startResizing = (e) => {
        e.preventDefault()
        setIsResizing(true)

        const startX = e.clientX
        const startWidth = typeof width === 'number' ? width : 400 // Fallback if auto

        const handleMouseMove = (moveEvent) => {
            const newWidth = startWidth + (startX - moveEvent.clientX)
            const constrainedWidth = Math.max(300, Math.min(newWidth, window.innerWidth - 50))
            setWidth(constrainedWidth)
            setIsAutoWidth(false) // Dragging always exits auto mode
        }

        const handleMouseUp = () => {
            setIsResizing(false)
            document.removeEventListener('mousemove', handleMouseMove)
            document.removeEventListener('mouseup', handleMouseUp)
        }

        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', handleMouseUp)
    }

    const toggleAutoWidth = () => {
        if (isAutoWidth) {
            setWidth(400)
            setIsAutoWidth(false)
        } else {
            setWidth('auto') // Will need CSS adjustment
            setIsAutoWidth(true)
        }
    }

    // Organize Top-Level Props standard to Speckle
    const topLevelProps = {
        id: element.id,
        name: element.name || 'Unnamed',
        speckle_type: element.speckle_type ? element.speckle_type.split('.').pop() : 'Unknown',
        category: element.category,
        family: element.family,
        type: element.type
    }

    // The rest of the properties
    const propertyData = element.raw_properties || element.properties || {}
    // If we have raw_properties, we might want to merge or prioritize. 
    // Usually 'properties' is the main bag.

    return (
        <motion.div
            initial={{ x: 400, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 400, opacity: 0 }}
            transition={{ duration: isResizing ? 0 : 0.3 }} // Disable transition during drag
            style={{ width: isAutoWidth ? 'fit-content' : width, minWidth: 300, maxWidth: isAutoWidth ? '60vw' : '90vw' }}
            className={`fixed right-0 top-0 bottom-0 shadow-2xl z-50 flex flex-col border-l
                ${darkMode ? 'bg-[#1e1e1e] border-[#333]' : 'bg-white border-gray-200'}
            `}
        >
            {/* Resize Handle */}
            <div
                className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-cyan-500/50 transition-colors z-[60]"
                onMouseDown={startResizing}
                onDoubleClick={toggleAutoWidth}
                title="Drag to resize, Double-click to auto-adjust"
            />

            {/* Header - "Selected" style from screenshot */}
            <div className={`flex items-center justify-between px-4 py-3 border-b ${darkMode ? 'border-[#333] bg-[#252526]' : 'border-gray-200 bg-gray-50'}`}>
                <h2 className={`font-semibold text-sm ${darkMode ? 'text-white' : 'text-gray-900'}`}>Selected</h2>
                <div className="flex items-center gap-3">
                    <button className="text-zinc-400 hover:text-white transition-colors" title="Isolate" aria-label="Isolate element in viewer">
                        <Eye className="w-4 h-4" />
                    </button>
                    <button className="text-zinc-400 hover:text-white transition-colors" title="Filter Selection" aria-label="Filter by selection">
                        <Filter className="w-4 h-4" />
                    </button>
                    <button className="text-zinc-400 hover:text-white transition-colors" title="More" aria-label="More options" aria-haspopup="true">
                        <MoreHorizontal className="w-4 h-4" />
                    </button>
                    <div className="w-px h-4 bg-zinc-700 mx-1"></div>
                    <button onClick={onClose} aria-label="Close panel" className="text-zinc-400 hover:text-red-400 transition-colors">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Top Level Summary (Always visible) */}
            <div className={`px-4 py-3 border-b ${darkMode ? 'border-[#333]' : 'border-gray-200'}`}>
                <div className="flex items-center gap-2 mb-2">
                    <ChevronDown className="w-4 h-4 text-zinc-500" />
                    <span className="font-semibold text-sm text-white">{topLevelProps.category || topLevelProps.speckle_type}</span>
                </div>

                {/* Fixed Top Properties Table Style */}
                <div className="space-y-1 ml-6">
                    {Object.entries(topLevelProps).map(([key, val]) => {
                        if (!val) return null
                        return (
                            <div key={key} className="flex justify-between text-xs font-mono group">
                                <span className="text-zinc-500 w-1/3">{key}</span>
                                <div className="flex-1 flex justify-between items-center overflow-hidden">
                                    <span className={`truncate text-zinc-300 ${key === 'id' ? 'font-mono text-zinc-400' : ''}`} title={val}>
                                        {val}
                                    </span>
                                    <button
                                        onClick={() => handleCopy(val)}
                                        aria-label={`Copy ${key} value`}
                                        className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-white p-0.5"
                                    >
                                        <Copy className="w-3 h-3" />
                                    </button>
                                </div>
                            </div>
                        )
                    })}
                </div>
            </div>

            {/* Active filter indicator */}
            {activeFilter && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-cyan-500/10 border-b border-cyan-500/20 text-[11px]">
                    <Filter className="w-3 h-3 text-cyan-400 shrink-0" />
                    <span className="text-cyan-300 font-mono truncate flex-1">
                        {activeFilter.path} = <span className="text-white">{String(activeFilter.value)}</span>
                    </span>
                    <button
                        onClick={() => { setActiveFilter(null); onFilter && onFilter({}) }}
                        aria-label="Clear active property filter"
                        className="text-cyan-500 hover:text-white transition-colors shrink-0"
                        title="Clear filter"
                    >
                        <X className="w-3 h-3" />
                    </button>
                </div>
            )}

            {/* Scrollable Tree Content */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
                {/* Loading state while parameters are being fetched */}
                {!element.properties && (
                    <div className="flex items-center gap-2 px-3 py-4 text-zinc-500 text-xs">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Loading properties…
                    </div>
                )}
                {/* Render full properties tree */}
                {element.properties && Object.entries(element.properties).map(([pset, vals]) => (
                    <ObjectTreeItem
                        key={pset}
                        label={pset}
                        data={vals}
                        depth={0}
                        onFilter={handlePropertyFilter}
                        activeFilter={activeFilter}
                        onCopy={handleCopy}
                        isAutoWidth={isAutoWidth}
                    />
                ))}
                {/* Fallback for legacy raw properties shape */}
                {!element.properties && propertyData && Object.keys(propertyData).length > 0 && (
                    <ObjectTreeItem
                        label="properties"
                        data={propertyData}
                        depth={0}
                        onFilter={handlePropertyFilter}
                        activeFilter={activeFilter}
                        onCopy={handleCopy}
                        isAutoWidth={isAutoWidth}
                    />
                )}

                {/* Render any additional data bags if they exist at root */}
                {element.quantities && (
                    <ObjectTreeItem
                        label="Quantities"
                        data={element.quantities}
                        depth={0}
                        onFilter={handlePropertyFilter}
                        activeFilter={activeFilter}
                        onCopy={handleCopy}
                        isAutoWidth={isAutoWidth}
                    />
                )}
                {element.materials && element.materials.length > 0 && (
                    <ObjectTreeItem
                        label="Materials"
                        data={element.materials}
                        depth={0}
                        onFilter={handlePropertyFilter}
                        activeFilter={activeFilter}
                        onCopy={handleCopy}
                        isAutoWidth={isAutoWidth}
                    />
                )}
            </div>

            {/* Element Count Footer */}
            <div className={`px-4 py-1.5 border-t text-[10px] flex justify-between items-center ${darkMode ? 'border-[#333] bg-[#252526] text-zinc-500' : 'bg-gray-50 text-gray-500'}`}>
                <span>@elements</span>
                <span>(0)</span>
            </div>

            {copied && (
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="absolute bottom-10 left-1/2 -translate-x-1/2 bg-zinc-900 text-white text-xs px-3 py-1.5 rounded-full border border-white/10 flex items-center gap-2"
                >
                    <Check className="w-3 h-3 text-green-400" />
                    Copied to clipboard
                </motion.div>
            )}
        </motion.div>
    )
}
