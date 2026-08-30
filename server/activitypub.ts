import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ServiceConfig } from './config.js'
import { serviceUrls } from './config.js'
import { metaValue, type ActivityRow, type FollowerRow, type IdeaRow } from './database.js'
import { FederationService } from './federation.js'
import { verifySignedPost } from './http-signatures.js'
import { escapeHtml } from './irap.js'

export const activityContext = [
  'https://www.w3.org/ns/activitystreams',
  'https://w3id.org/security/v1',
  {
    irap: 'https://proximitytoprogress.com/ns/irap#',
    ideaId: 'irap:ideaId',
    repository: 'irap:repository',
    gitCommit: 'irap:gitCommit',
    gitObjectFormat: 'irap:gitObjectFormat',
    gitStateVerified: 'irap:gitStateVerified',
  },
]

const publicCollection = 'https://www.w3.org/ns/activitystreams#Public'

function activityJson(reply: FastifyReply, body: unknown, status = 200) {
  return reply.code(status).type('application/activity+json; charset=utf-8').send(body)
}

export function ideaObject(config: ServiceConfig, row: IdeaRow) {
  const urls = serviceUrls(config)
  return {
    '@context': activityContext,
    id: `${config.publicOrigin}/ap/objects/ideas/${row.slug}`,
    type: 'Document',
    url: `${config.publicOrigin}/?idea=${encodeURIComponent(row.slug)}`,
    attributedTo: urls.actor,
    name: row.name,
    summary: row.summary,
    content: `<p>${escapeHtml(row.summary)}</p><p><strong>Git state:</strong> <code>${row.commit_value}</code></p>`,
    mediaType: 'text/yaml',
    published: row.created_at,
    updated: row.updated_at,
    to: [publicCollection],
    cc: [urls.followers],
    ideaId: row.idea_id,
    repository: row.repository,
    gitCommit: row.commit_value,
    gitObjectFormat: row.commit_algorithm,
    gitStateVerified: Boolean(row.git_verified),
    attachment: [
      { type: 'Link', name: 'Git repository', href: row.repository, mediaType: 'application/x-git' },
      { type: 'Document', name: 'IRAP YAML specification', mediaType: 'text/yaml', content: row.spec_yaml },
    ],
  }
}

