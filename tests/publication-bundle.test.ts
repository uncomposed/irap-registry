import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServiceConfig } from '../server/config'
import { openDatabase } from '../server/database'
import type { GitResolver, ResolvedIdeaState, ResolvedRepositoryFiles } from '../server/git-resolver'
import {
  applyPublicationBundle, createPublicationPlan, loadPublicationBundle, type PublicationSource,
} from '../server/publication-bundle'

const cleanup: string[] = []
const ideaCommit = 'a'.repeat(40)
const bundleCommit = 'b'.repeat(40)
const artifactDigest = `sha256:${'c'.repeat(64)}`

function config(): ServiceConfig {
  const directory = mkdtempSync(join(tmpdir(), 'irap-publication-bundle-'))
  cleanup.push(directory)
  return {
    host: '127.0.0.1', port: 8787, publicOrigin: 'https://publisher.example',
    actorName: 'registry', actorDisplayName: 'Registry', adminToken: 'administrator-token-long-enough',
    databasePath: join(directory, 'irap.sqlite'), staticPath: join(directory, 'dist'), production: false,
    federationEnabled: false, allowInsecureFederation: false, gitCachePath: join(directory, 'git'),
    verifyGitOnPublish: true, gitTimeoutMs: 10_000, gitMaxPackBytes: 10_000_000,
    verifyArtifactsOnSubmit: true, artifactTimeoutMs: 5_000, artifactMaxBytes: 1_000_000,
  }
}

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const repository = 'https://github.com/example/idea.git'
  const source: PublicationSource = {
    repository, objectFormat: 'sha1', commit: bundleCommit, path: '.idea/publication.yaml',
  }
  const bundleYaml = `publication_version: "1"
idea:
  slug: example-idea
  summary: A sufficiently descriptive publication summary.
  specification_path: public/idea.yaml
  state:
    repository: ${repository}
    object_format: sha1
    commit: ${ideaCommit}
renderings:
  - path: renderings/example.yaml
`
  const specYaml = 'spec_version: "0.1"\nidea:\n  id: https://publisher.example/ideas/example-idea\n  name: Example Idea\n'
  const renderingYaml = `irap_version: "0.1"
rendering:
  id: https://publisher.example/renderings/example-release
  title: Example rendering
  artifact:
    uri: https://artifacts.example/release.json
    digest: ${artifactDigest}
  renders:
    idea_id: https://publisher.example/ideas/example-idea
    git:
      repository: ${repository}
      object_format: sha1
      commit: ${ideaCommit}
  creator:
    id: https://creator.example
`
  const ideaState: ResolvedIdeaState = {
    ideaId: 'https://publisher.example/ideas/example-idea', ideaName: 'Example Idea',
    commit: ideaCommit, objectFormat: 'sha1', sourceRevision: ideaCommit,
    manifestYaml: 'spec_version: "0.1"', verifiersYaml: 'spec_version: "0.1"',
    policyYaml: 'spec_version: "0.1"', canonicalRef: 'refs/heads/main',
  }
  const files: Record<string, string> = {
    '.idea/publication.yaml': bundleYaml,
    'public/idea.yaml': specYaml,
    'renderings/example.yaml': renderingYaml,
  }
  const resolver = {
    async resolve() { return ideaState },
    async readFiles(_repository: string, objectFormat: 'sha1' | 'sha256', commit: string, paths: string[]): Promise<ResolvedRepositoryFiles> {
      return { commit, objectFormat, sourceRevision: commit, files: Object.fromEntries(paths.map((path) => [path, files[path]])) }
    },
  } as unknown as GitResolver
  return { repository, source, specYaml, ideaState, files, resolver }
}

