import { randomUUID, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ServiceConfig } from './config.js'
import { serviceUrls } from './config.js'
import type { IdeaRow } from './database.js'
import { FederationService } from './federation.js'
import { createIdeaActivity } from './activitypub.js'
import { ideaInputSchema } from './irap.js'
import { GitResolver } from './git-resolver.js'

function authorized(request: FastifyRequest, config: ServiceConfig) {
  const value = request.headers.authorization
  if (!value?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(value.slice(7))
  const expected = Buffer.from(config.adminToken)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function requireAdmin(config: ServiceConfig) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request, config)) return reply.code(401).header('www-authenticate', 'Bearer realm="IRAP publisher"').send({ error: 'A valid administrator token is required.' })
  }
}

function publicIdea(row: IdeaRow) {
  return {
    id: row.idea_id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    repository: row.repository,
    git_commit: { algorithm: row.commit_algorithm, value: row.commit_value },
    spec_yaml: row.spec_yaml,
    created_at: row.created_at,
    updated_at: row.updated_at,
    git_verified: Boolean(row.git_verified),
  }
}

export function registerApi(app: FastifyInstance, config: ServiceConfig, db: Database.Database, federation: FederationService, gitResolver: GitResolver) {
  const urls = serviceUrls(config)
  app.get('/api/health', async () => ({ status: 'ok', federation: config.federationEnabled, actor: urls.actor }))
  app.get('/api/config', async () => ({ actor: urls.actor, handle: urls.handle, federation: config.federationEnabled, protocol: 'irap/0.1' }))

  app.get('/api/ideas', async () => {
    const rows = db.prepare('SELECT * FROM ideas ORDER BY created_at DESC LIMIT 100').all() as IdeaRow[]
    return { items: rows.map(publicIdea) }
  })
  app.get('/api/v1/ideas', async () => {
    const rows = db.prepare('SELECT * FROM ideas ORDER BY created_at DESC LIMIT 100').all() as IdeaRow[]
    return { items: rows.map(publicIdea) }
  })

  app.get('/api/ideas/:slug', async (request, reply) => {
    const row = db.prepare('SELECT * FROM ideas WHERE slug = ?').get((request.params as { slug: string }).slug) as IdeaRow | undefined
    return row ? publicIdea(row) : reply.code(404).send({ error: 'Idea not found.' })
  })
  app.get('/api/v1/ideas/:slug', async (request, reply) => {
    const row = db.prepare('SELECT * FROM ideas WHERE slug = ?').get((request.params as { slug: string }).slug) as IdeaRow | undefined
    return row ? publicIdea(row) : reply.code(404).send({ error: 'Idea not found.' })
  })

  app.post('/api/ideas', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, preHandler: requireAdmin(config) }, async (request, reply) => {
    const parsed = ideaInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Idea validation failed.', issues: parsed.error.issues })
    const input = parsed.data
    let resolved: Awaited<ReturnType<GitResolver['resolve']>> | null = null
    if (config.verifyGitOnPublish) {
      try {
        resolved = await gitResolver.resolve(input.repository, input.git_commit.algorithm, input.git_commit.value)
      } catch (error) {
        request.log.warn({ error, repository: input.repository }, 'Git state verification failed')
        return reply.code(422).send({ error: error instanceof Error ? error.message : 'Git state verification failed.' })
      }
      if (resolved.ideaName !== input.name) return reply.code(422).send({ error: 'Published name does not match the historical idea manifest.' })
    }
    const now = new Date().toISOString()
    const row: IdeaRow = {
      id: randomUUID(),
      slug: input.slug,
      idea_id: resolved?.ideaId ?? `${config.publicOrigin}/ideas/${input.slug}`,
      name: input.name,
      summary: input.summary,
      repository: input.repository,
      commit_algorithm: input.git_commit.algorithm,
      commit_value: input.git_commit.value,
      spec_yaml: input.spec_yaml,
      git_verified: resolved ? 1 : 0,
      manifest_yaml: resolved?.manifestYaml ?? null,
      verifiers_yaml: resolved?.verifiersYaml ?? null,
      policy_yaml: resolved?.policyYaml ?? null,
      created_at: now,
      updated_at: now,
    }
    const activity = createIdeaActivity(config, row)
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO ideas (id, slug, idea_id, name, summary, repository, commit_algorithm, commit_value, spec_yaml, git_verified, manifest_yaml, verifiers_yaml, policy_yaml, created_at, updated_at)
          VALUES (@id, @slug, @idea_id, @name, @summary, @repository, @commit_algorithm, @commit_value, @spec_yaml, @git_verified, @manifest_yaml, @verifiers_yaml, @policy_yaml, @created_at, @updated_at)`).run(row)
        db.prepare(`INSERT INTO activities (id, type, object_id, body_json, public, published_at) VALUES (?, ?, ?, ?, 1, ?)`).run(
          activity.id, activity.type, activity.object.id, JSON.stringify(activity), now,
        )
      })()
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) return reply.code(409).send({ error: 'That idea slug is already published.' })
      throw error
    }
    const queuedDeliveries = federation.enqueueForFollowers(activity.id)
    return reply.code(201).header('location', activity.object.id).send({ idea: publicIdea(row), activity_id: activity.id, queued_deliveries: queuedDeliveries })
  })

  app.get('/api/admin/federation', { preHandler: requireAdmin(config) }, async () => {
    const counts = db.prepare(`SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status`).all()
    const followers = (db.prepare('SELECT COUNT(*) AS count FROM followers').get() as { count: number }).count
    const inbox = (db.prepare('SELECT COUNT(*) AS count FROM inbox_activities').get() as { count: number }).count
    return { followers, inbox_activities: inbox, deliveries: counts }
  })
}
