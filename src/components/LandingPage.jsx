import { CheckCircle2, Sparkles, Layers, Shield, Globe2, FileText, Calendar } from 'lucide-react'
import { LoginScreen } from './LoginScreen'

const features = [
  {
    title: 'Model normalization for every BIM source',
    description: 'Revit, Tekla, IFC, Navisworks, Blender, Rhino and Grasshopper all flow into a single IFC-aligned PostgreSQL schema.',
    icon: Layers,
  },
  {
    title: 'Clash detection & IDS validation',
    description: 'Cross-discipline clash checks and Information Delivery Specification compliance, federated across multiple models.',
    icon: Shield,
  },
  {
    title: 'BCF collaboration',
    description: 'Generate, review and track BCF topics, comments and viewpoints with your own built-in BCF 2.1/3.0 server — compatible with BIMcollab ZOOM.',
    icon: CheckCircle2,
  },
  {
    title: 'Document control',
    description: 'An ISO 19650-aligned CDE — Nextcloud-backed WIP → Shared → Published → Archived workflow with suitability codes, org-scoped WIP visibility, and an in-app/email notification feed.',
    icon: FileText,
  },
  {
    title: '4D/5D scheduling',
    description: 'Author construction schedules, play back build sequences, and pull quantity/cost takeoffs straight from the model.',
    icon: Calendar,
  },
  {
    title: 'AI-assisted BIM reasoning',
    description: 'MCP integration lets your BIM data be queried, summarized and reasoned over in natural language.',
    icon: Sparkles,
  },
]

export function LandingPage() {
  return (
    <div className="text-white">
      <div className="relative min-h-screen overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#151726] via-[#12131b] to-[#08080c]" />
        {/* Same blue → cyan → indigo → violet progression as the "Converge"
            gradient-text, washed diagonally top-left to bottom-right across
            the whole page at low opacity so it tints the background without
            hurting text contrast. Single linear wash (no separate radial
            blobs) keeps the transition uniform corner-to-corner instead of
            patchy. */}
        <div className="absolute inset-0 bg-gradient-to-br from-[#136CFF]/25 via-[#818CF8]/10 to-transparent pointer-events-none" />

        <div className="relative mx-auto flex max-w-6xl flex-col gap-6 px-6 py-6 lg:px-8 lg:py-8">
          <header className="flex items-center gap-4">
            <img src="/converge-logo2-transparent.png" alt="Converge logo" className="h-11 w-auto" />
            <div className="flex flex-col leading-none">
              <span className="self-start text-2xl font-bold gradient-text leading-none">Converge</span>
              <span className="mt-1.5 text-xs uppercase tracking-[0.35em] text-slate-400">Open source BIM coordination stack</span>
            </div>
          </header>

          {/* Hero — the login panel is the actual point of this page (a self-
              hosted tool's entry gate, not a public signup funnel), so it's
              the visually dominant element, not a small form buried under a
              placeholder graphic. */}
          <main className="grid gap-12 lg:grid-cols-[1.6fr_1fr] lg:items-center">
            <section className="max-w-2xl space-y-4">
              <p className="inline-flex items-center gap-2 rounded-full border border-slate-600/50 bg-slate-950/80 px-4 py-2 text-sm text-slate-300 shadow-sm shadow-slate-950/40">
                <Globe2 className="h-4 w-4 text-slate-300" />
                Open BIM operations, one platform.
              </p>
              <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                <span className="gradient-text">Converge</span> your BIM data, coordination workflows and AI insights.
              </h1>
              <p className="text-lg text-slate-300">
                A self-hosted dashboard for ingesting models, normalising them to IFC, reviewing clashes and IDS, managing documents, and collaborating through BCF with LLM-assisted BIM intelligence.
              </p>

              <div className="flex flex-wrap gap-3 pt-1">
                <span className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs uppercase tracking-[0.2em] text-slate-400">
                  Revit · Tekla · IFC · Blender · Navisworks · Rhino · Grasshopper
                </span>
                <span className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs uppercase tracking-[0.2em] text-slate-400">
                  Supports multiple Speckle servers — official or self-hosted
                </span>
              </div>
            </section>

            <section className="relative flex justify-center lg:justify-end">
              <LoginScreen layout="panel" className="relative" />
            </section>
          </main>

          <section id="features" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => {
              const Icon = feature.icon
              return (
                <div key={feature.title} className="rounded-[1.5rem] border border-white/10 bg-slate-950/80 p-4 shadow-xl shadow-slate-950/30 transition hover:border-indigo-400/40 hover:bg-slate-900/95">
                  <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-300">
                    <Icon className="h-4 w-4" />
                  </div>
                  <h2 className="mt-3 text-base font-semibold text-white">{feature.title}</h2>
                  <p className="mt-1 text-sm leading-6 text-slate-400">{feature.description}</p>
                </div>
              )
            })}
          </section>
        </div>
      </div>
    </div>
  )
}
