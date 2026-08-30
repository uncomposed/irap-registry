import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { canonicalize } from './domain/canonicalize'

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

type IdeaDetail = PublishedIdea & {
  states: Array<{ id: string; repository: string; object_format: string; commit: string; source_revision: string; resolved_at: string }>
  renderings: Array<{ id: string; uri: string; title: string | null; artifact_uri: string; artifact_digest: string; experience: { uri: string; source: 'live' | 'repository' } | null; digest_verified: boolean; digest_status: 'verified' | 'mismatch' | 'unverified'; status: string; submitted_at: string }>
}

type RenderingDetail = {
  id: string
  uri: string
  document: { rendering: { title?: string; description?: string; artifact: { uri: string; digest: string }; renders: { idea_id: string; git: { repository: string; object_format: string; commit: string } }; creator: { id: string } } }
  experience: { uri: string; source: 'live' | 'repository' } | null
  status: string
  digest_verified: boolean
  digest_status: 'verified' | 'mismatch' | 'unverified'
  historical_state: { commit: string; source_revision: string; policy: unknown }
  recognition: Record<string, { recognized: boolean; qualifying_verifier_ids: string[]; disagreement: boolean; attestation_count: number }>
  attestations: Array<{ id: string; uri: string; verifier_id: string; claim: string; result: string; signature_valid: boolean; recognition_status: string; recognition_reasons: string[]; issued_at: string }>
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

function repositoryBrowserUri(value: string) {
  try {
    const uri = new URL(value)
    if (['github.com', 'gitlab.com', 'codeberg.org'].includes(uri.hostname) && uri.pathname.endsWith('.git')) uri.pathname = uri.pathname.slice(0, -4)
    return uri.toString()
  } catch { return value }
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
  const requestedSlug = useMemo(() => new URLSearchParams(window.location.search).get('idea') ?? window.location.pathname.match(/^\/ideas\/([^/]+)/)?.[1] ?? null, [])
  const requestedRenderingId = useMemo(() => window.location.pathname.match(/^\/renderings\/([^/]+)/)?.[1] ?? null, [])
  const [selected, setSelected] = useState<string | null>(requestedSlug)
  const [detail, setDetail] = useState<IdeaDetail | null>(null)
  const [rendering, setRendering] = useState<RenderingDetail | null>(null)
  const selectedIdea = detail ?? ideas.find((idea) => idea.slug === selected)

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      setRendering(null)
      return
    }
    const controller = new AbortController()
    fetch(`/api/v1/ideas/${encodeURIComponent(selected)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<IdeaDetail> : Promise.reject(new Error('Idea unavailable')))
      .then((value) => setDetail(value))
      .catch((error) => { if ((error as Error).name !== 'AbortError') setDetail(null) })
    return () => controller.abort()
  }, [selected])

  useEffect(() => {
    if (!requestedRenderingId || ideas.length === 0) return
    const controller = new AbortController()
    fetch(`/api/v1/renderings/${encodeURIComponent(requestedRenderingId)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<RenderingDetail> : Promise.reject(new Error('Rendering unavailable')))
      .then((value) => {
        setRendering(value)
        const idea = ideas.find((entry) => entry.id === value.document.rendering.renders.idea_id)
        if (idea) setSelected(idea.slug)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [ideas, requestedRenderingId])

  async function selectRendering(id: string) {
    const response = await fetch(`/api/v1/renderings/${encodeURIComponent(id)}`)
    if (response.ok) setRendering(await response.json() as RenderingDetail)
  }

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
          <div><span>Network status</span><strong>{state === 'ready' ? info?.federation ? 'Federation ready' : 'Registry ready · federation off' : state === 'offline' ? 'Service offline' : 'Connecting'}</strong><small>{info ? info.federation ? 'WebFinger · signed inbox · public outbox' : 'Local registry API and historical verification' : 'Waiting for the IRAP service'}</small></div>
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
                <button className={`idea-card ${selected === idea.slug ? 'selected' : ''}`} key={idea.id} onClick={() => { setRendering(null); setSelected(idea.slug) }}>
                  <span className="idea-index">{String(index + 1).padStart(2, '0')}</span>
                  <div className="idea-card-copy"><span className="idea-protocol">IRAP · {idea.git_commit.algorithm.toUpperCase()} · {idea.git_verified ? 'Git verified' : 'Development record'}</span><h2>{idea.name}</h2><p>{idea.summary}</p><div><span><Icon name="git" size={13}/><code>{shortHash(idea.git_commit.value)}</code></span><span>{new Date(idea.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span></div></div>
                  <Icon name="arrow" size={17}/>
                </button>
              ))}
            </div>
            <aside className="idea-detail">
              {selectedIdea ? <>
                <span className="detail-label">Resolved idea</span><h2>{selectedIdea.name}</h2><p>{selectedIdea.summary}</p>
                <dl><div><dt>Idea ID</dt><dd>{selectedIdea.id}</dd></div><div><dt>Repository</dt><dd><a href={repositoryBrowserUri(selectedIdea.repository)} target="_blank" rel="noreferrer">Open source repository <Icon name="arrow" size={11}/></a></dd></div><div><dt>State proof</dt><dd>{selectedIdea.git_verified ? 'Fetched and resolved from Git' : 'Not fetched in development mode'}</dd></div><div><dt>Object format</dt><dd>{selectedIdea.git_commit.algorithm.toUpperCase()}</dd></div><div><dt>Exact commit</dt><dd><code>{selectedIdea.git_commit.value}</code></dd></div></dl>
                {detail && <section className="registry-renderings">
                  <div className="registry-section-title"><span>Registered renderings</span><strong>{detail.renderings.length}</strong></div>
                  {detail.renderings.length === 0 ? <p className="registry-empty">No external artifact has been registered against this idea yet.</p> : detail.renderings.map((entry) => (
                    <div key={entry.id} className={`registry-rendering-row ${rendering?.id === entry.id ? 'active' : ''}`}>
                      <a href={entry.experience?.uri ?? entry.artifact_uri} target="_blank" rel="noreferrer">
                        <span><strong>{entry.title ?? 'Untitled rendering'}</strong><small>{entry.experience?.source === 'repository' ? 'Open rendering source' : entry.experience ? 'Open rendering' : 'Open technical artifact'} · {entry.digest_status === 'verified' ? 'digest verified' : entry.digest_status === 'mismatch' ? 'digest mismatch' : 'digest unverified'}</small></span><Icon name="arrow" size={14}/>
                      </a>
                      <button type="button" onClick={() => void selectRendering(entry.id)}>Evidence</button>
                    </div>
                  ))}
                </section>}
                {rendering && <section className="registry-rendering-detail">
                  <span className="detail-label">Rendering evidence</span>
                  <h3>{rendering.document.rendering.title ?? 'Untitled rendering'}</h3>
                  {rendering.document.rendering.description && <p>{rendering.document.rendering.description}</p>}
                  <div className="registry-state-label"><Icon name="git" size={14}/>{rendering.historical_state.commit === selectedIdea.git_commit.value ? 'Current target' : 'Historical target'} · <code>{shortHash(rendering.historical_state.commit)}</code></div>
                  <div className="rendering-links">
                    <a className="rendering-primary-link" href={rendering.experience?.uri ?? rendering.document.rendering.artifact.uri} target="_blank" rel="noreferrer">{rendering.experience?.source === 'repository' ? 'Open rendering source' : rendering.experience ? 'Open rendering' : 'Open technical artifact'} <Icon name="arrow" size={13}/></a>
                    {rendering.experience && <a href={rendering.document.rendering.artifact.uri} target="_blank" rel="noreferrer">View artifact manifest</a>}
                  </div>
                  {rendering.digest_status !== 'verified' && <div className={`digest-warning ${rendering.digest_status === 'mismatch' ? 'digest-mismatch' : ''}`}><Icon name="alert" size={15}/><span>{rendering.digest_status === 'mismatch' ? 'SEVERE: fetched artifact bytes do not match the bound digest.' : 'Digest recorded but not independently fetched.'}</span></div>}
                  {Object.entries(rendering.recognition).map(([claim, result]) => <div className="recognition-summary" key={claim}>
                    <span className={result.recognized ? 'recognized' : 'pending'}><Icon name={result.recognized ? 'check' : 'alert'} size={14}/>{result.recognized ? 'Recognized' : 'Not recognized'}</span>
                    <strong>{claim.replaceAll('_', ' ')}</strong>
                    <small>{result.attestation_count} attestations · {result.disagreement ? 'disagreement visible' : 'no recognized disagreement'}</small>
                    {result.qualifying_verifier_ids.map((id) => <code key={id}>{id}</code>)}
                  </div>)}
                  <div className="registry-attestations">{rendering.attestations.map((entry) => <details key={entry.id}><summary><span>{entry.verifier_id}</span><b className={`attestation-${entry.recognition_status}`}>{entry.result} · {entry.recognition_status}</b></summary><p>Signature {entry.signature_valid ? 'valid' : 'not verified'} · {new Date(entry.issued_at).toLocaleString()}</p>{entry.recognition_reasons.map((reason) => <small key={reason}>{reason}</small>)}</details>)}</div>
                  <p className="fidelity-note">Recognition is an attributable judgment of fidelity—not truth, endorsement, or quality.</p>
                </section>}
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

export function SubmitRendering({ onCancel }: { onCancel: () => void }) {
  const { ideas, state } = usePublisherData()
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ id: string; uri: string; state: { commit: string; source_revision: string }; digest_verified: boolean } | null>(null)
  const [form, setForm] = useState({ idea_slug: '', title: '', description: '', artifact_uri: '', digest: '', repository: '', object_format: 'sha1', revision: 'refs/heads/main', creator: '' })
  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch('/api/v1/renderings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          idea_slug: form.idea_slug, title: form.title || undefined, description: form.description || undefined,
          artifact: { uri: form.artifact_uri, digest: form.digest },
          target: { repository: form.repository, object_format: form.object_format, revision: form.revision },
          creator: { id: form.creator },
        }),
      })
      const body = await response.json() as typeof result & { error?: string; issues?: Array<{ path: string[]; message: string }> }
      if (!response.ok || !body) throw new Error(body?.issues?.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' · ') || body?.error || 'Rendering submission failed.')
      setResult(body)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Rendering submission failed.')
    } finally {
      setSubmitting(false)
    }
  }

  if (result) return <main className="publish-success page-shell"><span className="success-mark"><Icon name="check" size={30}/></span><span className="kicker dark">Rendering registered</span><h1>Target frozen.</h1><p>The external artifact is permanently bound to the resolved Git commit. Its digest remains visibly submitter-supplied until independently fetched.</p><div><span>Requested target</span><code>{result.state.source_revision}</code><span>Frozen commit</span><code>{result.state.commit}</code></div><button className="primary-action dark" onClick={onCancel}>Return to ideas <Icon name="arrow" size={16}/></button></main>

  return <main className="publish-page page-shell">
    <div className="publish-intro"><span className="kicker dark">Register an external artifact</span><h1>Freeze the<br/><em>relationship.</em></h1><p>The artifact stays with its creator. This registry resolves the requested branch, tag, or commit and records the resulting full Git object ID.</p><div className="publish-boundary"><Icon name="lock" size={19}/><p><strong>No repository code runs.</strong> The service uses a hookless bare cache and reads only the historical IRAP metadata.</p></div></div>
    <form className="publish-form" onSubmit={submit}>
      <div className="form-section-heading"><span>01</span><div><h2>Idea and artifact</h2><p>Choose the idea and bind the creator-hosted bytes</p></div></div>
      <label><span>Idea</span><select required value={form.idea_slug} onChange={(event) => update('idea_slug', event.target.value)}><option value="">{state === 'loading' ? 'Loading ideas…' : 'Select a published idea'}</option>{ideas.map((idea) => <option value={idea.slug} key={idea.id}>{idea.name}</option>)}</select></label>
      <label><span>Title</span><input required maxLength={240} value={form.title} onChange={(event) => update('title', event.target.value)} /></label>
      <label><span>Description</span><textarea rows={3} maxLength={4000} value={form.description} onChange={(event) => update('description', event.target.value)} /></label>
      <label><span>Artifact URI</span><input required type="url" value={form.artifact_uri} onChange={(event) => update('artifact_uri', event.target.value)} placeholder="https://creator.example/artifact" /></label>
      <label><span>Artifact digest</span><input required pattern="sha256:[0-9a-f]{64}" value={form.digest} onChange={(event) => update('digest', event.target.value)} placeholder="sha256: followed by 64 lowercase hex characters" /></label>
      <label><span>Creator identity</span><input required value={form.creator} onChange={(event) => update('creator', event.target.value)} placeholder="https://creator.example/#me or did:key:…" /></label>
      <div className="form-section-heading"><span>02</span><div><h2>Git target</h2><p>A moving input that will be frozen on submission</p></div></div>
      <label><span>Repository URL</span><input required type="url" value={form.repository} onChange={(event) => update('repository', event.target.value)} placeholder="https://codeberg.org/owner/idea.git" /></label>
      <div className="commit-inputs"><label><span>Object format</span><select value={form.object_format} onChange={(event) => update('object_format', event.target.value)}><option value="sha1">SHA-1</option><option value="sha256">SHA-256</option></select></label><label><span>Branch, tag, or commit</span><input required value={form.revision} onChange={(event) => update('revision', event.target.value)} placeholder="refs/heads/main" /></label></div>
      <div className="form-section-heading"><span>03</span><div><h2>Authorization</h2><p>Registry administration</p></div></div>
      <label><span>Administrator token</span><input required type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></label>
      {error && <div className="publish-error" role="alert"><Icon name="alert" size={17}/><p>{error}</p></div>}
      <div className="form-actions"><button type="button" className="secondary-action" onClick={onCancel}>Cancel</button><button type="submit" className="primary-action dark" disabled={submitting}>{submitting ? 'Resolving Git…' : 'Resolve and register'} <Icon name="git" size={16}/></button></div>
    </form>
  </main>
}

