import { useEffect, useMemo, useState, type FormEvent } from 'react'

type ServiceInfo = {
  actor: string
  handle: string
  federation: boolean
  protocol: string
}

export type PublishedIdea = {
  id: string
  slug: string
  name: string
  summary: string
  repository: string
  git_commit: { algorithm: 'sha1' | 'sha256'; value: string }
  spec_yaml: string
  git_verified: boolean
  created_at: string
  updated_at: string
}

type IconName = 'globe' | 'git' | 'broadcast' | 'plus' | 'arrow' | 'file' | 'lock' | 'check' | 'alert'

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 4.3 6.2 4.3 9S15 17.8 12 21c-3-3.2-4.3-6.2-4.3-9S9 6.2 12 3Z"/></>,
    git: <><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h3a3 3 0 0 1 3 3v6a3 3 0 0 0 2 2.8M14 12h-3a3 3 0 0 1-3-3V8"/></>,
    broadcast: <><circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    arrow: <><path d="M5 12h14"/><path d="m15 8 4 4-4 4"/></>,
    file: <><path d="M6 2h8l4 4v16H6V2Z"/><path d="M14 2v5h5M9 12h6M9 16h6"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    alert: <><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v5M12 17h.01"/></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function shortHash(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-7)}`
}

function usePublisherData(refresh = 0) {
  const [info, setInfo] = useState<ServiceInfo | null>(null)
  const [ideas, setIdeas] = useState<PublishedIdea[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading')
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      fetch('/api/config', { signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error('Publisher unavailable')
        return response.json() as Promise<ServiceInfo>
      }),
      fetch('/api/ideas', { signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error('Publisher unavailable')
        return response.json() as Promise<{ items: PublishedIdea[] }>
      }),
    ]).then(([service, result]) => {
      setInfo(service)
      setIdeas(result.items)
      setState('ready')
    }).catch((error) => {
      if ((error as Error).name !== 'AbortError') setState('offline')
    })
    return () => controller.abort()
  }, [refresh])
  return { info, ideas, state }
}

