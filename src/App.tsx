import { useEffect, useMemo, useState } from 'react'
import acceptanceText from '../acceptance.md?raw'
import implementationAcceptanceText from '../IMPLEMENTATION_ACCEPTANCE.md?raw'
import specText from '../SPEC.yaml?raw'
import { attestations, ideaState, policy, rendering, verifierRegistry } from './data/demo'
import { evaluateRendering } from './domain/verification'
import type { AttestationEvaluation, RenderingEvaluation } from './domain/types'
import { IdeaDirectory, PublishIdea } from './Publisher'

type View = 'ideas' | 'explorer' | 'protocol' | 'acceptance' | 'publish'

const statusCopy = {
  'recognized-pass': { label: 'Recognized pass', icon: 'check' },
  'recognized-fail': { label: 'Recognized fail', icon: 'x' },
  'valid-unrecognized': { label: 'Valid signature · not recognized', icon: 'minus' },
  invalid: { label: 'Invalid signature', icon: 'x' },
} as const

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    mark: <><path d="M7 3.7 12 1l5 2.7v5.6L12 12 7 9.3V3.7Z"/><path d="M12 12v5.5M7 9.3l-3 1.6v5.4L9 19l3-1.5 3 1.5 5-2.7v-5.4l-3-1.6"/></>,
    check: <path d="m5 12 4 4L19 6" />,
    x: <><path d="m7 7 10 10"/><path d="M17 7 7 17"/></>,
    minus: <path d="M5 12h14" />,
    git: <><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h3a3 3 0 0 1 3 3v6a3 3 0 0 0 2 2.8M14 12h-3a3 3 0 0 1-3-3V8"/></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/></>,
    shield: <path d="M12 3 5 6v5c0 4.6 2.9 8 7 10 4.1-2 7-5.4 7-10V6l-7-3Z" />,
    file: <><path d="M6 2h8l4 4v16H6V2Z"/><path d="M14 2v5h5M9 12h6M9 16h6"/></>,
    arrow: <><path d="M5 12h14"/><path d="m15 8 4 4-4 4"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    link: <><path d="m10 13 4-4"/><path d="m7 16-1 1a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0"/><path d="m17 8 1-1a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0"/></>,
    key: <><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l2 2M14 9l2 2"/></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

function shortHash(value: string, lead = 10, tail = 7) {
  return `${value.slice(0, lead)}…${value.slice(-tail)}`
}

function StatusPill({ evaluation }: { evaluation: AttestationEvaluation }) {
  const status = statusCopy[evaluation.status]
  return (
    <span className={`status-pill status-${evaluation.status}`}>
      <Icon name={status.icon} size={14} />
      {status.label}
    </span>
  )
}

function Header({ view, setView }: { view: View; setView: (view: View) => void }) {
  const [open, setOpen] = useState(false)
  const navigate = (next: View) => {
    setView(next)
    setOpen(false)
  }
  return (
    <header className="site-header">
      <button className="brand" onClick={() => navigate('ideas')} aria-label="IRAP home">
        <span className="brand-mark"><Icon name="mark" size={26} /></span>
        <span><strong>IRAP</strong><small>Federated Publisher</small></span>
      </button>
      <button className="mobile-menu" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Toggle navigation"><Icon name="menu" /></button>
      <nav className={open ? 'nav-open' : ''} aria-label="Primary">
        {(['ideas', 'explorer', 'protocol', 'acceptance', 'publish'] as View[]).map((item) => (
          <button key={item} className={view === item ? 'active' : ''} onClick={() => navigate(item)}>
            {item === 'ideas' ? 'Ideas' : item === 'publish' ? 'Publish' : item[0].toUpperCase() + item.slice(1)}
          </button>
        ))}
      </nav>
      <div className="header-state">
        <span className="live-dot" /> Reference implementation
      </div>
    </header>
  )
}

