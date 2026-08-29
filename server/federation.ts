import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import type Database from 'better-sqlite3'
import type { FastifyBaseLogger } from 'fastify'
import type { ServiceConfig } from './config.js'
import { serviceUrls } from './config.js'
import { metaValue, type ActivityRow, type DeliveryRow, type FollowerRow } from './database.js'
import { createSignedPostHeaders, type ResolvedSigningKey } from './http-signatures.js'

type RemoteActorDocument = {
  id?: string
  inbox?: string
  endpoints?: { sharedInbox?: string }
  publicKey?: { id?: string; owner?: string; publicKeyPem?: string }
}

function privateIpv4(address: string) {
  const parts = address.split('.').map(Number)
  return (
    parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 198 && [18, 19].includes(parts[1])) ||
    parts[0] >= 224
  )
}

function privateIp(address: string) {
  if (isIP(address) === 4) return privateIpv4(address)
  const normalized = address.toLowerCase()
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
}

export async function assertFederationUrl(urlValue: string, config: ServiceConfig) {
  const url = new URL(urlValue)
  if (url.username || url.password) throw new Error('Federation URLs cannot contain credentials.')
  if (url.protocol !== 'https:' && !(config.allowInsecureFederation && url.protocol === 'http:')) {
    throw new Error('Federation URLs must use HTTPS.')
  }
  if (['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase())) throw new Error('Local federation targets are blocked.')
  if (isIP(url.hostname) && privateIp(url.hostname)) throw new Error('Private federation targets are blocked.')
  const addresses = await lookup(url.hostname, { all: true })
  if (!addresses.length || addresses.some(({ address }) => privateIp(address))) throw new Error('Federation target resolves to a private or reserved address.')
  return url
}

async function safeFetchJson(urlValue: string, config: ServiceConfig) {
  await assertFederationUrl(urlValue, config)
  const response = await fetch(urlValue, {
    headers: { accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"' },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Remote actor fetch returned ${response.status}.`)
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > 1_000_000) throw new Error('Remote actor document is too large.')
  const text = await response.text()
  if (Buffer.byteLength(text) > 1_000_000) throw new Error('Remote actor document is too large.')
  return JSON.parse(text) as RemoteActorDocument
}

export class FederationService {
  private timer?: NodeJS.Timeout

  constructor(
    private db: Database.Database,
    private config: ServiceConfig,
    private log: FastifyBaseLogger,
  ) {}

  async resolveSigningKey(keyId: string): Promise<ResolvedSigningKey> {
    const actorUrl = new URL(keyId)
    actorUrl.hash = ''
    const cached = this.db.prepare('SELECT * FROM remote_actors WHERE public_key_id = ? AND fetched_at > ?').get(
      keyId,
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    ) as { id: string; public_key_id: string; public_key_pem: string } | undefined
    if (cached) return { id: cached.public_key_id, owner: cached.id, publicKeyPem: cached.public_key_pem }

    const document = await safeFetchJson(actorUrl.toString(), this.config)
    if (!document.id || !document.inbox || !document.publicKey?.id || !document.publicKey.owner || !document.publicKey.publicKeyPem) {
      throw new Error('Remote actor document is missing inbox or public key fields.')
    }
    if (document.id !== actorUrl.toString() || document.publicKey.owner !== document.id || document.publicKey.id !== keyId) {
      throw new Error('Remote actor key ownership does not match the requested key.')
    }
    await assertFederationUrl(document.inbox, this.config)
    if (document.endpoints?.sharedInbox) await assertFederationUrl(document.endpoints.sharedInbox, this.config)
    this.db.prepare(`
      INSERT INTO remote_actors (id, inbox, shared_inbox, public_key_id, public_key_pem, fetched_at)
      VALUES (@id, @inbox, @sharedInbox, @keyId, @publicKeyPem, @fetchedAt)
      ON CONFLICT(id) DO UPDATE SET inbox=excluded.inbox, shared_inbox=excluded.shared_inbox,
        public_key_id=excluded.public_key_id, public_key_pem=excluded.public_key_pem, fetched_at=excluded.fetched_at
    `).run({
      id: document.id,
      inbox: document.inbox,
      sharedInbox: document.endpoints?.sharedInbox ?? null,
      keyId: document.publicKey.id,
      publicKeyPem: document.publicKey.publicKeyPem,
      fetchedAt: new Date().toISOString(),
    })
    return { id: document.publicKey.id, owner: document.id, publicKeyPem: document.publicKey.publicKeyPem }
  }

  async remoteActor(actorId: string) {
    const existing = this.db.prepare('SELECT * FROM remote_actors WHERE id = ?').get(actorId) as { id: string; inbox: string; shared_inbox: string | null } | undefined
    if (existing) return existing
    const document = await safeFetchJson(actorId, this.config)
    if (!document.id || document.id !== actorId || !document.inbox || !document.publicKey?.id) throw new Error('Remote actor is incomplete.')
    await this.resolveSigningKey(document.publicKey.id)
    return this.db.prepare('SELECT * FROM remote_actors WHERE id = ?').get(actorId) as { id: string; inbox: string; shared_inbox: string | null }
  }

  enqueueForFollowers(activityId: string) {
    const followers = this.db.prepare('SELECT * FROM followers').all() as FollowerRow[]
    const insert = this.db.prepare(`INSERT OR IGNORE INTO deliveries (activity_id, inbox, next_attempt_at) VALUES (?, ?, ?)`)
    const now = new Date().toISOString()
    this.db.transaction(() => {
      for (const follower of followers) insert.run(activityId, follower.shared_inbox ?? follower.inbox, now)
    })()
    return followers.length
  }

  enqueue(activityId: string, inbox: string) {
    this.db.prepare(`INSERT OR IGNORE INTO deliveries (activity_id, inbox, next_attempt_at) VALUES (?, ?, ?)`).run(activityId, inbox, new Date().toISOString())
  }

  start() {
    if (!this.config.federationEnabled || this.timer) return
    this.timer = setInterval(() => void this.runDue(), 10_000)
    this.timer.unref()
    void this.runDue()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async runDue() {
    const rows = this.db.prepare(`
      SELECT * FROM deliveries WHERE status IN ('queued', 'retry') AND next_attempt_at <= ? ORDER BY id LIMIT 20
    `).all(new Date().toISOString()) as DeliveryRow[]
    for (const row of rows) await this.deliver(row)
  }

  private async deliver(row: DeliveryRow) {
    this.db.prepare(`UPDATE deliveries SET status = 'processing' WHERE id = ?`).run(row.id)
    try {
      const activity = this.db.prepare('SELECT * FROM activities WHERE id = ?').get(row.activity_id) as ActivityRow | undefined
      if (!activity) throw new Error('Activity no longer exists.')
      await assertFederationUrl(row.inbox, this.config)
      const body = activity.body_json
      const urls = serviceUrls(this.config)
      const headers = createSignedPostHeaders(row.inbox, body, urls.keyId, metaValue(this.db, 'actor_private_key'))
      const response = await fetch(row.inbox, {
        method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`Remote inbox returned ${response.status}.`)
      this.db.prepare(`UPDATE deliveries SET status='sent', attempts=attempts+1, last_error=NULL WHERE id=?`).run(row.id)
    } catch (error) {
      const attempts = row.attempts + 1
      const failed = attempts >= 8
      const delayMinutes = Math.min(24 * 60, 2 ** attempts)
      this.db.prepare(`UPDATE deliveries SET status=?, attempts=?, next_attempt_at=?, last_error=? WHERE id=?`).run(
        failed ? 'failed' : 'retry',
        attempts,
        new Date(Date.now() + delayMinutes * 60_000).toISOString(),
        error instanceof Error ? error.message.slice(0, 1000) : 'Unknown delivery error',
        row.id,
      )
      this.log.warn({ deliveryId: row.id, attempts, failed, error }, 'ActivityPub delivery failed')
    }
  }
}
