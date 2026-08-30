import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { parse } from 'yaml'
import { activityContext } from './activitypub.js'
import { requireAdmin } from './api.js'
import type { ServiceConfig } from './config.js'
import { serviceUrls } from './config.js'
import type { AttestationRow, IdeaRow, IdeaStateRow, RenderingRow } from './database.js'
import type { FederationService } from './federation.js'
import type { GitResolver, ResolvedIdeaState } from './git-resolver.js'
import { attestationDocumentSchema, renderingDocumentSchema, renderingSubmissionSchema, type AttestationDocument, type RenderingDocument } from './irap.js'
import { aggregateRecognition, evaluateAttestation } from './registry-verification.js'
import { inspectArtifact } from './artifact.js'

const publicCollection = 'https://www.w3.org/ns/activitystreams#Public'

function stateFromResolved(db: Database.Database, resolved: ResolvedIdeaState, repository: string, now: string) {
  db.prepare(`INSERT OR IGNORE INTO idea_states
    (id, idea_id, repository, object_format, commit_value, source_revision, manifest_yaml, verifiers_yaml, policy_yaml, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    randomUUID(), resolved.ideaId, repository, resolved.objectFormat, resolved.commit, resolved.sourceRevision,
    resolved.manifestYaml, resolved.verifiersYaml, resolved.policyYaml, now,
  )
  return db.prepare('SELECT * FROM idea_states WHERE repository = ? AND commit_value = ?').get(repository, resolved.commit) as IdeaStateRow
}

function storedAttestation(row: AttestationRow) {
  return {
    id: row.id,
    uri: row.attestation_uri,
    rendering_id: row.rendering_id,
    target_commit: row.target_commit,
    verifier_id: row.verifier_uri,
    verifier_key_id: row.verifier_key_id,
    claim: row.claim,
    result: row.result,
    note: row.note,
    issued_at: row.issued_at,
    signature_valid: Boolean(row.signature_valid),
    recognition_status: row.recognition_status,
    recognition_reasons: JSON.parse(row.recognition_reasons_json),
    document: JSON.parse(row.raw_attestation_json),
  }
}

function localResourceUri(config: ServiceConfig, resource: 'renderings' | 'attestations', identifier: string) {
  return `${config.publicOrigin}/${resource}/${encodeURIComponent(identifier)}`
}

function renderingObject(config: ServiceConfig, row: RenderingRow, document: RenderingDocument) {
  const urls = serviceUrls(config)
  return {
    '@context': activityContext,
    id: `${config.publicOrigin}/ap/objects/renderings/${row.id}`,
    type: 'Document',
    url: `${config.publicOrigin}/renderings/${row.id}`,
    attributedTo: urls.actor,
    name: row.title ?? 'IRAP rendering',
    summary: row.description ?? `Rendering of ${row.idea_id}`,
    published: row.submitted_at,
    to: [publicCollection],
    cc: [urls.followers],
    attachment: [
      { type: 'Link', name: 'External artifact', href: row.artifact_uri },
      { type: 'Document', name: 'IRAP rendering manifest', mediaType: 'application/json', content: JSON.stringify(document) },
    ],
  }
}

function attestationObject(config: ServiceConfig, row: AttestationRow) {
  const urls = serviceUrls(config)
  return {
    '@context': activityContext,
    id: `${config.publicOrigin}/ap/objects/attestations/${row.id}`,
    type: 'Note',
    url: `${config.publicOrigin}/attestations/${row.id}`,
    attributedTo: urls.actor,
    name: `IRAP ${row.claim}: ${row.result}`,
    content: `An attributable ${row.result} judgment was published. Signature: ${row.signature_valid ? 'valid' : 'not verified'}; recognition: ${row.recognition_status}.`,
    published: row.created_at,
    to: [publicCollection],
    cc: [urls.followers],
    inReplyTo: `${config.publicOrigin}/ap/objects/renderings/${row.rendering_id}`,
  }
}

function publishObject(db: Database.Database, config: ServiceConfig, federation: FederationService, object: Record<string, unknown>, now: string) {
  const urls = serviceUrls(config)
  const activity = {
    '@context': activityContext,
    id: `${config.publicOrigin}/ap/activities/${randomUUID()}`,
    type: 'Create', actor: urls.actor, published: now, to: [publicCollection], cc: [urls.followers], object,
  }
  db.prepare(`INSERT INTO activities (id, type, object_id, body_json, public, published_at) VALUES (?, 'Create', ?, ?, 1, ?)`).run(
    activity.id, object.id, JSON.stringify(activity), now,
  )
  return { activity, deliveries: federation.enqueueForFollowers(activity.id) }
}

function registryJson(reply: FastifyReply, body: unknown, status = 200) {
  return reply.code(status).type('application/json; charset=utf-8').send(body)
}

export function registerRegistryApi(
  app: FastifyInstance,
  config: ServiceConfig,
  db: Database.Database,
  federation: FederationService,
  gitResolver: GitResolver,
) {
  app.get('/api/v1/ideas/:slug/states/:commit', async (request, reply) => {
    const { slug, commit } = request.params as { slug: string; commit: string }
    const idea = db.prepare('SELECT * FROM ideas WHERE slug = ?').get(slug) as IdeaRow | undefined
    if (!idea) return reply.code(404).send({ error: 'Idea not found.' })
    const state = db.prepare('SELECT * FROM idea_states WHERE idea_id = ? AND commit_value = ?').get(idea.idea_id, commit) as IdeaStateRow | undefined
    if (!state) return reply.code(404).send({ error: 'Historical state not found.' })
    return {
      id: state.id,
      idea_id: state.idea_id,
      repository: state.repository,
      object_format: state.object_format,
      commit: state.commit_value,
      source_revision: state.source_revision,
      resolved_at: state.resolved_at,
      manifest: parse(state.manifest_yaml),
      verifier_registry: parse(state.verifiers_yaml),
      verification_policy: parse(state.policy_yaml),
    }
  })

  app.post('/api/v1/renderings', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, preHandler: requireAdmin(config) }, async (request, reply) => {
    const parsed = renderingSubmissionSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Rendering submission validation failed.', issues: parsed.error.issues })
    const input = parsed.data
    if (config.production && new URL(input.artifact.uri).protocol !== 'https:') return reply.code(400).send({ error: 'Artifact URI must use HTTPS in production.' })
    const idea = db.prepare('SELECT * FROM ideas WHERE slug = ?').get(input.idea_slug) as IdeaRow | undefined
    if (!idea) return reply.code(404).send({ error: 'Idea not found.' })
    let resolved: ResolvedIdeaState
    try {
      resolved = await gitResolver.resolve(input.target.repository, input.target.object_format, input.target.revision)
    } catch (error) {
      request.log.warn({ error, repository: input.target.repository }, 'Rendering target resolution failed')
      return reply.code(422).send({ error: error instanceof Error ? error.message : 'Rendering target resolution failed.' })
    }
    if (resolved.ideaId !== idea.idea_id) return reply.code(422).send({ error: 'Resolved historical manifest belongs to a different idea.' })
    const id = randomUUID()
    const renderingUri = input.id ?? `${config.publicOrigin}/renderings/${id}`
    const now = new Date().toISOString()
    const artifactInspection = await inspectArtifact(input.artifact.uri, input.artifact.digest, config)
    const document: RenderingDocument = {
      irap_version: '0.1',
      rendering: {
        id: renderingUri,
        ...(input.title ? { title: input.title } : {}),
        ...(input.description ? { description: input.description } : {}),
        artifact: input.artifact,
        renders: {
          idea_id: resolved.ideaId,
          git: { repository: input.target.repository, object_format: resolved.objectFormat, commit: resolved.commit },
        },
        creator: input.creator,
      },
    }
    const row: RenderingRow = {
      id,
      rendering_uri: renderingUri,
      idea_id: resolved.ideaId,
      state_id: '',
      artifact_uri: input.artifact.uri,
      artifact_digest: input.artifact.digest,
      digest_verified: artifactInspection.status === 'verified' ? 1 : artifactInspection.status === 'mismatch' ? -1 : 0,
      creator_uri: input.creator.id,
      title: input.title ?? null,
      description: input.description ?? null,
      submitted_at: now,
      raw_manifest_json: JSON.stringify(document),
      status: 'active',
    }
    let activityId = ''
    let queuedDeliveries = 0
    try {
      db.transaction(() => {
        const state = stateFromResolved(db, resolved, input.target.repository, now)
        row.state_id = state.id
        db.prepare(`INSERT INTO renderings
          (id, rendering_uri, idea_id, state_id, artifact_uri, artifact_digest, digest_verified, creator_uri, title, description, submitted_at, raw_manifest_json, status)
          VALUES (@id, @rendering_uri, @idea_id, @state_id, @artifact_uri, @artifact_digest, @digest_verified, @creator_uri, @title, @description, @submitted_at, @raw_manifest_json, @status)`).run(row)
        const publication = publishObject(db, config, federation, renderingObject(config, row, document), now)
        activityId = publication.activity.id
        queuedDeliveries = publication.deliveries
      })()
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) return reply.code(409).send({ error: 'That rendering URI is already registered.' })
      throw error
    }
    return reply.code(201).header('location', `${config.publicOrigin}/api/v1/renderings/${id}`).send({
      id, uri: renderingUri, document, state: { commit: resolved.commit, source_revision: resolved.sourceRevision },
      digest_verified: artifactInspection.status === 'verified', digest_status: artifactInspection,
      activity_id: activityId, queued_deliveries: queuedDeliveries,
    })
  })

  app.get('/api/v1/renderings/:id', async (request, reply) => {
    const identifier = (request.params as { id: string }).id
    const row = db.prepare('SELECT * FROM renderings WHERE id = ? OR rendering_uri = ?')
      .get(identifier, localResourceUri(config, 'renderings', identifier)) as RenderingRow | undefined
    if (!row) return reply.code(404).send({ error: 'Rendering not found.' })
    const state = db.prepare('SELECT * FROM idea_states WHERE id = ?').get(row.state_id) as IdeaStateRow
    const attestations = db.prepare('SELECT * FROM attestations WHERE rendering_id = ? ORDER BY issued_at DESC').all(row.id) as AttestationRow[]
    return {
      id: row.id,
      uri: row.rendering_uri,
      document: JSON.parse(row.raw_manifest_json),
      status: row.status,
      digest_verified: row.digest_verified === 1,
      digest_status: row.digest_verified === 1 ? 'verified' : row.digest_verified === -1 ? 'mismatch' : 'unverified',
      historical_state: { commit: state.commit_value, source_revision: state.source_revision, policy: parse(state.policy_yaml) },
      recognition: aggregateRecognition(state, attestations),
      attestations: attestations.map(storedAttestation),
    }
  })

  app.post('/api/v1/attestations/verify', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = attestationDocumentSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Attestation validation failed.', issues: parsed.error.issues })
    const rendering = db.prepare('SELECT * FROM renderings WHERE rendering_uri = ?').get(parsed.data.attestation.rendering.id) as RenderingRow | undefined
    if (!rendering) return reply.code(404).send({ error: 'Referenced rendering is not registered.' })
    const state = db.prepare('SELECT * FROM idea_states WHERE id = ?').get(rendering.state_id) as IdeaStateRow
    const renderingDocument = renderingDocumentSchema.parse(JSON.parse(rendering.raw_manifest_json))
    return evaluateAttestation(parsed.data, rendering, renderingDocument, state)
  })

  app.post('/api/v1/attestations', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = attestationDocumentSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Attestation validation failed.', issues: parsed.error.issues })
    const document: AttestationDocument = parsed.data
    const rendering = db.prepare('SELECT * FROM renderings WHERE rendering_uri = ?').get(document.attestation.rendering.id) as RenderingRow | undefined
    if (!rendering) return reply.code(404).send({ error: 'Referenced rendering is not registered.' })
    const state = db.prepare('SELECT * FROM idea_states WHERE id = ?').get(rendering.state_id) as IdeaStateRow
    const renderingDocument = renderingDocumentSchema.parse(JSON.parse(rendering.raw_manifest_json))
    const verification = evaluateAttestation(document, rendering, renderingDocument, state)
    const id = randomUUID()
    const now = new Date().toISOString()
    const received = document.attestation
    const row: AttestationRow = {
      id,
      attestation_uri: received.id,
      rendering_id: rendering.id,
      target_commit: received.against.git.commit,
      verifier_uri: received.verifier.id,
      verifier_key_id: received.verifier.key_id,
      claim: received.judgment.claim,
      result: received.judgment.result,
      note: received.judgment.note ?? null,
      issued_at: received.issued_at,
      raw_attestation_json: JSON.stringify(document),
      signature_valid: verification.signature_valid ? 1 : 0,
      recognition_status: verification.recognition_status,
      recognition_reasons_json: JSON.stringify(verification.recognition_reasons),
      created_at: now,
    }
    let activityId = ''
    let queuedDeliveries = 0
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO attestations
          (id, attestation_uri, rendering_id, target_commit, verifier_uri, verifier_key_id, claim, result, note, issued_at, raw_attestation_json, signature_valid, recognition_status, recognition_reasons_json, created_at)
          VALUES (@id, @attestation_uri, @rendering_id, @target_commit, @verifier_uri, @verifier_key_id, @claim, @result, @note, @issued_at, @raw_attestation_json, @signature_valid, @recognition_status, @recognition_reasons_json, @created_at)`).run(row)
        const publication = publishObject(db, config, federation, attestationObject(config, row), now)
        activityId = publication.activity.id
        queuedDeliveries = publication.deliveries
      })()
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) return reply.code(409).send({ error: 'That attestation URI is already registered.' })
      throw error
    }
    return reply.code(201).header('location', `${config.publicOrigin}/api/v1/attestations/${id}`).send({
      id, uri: received.id, verification, activity_id: activityId, queued_deliveries: queuedDeliveries,
    })
  })

  app.get('/api/v1/attestations/:id', async (request, reply) => {
    const identifier = (request.params as { id: string }).id
    const row = db.prepare('SELECT * FROM attestations WHERE id = ? OR attestation_uri = ?')
      .get(identifier, localResourceUri(config, 'attestations', identifier)) as AttestationRow | undefined
    return row ? storedAttestation(row) : reply.code(404).send({ error: 'Attestation not found.' })
  })

  app.get('/ap/objects/renderings/:id', async (request, reply) => {
    const row = db.prepare('SELECT * FROM renderings WHERE id = ?').get((request.params as { id: string }).id) as RenderingRow | undefined
    return row ? registryJson(reply, renderingObject(config, row, JSON.parse(row.raw_manifest_json)), 200) : reply.code(404).send({ error: 'Rendering not found.' })
  })

  app.get('/ap/objects/attestations/:id', async (request, reply) => {
    const row = db.prepare('SELECT * FROM attestations WHERE id = ?').get((request.params as { id: string }).id) as AttestationRow | undefined
    return row ? registryJson(reply, attestationObject(config, row), 200) : reply.code(404).send({ error: 'Attestation not found.' })
  })
}
