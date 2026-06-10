import { useState, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import { Edit2, Save, X } from 'lucide-react'

export function MarkdownWidget({ content, onUpdate }) {
    const [isEditing, setIsEditing] = useState(false)
    const [tempContent, setTempContent] = useState(content || '')

    // Keep tempContent in sync with the prop when NOT editing
    // (handles external content updates while the panel is open but not in edit mode)
    useEffect(() => {
        if (!isEditing) setTempContent(content || '')
    }, [content, isEditing])

    const handleSave = useCallback(() => {
        onUpdate?.(tempContent)
        setIsEditing(false)
    }, [tempContent, onUpdate])

    const handleCancel = useCallback(() => {
        setTempContent(content || '')
        setIsEditing(false)
    }, [content])

    const handleKeyDown = useCallback((e) => {
        if (e.key === 'Escape') {
            e.preventDefault()
            handleCancel()
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault()
            handleSave()
        }
    }, [handleSave, handleCancel])

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Toolbar */}
            <div className="flex items-center justify-between p-3 border-b border-white/5 bg-zinc-900/30">
                <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider pl-2">
                    {isEditing ? 'Editing Note' : 'Note'}
                </h3>
                <div className="flex gap-1.5">
                    {isEditing ? (
                        <>
                            <button
                                onClick={handleCancel}
                                className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-zinc-200 transition-colors flex items-center gap-1 text-xs"
                                title="Cancel (Esc)"
                            >
                                <X className="w-3.5 h-3.5" />
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                className="p-1.5 rounded-lg bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors flex items-center gap-1 text-xs font-medium"
                                title="Save (Ctrl+S)"
                            >
                                <Save className="w-3.5 h-3.5" />
                                Save
                            </button>
                        </>
                    ) : (
                        <button
                            onClick={() => setIsEditing(true)}
                            className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-colors"
                            title="Edit note"
                        >
                            <Edit2 className="w-4 h-4" />
                        </button>
                    )}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto">
                {isEditing ? (
                    <textarea
                        value={tempContent}
                        onChange={e => setTempContent(e.target.value)}
                        onKeyDown={handleKeyDown}
                        className="w-full h-full bg-transparent p-4 text-sm font-mono text-zinc-300 resize-none focus:outline-none"
                        placeholder="Write your note in Markdown…"
                        autoFocus
                    />
                ) : (
                    <div className={`p-6 prose prose-invert prose-sm max-w-none
                        [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-4 [&_h1]:text-blue-400
                        [&_h2]:text-xl  [&_h2]:font-bold [&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:text-zinc-200
                        [&_h3]:text-lg  [&_h3]:font-bold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-zinc-300
                        [&_p]:text-zinc-400 [&_p]:leading-relaxed [&_p]:mb-3
                        [&_ul]:list-disc   [&_ul]:pl-5 [&_ul]:mb-3 [&_ul]:text-zinc-400
                        [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-3 [&_ol]:text-zinc-400
                        [&_li]:mb-1 [&_li]:text-zinc-400
                        [&_blockquote]:border-l-4 [&_blockquote]:border-zinc-700 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-zinc-500 [&_blockquote]:my-3
                        [&_pre]:bg-zinc-950 [&_pre]:p-4 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:my-4
                        [&_code]:bg-zinc-800 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono [&_code]:text-red-300
                        [&_a]:text-blue-400 [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-blue-300
                        [&_hr]:border-white/10 [&_hr]:my-4
                        [&_table]:w-full [&_table]:text-sm [&_table]:border-collapse
                        [&_th]:text-left [&_th]:px-3 [&_th]:py-1.5 [&_th]:border [&_th]:border-white/10 [&_th]:text-zinc-300 [&_th]:font-medium
                        [&_td]:px-3 [&_td]:py-1.5 [&_td]:border [&_td]:border-white/10 [&_td]:text-zinc-400
                        [&_strong]:text-zinc-200 [&_strong]:font-semibold
                        [&_em]:text-zinc-300 [&_em]:italic`}
                    >
                        <ReactMarkdown>
                            {content || '*No content yet — click the edit button to add a note.*'}
                        </ReactMarkdown>
                    </div>
                )}
            </div>
        </div>
    )
}
