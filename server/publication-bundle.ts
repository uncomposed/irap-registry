import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { inspectArtifact, type ArtifactInspection } from './artifact.js'
import type { ServiceConfig } from './config.js'
import type { IdeaRow, IdeaStateRow, RenderingRow } from './database.js'
import { GitResolver, type ResolvedIdeaState } from './git-resolver.js'
import { renderingDocumentSchema, type RenderingDocument, type RenderingSubmission } from './irap.js'

const safePath = z.string().min(1).max(240).regex(/^[A-Za-z0-9._/-]+$/).refine((value) => {
  const segments = value.split('/')
  return !value.startsWith('/') && !value.includes('\\') && segments.every((segment) => segment && segment !== '.' && segment !== '..') && segments[0] !== '.git'
}, 'Use a safe repository-relative path.')

const gitState = z.discriminatedUnion('object_format', [
  z.object({
    repository: z.string().url(), object_format: z.literal('sha1'),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
  }),
  z.object({
    repository: z.string().url(), object_format: z.literal('sha256'),
    commit: z.string().regex(/^[0-9a-f]{64}$/),
  }),
])

export const publicationBundleSchema = z.object({
  publication_version: z.literal('1'),
  idea: z.object({
    slug: z.string().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    summary: z.string().min(12).max(1000),
    specification_path: safePath,
    state: gitState,
  }),
  renderings: z.array(z.object({ path: safePath })).min(1).max(50),
}).superRefine((bundle, context) => {
  const paths = bundle.renderings.map((entry) => entry.path)
  if (new Set(paths).size !== paths.length) context.addIssue({ code: 'custom', path: ['renderings'], message: 'Rendering declaration paths must be unique.' })
})

export type PublicationBundle = z.infer<typeof publicationBundleSchema>

export type PublicationSource = {
  repository: string
  objectFormat: 'sha1' | 'sha256'
  commit: string
  path: string
}

export type LoadedPublicationBundle = {
  source: PublicationSource
  bundle: PublicationBundle
  ideaState: ResolvedIdeaState
  specYaml: string
  renderings: Array<{ path: string; document: RenderingDocument; inspection: ArtifactInspection }>
}

export type PublicationPlan = {
  source: PublicationSource
  idea: {
    status: 'create' | 'existing' | 'conflict'
    slug: string
    id: string
    name: string
    repository: string
    commit: string
  }
  renderings: Array<{
    status: 'create' | 'existing' | 'conflict'
    path: string
    uri: string
    artifact_uri: string
    artifact_digest: string
    artifact_status: ArtifactInspection['status']
    target_commit: string
  }>
  warnings: string[]
  conflicts: string[]
}