function Pipeline() {
  const items = [
    ['Idea', 'Durable identity', 'layers'],
    ['Git state', 'Exact object', 'git'],
    ['Rendering', 'Published artifact', 'file'],
    ['Attestation', 'Signed judgment', 'key'],
    ['Policy', 'Historical rules', 'shield'],
  ]
  return (
    <div className="pipeline" aria-label="IRAP object model">
      {items.map(([title, copy, icon], index) => (
        <div className="pipeline-part" key={title}>
          <div className={`pipeline-node node-${index}`}>
            <span><Icon name={icon} size={18} /></span>
            <div><strong>{title}</strong><small>{copy}</small></div>
          </div>
          {index < items.length - 1 && <Icon name="arrow" size={16} />}
        </div>
      ))}
    </div>
  )
}

function SummaryCard({ evaluation }: { evaluation: RenderingEvaluation }) {
  return (
    <section className="summary-card">
      <div className="eyebrow"><span>Selected rendering</span><span className="object-type">text/html</span></div>
      <div className="summary-title-row">
        <div>
          <h2>{rendering.title}</h2>
          <p>{rendering.description}</p>
        </div>
        <div className={`recognition-seal ${evaluation.recognized ? 'seal-good' : ''}`}>
          <Icon name={evaluation.recognized ? 'check' : 'minus'} size={22} />
          <strong>{evaluation.recognized ? 'Recognized' : 'Pending'}</strong>
          <small>{evaluation.passes} of {evaluation.threshold} required passes</small>
        </div>
      </div>
      <div className="fact-grid">
        <div><span>Rendering ID</span><strong>{rendering.id.replace('https://', '')}</strong></div>
        <div><span>Created by</span><strong>{rendering.creator.name}</strong></div>
        <div><span>Artifact SHA-256</span><code>{shortHash(rendering.artifact.sha256, 12, 9)}</code></div>
        <div><span>Published</span><strong>August 27, 2026</strong></div>
      </div>
    </section>
  )
}

function StateCard() {
  return (
    <section className="state-card">
      <div className="card-heading"><span className="icon-box"><Icon name="git" /></span><div><small>Exact state anchor</small><h3>Idea Rendering Attestation Protocol</h3></div></div>
      <div className="state-line"><span>Idea ID</span><strong>proximitytoprogress.com/ideas/irap</strong></div>
      <div className="state-line"><span>Repository</span><strong>git.example.org/proximity/irap.git</strong></div>
      <div className="commit-block">
        <span><Icon name="git" size={15} /> Git commit · {ideaState.git_commit.algorithm.toUpperCase()}</span>
        <code>{ideaState.git_commit.value}</code>
        <small>Full object ID · not a branch or tag</small>
      </div>
      <div className="policy-block">
        <div><span className="icon-box small"><Icon name="shield" size={16} /></span><div><small>Policy at this commit</small><strong>1 recognized pass required</strong></div></div>
        <span className="policy-match"><Icon name="check" size={13} /> State matched</span>
      </div>
    </section>
  )
}