type VerificationPreview = { signature_valid: boolean; recognized: boolean; recognition_status: string; recognition_reasons: string[]; policy_commit: string; canonical_unsigned_json: string }

const attestationTemplate = JSON.stringify({
  irap_version: '0.1',
  attestation: {
    id: 'https://reviewer.example/attestations/replace-me',
    rendering: { id: 'https://publisher.example/renderings/replace-me', artifact_digest: `sha256:${'0'.repeat(64)}` },
    against: { idea_id: 'https://ideas.example/replace-me', git: { repository: 'https://codeberg.org/owner/idea.git', object_format: 'sha1', commit: '0'.repeat(40) } },
    verifier: { id: 'https://reviewer.example/#me', key_id: 'reviewer-ed25519-key' },
    judgment: { claim: 'faithful_rendering', result: 'pass', note: 'Explain the attributable judgment.' },
    evidence: [], issued_at: '2026-08-29T20:00:00Z',
    signature: { algorithm: 'Ed25519', canonicalization: 'RFC8785-JCS', value: 'replace-with-base64url-signature' },
  },
}, null, 2)

export function SubmitAttestation({ onCancel }: { onCancel: () => void }) {
  const [document, setDocument] = useState(attestationTemplate)
  const [preview, setPreview] = useState<VerificationPreview | null>(null)
  const [previewSource, setPreviewSource] = useState('')
  const [error, setError] = useState('')
  const [published, setPublished] = useState<{ id: string; uri: string } | null>(null)
  const canonicalPayload = useMemo(() => {
    try {
      const parsed = JSON.parse(document) as { attestation?: Record<string, unknown> }
      if (!parsed.attestation) return ''
      const { signature: _signature, ...unsignedAttestation } = parsed.attestation
      return canonicalize({ ...parsed, attestation: unsignedAttestation })
    } catch { return '' }
  }, [document])

  useEffect(() => {
    const attestationId = window.location.pathname.match(/^\/attestations\/([^/]+)/)?.[1]
    const renderingId = window.location.pathname.match(/^\/review\/([^/]+)/)?.[1]
    const controller = new AbortController()
    if (attestationId) {
      fetch(`/api/v1/attestations/${encodeURIComponent(attestationId)}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<{ document: unknown }> : Promise.reject(new Error('Attestation unavailable')))
        .then((value) => setDocument(JSON.stringify(value.document, null, 2)))
        .catch(() => {})
    } else if (renderingId) {
      fetch(`/api/v1/renderings/${encodeURIComponent(renderingId)}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<RenderingDetail> : Promise.reject(new Error('Rendering unavailable')))
        .then((value) => {
          const rendered = value.document.rendering
          const template = JSON.parse(attestationTemplate) as { attestation: Record<string, unknown> & { rendering: unknown; against: unknown } }
          template.attestation.rendering = { id: value.uri, artifact_digest: rendered.artifact.digest }
          template.attestation.against = { idea_id: rendered.renders.idea_id, git: rendered.renders.git }
          setDocument(JSON.stringify(template, null, 2))
        })
        .catch(() => {})
    }
    return () => controller.abort()
  }, [])

  async function send(path: string) {
    setError('')
    try {
      const payload = JSON.parse(document)
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      const body = await response.json() as VerificationPreview & { id?: string; uri?: string; verification?: VerificationPreview; error?: string; issues?: Array<{ path: string[]; message: string }> }
      if (!response.ok) throw new Error(body.issues?.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' · ') || body.error || 'Attestation request failed.')
      if (path.endsWith('/verify')) { setPreview(body); setPreviewSource(document) }
      else if (body.id && body.uri) setPublished({ id: body.id, uri: body.uri })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Attestation request failed.') }
  }

  if (published) return <main className="publish-success page-shell"><span className="success-mark"><Icon name="check" size={30}/></span><span className="kicker dark">Attestation published</span><h1>Judgment preserved.</h1><p>The raw signed object and its separate cryptographic and recognition results are stored and federated.</p><div><span>Registry record</span><code>{published.id}</code><span>Attestation URI</span><code>{published.uri}</code></div><button className="primary-action dark" onClick={onCancel}>Return to ideas <Icon name="arrow" size={16}/></button></main>

  return <main className="attestation-page page-shell">
    <section className="attestation-intro"><span className="kicker dark">External-signer workflow</span><h1>Inspect. Sign.<br/><em>Then publish.</em></h1><p>The registry never asks for a verifier private key. Prepare the document, sign the exact canonical payload externally, replace the signature value, and verify before publication.</p><div className="fidelity-note">A valid or recognized attestation is attributable fidelity evidence—not truth, endorsement, or quality.</div></section>
    <section className="attestation-workbench">
      <label><span>IRAP attestation JSON</span><textarea className="yaml-input" rows={24} spellCheck={false} value={document} onChange={(event) => { setDocument(event.target.value); setPreview(null) }} /></label>
      <div className="canonical-panel"><div><span>RFC 8785 signing payload</span><button type="button" disabled={!canonicalPayload} onClick={() => void navigator.clipboard.writeText(canonicalPayload)}>Copy payload</button></div><pre>{canonicalPayload || 'Enter a valid attestation JSON document to derive its unsigned canonical payload.'}</pre></div>
      {preview && <div className={`verification-preview preview-${preview.recognition_status}`}><strong>{preview.signature_valid ? 'Signature valid' : 'Signature not verified'} · {preview.recognition_status}</strong><span>Policy commit <code>{shortHash(preview.policy_commit)}</code></span>{preview.recognition_reasons.map((reason) => <p key={reason}>{reason}</p>)}</div>}
      {error && <div className="publish-error" role="alert"><Icon name="alert" size={17}/><p>{error}</p></div>}
      <div className="form-actions"><button className="secondary-action" type="button" onClick={onCancel}>Cancel</button><button className="secondary-action" type="button" onClick={() => void send('/api/v1/attestations/verify')}>Verify without publishing</button><button className="primary-action dark" type="button" disabled={!preview || previewSource !== document} onClick={() => void send('/api/v1/attestations')}>Publish unchanged record <Icon name="broadcast" size={16}/></button></div>
    </section>
  </main>
}