describe('publication bundles', () => {
  it('loads an exact bundle and binds every rendering to its frozen idea state', async () => {
    const input = fixture()
    const loaded = await loadPublicationBundle(config(), input.resolver, input.source, async () => ({ status: 'verified', computed_digest: artifactDigest }))
    expect(loaded.source.commit).toBe(bundleCommit)
    expect(loaded.ideaState.commit).toBe(ideaCommit)
    expect(loaded.specYaml).toBe(input.specYaml)
    expect(loaded.renderings[0]).toMatchObject({ path: 'renderings/example.yaml', inspection: { status: 'verified' } })

    await expect(loadPublicationBundle(config(), input.resolver, { ...input.source, commit: 'refs/heads/main' }, async () => ({ status: 'verified' })))
      .rejects.toThrow('full Git commit')
  })

  it('rejects a specification whose identity differs from the historical manifest', async () => {
    const input = fixture()
    input.files['public/idea.yaml'] = input.specYaml.replace('Example Idea', 'Different Idea')
    await expect(loadPublicationBundle(config(), input.resolver, input.source, async () => ({ status: 'verified' })))
      .rejects.toThrow('identity differs from the historical idea manifest')
  })

  it('plans create, detects idempotent existing records, and refuses equivocation', async () => {
    const runtime = config()
    const input = fixture()
    const loaded = await loadPublicationBundle(runtime, input.resolver, input.source, async () => ({ status: 'verified', computed_digest: artifactDigest }))
    const db = openDatabase(runtime.databasePath)
    const create = createPublicationPlan(db, loaded)
    expect(create).toMatchObject({ idea: { status: 'create' }, renderings: [{ status: 'create', artifact_status: 'verified' }], conflicts: [] })

    db.prepare(`INSERT INTO ideas
      (id, slug, idea_id, name, summary, repository, commit_algorithm, commit_value, spec_yaml, git_verified, manifest_yaml, verifiers_yaml, policy_yaml, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(
      'idea-row', loaded.bundle.idea.slug, loaded.ideaState.ideaId, loaded.ideaState.ideaName, loaded.bundle.idea.summary,
      loaded.bundle.idea.state.repository, loaded.bundle.idea.state.object_format, loaded.bundle.idea.state.commit, loaded.specYaml,
      loaded.ideaState.manifestYaml, loaded.ideaState.verifiersYaml, loaded.ideaState.policyYaml, '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z',
    )
    db.prepare(`INSERT INTO idea_states
      (id, idea_id, repository, object_format, commit_value, source_revision, manifest_yaml, verifiers_yaml, policy_yaml, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'state-row', loaded.ideaState.ideaId, loaded.bundle.idea.state.repository, loaded.bundle.idea.state.object_format,
      loaded.bundle.idea.state.commit, loaded.bundle.idea.state.commit, loaded.ideaState.manifestYaml,
      loaded.ideaState.verifiersYaml, loaded.ideaState.policyYaml, '2026-08-30T00:00:00Z',
    )
    const document = loaded.renderings[0].document
    db.prepare(`INSERT INTO renderings
      (id, rendering_uri, idea_id, state_id, artifact_uri, artifact_digest, digest_verified, creator_uri, title, description, submitted_at, raw_manifest_json, status)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'active')`).run(
      'rendering-row', document.rendering.id, loaded.ideaState.ideaId, 'state-row', document.rendering.artifact.uri,
      document.rendering.artifact.digest, document.rendering.creator.id, document.rendering.title ?? null,
      document.rendering.description ?? null, '2026-08-30T00:00:00Z', JSON.stringify(document),
    )
    const existing = createPublicationPlan(db, loaded)
    expect(existing).toMatchObject({ idea: { status: 'existing' }, renderings: [{ status: 'existing' }], conflicts: [] })

    db.prepare('UPDATE renderings SET raw_manifest_json = ? WHERE id = ?').run(JSON.stringify({ ...document, rendering: { ...document.rendering, title: 'Equivocated' } }), 'rendering-row')
    const conflict = createPublicationPlan(db, loaded)
    expect(conflict.renderings[0].status).toBe('conflict')
    expect(conflict.conflicts[0]).toContain('different content')
    db.close()
  })

  it('refuses digest mismatch and applies only planned creates through the loopback API', async () => {
    const runtime = config()
    const input = fixture()
    const mismatch = await loadPublicationBundle(runtime, input.resolver, input.source, async () => ({ status: 'mismatch', computed_digest: `sha256:${'d'.repeat(64)}` }))
    const mismatchDb = openDatabase(runtime.databasePath)
    expect(createPublicationPlan(mismatchDb, mismatch)).toMatchObject({ renderings: [{ status: 'conflict' }] })
    mismatchDb.close()

    const verified = await loadPublicationBundle(runtime, input.resolver, input.source, async () => ({ status: 'verified', computed_digest: artifactDigest }))
    const cleanDirectory = mkdtempSync(join(tmpdir(), 'irap-publication-apply-'))
    cleanup.push(cleanDirectory)
    const cleanDb = openDatabase(join(cleanDirectory, 'irap.sqlite'))
    const plan = createPublicationPlan(cleanDb, verified)
    cleanDb.close()
    const calls: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = []
    const fakeFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      calls.push({ url: String(input), authorization: headers.get('authorization'), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ activity_id: `activity-${calls.length}` }), { status: 201, headers: { 'content-type': 'application/json' } })
    }
    const result = await applyPublicationBundle(runtime, verified, plan, fakeFetch)
    expect(result).toMatchObject({ idea: { status: 'published' }, renderings: [{ status: 'published' }] })
    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:8787/api/ideas', 'http://127.0.0.1:8787/api/v1/renderings',
    ])
    expect(calls.every((call) => call.authorization === `Bearer ${runtime.adminToken}`)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(runtime.adminToken)
  })
})
