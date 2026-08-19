// Shared shell for /impressum and /datenschutz — deliberately outside the
// auth gate (see App.jsx's _legalPage check, evaluated before the
// resetToken/authLoading/authUser branches) since German law requires the
// legal notice and privacy policy to be reachable without logging in.
export function LegalPageLayout({ title, children }) {
  return (
    <div className="min-h-screen text-white">
      <div className="relative min-h-screen overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#151726] via-[#12131b] to-[#08080c]" />
        <div className="absolute inset-0 bg-gradient-to-br from-[#136CFF]/25 via-[#818CF8]/10 to-transparent pointer-events-none" />

        <div className="relative mx-auto flex max-w-3xl flex-col gap-8 px-6 py-10 lg:px-8">
          <header className="flex items-center justify-between gap-4">
            <a href="/" className="flex items-center gap-3">
              <img src="/converge-logo2-transparent.png" alt="Converge logo" className="h-9 w-auto" />
              <span className="text-xl font-bold gradient-text leading-none">Converge</span>
            </a>
            <a href="/" className="text-sm text-slate-400 hover:text-slate-200 transition-colors">
              &larr; Zurück
            </a>
          </header>

          <main className="rounded-[1.5rem] border border-white/10 bg-slate-950/80 p-6 shadow-xl shadow-slate-950/30 sm:p-10">
            <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">{title}</h1>
            <div className="mt-6 space-y-6 text-sm leading-6 text-slate-300 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-white [&_h2]:mb-2 [&_p]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_a]:text-indigo-300 [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-indigo-200">
              {children}
            </div>
          </main>

          <footer className="flex flex-wrap gap-4 text-xs text-slate-500">
            <a href="/impressum" className="hover:text-slate-300 transition-colors">Impressum</a>
            <a href="/datenschutz" className="hover:text-slate-300 transition-colors">Datenschutz</a>
          </footer>
        </div>
      </div>
    </div>
  )
}

// Visually loud wrapper for any field the deployment operator must fill in
// with real information before going live — an Impressum/Datenschutzerklärung
// published with placeholder text is arguably worse than having none, so
// these are red, not just styled differently.
export function LegalPlaceholder({ children }) {
  return (
    <span className="rounded bg-red-500/20 px-1.5 py-0.5 font-mono text-red-300 ring-1 ring-red-500/40">
      {children}
    </span>
  )
}
