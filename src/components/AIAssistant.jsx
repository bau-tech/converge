import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Send, Bot, User, Loader2, X, Sparkles, Settings, Database, Cpu, Save } from 'lucide-react'
import { SpeckleContextBuilder } from '../utils/speckleContextBuilder'

const OPENAI_API_KEY      = import.meta.env.VITE_OPENAI_API_KEY
const DEFAULT_OLLAMA_URL  = import.meta.env.VITE_OLLAMA_BASE_URL  || 'http://localhost:11434'
const DEFAULT_OLLAMA_MODEL= import.meta.env.VITE_OLLAMA_MODEL     || 'llama3'
const DEFAULT_LMSTUDIO_URL= import.meta.env.VITE_LMSTUDIO_BASE_URL|| 'http://localhost:1234/v1'

// Tool definitions (OpenAI tools format — supported by OpenAI, Ollama ≥0.3, LM Studio)
const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'set_filters',
            description: 'Apply filters to the BIM dashboard to show specific elements',
            parameters: {
                type: 'object',
                properties: {
                    filters: {
                        type: 'object',
                        description: 'Key-value pairs of field:value filters',
                        properties: {
                            category:   { type: 'string', description: 'Element category (Wall, Floor, Column, etc.)' },
                            ifc_type:   { type: 'string', description: 'IFC type (IfcWall, IfcBeam, IfcColumn, ...)' },
                            family:     { type: 'string', description: 'Family name' },
                            level:      { type: 'string', description: 'Building level / storey' },
                            material:   { type: 'string', description: 'Material type' },
                            grade_short:{ type: 'string', description: 'Steel grade (S355, S235, ...)' },
                            profile_name:{ type: 'string', description: 'Steel profile name' },
                            discipline: { type: 'string', description: 'Discipline (Architecture, Structure, MEP)' },
                            phase:      { type: 'string', description: 'Construction phase' },
                        },
                    },
                    explanation: { type: 'string', description: 'Human-readable explanation of what filters were applied' },
                },
                required: ['filters', 'explanation'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'calculate_aggregate',
            description: 'Calculate aggregate statistics (sum, average, count) grouped by a field',
            parameters: {
                type: 'object',
                properties: {
                    operation:   { type: 'string', enum: ['sum', 'avg', 'count', 'min', 'max'] },
                    field:       { type: 'string', description: 'Field to aggregate (volume_m3, area_m2, weight_kg, length_mm)' },
                    group_by:    { type: 'string', description: 'Field to group by (level, category, material, ifc_type)' },
                    explanation: { type: 'string', description: 'Explanation of the calculation' },
                },
                required: ['operation', 'field', 'explanation'],
            },
        },
    },
]

