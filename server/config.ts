import { resolve } from 'node:path'

export type ServiceConfig = {
  host: string
  port: number
  publicOrigin: string
  actorName: string
  actorDisplayName: string
  adminToken: string
  databasePath: string
  staticPath: string
  production: boolean
  federationEnabled: boolean
  allowInsecureFederation: boolean
  gitCachePath: string
  verifyGitOnPublish: boolean
  gitTimeoutMs: number
  gitMaxPackBytes: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const production = env.NODE_ENV === 'production'
  const publicOrigin = (env.PUBLIC_ORIGIN ?? 'http://localhost:8787').replace(/\/$/, '')
  const origin = new URL(publicOrigin)
  const adminToken = env.ADMIN_TOKEN ?? 'development-only-change-me'
  const port = Number(env.PORT ?? 8787)
  const gitTimeoutMs = Number(env.GIT_TIMEOUT_MS ?? 60_000)
  const gitMaxPackBytes = Number(env.GIT_MAX_PACK_BYTES ?? 200 * 1024 * 1024)

  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.')
  if (!Number.isInteger(gitTimeoutMs) || gitTimeoutMs < 1_000) throw new Error('GIT_TIMEOUT_MS must be an integer of at least 1000.')
  if (!Number.isInteger(gitMaxPackBytes) || gitMaxPackBytes < 1_048_576) throw new Error('GIT_MAX_PACK_BYTES must be an integer of at least 1048576.')
  if (production && origin.protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must use HTTPS in production.')
  if (production && adminToken.length < 24) throw new Error('ADMIN_TOKEN must contain at least 24 characters in production.')

  return {
    host: env.HOST ?? '0.0.0.0',
    port,
    publicOrigin,
    actorName: env.ACTOR_NAME ?? 'ideas',
    actorDisplayName: env.ACTOR_DISPLAY_NAME ?? 'IRAP Idea Publisher',
    adminToken,
    databasePath: resolve(env.DATABASE_PATH ?? 'data/irap.sqlite'),
    staticPath: resolve(env.STATIC_PATH ?? 'dist'),
    production,
    federationEnabled: env.FEDERATION_ENABLED !== 'false',
    allowInsecureFederation: !production && env.ALLOW_INSECURE_FEDERATION === 'true',
    gitCachePath: resolve(env.GIT_CACHE_PATH ?? 'data/git'),
    verifyGitOnPublish: env.VERIFY_GIT_ON_PUBLISH ? env.VERIFY_GIT_ON_PUBLISH === 'true' : production,
    gitTimeoutMs,
    gitMaxPackBytes,
  }
}

export function serviceUrls(config: ServiceConfig) {
  const actor = `${config.publicOrigin}/ap/actors/${config.actorName}`
  const hostname = new URL(config.publicOrigin).host
  return {
    actor,
    inbox: `${actor}/inbox`,
    outbox: `${actor}/outbox`,
    followers: `${actor}/followers`,
    sharedInbox: `${config.publicOrigin}/ap/inbox`,
    keyId: `${actor}#main-key`,
    handle: `@${config.actorName}@${hostname}`,
  }
}
