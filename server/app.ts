import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import rateLimit from '@fastify/rate-limit'
import rawBody from 'fastify-raw-body'
import type { ServiceConfig } from './config.js'
import { openDatabase } from './database.js'
import { FederationService } from './federation.js'
import { registerActivityPub } from './activitypub.js'
import { registerApi } from './api.js'
import { GitResolver } from './git-resolver.js'

export async function buildApp(config: ServiceConfig) {
  const app = Fastify({
    logger: config.production ? true : { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 1_000_000,
    trustProxy: config.production,
    requestIdHeader: 'x-request-id',
  })
  const db = openDatabase(config.databasePath)
  const federation = new FederationService(db, config, app.log)
  const gitResolver = new GitResolver(config)

  await app.register(rawBody, { global: false, encoding: 'utf8', runFirst: true })
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' })
  registerActivityPub(app, config, db, federation)
  registerApi(app, config, db, federation, gitResolver)

  if (existsSync(config.staticPath)) {
    await app.register(fastifyStatic, { root: config.staticPath, wildcard: false })
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && request.headers.accept?.includes('text/html')) return reply.sendFile('index.html')
      return reply.code(404).send({ error: 'Not found.' })
    })
  }

  app.addHook('onReady', async () => federation.start())
  app.addHook('onClose', async () => {
    federation.stop()
    db.close()
  })

  return app
}