function recordActivity(db: Database.Database, body: Record<string, unknown>, isPublic: boolean) {
  db.prepare(`INSERT INTO activities (id, type, object_id, body_json, public, published_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    body.id,
    body.type,
    typeof body.object === 'object' && body.object && 'id' in body.object ? String((body.object as { id: unknown }).id) : null,
    JSON.stringify(body),
    isPublic ? 1 : 0,
    body.published,
  )
}

export function createIdeaActivity(config: ServiceConfig, row: IdeaRow) {
  const urls = serviceUrls(config)
  const object = ideaObject(config, row)
  return {
    '@context': activityContext,
    id: `${config.publicOrigin}/ap/activities/${randomUUID()}`,
    type: 'Create',
    actor: urls.actor,
    published: row.created_at,
    to: [publicCollection],
    cc: [urls.followers],
    object,
  }
}

function rawRequestBody(request: FastifyRequest) {
  const raw = (request as FastifyRequest & { rawBody?: Buffer | string }).rawBody
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (typeof raw === 'string') return raw
  return typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
}

export function registerActivityPub(
  app: FastifyInstance,
  config: ServiceConfig,
  db: Database.Database,
  federation: FederationService,
) {
  const urls = serviceUrls(config)

  app.get('/.well-known/webfinger', async (request, reply) => {
    const resource = (request.query as { resource?: string }).resource
    const expected = `acct:${config.actorName}@${new URL(config.publicOrigin).host}`
    if (resource !== expected && resource !== urls.actor) return reply.code(404).send({ error: 'Unknown resource.' })
    return reply.type('application/jrd+json; charset=utf-8').send({
      subject: expected,
      aliases: [urls.actor],
      links: [
        { rel: 'self', type: 'application/activity+json', href: urls.actor },
        { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: config.publicOrigin },
      ],
    })
  })

  app.get('/.well-known/nodeinfo', async (_request, reply) => reply.send({
    links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: `${config.publicOrigin}/nodeinfo/2.1` }],
  }))

  app.get('/nodeinfo/2.1', async (_request, reply) => {
    const ideaCount = (db.prepare('SELECT COUNT(*) AS count FROM ideas').get() as { count: number }).count
    return reply.type('application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.1#"').send({
      version: '2.1',
      software: { name: 'irap-publisher', version: '0.5.0' },
      protocols: ['activitypub'],
      services: { inbound: [], outbound: [] },
      openRegistrations: false,
      usage: { users: { total: 1, activeMonth: 1, activeHalfyear: 1 }, localPosts: ideaCount },
      metadata: { nodeName: config.actorDisplayName },
    })
  })

  app.get('/ap/actors/:username', async (request, reply) => {
    if ((request.params as { username: string }).username !== config.actorName) return reply.code(404).send({ error: 'Actor not found.' })
    return activityJson(reply, {
      '@context': activityContext,
      id: urls.actor,
      type: 'Application',
      preferredUsername: config.actorName,
      name: config.actorDisplayName,
      summary: 'Publishes exact Git states and federated IRAP idea announcements.',
      url: config.publicOrigin,
      inbox: urls.inbox,
      outbox: urls.outbox,
      followers: urls.followers,
      endpoints: { sharedInbox: urls.sharedInbox },
      publicKey: { id: urls.keyId, owner: urls.actor, publicKeyPem: metaValue(db, 'actor_public_key') },
    })
  })

  app.get('/ap/actors/:username/outbox', async (request, reply) => {
    if ((request.params as { username: string }).username !== config.actorName) return reply.code(404).send({ error: 'Actor not found.' })
    const page = (request.query as { page?: string }).page === 'true'
    const total = (db.prepare('SELECT COUNT(*) AS count FROM activities WHERE public = 1').get() as { count: number }).count
    if (!page) return activityJson(reply, {
      '@context': activityContext, id: urls.outbox, type: 'OrderedCollection', totalItems: total, first: `${urls.outbox}?page=true`,
    })
    const rows = db.prepare('SELECT * FROM activities WHERE public = 1 ORDER BY published_at DESC LIMIT 40').all() as ActivityRow[]
    return activityJson(reply, {
      '@context': activityContext,
      id: `${urls.outbox}?page=true`,
      type: 'OrderedCollectionPage',
      partOf: urls.outbox,
      orderedItems: rows.map((row) => JSON.parse(row.body_json)),
    })
  })

  app.get('/ap/actors/:username/followers', async (request, reply) => {
    if ((request.params as { username: string }).username !== config.actorName) return reply.code(404).send({ error: 'Actor not found.' })
    const rows = db.prepare('SELECT * FROM followers ORDER BY created_at DESC').all() as FollowerRow[]
    return activityJson(reply, {
      '@context': activityContext, id: urls.followers, type: 'OrderedCollection', totalItems: rows.length,
      orderedItems: rows.map((row) => row.actor_id),
    })
  })

  app.get('/ap/objects/ideas/:slug', async (request, reply) => {
    const row = db.prepare('SELECT * FROM ideas WHERE slug = ?').get((request.params as { slug: string }).slug) as IdeaRow | undefined
    return row ? activityJson(reply, ideaObject(config, row)) : reply.code(404).send({ error: 'Idea not found.' })
  })

  const inboxHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.federationEnabled) return reply.code(503).send({ error: 'Federation is disabled.' })
    const bodyText = rawRequestBody(request)
    let activity: Record<string, unknown>
    try { activity = JSON.parse(bodyText) as Record<string, unknown> } catch { return reply.code(400).send({ error: 'Invalid JSON.' }) }
    if (typeof activity.id !== 'string' || typeof activity.actor !== 'string' || typeof activity.type !== 'string') {
      return reply.code(400).send({ error: 'Activity requires string id, actor, and type.' })
    }
    try {
      const key = await verifySignedPost({
        method: request.method,
        path: request.raw.url ?? request.url,
        headers: request.headers as Record<string, string | string[] | undefined>,
        body: bodyText,
      }, (keyId) => federation.resolveSigningKey(keyId))
      if (key.owner !== activity.actor) return reply.code(401).send({ error: 'Signature owner does not match activity actor.' })
    } catch (error) {
      request.log.warn({ error }, 'Rejected ActivityPub request')
      return reply.code(401).send({ error: error instanceof Error ? error.message : 'Signature verification failed.' })
    }

    const inserted = db.prepare(`INSERT OR IGNORE INTO inbox_activities (id, actor_id, type, body_json, received_at) VALUES (?, ?, ?, ?, ?)`).run(
      activity.id, activity.actor, activity.type, bodyText, new Date().toISOString(),
    )
    if (!inserted.changes) return reply.code(202).send()

    try {
      if (activity.type === 'Follow' && activity.object === urls.actor) {
        const remote = await federation.remoteActor(activity.actor)
        db.prepare(`INSERT INTO followers (actor_id, inbox, shared_inbox, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(actor_id) DO UPDATE SET inbox=excluded.inbox, shared_inbox=excluded.shared_inbox`).run(
          activity.actor, remote.inbox, remote.shared_inbox, new Date().toISOString(),
        )
        const accept = {
          '@context': activityContext,
          id: `${config.publicOrigin}/ap/activities/${randomUUID()}`,
          type: 'Accept',
          actor: urls.actor,
          object: activity,
          to: [activity.actor],
          published: new Date().toISOString(),
        }
        recordActivity(db, accept, false)
        federation.enqueue(accept.id, remote.inbox)
      } else if (activity.type === 'Undo') {
        const object = activity.object as { type?: unknown; actor?: unknown } | undefined
        if (object?.type === 'Follow' && object.actor === activity.actor) db.prepare('DELETE FROM followers WHERE actor_id = ?').run(activity.actor)
      } else if (activity.type === 'Delete' && activity.object === activity.actor) {
        db.prepare('DELETE FROM followers WHERE actor_id = ?').run(activity.actor)
      }
    } catch (error) {
      request.log.error({ error, activityId: activity.id }, 'Accepted activity but failed to apply inbox side effect')
    }
    return reply.code(202).send()
  }

  app.post('/ap/inbox', { config: { rawBody: true, rateLimit: { max: 120, timeWindow: '1 minute' } } }, inboxHandler)
  app.post('/ap/actors/:username/inbox', { config: { rawBody: true, rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    if ((request.params as { username: string }).username !== config.actorName) return reply.code(404).send({ error: 'Actor not found.' })
    return inboxHandler(request, reply)
  })

  return { recordActivity }
}