export function IdeaDirectory({ onPublish }: { onPublish: () => void }) {
  const [refresh] = useState(0)
  const { info, ideas, state } = usePublisherData(refresh)
  const requestedSlug = useMemo(() => new URLSearchParams(window.location.search).get('idea'), [])
  const [selected, setSelected] = useState<string | null>(requestedSlug)
  const selectedIdea = ideas.find((idea) => idea.slug === selected)

  return (
    <>
      <section className="publisher-hero">
        <div className="publisher-hero-copy">
          <span className="kicker">Federated idea registry</span>
          <h1>Ideas should travel<br /><em>with their history.</em></h1>
          <p>Publish an exact Git state once. Let renderings, judgments, and communities form around an object that cannot silently move.</p>
          <div className="publisher-actions">
            <button className="primary-action" onClick={onPublish}><Icon name="plus" size={16}/> Publish an idea</button>
            {info && <span className="actor-handle"><Icon name="broadcast" size={15}/>{info.handle}</span>}
          </div>
        </div>
        <div className="federation-card">
          <div className="federation-orbit"><span className="orbit-center"><Icon name="broadcast" size={25}/></span><i/><i/><i/></div>
          <div><span>Network status</span><strong>{state === 'ready' && info?.federation ? 'Federation ready' : state === 'offline' ? 'Service offline' : 'Connecting'}</strong><small>{info ? 'WebFinger · signed inbox · public outbox' : 'Waiting for the IRAP service'}</small></div>
        </div>
      </section>

      <main className="page-shell directory-shell">
        <section className="directory-heading">
          <div><span>{ideas.length.toString().padStart(2, '0')}</span><div><h2>Published ideas</h2><p>Each entry resolves to an immutable Git state and a portable ActivityPub object.</p></div></div>
          <div className={`service-indicator indicator-${state}`}><i/>{state === 'ready' ? 'Live index' : state === 'offline' ? 'Backend unavailable' : 'Loading index'}</div>
        </section>

        {state === 'offline' ? (
          <section className="empty-directory"><Icon name="alert" size={28}/><h2>The publishing service is not running.</h2><p>Start the TypeScript service alongside the web client. The original verification explorer remains available from the navigation.</p><code>npm run dev:server</code></section>
        ) : state === 'loading' ? (
          <section className="directory-loading"><span/><p>Resolving the local outbox…</p></section>
        ) : ideas.length === 0 ? (
          <section className="empty-directory"><Icon name="globe" size={31}/><h2>No ideas have been published yet.</h2><p>The registry is healthy and ready for its first exact Git state.</p><button className="text-action" onClick={onPublish}>Publish the first idea <Icon name="arrow" size={15}/></button></section>
        ) : (
          <div className="idea-layout">
            <div className="idea-list">
              {ideas.map((idea, index) => (
                <button className={`idea-card ${selected === idea.slug ? 'selected' : ''}`} key={idea.id} onClick={() => setSelected(idea.slug)}>
                  <span className="idea-index">{String(index + 1).padStart(2, '0')}</span>
                  <div className="idea-card-copy"><span className="idea-protocol">IRAP · {idea.git_commit.algorithm.toUpperCase()} · {idea.git_verified ? 'Git verified' : 'Development record'}</span><h2>{idea.name}</h2><p>{idea.summary}</p><div><span><Icon name="git" size={13}/><code>{shortHash(idea.git_commit.value)}</code></span><span>{new Date(idea.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span></div></div>
                  <Icon name="arrow" size={17}/>
                </button>
              ))}
            </div>
            <aside className="idea-detail">
              {selectedIdea ? <>
                <span className="detail-label">Resolved idea</span><h2>{selectedIdea.name}</h2><p>{selectedIdea.summary}</p>
                <dl><div><dt>Idea ID</dt><dd>{selectedIdea.id}</dd></div><div><dt>Repository</dt><dd>{selectedIdea.repository}</dd></div><div><dt>State proof</dt><dd>{selectedIdea.git_verified ? 'Fetched and resolved from Git' : 'Not fetched in development mode'}</dd></div><div><dt>Object format</dt><dd>{selectedIdea.git_commit.algorithm.toUpperCase()}</dd></div><div><dt>Exact commit</dt><dd><code>{selectedIdea.git_commit.value}</code></dd></div></dl>
                <details><summary>View published specification</summary><pre>{selectedIdea.spec_yaml}</pre></details>
                <div className="federated-note"><Icon name="broadcast" size={17}/><p>Available as an ActivityStreams <strong>Document</strong> in this publisher’s public outbox.</p></div>
              </> : <div className="detail-placeholder"><Icon name="file" size={28}/><p>Select an idea to resolve its exact state and published specification.</p></div>}
            </aside>
          </div>
        )}
      </main>
    </>
  )
}

type PublishResult = { idea: PublishedIdea; activity_id: string; queued_deliveries: number }

export function PublishIdea({ onPublished, onCancel }: { onPublished: (idea: PublishedIdea) => void; onCancel: () => void }) {
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<PublishResult | null>(null)
  const [form, setForm] = useState({
    slug: '', name: '', summary: '', repository: '', algorithm: 'sha1' as 'sha1' | 'sha256', commit: '',
    spec: 'idea:\n  name: \n  version: 1\n\nprinciples:\n  - \n',
  })
  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const response = await fetch('/api/ideas', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          slug: form.slug, name: form.name, summary: form.summary, repository: form.repository,
          git_commit: { algorithm: form.algorithm, value: form.commit }, spec_yaml: form.spec,
        }),
      })
      const body = await response.json() as PublishResult & { error?: string; issues?: Array<{ path: string[]; message: string }> }
      if (!response.ok) throw new Error(body.issues?.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' · ') || body.error || 'Publication failed.')
      setResult(body)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Publication failed.')
    } finally {
      setSubmitting(false)
    }
  }

  if (result) return (
    <main className="publish-success page-shell"><span className="success-mark"><Icon name="check" size={30}/></span><span className="kicker dark">Publication complete</span><h1>{result.idea.name}</h1><p>{result.idea.git_verified ? 'The exact Git state was fetched and verified; its ActivityPub Create activity is now in the public outbox.' : 'The development record was stored without a remote Git fetch; its ActivityPub Create activity is now in the public outbox.'}</p><div><span>Activity</span><code>{result.activity_id}</code><span>Deliveries queued</span><strong>{result.queued_deliveries}</strong></div><button className="primary-action dark" onClick={() => onPublished(result.idea)}>Open the idea directory <Icon name="arrow" size={16}/></button></main>
  )

  return (
    <main className="publish-page page-shell">
      <div className="publish-intro"><span className="kicker dark">Create a canonical publication</span><h1>Publish an<br /><em>exact state.</em></h1><p>The service creates the durable idea URL and ActivityPub object. You supply the Git transport, full object ID, and human-readable specification.</p><div className="publish-boundary"><Icon name="lock" size={19}/><p><strong>Your token stays in this browser tab.</strong> It is sent only to this origin when you submit and is never stored by the client.</p></div></div>
      <form className="publish-form" onSubmit={submit}>
        <div className="form-section-heading"><span>01</span><div><h2>Idea identity</h2><p>Human meaning and durable URL</p></div></div>
        <label><span>Name</span><input required maxLength={140} value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="A name people can carry forward" /></label>
        <label><span>URL slug</span><div className="input-prefix"><span>/ideas/</span><input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={form.slug} onChange={(event) => update('slug', event.target.value)} placeholder="durable-idea-name" /></div></label>
        <label><span>Summary</span><textarea required minLength={12} maxLength={1000} rows={3} value={form.summary} onChange={(event) => update('summary', event.target.value)} placeholder="What is this idea trying to make possible?" /></label>

        <div className="form-section-heading"><span>02</span><div><h2>Exact Git state</h2><p>Transport plus immutable object</p></div></div>
        <label><span>Repository URL</span><input required type="url" value={form.repository} onChange={(event) => update('repository', event.target.value)} placeholder="https://git.example.org/idea.git" /></label>
        <div className="commit-inputs"><label><span>Object format</span><select value={form.algorithm} onChange={(event) => update('algorithm', event.target.value)}><option value="sha1">SHA-1 · 40 hex</option><option value="sha256">SHA-256 · 64 hex</option></select></label><label><span>Full commit</span><input required minLength={form.algorithm === 'sha1' ? 40 : 64} maxLength={form.algorithm === 'sha1' ? 40 : 64} pattern="[0-9a-f]+" value={form.commit} onChange={(event) => update('commit', event.target.value)} placeholder={form.algorithm === 'sha1' ? '40 lowercase hexadecimal characters' : '64 lowercase hexadecimal characters'} /></label></div>

        <div className="form-section-heading"><span>03</span><div><h2>Specification</h2><p>Human-facing YAML representation</p></div></div>
        <label><span>Idea YAML</span><textarea className="yaml-input" required rows={12} value={form.spec} onChange={(event) => update('spec', event.target.value)} spellCheck={false} /></label>

        <div className="form-section-heading"><span>04</span><div><h2>Authorization</h2><p>Local publisher administration</p></div></div>
        <label><span>Administrator token</span><input required type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="ADMIN_TOKEN from the server environment" /></label>
        {error && <div className="publish-error" role="alert"><Icon name="alert" size={17}/><p>{error}</p></div>}
        <div className="form-actions"><button type="button" className="secondary-action" onClick={onCancel}>Cancel</button><button type="submit" className="primary-action dark" disabled={submitting}>{submitting ? 'Publishing…' : 'Publish and federate'} <Icon name="broadcast" size={16}/></button></div>
      </form>
    </main>
  )
}