function newMsgId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export function AIAssistant({ data, fullData, onApplyFilters, currentFilters, onClose }) {
    const [provider, setProvider]   = useState(() => localStorage.getItem('ai_provider') || 'openai')
    const [ollamaConfig, setOllamaConfig] = useState(() => ({
        baseUrl: localStorage.getItem('ollama_url')   || DEFAULT_OLLAMA_URL,
        model:   localStorage.getItem('ollama_model') || DEFAULT_OLLAMA_MODEL,
    }))
    const [lmStudioConfig, setLmStudioConfig] = useState(() => ({
        baseUrl: localStorage.getItem('lmstudio_url')   || DEFAULT_LMSTUDIO_URL,
        model:   localStorage.getItem('lmstudio_model') || 'local-model',
    }))
    const [showSettings, setShowSettings] = useState(false)
    const [messages, setMessages] = useState([{
        id: newMsgId(),
        role: 'assistant',
        content: 'Hi! I can help you analyze your BIM model. Try asking:\n• "Show me all structural columns"\n• "Find concrete walls on level 2"\n• "What materials are used most?"\n• "Calculate total steel weight by level"',
    }])
    const [input, setInput]   = useState('')
    const [loading, setLoading] = useState(false)
    const abortRef            = useRef(null)
    const messagesEndRef      = useRef(null)

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages])

    // Memoize system prompt — rebuilding traverses 100 elements, no need to redo it on every keystroke
    const systemPrompt = useMemo(() => {
        if (!data && !fullData) return ''
        return new SpeckleContextBuilder(data, fullData).buildSystemPrompt(currentFilters)
    }, [data, fullData, currentFilters])

    const handleSaveSettings = () => {
        localStorage.setItem('ai_provider',    provider)
        localStorage.setItem('ollama_url',     ollamaConfig.baseUrl)
        localStorage.setItem('ollama_model',   ollamaConfig.model)
        localStorage.setItem('lmstudio_url',   lmStudioConfig.baseUrl)
        localStorage.setItem('lmstudio_model', lmStudioConfig.model)
        setShowSettings(false)
    }

    const addMessage = useCallback((msg) => {
        setMessages(prev => [...prev, { id: newMsgId(), ...msg }])
    }, [])

    const handleSend = useCallback(async () => {
        if (!input.trim() || loading) return

        const isOpenAI = provider === 'openai'
        if (isOpenAI && !OPENAI_API_KEY) {
            addMessage({ role: 'assistant', content: '⚠️ OpenAI API key not configured. Add VITE_OPENAI_API_KEY to your .env file.', error: true })
            return
        }

        const userText = input.trim()
        setInput('')
        addMessage({ role: 'user', content: userText })
        setLoading(true)

        // Cancel any previous in-flight request
        abortRef.current?.abort()
        const ctrl = new AbortController()
        abortRef.current = ctrl

        try {
            const endpoint = isOpenAI
                ? 'https://api.openai.com/v1/chat/completions'
                : provider === 'ollama'
                    ? `${ollamaConfig.baseUrl}/v1/chat/completions`
                    : `${lmStudioConfig.baseUrl}/chat/completions`

            const headers = { 'Content-Type': 'application/json' }
            if (isOpenAI) headers['Authorization'] = `Bearer ${OPENAI_API_KEY}`

            // Build full conversation history for multi-turn context.
            // Strip UI-only fields (filters, error, id) before sending to API.
            const historyForApi = messages.map(({ role, content }) => ({ role, content }))

            const res = await fetch(endpoint, {
                method: 'POST',
                headers,
                signal: ctrl.signal,
                body: JSON.stringify({
                    model: isOpenAI ? 'gpt-4o' : (provider === 'ollama' ? ollamaConfig.model : lmStudioConfig.model),
                    messages: [
                        { role: 'system', content: systemPrompt },
                        ...historyForApi,
                        { role: 'user', content: userText },
                    ],
                    tools: TOOLS,
                    tool_choice: 'auto',
                }),
            })

            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.error?.message || `API error ${res.status}`)
            }

            const result = await res.json()
            const choice = result.choices?.[0]
            if (!choice) throw new Error('Empty response from API')

            const message = choice.message

            // ── Tool call (new tools format) ────────────────────────────────
            if (message.tool_calls?.length) {
                for (const toolCall of message.tool_calls) {
                    const name = toolCall.function.name
                    let args
                    try {
                        args = JSON.parse(toolCall.function.arguments)
                    } catch {
                        addMessage({ role: 'assistant', content: '⚠️ The AI returned a malformed tool call. Please try rephrasing your question.', error: true })
                        continue
                    }

                    if (name === 'set_filters') {
                        const cleanFilters = Object.fromEntries(
                            Object.entries(args.filters || {}).filter(([, v]) => v && String(v).trim())
                        )
                        addMessage({ role: 'assistant', content: args.explanation || 'Applied filters', filters: cleanFilters })
                        if (Object.keys(cleanFilters).length > 0) onApplyFilters?.(cleanFilters)

                    } else if (name === 'calculate_aggregate') {
                        // Perform the aggregate locally from fullData
                        const agg = computeAggregate(fullData, args)
                        const resultText = agg
                            ? `${args.explanation}\n\nResult:\n${agg}`
                            : `${args.explanation}\n\nNo data available for this calculation.`
                        addMessage({ role: 'assistant', content: resultText })

                    } else {
                        addMessage({ role: 'assistant', content: `*(Unhandled tool: ${name})*` })
                    }
                }
                return
            }

            // ── Legacy function_call format (fallback for older APIs) ────────
            if (message.function_call) {
                let args
                try { args = JSON.parse(message.function_call.arguments) } catch {
                    args = {}
                }
                if (message.function_call.name === 'set_filters') {
                    const cleanFilters = Object.fromEntries(
                        Object.entries(args.filters || {}).filter(([, v]) => v && String(v).trim())
                    )
                    addMessage({ role: 'assistant', content: args.explanation || 'Applied filters', filters: cleanFilters })
                    if (Object.keys(cleanFilters).length > 0) onApplyFilters?.(cleanFilters)
                    return
                }
            }

            // ── JSON text fallback (some local models return JSON text) ───────
            if (message.content && (message.content.trim().startsWith('{') || message.content.includes('"filters"'))) {
                try {
                    const match = message.content.match(/\{[\s\S]*\}/)
                    const parsed = JSON.parse(match ? match[0] : message.content)
                    if (parsed.filters) {
                        const cleanFilters = Object.fromEntries(
                            Object.entries(parsed.filters).filter(([, v]) => v && String(v).trim())
                        )
                        addMessage({ role: 'assistant', content: parsed.explanation || 'Applied filters', filters: cleanFilters })
                        if (Object.keys(cleanFilters).length > 0) onApplyFilters?.(cleanFilters)
                        return
                    }
                } catch { /* not JSON — fall through to regular text */ }
            }

            // ── Regular text response ────────────────────────────────────────
            addMessage({ role: 'assistant', content: message.content || '(empty response)' })

        } catch (err) {
            if (err.name === 'AbortError') return
            const providerName = provider === 'openai' ? 'OpenAI' : provider === 'ollama' ? 'Ollama' : 'LM Studio'
            let msg = `Sorry, I encountered an error with ${providerName}: ${err.message}.`
            if (err.message === 'Failed to fetch' && !isOpenAI) {
                msg += `\n\nPossible fixes:\n1. Ensure ${providerName} is running.\n2. Enable CORS in ${providerName} settings.\n3. Check the URL in AI Settings.`
            } else if (isOpenAI) {
                msg += ' Check your API key and internet connection.'
            }
            addMessage({ role: 'assistant', content: msg, error: true })
        } finally {
            setLoading(false)
        }
    }, [input, loading, provider, ollamaConfig, lmStudioConfig, messages, systemPrompt, addMessage, onApplyFilters, fullData])

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSend()
        }
    }

    return (
        <div className="flex flex-col h-full bg-zinc-900 border-l border-white/10">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-zinc-800/50">
                <div className="flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-cyan-500" />
                    <h3 className="font-semibold text-sm">AI Assistant</h3>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => setShowSettings(v => !v)}
                        className={`p-1.5 rounded-lg transition-colors ${showSettings ? 'bg-cyan-500/20 text-cyan-400' : 'hover:bg-white/10 text-zinc-400'}`}
                        title="AI Settings"
                    >
                        <Settings className="w-4 h-4" />
                    </button>
                    <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-zinc-400">
                        <X className="w-4 h-4" />
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
                        <div className="p-4 space-y-4">
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-zinc-400">AI Provider</label>
                                <div className="flex gap-2">
                                    {[
                                        { id: 'openai',   icon: <Cpu className="w-3 h-3" />,      label: 'OpenAI'    },
                                        { id: 'ollama',   icon: <Database className="w-3 h-3" />,  label: 'Ollama'    },
                                        { id: 'lmstudio', icon: <Cpu className="w-3 h-3" />,      label: 'LM Studio' },
                                    ].map(p => (
                                        <button
                                            key={p.id}
                                            onClick={() => setProvider(p.id)}
                                            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-xs transition-colors ${
                                                provider === p.id
                                                    ? 'bg-cyan-500/20 border border-cyan-500/50 text-cyan-400'
                                                    : 'bg-zinc-800/50 border border-white/5 text-zinc-500 hover:text-zinc-300'
                                            }`}
                                        >
                                            {p.icon}{p.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {provider === 'ollama' && (
                                <div className="space-y-3 pt-2">
                                    <ConfigField label="Ollama API URL" value={ollamaConfig.baseUrl} placeholder="http://localhost:11434"
                                        onChange={v => setOllamaConfig(p => ({ ...p, baseUrl: v }))} />
                                    <ConfigField label="Model Name" value={ollamaConfig.model} placeholder="llama3"
                                        onChange={v => setOllamaConfig(p => ({ ...p, model: v }))} />
                                </div>
                            )}
                            {provider === 'lmstudio' && (
                                <div className="space-y-3 pt-2">
                                    <ConfigField label="LM Studio URL" value={lmStudioConfig.baseUrl} placeholder="http://localhost:1234/v1"
                                        onChange={v => setLmStudioConfig(p => ({ ...p, baseUrl: v }))} />
                                    <ConfigField label="Model Identifier" value={lmStudioConfig.model} placeholder="local-model"
                                        onChange={v => setLmStudioConfig(p => ({ ...p, model: v }))} />
                                </div>
                            )}

                            <button
                                onClick={handleSaveSettings}
                                className="w-full flex items-center justify-center gap-2 py-2 bg-cyan-500 hover:bg-cyan-600 text-white rounded-md text-xs font-medium transition-colors"
                            >
                                <Save className="w-3 h-3" /> Save Configuration
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.map(msg => (
                    <motion.div
                        key={msg.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                    >
                        <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                            msg.role === 'user' ? 'bg-cyan-500/20 text-cyan-400'
                            : msg.error        ? 'bg-red-500/20 text-red-400'
                            :                    'bg-purple-500/20 text-purple-400'
                        }`}>
                            {msg.role === 'user' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                        </div>

                        <div className={`flex-1 max-w-[80%] ${msg.role === 'user' ? 'text-right' : ''}`}>
                            <div className={`inline-block px-4 py-2 rounded-lg ${
                                msg.role === 'user' ? 'bg-cyan-500/20 text-cyan-100'
                                : msg.error        ? 'bg-red-500/10 text-red-200 border border-red-500/20'
                                :                    'bg-zinc-800/50 text-zinc-200'
                            }`}>
                                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>

                                {msg.filters && Object.keys(msg.filters).length > 0 && (
                                    <div className="mt-2 pt-2 border-t border-white/10">
                                        <p className="text-xs text-zinc-400 mb-1">Applied filters:</p>
                                        <div className="flex flex-wrap gap-1">
                                            {Object.entries(msg.filters).map(([field, value]) => (
                                                <span key={field} className="text-xs px-2 py-0.5 bg-cyan-500/20 text-cyan-300 rounded">
                                                    {field}: {value}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </motion.div>
                ))}

                {loading && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex gap-3">
                        <div className="w-8 h-8 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center">
                            <Bot className="w-4 h-4" />
                        </div>
                        <div className="bg-zinc-800/50 px-4 py-2 rounded-lg">
                            <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
                        </div>
                    </motion.div>
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="p-4 border-t border-white/10">
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Ask about your model..."
                        disabled={loading}
                        className="flex-1 px-4 py-2 bg-zinc-800/50 border border-white/10 rounded-lg focus:outline-none focus:border-cyan-500 text-sm placeholder:text-zinc-500 disabled:opacity-50"
                    />
                    <button
                        onClick={handleSend}
                        disabled={!input.trim() || loading}
                        className="px-4 py-2 bg-cyan-500 hover:bg-cyan-600 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-lg transition-colors flex items-center gap-2"
                    >
                        <Send className="w-4 h-4" />
                    </button>
                </div>
                <p className="text-xs text-zinc-500 mt-2">
                    {provider === 'openai' ? 'OpenAI GPT-4o'
                        : provider === 'ollama' ? `Ollama · ${ollamaConfig.model}`
                        : `LM Studio · ${lmStudioConfig.model}`}
                    {' · '}Enter to send
                </p>
            </div>
        </div>
    )
}

// ── Helpers ────────────────────────────────────────────────────────────────

function ConfigField({ label, value, placeholder, onChange }) {
    return (
        <div className="space-y-1">
            <label className="text-xs font-medium text-zinc-400">{label}</label>
            <input
                type="text"
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full bg-zinc-800/50 border border-white/10 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-cyan-500 text-zinc-200"
            />
        </div>
    )
}

// Performs a local aggregate calculation from fullData
function computeAggregate(fullData, { operation, field, group_by }) {
    if (!fullData?.elements?.length) return null

    const getVal = (el, path) => {
        const parts = path.split('.')
        let cur = el
        for (const p of parts) {
            if (cur == null) return undefined
            cur = cur[p]
        }
        return cur
    }

    const groups = {}
    for (const el of fullData.elements) {
        const groupKey = group_by ? String(getVal(el, group_by) ?? 'Unknown') : '_all'
        const raw      = getVal(el, field)
        const val      = typeof raw === 'number' ? raw : parseFloat(raw)

        if (!groups[groupKey]) groups[groupKey] = { count: 0, sum: 0, values: [] }
        groups[groupKey].count += 1
        if (!isNaN(val)) {
            groups[groupKey].sum += val
            groups[groupKey].values.push(val)
        }
    }

    const fmt = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
    const lines = Object.entries(groups)
        .sort(([, a], [, b]) => b.sum - a.sum)
        .slice(0, 15)
        .map(([group, g]) => {
            let val
            switch (operation) {
                case 'sum':   val = fmt(g.sum); break
                case 'avg':   val = g.values.length ? fmt(g.sum / g.values.length) : '—'; break
                case 'count': val = g.count; break
                case 'min':   val = g.values.length ? fmt(Math.min(...g.values)) : '—'; break
                case 'max':   val = g.values.length ? fmt(Math.max(...g.values)) : '—'; break
                default:      val = '?'
            }
            return `  ${group}: ${val}`
        })

    return lines.join('\n') + (Object.keys(groups).length > 15 ? `\n  … (${Object.keys(groups).length - 15} more)` : '')
}