function parseYamlMapping(value: string, label: string) {
  const document = parseDocument(value)
  if (document.errors.length) throw new Error(`${label} is invalid YAML: ${document.errors[0].message}`)
  const parsed = document.toJS({ maxAliasCount: 20 })
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a YAML mapping.`)
  return parsed
}

function sameYamlMapping(left: string, right: string) {
  try {
    return isDeepStrictEqual(parseYamlMapping(left, 'Stored specification'), parseYamlMapping(right, 'Bundle specification'))
  } catch {
    return false
  }
}

function fullCommit(value: string, objectFormat: 'sha1' | 'sha256') {
  return (objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/).test(value)
}

function specificationIdentity(value: Record<string, unknown>) {
  for (const key of ['idea', 'idea_model', 'protocol'] as const) {
    const candidate = value[key]
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const identity = candidate as Record<string, unknown>
    if (typeof identity.name === 'string') {
      const names = [identity.name]
      if (key === 'protocol' && typeof identity.short_name === 'string') {
        names.push(`${identity.name} (${identity.short_name})`)
      }
      return { id: typeof identity.id === 'string' ? identity.id : null, names }
    }
  }
  return null
}

function renderingSubmission(slug: string, document: RenderingDocument): RenderingSubmission {
  const rendering = document.rendering
  return {
    idea_slug: slug,
    id: rendering.id,
    ...(rendering.title ? { title: rendering.title } : {}),
    ...(rendering.description ? { description: rendering.description } : {}),
    artifact: rendering.artifact,
    target: {
      repository: rendering.renders.git.repository,
      object_format: rendering.renders.git.object_format,
      revision: rendering.renders.git.commit,
    },
    creator: rendering.creator,
  }
}

export async function loadPublicationBundle(
  config: ServiceConfig,
  resolver: GitResolver,
  source: PublicationSource,
  inspect: typeof inspectArtifact = inspectArtifact,
): Promise<LoadedPublicationBundle> {
  if (!fullCommit(source.commit, source.objectFormat)) throw new Error('Publication bundle source must be a full Git commit object ID.')
  const bundleRead = await resolver.readFiles(source.repository, source.objectFormat, source.commit, [source.path])
  if (bundleRead.commit !== source.commit) throw new Error('Publication bundle resolved to a different source commit.')
  const bundle = publicationBundleSchema.parse(parseYamlMapping(bundleRead.files[source.path], source.path))
  const state = bundle.idea.state
  const ideaState = await resolver.resolve(state.repository, state.object_format, state.commit)
  if (ideaState.commit !== state.commit) throw new Error('Idea state resolved to a different commit.')
  const stateFiles = await resolver.readFiles(state.repository, state.object_format, state.commit, [bundle.idea.specification_path])
  const specYaml = stateFiles.files[bundle.idea.specification_path]
  const specification = specificationIdentity(parseYamlMapping(specYaml, bundle.idea.specification_path))
  if (!specification || (specification.id !== null && specification.id !== ideaState.ideaId) || !specification.names.includes(ideaState.ideaName)) {
    throw new Error(`${bundle.idea.specification_path} identity differs from the historical idea manifest.`)
  }

  const renderingPaths = bundle.renderings.map((entry) => entry.path)
  const declarations = await resolver.readFiles(source.repository, source.objectFormat, source.commit, renderingPaths)
  const renderings = await Promise.all(renderingPaths.map(async (path) => {
    const document = renderingDocumentSchema.parse(parseYamlMapping(declarations.files[path], path))
    const target = document.rendering.renders
    if (target.idea_id !== ideaState.ideaId) throw new Error(`${path} targets a different idea ID.`)
    if (target.git.repository !== state.repository || target.git.object_format !== state.object_format || target.git.commit !== state.commit) {
      throw new Error(`${path} does not target the bundle's exact idea state.`)
    }
    const inspection = await inspect(document.rendering.artifact.uri, document.rendering.artifact.digest, config)
    return { path, document, inspection }
  }))
  return { source, bundle, ideaState, specYaml, renderings }
}

