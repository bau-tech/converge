import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence, useDragControls } from 'framer-motion'
import { MessageSquare, Send, X, Sparkles, Settings, Cpu, Database, Save, Wrench, Filter, Download, Trash2, Copy, Check } from 'lucide-react'
import { RUNTIME_CONFIG } from '../runtimeConfig'

// ── Minimal inline markdown renderer ────────────────────────────────────────
function MarkdownMessage({ content }) {
    const lines = content.split('\n')
    const elements = []
    let tableBuffer = []
    let key = 0

    const flushTable = () => {
        if (tableBuffer.length < 2) {
            tableBuffer.forEach(l => elements.push(<p key={key++} className="text-sm leading-relaxed">{l}</p>))
            tableBuffer = []
            return
        }
        const headers = tableBuffer[0].split('|').map(h => h.trim()).filter(Boolean)
        const rows = tableBuffer.slice(2).map(r => r.split('|').map(c => c.trim()).filter(Boolean))
        elements.push(
            <div key={key++} className="overflow-x-auto my-2">
                <table className="text-[11px] w-full border-collapse">
                    <thead>
                        <tr>{headers.map((h, i) => <th key={i} className="border border-white/10 px-2 py-1 text-left text-zinc-300 bg-white/5">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                        {rows.map((r, ri) => (
                            <tr key={ri} className="even:bg-white/5">
                                {r.map((c, ci) => <td key={ci} className="border border-white/10 px-2 py-1 text-zinc-400">{c}</td>)}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        )
        tableBuffer = []
    }

    for (const line of lines) {
        if (line.startsWith('|')) {
            tableBuffer.push(line)
            continue
        }
        if (tableBuffer.length) flushTable()

        if (!line.trim()) { elements.push(<br key={key++} />); continue }

        // Bold **text**
        const parts = line.split(/(\*\*[^*]+\*\*)/)
        const rendered = parts.map((p, i) =>
            p.startsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p
        )
        elements.push(<p key={key++} className="text-sm leading-relaxed">{rendered}</p>)
    }
    if (tableBuffer.length) flushTable()
    return <div className="space-y-1">{elements}</div>
}

const INIT_MSG = { role: 'assistant', id: 'init', content: 'Hi! Ask me anything about this model:\n• "Show all structural columns"\n• "Total concrete volume by storey"\n• "Any unusually heavy beams?"\n• "Find walls without a material"\n• "How does this version compare to the previous one?"' }

function CopyButton({ text }) {
    const [copied, setCopied] = useState(false)
    return (
        <button
            onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-white/10 text-zinc-500 hover:text-zinc-300"
            title="Copy"
        >
            {copied ? <Check className="w-3 h-3 text-cyan-400" /> : <Copy className="w-3 h-3" />}
        </button>
    )
}

function exportMarkdown(messages) {
    const lines = ['# BIM AI Chat', `*${new Date().toLocaleString()}*`, '']
    for (const m of messages) {
        if (m.id === 'init') continue
        lines.push(`---\n\n**${m.role === 'user' ? 'You' : 'Assistant'}:** ${m.content}`)
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'chat.md'; a.click()
}

export function ChatWidget({ onFilter, projectId, modelId, modelContext, normalizerUrl = 'http://localhost:8002' }) {
    const [isOpen, setIsOpen] = useState(false)
    const [showSettings, setShowSettings] = useState(false)
    const [messages, setMessages] = useState([INIT_MSG])
    const [input, setInput] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const messagesEndRef = useRef(null)
    const dragControls = useDragControls() // Initialize drag controls

    // ChatWidget stays mounted across model switches (it's not remounted per
    // model), so a streaming /chat/stream request started against one model
    // can still be in flight when the user switches to another before it
    // finishes. abortRef cancels the stale request outright on a model
    // change; activeModelRef is a defense-in-depth guard in case a response
    // is already fully buffered and completes right as the switch happens —
    // either way, onFilter(finalIds) never gets applied to a model other
    // than the one the ids were actually computed for.
    const abortRef = useRef(null)
    const activeModelRef = useRef(modelId)
    useEffect(() => {
        activeModelRef.current = modelId
        abortRef.current?.abort()
    }, [modelId])

    // LLM Configuration
    const [provider, setProvider] = useState(() => localStorage.getItem('chat_ai_provider') || 'mistral')
    const [ollamaConfig, setOllamaConfig] = useState(() => ({
        baseUrl: localStorage.getItem('chat_ollama_url') || RUNTIME_CONFIG.OLLAMA_BASE_URL,
        model: localStorage.getItem('chat_ollama_model') || RUNTIME_CONFIG.OLLAMA_MODEL
    }))
    const [lmStudioConfig, setLmStudioConfig] = useState(() => ({
        baseUrl: localStorage.getItem('chat_lmstudio_url') || RUNTIME_CONFIG.LMSTUDIO_BASE_URL,
        model: localStorage.getItem('chat_lmstudio_model') || 'local-model'
    }))
    const [mistralConfig, setMistralConfig] = useState(() => ({
        apiKey: localStorage.getItem('chat_mistral_key') || RUNTIME_CONFIG.MISTRAL_API_KEY,
        model: localStorage.getItem('chat_mistral_model') || 'mistral-large-latest'
    }))
    const [anthropicConfig, setAnthropicConfig] = useState(() => ({
        apiKey: localStorage.getItem('chat_anthropic_key') || RUNTIME_CONFIG.ANTHROPIC_API_KEY,
        model: localStorage.getItem('chat_anthropic_model') || 'claude-sonnet-5'
    }))

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }

    useEffect(() => {
        scrollToBottom()
    }, [messages, isOpen])

    const handleReset = () => { setMessages([INIT_MSG]); if (onFilter) onFilter(null) }

    const handleSaveSettings = () => {
        localStorage.setItem('chat_ai_provider', provider)
        localStorage.setItem('chat_ollama_url', ollamaConfig.baseUrl)
        localStorage.setItem('chat_ollama_model', ollamaConfig.model)
        localStorage.setItem('chat_lmstudio_url', lmStudioConfig.baseUrl)
        localStorage.setItem('chat_lmstudio_model', lmStudioConfig.model)
        localStorage.setItem('chat_mistral_key', mistralConfig.apiKey)
        localStorage.setItem('chat_mistral_model', mistralConfig.model)
        localStorage.setItem('chat_anthropic_key', anthropicConfig.apiKey)
        localStorage.setItem('chat_anthropic_model', anthropicConfig.model)
        setShowSettings(false)
    }

    const handleSubmit = async (e) => {
        e.preventDefault()
        if (!input.trim() || isLoading) return

        const userMsg = input.trim()
        setInput('')
        const requestModelId = modelId
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        const history = messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(-12)
            .map(m => ({ role: m.role, content: m.content }))

        const body = JSON.stringify({
            message: userMsg,
            project_id: projectId,
            model_id: modelId,
            history,
            ai_provider: provider,
            ollama_config: provider === 'ollama' ? ollamaConfig : undefined,
            lmstudio_config: provider === 'lmstudio' ? lmStudioConfig : undefined,
            mistral_config: provider === 'mistral' ? mistralConfig : undefined,
            anthropic_config: provider === 'anthropic' ? anthropicConfig : undefined,
            model_context: modelContext || undefined,
        })

        // Add user message + live assistant placeholder
        setMessages(prev => [
            ...prev,
            { role: 'user', content: userMsg },
            { role: 'thinking', activeTools: [], text: '' },
        ])
        setIsLoading(true)

        try {
            const response = await fetch(`${normalizerUrl}/chat/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                signal: controller.signal,
            })

            if (!response.ok) throw new Error(`Server error: ${response.status}`)

            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            let accText = ''
            let activeTools = []
            let finalIds = []
            let toolsUsed = []

            const updateLive = (patch) => {
                setMessages(prev => {
                    const next = [...prev]
                    const idx = next.findLastIndex(m => m.role === 'thinking')
                    if (idx !== -1) next[idx] = { ...next[idx], ...patch }
                    return next
                })
            }

            // eslint-disable-next-line no-constant-condition
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })

                const lines = buffer.split('\n')
                buffer = lines.pop()   // keep the incomplete last line

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue
                    let event
                    try { event = JSON.parse(line.slice(6)) } catch { continue }

                    if (event.type === 'reasoning') {
                        updateLive({ reasoning: event.text })

                    } else if (event.type === 'tool_start') {
                        activeTools = [...activeTools, event.name]
                        updateLive({ activeTools })

                    } else if (event.type === 'tool_done') {
                        // Keep completed tools visible
                        updateLive({ activeTools })

                    } else if (event.type === 'text_delta') {
                        accText += event.delta
                        updateLive({ text: accText })

                    } else if (event.type === 'elements') {
                        finalIds = event.ids || []

                    } else if (event.type === 'done') {
                        toolsUsed = event.toolsUsed || []

                    } else if (event.type === 'error') {
                        accText = `Sorry, an error occurred: ${event.message}`
                        if (event.detail) accText += `\n\n\`${event.detail}\``
                        updateLive({ text: accText })
                    }
                }
            }

            // Promote thinking bubble → real assistant message
            setMessages(prev => {
                const next = [...prev]
                const idx = next.findLastIndex(m => m.role === 'thinking')
                if (idx !== -1) {
                    next[idx] = {
                        role: 'assistant',
                        content: accText || 'Done.',
                        elementCount: finalIds.length > 0 ? finalIds.length : null,
                        toolsUsed,
                    }
                }
                return next
            })

            // Skip if the user switched models while this response was
            // streaming — applying finalIds now would filter the *new*
            // model's viewer/table using element ids computed for the old
            // one (aborting the request above already prevents this in the
            // common case; this covers the response completing right as
            // the switch happens, before the abort takes effect).
            if (requestModelId === activeModelRef.current) {
                if (finalIds.length > 0) {
                    if (onFilter) onFilter(finalIds)
                } else if (onFilter) {
                    onFilter(null)
                }
            }

        } catch (error) {
            if (error.name === 'AbortError') return
            console.error('Chat error:', error)
            setMessages(prev => [
                ...prev.filter(m => m.role !== 'thinking'),
                { role: 'assistant', content: `Sorry, I encountered an error: ${error.message}` }
            ])
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <motion.div
            drag
            dragMomentum={false}
            dragControls={dragControls}
            dragListener={false} // Disable dragging by default, enable on specific elements
            initial={false}
            // z-[260]: above the Element panel (z-[245]) so this FAB stays clickable
            // even when the panel is covering the bottom-right corner of the viewer.
            className="fixed bottom-[calc(6rem+env(safe-area-inset-bottom))] right-6 z-[260] flex flex-col items-end"
        >

            {/* Chat Window */}
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 20 }}
                        className="pointer-events-auto w-[350px] h-[500px] max-w-[calc(100vw-3rem)] max-h-[calc(100vh-8rem)] panel-thin flex flex-col overflow-hidden mb-4 shadow-2xl"
                    >
                        {/* Header */}
                        <div
                            className="px-3 py-2 border-b border-white/10 flex items-center justify-between bg-white/5 cursor-move"
                            onPointerDown={(e) => dragControls.start(e)}
                        >
                            <div className="flex items-center gap-1.5">
                                <div className="p-1 rounded-md bg-cyan-500/20 text-cyan-400">
                                    <Sparkles className="w-3.5 h-3.5" />
                                </div>
                                <div>
                                    <h3 className="font-medium text-xs">AI Assistant</h3>
                                    <p className="text-[9px] text-zinc-400">
                                        {provider === 'openai' ? 'OpenAI' : provider === 'mistral' ? 'Mistral AI' : provider === 'anthropic' ? `Claude (${anthropicConfig.model})` : provider === 'ollama' ? `Ollama (${ollamaConfig.model})` : `LM Studio (${lmStudioConfig.model})`}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-0.5">
                                <button
                                    onClick={(e) => { e.stopPropagation(); exportMarkdown(messages) }}
                                    className="p-1 hover:bg-white/10 rounded-md transition-colors text-zinc-400"
                                    title="Export chat as Markdown"
                                    onPointerDown={(e) => e.stopPropagation()}
                                >
                                    <Download className="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onClick={(e) => { e.stopPropagation(); handleReset() }}
                                    className="p-1 hover:bg-white/10 rounded-md transition-colors text-zinc-400"
                                    title="Clear chat"
                                    onPointerDown={(e) => e.stopPropagation()}
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        setShowSettings(!showSettings)
                                    }}
                                    className={`p-1 rounded-md transition-colors ${showSettings ? 'bg-cyan-500/20 text-cyan-400' : 'hover:bg-white/10 text-zinc-400'}`}
                                    title="AI Settings"
                                    onPointerDown={(e) => e.stopPropagation()}
                                >
                                    <Settings className="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onClick={() => setIsOpen(false)}
                                    className="p-1 hover:bg-white/10 rounded-md transition-colors cursor-pointer"
                                    onPointerDown={(e) => e.stopPropagation()}
                                >
                                    <X className="w-3.5 h-3.5 text-zinc-400" />
                                </button>
                            </div>
                        </div>

                        {/* Settings Panel */}
                        <AnimatePresence>
                            {showSettings && (
                                <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    className="border-b border-white/10 bg-black/20 overflow-hidden"
                                >
                                    <div className="p-2 space-y-2">
                                        <div className="space-y-1.5">
                                            <label className="text-[9px] font-medium text-zinc-400 uppercase tracking-wider">AI Provider</label>
                                            <div className="grid grid-cols-3 gap-1.5">
                                                <button
                                                    onClick={() => setProvider('openai')}
                                                    className={`flex items-center justify-center gap-1 py-1 rounded text-[11px] transition-colors ${provider === 'openai' ? 'bg-cyan-500/20 border border-cyan-500/50 text-cyan-400' : 'bg-zinc-800/50 border border-white/5 text-zinc-500 hover:text-zinc-300'}`}
                                                >
                                                    <Cpu className="w-2.5 h-2.5" />
                                                    OpenAI
                                                </button>
                                                <button
                                                    onClick={() => setProvider('anthropic')}
                                                    className={`flex items-center justify-center gap-1 py-1 rounded text-[11px] transition-colors ${provider === 'anthropic' ? 'bg-cyan-500/20 border border-cyan-500/50 text-cyan-400' : 'bg-zinc-800/50 border border-white/5 text-zinc-500 hover:text-zinc-300'}`}
                                                >
                                                    <Cpu className="w-2.5 h-2.5" />
                                                    Claude
                                                </button>
                                                <button
                                                    onClick={() => setProvider('mistral')}
                                                    className={`flex items-center justify-center gap-1 py-1 rounded text-[11px] transition-colors ${provider === 'mistral' ? 'bg-cyan-500/20 border border-cyan-500/50 text-cyan-400' : 'bg-zinc-800/50 border border-white/5 text-zinc-500 hover:text-zinc-300'}`}
                                                >
                                                    <Cpu className="w-2.5 h-2.5" />
                                                    Mistral
                                                </button>
                                                <button
                                                    onClick={() => setProvider('ollama')}
                                                    className={`flex items-center justify-center gap-1 py-1 rounded text-[11px] transition-colors ${provider === 'ollama' ? 'bg-cyan-500/20 border border-cyan-500/50 text-cyan-400' : 'bg-zinc-800/50 border border-white/5 text-zinc-500 hover:text-zinc-300'}`}
                                                >
                                                    <Database className="w-2.5 h-2.5" />
                                                    Ollama
                                                </button>
                                                <button
                                                    onClick={() => setProvider('lmstudio')}
                                                    className={`flex items-center justify-center gap-1 py-1 rounded text-[11px] transition-colors ${provider === 'lmstudio' ? 'bg-cyan-500/20 border border-cyan-500/50 text-cyan-400' : 'bg-zinc-800/50 border border-white/5 text-zinc-500 hover:text-zinc-300'}`}
                                                >
                                                    <Cpu className="w-2.5 h-2.5" />
                                                    LM Studio
                                                </button>
                                            </div>
                                        </div>

                                        {provider === 'ollama' && (
                                            <div className="space-y-1.5 pt-1">
                                                <div className="space-y-1">
                                                    <label className="text-[9px] font-medium text-zinc-400 uppercase tracking-wider">Ollama URL</label>
                                                    <input
                                                        type="text"
                                                        value={ollamaConfig.baseUrl}
                                                        onChange={(e) => setOllamaConfig(prev => ({ ...prev, baseUrl: e.target.value }))}
                                                        placeholder="http://localhost:11434"
                                                        className="w-full bg-zinc-800/50 border border-white/10 rounded px-2 py-1 text-xs focus:outline-none focus:border-cyan-500 text-zinc-200"
                                                    />
                                                </div>
                                                <div className="space-y-1">
                                                    <label className="text-[9px] font-medium text-zinc-400 uppercase tracking-wider">Model</label>
                                                    <input
                                                        type="text"
                                                        value={ollamaConfig.model}
                                                        onChange={(e) => setOllamaConfig(prev => ({ ...prev, model: e.target.value }))}
                                                        placeholder="llama3"
                                                        className="w-full bg-zinc-800/50 border border-white/10 rounded px-2 py-1 text-xs focus:outline-none focus:border-cyan-500 text-zinc-200"
                                                    />
                                                </div>
                                            </div>
                                        )}

                                        {provider === 'lmstudio' && (
                                            <div className="space-y-1.5 pt-1">
                                                <div className="space-y-1">
                                                    <label className="text-[9px] font-medium text-zinc-400 uppercase tracking-wider">LM Studio URL</label>
                                                    <input
                                                        type="text"
                                                        value={lmStudioConfig.baseUrl}
                                                        onChange={(e) => setLmStudioConfig(prev => ({ ...prev, baseUrl: e.target.value }))}
                                                        placeholder="http://localhost:1234/v1"
                                                        className="w-full bg-zinc-800/50 border border-white/10 rounded px-2 py-1 text-xs focus:outline-none focus:border-cyan-500 text-zinc-200"
                                                    />
                                                </div>
                                                <div className="space-y-1">
                                                    <label className="text-[9px] font-medium text-zinc-400 uppercase tracking-wider">Model</label>
                                                    <input
                                                        type="text"
                                                        value={lmStudioConfig.model}
                                                        onChange={(e) => setLmStudioConfig(prev => ({ ...prev, model: e.target.value }))}
                                                        placeholder="local-model"
                                                        className="w-full bg-zinc-800/50 border border-white/10 rounded px-2 py-1 text-xs focus:outline-none focus:border-cyan-500 text-zinc-200"
                                                    />
                                                </div>
                                            </div>
                                        )}

                                        {provider === 'mistral' && (
                                            <div className="space-y-1.5 pt-1">
                                                <div className="space-y-1">
                                                    <label className="text-[9px] font-medium text-zinc-400 uppercase tracking-wider">Mistral API Key</label>
                                                    <input
                                                        type="password"
                                                        value={mistralConfig.apiKey}
                                                        onChange={(e) => setMistralConfig(prev => ({ ...prev, apiKey: e.target.value }))}
                                                        placeholder="sk-..."
                                                        className="w-full bg-zinc-800/50 border border-white/10 rounded px-2 py-1 text-xs focus:outline-none focus:border-cyan-500 text-zinc-200"
                                                    />
                                                </div>
                                                <div className="space-y-1">
                                                    <label className="text-[9px] font-medium text-zinc-400 uppercase tracking-wider">Model</label>
                                                    <input
                                                        type="text"
                                                        value={mistralConfig.model}
                                                        onChange={(e) => setMistralConfig(prev => ({ ...prev, model: e.target.value }))}
                                                        placeholder="mistral-large-latest"
                                                        className="w-full bg-zinc-800/50 border border-white/10 rounded px-2 py-1 text-xs focus:outline-none focus:border-cyan-500 text-zinc-200"
                                                    />
                                                </div>
                                            </div>
                                        )}

                                        {provider === 'anthropic' && (
                                            <div className="space-y-1.5 pt-1">
                                                <div className="space-y-1">
                                                    <label className="text-[9px] font-medium text-zinc-400 uppercase tracking-wider">Anthropic API Key</label>
                                                    <input
                                                        type="password"
                                                        value={anthropicConfig.apiKey}
                                                        onChange={(e) => setAnthropicConfig(prev => ({ ...prev, apiKey: e.target.value }))}
                                                        placeholder="sk-ant-..."
                                                        className="w-full bg-zinc-800/50 border border-white/10 rounded px-2 py-1 text-xs focus:outline-none focus:border-cyan-500 text-zinc-200"
                                                    />
                                                </div>
                                                <div className="space-y-1">
                                                    <label className="text-[9px] font-medium text-zinc-400 uppercase tracking-wider">Model</label>
                                                    <input
                                                        type="text"
                                                        value={anthropicConfig.model}
                                                        onChange={(e) => setAnthropicConfig(prev => ({ ...prev, model: e.target.value }))}
                                                        placeholder="claude-sonnet-5"
                                                        className="w-full bg-zinc-800/50 border border-white/10 rounded px-2 py-1 text-xs focus:outline-none focus:border-cyan-500 text-zinc-200"
                                                    />
                                                </div>
                                            </div>
                                        )}

                                        <button
                                            onClick={handleSaveSettings}
                                            className="w-full flex items-center justify-center gap-1.5 py-1 bg-cyan-500 hover:bg-cyan-600 text-white rounded text-[11px] font-medium transition-colors"
                                        >
                                            <Save className="w-2.5 h-2.5" />
                                            Save
                                        </button>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* Messages */}
                        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
                            {messages.map((msg, idx) => {
                                if (msg.role === 'thinking') {
                                    const hasText = msg.text && msg.text.length > 0
                                    return (
                                        <div key={idx} className="flex justify-start">
                                            <div className="max-w-[90%] space-y-1.5">
                                                {/* Live tool indicators */}
                                                {(msg.activeTools || []).length > 0 && (
                                                    <div className="flex flex-wrap gap-1">
                                                        {[...new Set(msg.activeTools)].map(t => (
                                                            <span key={t} className="flex items-center gap-1 text-[10px] text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 rounded px-1.5 py-0.5 animate-pulse">
                                                                <Wrench className="w-2.5 h-2.5" />
                                                                {t.replace(/_/g, ' ')}
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                                {/* Streaming text or spinner */}
                                                <div className="bg-zinc-800/50 border border-white/10 rounded-2xl rounded-tl-sm px-4 py-3">
                                                    {hasText ? (
                                                        <div className="text-sm text-zinc-100 leading-relaxed whitespace-pre-wrap">
                                                            {msg.text}
                                                            <span className="inline-block w-1.5 h-3.5 bg-cyan-400 ml-0.5 animate-pulse align-text-bottom" />
                                                        </div>
                                                    ) : (
                                                        <div className="flex items-center gap-2">
                                                            <Wrench className="w-3 h-3 text-cyan-400 animate-pulse" />
                                                            <span className="text-xs text-zinc-400">Agent is working</span>
                                                            <div className="flex gap-1 ml-1">
                                                                {[0, 150, 300].map(d => (
                                                                    <div key={d} className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    )
                                }

                                if (msg.role === 'user') {
                                    return (
                                        <div key={idx} className="flex justify-end">
                                            <div className="max-w-[85%] bg-cyan-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed">
                                                {msg.content}
                                            </div>
                                        </div>
                                    )
                                }

                                // assistant
                                return (
                                    <div key={idx} className="flex justify-start">
                                        <div className="max-w-[90%] space-y-2">
                                            <div className="group relative bg-zinc-800/80 border border-white/10 text-zinc-100 rounded-2xl rounded-tl-sm px-4 py-2.5">
                                                <MarkdownMessage content={msg.content} />
                                                <div className="absolute top-1.5 right-1.5">
                                                    <CopyButton text={msg.content} />
                                                </div>
                                            </div>
                                            {/* Tool badges */}
                                            {msg.toolsUsed?.length > 0 && (
                                                <div className="flex flex-wrap gap-1 px-1">
                                                    {[...new Set(msg.toolsUsed)].map(t => (
                                                        <span key={t} className="flex items-center gap-1 text-[10px] text-zinc-500 bg-zinc-800/60 border border-white/5 rounded px-1.5 py-0.5">
                                                            <Wrench className="w-2.5 h-2.5" />
                                                            {t.replace(/_/g, ' ')}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                            {/* Element count badge */}
                                            {msg.elementCount != null && msg.elementCount > 0 && (
                                                <div className="flex items-center gap-1.5 px-1">
                                                    <span className="flex items-center gap-1 text-[11px] text-cyan-400 font-medium">
                                                        <Filter className="w-3 h-3" />
                                                        {msg.elementCount.toLocaleString()} elements highlighted in 3D
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )
                            })}
                            <div ref={messagesEndRef} />
                        </div>

                        {/* Input */}
                        <form onSubmit={handleSubmit} className="p-2 border-t border-white/10 bg-white/5">
                            <div className="relative">
                                <input
                                    type="text"
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    placeholder="Ask about your model..."
                                    className="w-full bg-zinc-900/50 border border-white/10 rounded-lg pl-3 pr-9 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all placeholder:text-zinc-500"
                                />
                                <button
                                    type="submit"
                                    disabled={!input.trim() || isLoading}
                                    className="absolute right-1 top-1 p-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded-md disabled:opacity-50 disabled:hover:bg-cyan-600 transition-colors cursor-pointer"
                                >
                                    <Send className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </form>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Toggle Button */}
            <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setIsOpen(!isOpen)}
                onPointerDown={(e) => {
                    // Check if it's a drag or a click? useDragControls handles start.
                    // But we also want click to toggle.
                    // Framer motion drag usually doesn't prevent click unless dragged.
                    dragControls.start(e)
                }}
                className="pointer-events-auto w-12 h-12 rounded-full border border-cyan-500/40 backdrop-blur-md text-cyan-400 shadow-lg hover:bg-cyan-500/10 flex items-center justify-center transition-colors relative cursor-move"
            >
                {isOpen ? (
                    <X className="w-8 h-8" />
                ) : (
                    <MessageSquare className="w-8 h-8" />
                )}
                {/* Ping animation if closed and no messages read? Optional. */}
            </motion.button>
        </motion.div>
    )
}
