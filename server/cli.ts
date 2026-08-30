import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { parse } from 'yaml'
import { loadConfig } from './config.js'
import { openDatabase, openReadonlyDatabase, type AttestationRow, type IdeaRow, type IdeaStateRow, type RenderingRow } from './database.js'
import { GitResolver } from './git-resolver.js'
import { attestationDocumentSchema, renderingDocumentSchema } from './irap.js'
import { evaluateAttestation } from './registry-verification.js'
import { applyPublicationBundle, createPublicationPlan, loadPublicationBundle, type PublicationSource } from './publication-bundle.js'

type DeploymentManifest = {
  live_url: string
  idea_name: string
  idea_summary: string
  protocol_spec_uri: string
  implementation: { repository: string; object_format: 'sha1'; commit: string }
  renders: { idea_id: string; git: { repository: string; object_format: 'sha1' | 'sha256'; commit: string } }
}

async function responseBody(response: Response) {
  const text = await response.text()
  try { return JSON.parse(text) as Record<string, unknown> } catch { return { raw: text } }
}

async function publishReference(config: ReturnType<typeof loadConfig>) {
  const manifestPath = resolve(config.staticPath, 'release-artifact/deployment-manifest.json')
  const manifestBytes = await readFile(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as DeploymentManifest
  const base = `http://127.0.0.1:${config.port}`
  const headers = { authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' }
  const specResponse = await fetch(manifest.protocol_spec_uri, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  if (!specResponse.ok) throw new Error(`Canonical specification fetch returned ${specResponse.status}.`)
  const specYaml = await specResponse.text()
  const ideaPayload = {
    slug: 'irap', name: manifest.idea_name, summary: manifest.idea_summary,
    repository: manifest.renders.git.repository,
    git_commit: { algorithm: manifest.renders.git.object_format, value: manifest.renders.git.commit },
    spec_yaml: specYaml,
  }
  const ideaResponse = await fetch(`${base}/api/ideas`, { method: 'POST', headers, body: JSON.stringify(ideaPayload) })
  const ideaResult = await responseBody(ideaResponse)
  if (![201, 409].includes(ideaResponse.status)) throw new Error(`Idea publication failed (${ideaResponse.status}): ${JSON.stringify(ideaResult)}`)
  if (ideaResponse.status === 409) {
    const existing = await fetch(`${base}/api/v1/ideas/irap`).then(responseBody) as { git_commit?: { value?: string } }
    if (existing.git_commit?.value !== manifest.renders.git.commit) throw new Error('Existing IRAP idea points to a different commit.')
  }

  const artifactUri = `${manifest.live_url}/artifacts/${manifest.implementation.commit}/deployment-manifest.json`
  const renderingUri = `${manifest.live_url}/renderings/irap-registry-${manifest.implementation.commit}`
  const renderingPayload = {
    idea_slug: 'irap', id: renderingUri, title: 'IRAP Federated Registry',
    description: 'A deployed registry that indexes exact IRAP states, renderings, and signed attestations and announces them over ActivityPub.',
    artifact: { uri: artifactUri, digest: `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}` },
    target: { repository: manifest.renders.git.repository, object_format: manifest.renders.git.object_format, revision: manifest.renders.git.commit },
    creator: { id: 'https://github.com/uncomposed' },
  }
  const renderingResponse = await fetch(`${base}/api/v1/renderings`, { method: 'POST', headers, body: JSON.stringify(renderingPayload) })
  const renderingResult = await responseBody(renderingResponse)
  if (![201, 409].includes(renderingResponse.status)) throw new Error(`Rendering publication failed (${renderingResponse.status}): ${JSON.stringify(renderingResult)}`)
  if (renderingResponse.status === 409) {
    const existing = await fetch(`${base}/api/v1/ideas/irap`).then(responseBody) as { renderings?: Array<{ uri?: string }> }
    if (!existing.renderings?.some((entry) => entry.uri === renderingUri)) throw new Error('Rendering URI conflict does not match the reference deployment.')
  }
  process.stdout.write(JSON.stringify({
    idea: { status: ideaResponse.status === 201 ? 'published' : 'existing', commit: manifest.renders.git.commit },
    rendering: { status: renderingResponse.status === 201 ? 'published' : 'existing', uri: renderingUri, artifact_uri: artifactUri },
  }) + '\n')
}

function publicationSource(arguments_: string[]): { source: PublicationSource; apply: boolean } {
  const values = new Map<string, string>()
  let apply = false
  let dryRun = false
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--apply') { apply = true; continue }
    if (argument === '--dry-run') { dryRun = true; continue }
    if (!['--repository', '--revision', '--object-format', '--path'].includes(argument)) throw new Error(`Unknown publish-bundle argument: ${argument}`)
    const value = arguments_[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`)
    values.set(argument, value)
    index += 1
  }
  if (apply && dryRun) throw new Error('Choose either --dry-run or --apply, not both.')
  const repository = values.get('--repository')
  const commit = values.get('--revision')
  const objectFormat = values.get('--object-format') ?? 'sha1'
  if (!repository || !commit) throw new Error('publish-bundle requires --repository and --revision.')
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new Error('--object-format must be sha1 or sha256.')
  return {
    source: { repository, objectFormat, commit, path: values.get('--path') ?? '.idea/publication.yaml' },
    apply,
  }
}

async function publishBundle(config: ReturnType<typeof loadConfig>, arguments_: string[]) {
  const { source, apply } = publicationSource(arguments_)
  const loaded = await loadPublicationBundle(config, new GitResolver(config), source)
  const db = openReadonlyDatabase(config.databasePath)
  let plan
  try {
    plan = createPublicationPlan(db, loaded)
  } finally {
    db.close()
  }
  if (!apply || plan.conflicts.length) {
    process.stdout.write(JSON.stringify({ mode: apply ? 'apply-refused' : 'dry-run', plan }, null, 2) + '\n')
    if (plan.conflicts.length) process.exitCode = 2
    return
  }
  const result = await applyPublicationBundle(config, loaded, plan)
  process.stdout.write(JSON.stringify({ mode: 'applied', plan, result }, null, 2) + '\n')
}

async function main() {
  const config = loadConfig()
  const command = process.argv[2]
  if (command === 'publish-reference') return publishReference(config)
  if (command === 'publish-bundle') return publishBundle(config, process.argv.slice(3))
  const db = openDatabase(config.databasePath)
  try {
    if (command === 'backup') {
      const dataRoot = dirname(config.databasePath)
      const target = resolve(process.argv[3] ?? `${dataRoot}/backups/irap-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)
      const relation = relative(dataRoot, target)
      if (relation.startsWith('..') || relation === '') throw new Error('Backup target must be a file beneath the configured data directory.')
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await db.backup(target)
      await chmod(target, 0o600)
      process.stdout.write(`${target}\n`)
      return
    }

    if (command === 'verify-all') {
      const rows = db.prepare('SELECT * FROM attestations ORDER BY created_at').all() as AttestationRow[]
      const update = db.prepare('UPDATE attestations SET signature_valid = ?, recognition_status = ?, recognition_reasons_json = ? WHERE id = ?')
      let changed = 0
      for (const row of rows) {
        const rendering = db.prepare('SELECT * FROM renderings WHERE id = ?').get(row.rendering_id) as RenderingRow
        const state = db.prepare('SELECT * FROM idea_states WHERE id = ?').get(rendering.state_id) as IdeaStateRow
        const document = attestationDocumentSchema.parse(JSON.parse(row.raw_attestation_json))
        const renderingDocument = renderingDocumentSchema.parse(JSON.parse(rendering.raw_manifest_json))
        const result = evaluateAttestation(document, rendering, renderingDocument, state)
        const reasons = JSON.stringify(result.recognition_reasons)
        if (row.signature_valid !== Number(result.signature_valid) || row.recognition_status !== result.recognition_status || row.recognition_reasons_json !== reasons) changed += 1
        update.run(Number(result.signature_valid), result.recognition_status, reasons, row.id)
      }
      process.stdout.write(JSON.stringify({ verified: rows.length, changed, raw_records_rewritten: 0 }) + '\n')
      return
    }

    if (command === 'sync') {
      const resolver = new GitResolver(config)
      const ideas = db.prepare('SELECT * FROM ideas WHERE git_verified = 1 ORDER BY created_at').all() as IdeaRow[]
      let advanced = 0
      for (const idea of ideas) {
        const historicalManifest = parse(idea.manifest_yaml ?? '') as { repository?: { canonical_ref?: unknown } }
        if (typeof historicalManifest.repository?.canonical_ref !== 'string') throw new Error(`Idea ${idea.slug} has no canonical ref.`)
        const resolved = await resolver.resolve(idea.repository, idea.commit_algorithm, historicalManifest.repository.canonical_ref)
        if (resolved.ideaId !== idea.idea_id) throw new Error(`Idea identity changed while syncing ${idea.slug}.`)
        const now = new Date().toISOString()
        db.transaction(() => {
          db.prepare(`INSERT OR IGNORE INTO idea_states
            (id, idea_id, repository, object_format, commit_value, source_revision, manifest_yaml, verifiers_yaml, policy_yaml, resolved_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            randomUUID(), resolved.ideaId, idea.repository, resolved.objectFormat, resolved.commit, resolved.sourceRevision,
            resolved.manifestYaml, resolved.verifiersYaml, resolved.policyYaml, now,
          )
          if (resolved.commit !== idea.commit_value) {
            db.prepare(`UPDATE ideas SET commit_value = ?, manifest_yaml = ?, verifiers_yaml = ?, policy_yaml = ?, updated_at = ? WHERE id = ?`).run(
              resolved.commit, resolved.manifestYaml, resolved.verifiersYaml, resolved.policyYaml, now, idea.id,
            )
            advanced += 1
          }
        })()
      }
      process.stdout.write(JSON.stringify({ synced: ideas.length, advanced, historical_rendering_targets_rewritten: 0 }) + '\n')
      return
    }

    throw new Error('Usage: npm run cli -- backup [data-relative-path] | verify-all | sync | publish-reference | publish-bundle --repository URL --revision FULL_COMMIT [--object-format sha1|sha256] [--path .idea/publication.yaml] [--dry-run|--apply]')
  } finally {
    db.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