function AttestationList({ evaluation, selected, onSelect }: { evaluation: RenderingEvaluation; selected: number; onSelect: (index: number) => void }) {
  return (
    <section className="attestations-card">
      <div className="section-heading">
        <div><span className="section-icon"><Icon name="key" /></span><div><h3>Attributable attestations</h3><p>Every judgment remains visible, whether recognized or not.</p></div></div>
        <span className="count-badge">{evaluation.evaluations.length} records</span>
      </div>
      <div className="attestation-list">
        {evaluation.evaluations.map((item, index) => {
          const displayName = item.verifier?.name ?? (item.attestation.verifier.id === 'did:key:review-bot' ? 'Open Review Bot' : 'Unknown signer')
          const kind = item.verifier?.kind ?? (item.attestation.verifier.id.includes('bot') ? 'AI verifier' : 'Unregistered verifier')
          return (
            <button className={`attestation-row ${selected === index ? 'selected' : ''}`} key={item.attestation.id} onClick={() => onSelect(index)}>
              <span className={`avatar avatar-${index}`}>{displayName.split(' ').map((word) => word[0]).join('').slice(0, 2)}</span>
              <span className="attestation-person"><strong>{displayName}</strong><small>{kind} · {new Date(item.attestation.signed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</small></span>
              <span className="attestation-claim"><small>Claim</small><strong>{item.attestation.judgment.claim.replace('_', ' ')}</strong></span>
              <StatusPill evaluation={item} />
              <span className="row-chevron">›</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function EvidencePanel({ evaluation }: { evaluation: AttestationEvaluation }) {
  const signed = evaluation.signatureValid
  const eligible = evaluation.recognized
  return (
    <aside className="evidence-panel">
      <div className="evidence-top">
        <span>Selected attestation</span>
        <StatusPill evaluation={evaluation} />
      </div>
      <h3>{evaluation.attestation.judgment.result === 'pass' ? 'Faithful rendering' : 'Not a faithful rendering'}</h3>
      <p className="evidence-summary">{evaluation.attestation.evidence.summary}</p>
      <div className="audit-steps">
        <div className={signed ? 'step-good' : 'step-bad'}><span><Icon name={signed ? 'check' : 'x'} size={15} /></span><div><strong>Signature</strong><small>{signed ? 'Ed25519 signature valid' : 'Canonical payload check failed'}</small></div></div>
        <div className={eligible ? 'step-good' : 'step-neutral'}><span><Icon name={eligible ? 'check' : 'minus'} size={15} /></span><div><strong>Policy eligibility</strong><small>{eligible ? 'Authorized at this commit' : 'Does not count under this policy'}</small></div></div>
        <div className="step-good"><span><Icon name="check" size={15} /></span><div><strong>Target binding</strong><small>Rendering and full Git state named</small></div></div>
      </div>
      {evaluation.reasons.length > 0 && (
        <div className="reason-box"><strong>Why this result</strong>{evaluation.reasons.map((reason) => <p key={reason}>{reason}</p>)}</div>
      )}
      <dl className="evidence-meta">
        <div><dt><Icon name="user" size={15} /> Signer ID</dt><dd>{evaluation.attestation.verifier.id}</dd></div>
        <div><dt><Icon name="clock" size={15} /> Signed</dt><dd>{new Date(evaluation.attestation.signed_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</dd></div>
        <div><dt><Icon name="link" size={15} /> Evidence</dt><dd>{evaluation.attestation.evidence.uri.replace('https://', '')}</dd></div>
        <div><dt>SHA-256</dt><dd><code>{shortHash(evaluation.attestation.evidence.sha256, 10, 8)}</code></dd></div>
      </dl>
      <div className="principle-note"><Icon name="shield" size={17} /><p><strong>Verification is attributable.</strong> This result says who judged what, against which state, under which rules.</p></div>
    </aside>
  )
}

function Explorer({ evaluation }: { evaluation: RenderingEvaluation }) {
  const [selected, setSelected] = useState(0)
  return (
    <>
      <section className="hero">
        <div><span className="kicker">Reference rendering · IRAP 0.1</span><h1>Trust the relationship,<br /><em>not the badge.</em></h1><p>Inspect an artifact against an exact Git state, a named verifier, and the policy that existed at that moment.</p></div>
        <div className="hero-quote"><span>Core principle</span><blockquote>“Verification is an attributable act, not an intrinsic property.”</blockquote></div>
      </section>
      <main className="page-shell explorer-shell">
        <Pipeline />
        <div className="overview-grid"><SummaryCard evaluation={evaluation} /><StateCard /></div>
        <div className="review-grid"><AttestationList evaluation={evaluation} selected={selected} onSelect={setSelected} /><EvidencePanel evaluation={evaluation.evaluations[selected]} /></div>
      </main>
    </>
  )
}

function ProtocolView() {
  const concepts = [
    ['01', 'Idea', 'A durable semantic identity. Mirrors can change without changing the idea.'],
    ['02', 'Exact Git state', 'A repository plus a full SHA-1 or SHA-256 Git object ID.'],
    ['03', 'Rendering', 'An independently published, content-addressed artifact claiming that state.'],
    ['04', 'Attestation', 'A signed conclusion by an attributable verifier with bound evidence.'],
    ['05', 'Historical policy', 'The registry and recognition rules stored in that exact state.'],
  ]
  return (
    <main className="document-page page-shell">
      <span className="kicker dark">Normative model · draft 0.1</span>
      <h1>One protocol, five typed objects.</h1>
      <p className="document-lede">IRAP separates identity, versioned state, creative work, judgment, and governance so each claim can be inspected and falsified independently.</p>
      <div className="concept-grid">{concepts.map(([number, title, body]) => <article key={number}><span>{number}</span><h2>{title}</h2><p>{body}</p></article>)}</div>
      <section className="algorithm-card"><div><small>Recognition algorithm</small><h2>Validity first. Governance second.</h2></div><ol><li>Bind artifact and attestation to the same exact state.</li><li>Verify the Ed25519 signature over canonical JSON.</li><li>Load keys and policy from that historical state.</li><li>Apply scope, eligibility, disagreement, and threshold rules.</li></ol></section>
      <details className="source-details"><summary>Inspect bundled SPEC.yaml</summary><pre>{specText}</pre></details>
    </main>
  )
}

function AcceptanceView() {
  const criteria = useMemo(() => implementationAcceptanceText.split('\n').filter((line) => line.startsWith('- **A')), [])
  return (
    <main className="document-page page-shell">
      <span className="kicker dark">Auditable completion · 16 checks</span>
      <h1>What “done” means.</h1>
      <p className="document-lede">Every recommendation has an observable evidence path and a prior failure mode it is designed to catch.</p>
      <div className="acceptance-grid">{criteria.map((criterion) => {
        const match = criterion.match(/- \*\*(A\d+) — ([^*]+):\*\* (.*)/)
        if (!match) return null
        return <article key={match[1]}><span>{match[1]}</span><div><h2>{match[2]}</h2><p>{match[3]}</p></div></article>
      })}</div>
      <section className="stopping-rule"><Icon name="shield" size={26} /><div><small>Stopping rule</small><p>Do not call the service deployable if its tests, compiled builds, container health check, discovery endpoints, or signed-transport falsification test fails.</p></div></section>
      <details className="source-details"><summary>Inspect the original IRAP v0.1 acceptance checklist</summary><pre>{acceptanceText}</pre></details>
    </main>
  )
}

function LoadingState() {
  return <main className="loading"><span className="spinner" /><p>Evaluating canonical signatures and historical policy…</p></main>
}

export default function App() {
  const [view, setView] = useState<View>('ideas')
  const [evaluation, setEvaluation] = useState<RenderingEvaluation | null>(null)

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [view])

  useEffect(() => {
    let current = true
    evaluateRendering(rendering, attestations, verifierRegistry, policy).then((result) => current && setEvaluation(result))
    return () => { current = false }
  }, [])

  return (
    <div className="app">
      <Header view={view} setView={setView} />
      {view === 'ideas' ? <IdeaDirectory onPublish={() => setView('publish')} />
        : view === 'publish' ? <PublishIdea onPublished={() => setView('ideas')} onCancel={() => setView('ideas')} />
        : view === 'explorer' ? (evaluation ? <Explorer evaluation={evaluation} /> : <LoadingState />)
        : view === 'protocol' ? <ProtocolView /> : <AcceptanceView />}
      <footer><div><span className="brand-mark small"><Icon name="mark" size={19} /></span><strong>IRAP 0.1</strong><span>Forge-agnostic · federation-optional</span></div><div className="implementation-commit">Implements commit <code>{__IRAP_IMPLEMENTATION_COMMIT__}</code></div></footer>
    </div>
  )
}
