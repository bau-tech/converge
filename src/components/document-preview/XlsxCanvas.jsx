import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

// .xlsx and legacy .xls — SheetJS Community Edition ('xlsx' package) reads
// both from the same code path, entirely client-side. Multi-sheet workbooks
// get a tab strip; each sheet is rendered as a plain HTML table via
// XLSX.utils.sheet_to_html (styled with Tailwind's arbitrary descendant
// selectors below rather than a separate stylesheet).
export function XlsxCanvas({ url }) {
    const [status, setStatus] = useState('loading') // loading | ready | error
    const [error, setError] = useState(null)
    const [sheets, setSheets] = useState([]) // [{ name, html }]
    const [activeSheet, setActiveSheet] = useState(0)

    useEffect(() => {
        let cancelled = false
        async function load() {
            try {
                const XLSX = await import('xlsx')
                const res = await fetch(url)
                if (!res.ok) throw new Error(`Could not download file (${res.status})`)
                const buffer = await res.arrayBuffer()
                if (cancelled) return
                const workbook = XLSX.read(buffer, { type: 'array' })
                const parsed = workbook.SheetNames.map(name => ({
                    name,
                    html: XLSX.utils.sheet_to_html(workbook.Sheets[name]),
                }))
                if (parsed.length === 0) throw new Error('No sheets found in this workbook')
                setSheets(parsed)
                setStatus('ready')
            } catch (err) {
                if (!cancelled) { setError(err.message); setStatus('error') }
            }
        }
        load()
        return () => { cancelled = true }
    }, [url])

    if (status === 'loading') {
        return (
            <div className="w-full h-full flex items-center justify-center gap-2 text-sm text-gray-500 bg-white">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading spreadsheet…
            </div>
        )
    }
    if (status === 'error') {
        return (
            <div className="w-full h-full flex items-center justify-center text-sm text-red-500 px-8 text-center bg-white">
                Could not preview this spreadsheet: {error}
            </div>
        )
    }

    return (
        <div className="w-full h-full flex flex-col bg-white">
            {sheets.length > 1 && (
                <div className="flex gap-1 px-3 py-2 border-b border-gray-200 overflow-x-auto shrink-0 bg-gray-50">
                    {sheets.map((s, i) => (
                        <button
                            key={s.name}
                            onClick={() => setActiveSheet(i)}
                            className={`text-xs px-3 py-1.5 rounded whitespace-nowrap transition-colors ${
                                i === activeSheet ? 'bg-emerald-500/20 text-emerald-700 font-medium' : 'text-gray-600 hover:bg-gray-200'
                            }`}
                        >
                            {s.name}
                        </button>
                    ))}
                </div>
            )}
            <div
                className="flex-1 overflow-auto p-3 text-gray-900 text-xs [&_table]:border-collapse [&_td]:border [&_td]:border-gray-300 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-gray-300 [&_th]:bg-gray-100 [&_th]:px-2 [&_th]:py-1 [&_th]:font-medium"
                dangerouslySetInnerHTML={{ __html: sheets[activeSheet]?.html || '' }}
            />
        </div>
    )
}