export function createPublicationPlan(db: Database.Database, loaded: LoadedPublicationBundle): PublicationPlan {
  const { bundle, ideaState } = loaded
  const conflicts: string[] = []
  const warnings: string[] = []
  const bySlug = db.prepare('SELECT * FROM ideas WHERE slug = ?').get(bundle.idea.slug) as IdeaRow | undefined
  const byIdentity = db.prepare('SELECT * FROM ideas WHERE idea_id = ?').get(ideaState.ideaId) as IdeaRow | undefined
  let ideaStatus: PublicationPlan['idea']['status'] = 'create'
  if (bySlug || byIdentity) {
    if (!bySlug || !byIdentity || bySlug.id !== byIdentity.id) {
      ideaStatus = 'conflict'
      conflicts.push(`Idea slug ${bundle.idea.slug} and identity ${ideaState.ideaId} do not resolve to the same stored idea.`)
    } else {
      const exact = bySlug.idea_id === ideaState.ideaId && bySlug.name === ideaState.ideaName && bySlug.summary === bundle.idea.summary &&
        bySlug.repository === bundle.idea.state.repository && bySlug.commit_algorithm === bundle.idea.state.object_format &&
        bySlug.commit_value === bundle.idea.state.commit && sameYamlMapping(bySlug.spec_yaml, loaded.specYaml)
      ideaStatus = exact ? 'existing' : 'conflict'
      if (!exact) conflicts.push(`Stored idea ${bundle.idea.slug} differs from the bundle's exact state or publication metadata.`)
    }
  }

  const renderings = loaded.renderings.map(({ path, document, inspection }) => {
    const declared = document.rendering
    const row = db.prepare('SELECT * FROM renderings WHERE rendering_uri = ?').get(declared.id) as RenderingRow | undefined
    let status: PublicationPlan['renderings'][number]['status'] = 'create'
    if (inspection.status === 'mismatch') {
      status = 'conflict'
      conflicts.push(`${path} artifact bytes do not match ${declared.artifact.digest}.`)
    } else if (inspection.status === 'unverified') {
      warnings.push(`${path} artifact could not be verified: ${inspection.reason ?? 'no reason reported'}`)
    }
    if (row) {
      const state = db.prepare('SELECT * FROM idea_states WHERE id = ?').get(row.state_id) as IdeaStateRow | undefined
      const stored = renderingDocumentSchema.safeParse(JSON.parse(row.raw_manifest_json))
      const exact = row.idea_id === ideaState.ideaId && state?.repository === bundle.idea.state.repository &&
        state.object_format === bundle.idea.state.object_format && state.commit_value === bundle.idea.state.commit &&
        stored.success && isDeepStrictEqual(stored.data, document)
      if (!exact) {
        status = 'conflict'
        conflicts.push(`Rendering URI ${declared.id} is already registered with different content or target state.`)
      } else if (status !== 'conflict') {
        status = 'existing'
      }
    }
    return {
      status, path, uri: declared.id, artifact_uri: declared.artifact.uri,
      artifact_digest: declared.artifact.digest, artifact_status: inspection.status,
      target_commit: declared.renders.git.commit,
    }
  })

  return {
    source: loaded.source,
    idea: {
      status: ideaStatus, slug: bundle.idea.slug, id: ideaState.ideaId, name: ideaState.ideaName,
      repository: bundle.idea.state.repository, commit: bundle.idea.state.commit,
    },
    renderings,
    warnings,
    conflicts,
  }
}

async function responseBody(response: Response) {
  const text = await response.text()
  try { return JSON.parse(text) as Record<string, unknown> } catch { return { raw: text } }
}

export async function applyPublicationBundle(
  config: ServiceConfig,
  loaded: LoadedPublicationBundle,
  plan: PublicationPlan,
  fetchImplementation: typeof fetch = fetch,
  baseUrl = `http://127.0.0.1:${config.port}`,
) {
  if (plan.conflicts.length) throw new Error('Publication bundle has conflicts and cannot be applied.')
  const headers = { authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' }
  const result: {
    idea: { status: 'published' | 'existing'; activity_id?: unknown }
    renderings: Array<{ uri: string; status: 'published' | 'existing'; activity_id?: unknown }>
  } = {
    idea: { status: plan.idea.status === 'create' ? 'published' : 'existing' },
    renderings: [],
  }

  if (plan.idea.status === 'create') {
    const response = await fetchImplementation(`${baseUrl}/api/ideas`, {
      method: 'POST', headers,
      body: JSON.stringify({
        slug: loaded.bundle.idea.slug,
        name: loaded.ideaState.ideaName,
        summary: loaded.bundle.idea.summary,
        repository: loaded.bundle.idea.state.repository,
        git_commit: { algorithm: loaded.bundle.idea.state.object_format, value: loaded.bundle.idea.state.commit },
        spec_yaml: loaded.specYaml,
      }),
    })
    const body = await responseBody(response)
    if (response.status !== 201) throw new Error(`Idea publication failed (${response.status}): ${JSON.stringify(body)}`)
    result.idea.activity_id = body.activity_id
  }

  for (let index = 0; index < loaded.renderings.length; index += 1) {
    const planned = plan.renderings[index]
    if (planned.status === 'existing') {
      result.renderings.push({ uri: planned.uri, status: 'existing' })
      continue
    }
    const response = await fetchImplementation(`${baseUrl}/api/v1/renderings`, {
      method: 'POST', headers,
      body: JSON.stringify(renderingSubmission(loaded.bundle.idea.slug, loaded.renderings[index].document)),
    })
    const body = await responseBody(response)
    if (response.status !== 201) throw new Error(`Rendering publication failed for ${planned.uri} (${response.status}): ${JSON.stringify(body)}`)
    result.renderings.push({ uri: planned.uri, status: 'published', activity_id: body.activity_id })
  }
  return result
}
