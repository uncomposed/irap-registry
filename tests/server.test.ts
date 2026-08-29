import { generateKeyPairSync } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../server/app'
import type { ServiceConfig } from '../server/config'
import { createSignedPostHeaders, verifySignedPost } from '../server/http-signatures'
import { GitResolver } from '../server/git-resolver'

const cleanup: string[] = []

function testConfig(): ServiceConfig {
  const directory = mkdtempSync(join(tmpdir(), 'irap-server-'))
  cleanup.push(directory)
  return {
    host: '127.0.0.1',
    port: 0,
    publicOrigin: 'https://publisher.example',
    actorName: 'ideas',
    actorDisplayName: 'Test Idea Publisher',
    adminToken: 'test-administrator-token-long-enough',
    databasePath: join(directory, 'irap.sqlite'),
    staticPath: join(directory, 'missing-dist'),
    production: false,
    federationEnabled: false,
    allowInsecureFederation: false,
    gitCachePath: join(directory, 'git'),
    verifyGitOnPublish: false,
    gitTimeoutMs: 10_000,
    gitMaxPackBytes: 10 * 1024 * 1024,
  }
}

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('ActivityPub discovery and publication', () => {
  it('exposes WebFinger, actor keys, and an outbox', async () => {
    const app = await buildApp(testConfig())
    const webfinger = await app.inject({ method: 'GET', url: '/.well-known/webfinger?resource=acct%3Aideas%40publisher.example' })
    expect(webfinger.statusCode).toBe(200)
    expect(webfinger.json().links[0].href).toBe('https://publisher.example/ap/actors/ideas')

    const actor = await app.inject({ method: 'GET', url: '/ap/actors/ideas', headers: { accept: 'application/activity+json' } })
    expect(actor.statusCode).toBe(200)
    expect(actor.json().type).toBe('Application')
    expect(actor.json().publicKey.publicKeyPem).toContain('BEGIN PUBLIC KEY')

    const outbox = await app.inject({ method: 'GET', url: '/ap/actors/ideas/outbox' })
    expect(outbox.json()).toMatchObject({ type: 'OrderedCollection', totalItems: 0 })
    expect((await app.inject({ method: 'GET', url: '/api/v1/ideas' })).json()).toEqual({ items: [] })
    await app.close()
  })

  it('preserves the actor cryptographic identity across restarts', async () => {
    const config = testConfig()
    const first = await buildApp(config)
    const firstKey = (await first.inject({ method: 'GET', url: '/ap/actors/ideas' })).json().publicKey.publicKeyPem
    await first.close()
    const second = await buildApp(config)
    const secondKey = (await second.inject({ method: 'GET', url: '/ap/actors/ideas' })).json().publicKey.publicKeyPem
    expect(secondKey).toBe(firstKey)
    await second.close()
  })

  it('publishes an exact Git state and announces it in the public outbox', async () => {
    const config = testConfig()
    const app = await buildApp(config)
    const input = {
      slug: 'public-reasoning',
      name: 'Public Reasoning',
      summary: 'A proposal for making attributed reasoning inspectable over time.',
      repository: 'https://git.example/public-reasoning.git',
      git_commit: { algorithm: 'sha1', value: 'a'.repeat(40) },
      spec_yaml: 'idea:\n  name: Public Reasoning\n  version: 1\n',
    }
    const unauthorized = await app.inject({ method: 'POST', url: '/api/ideas', payload: input })
    expect(unauthorized.statusCode).toBe(401)

    const published = await app.inject({
      method: 'POST', url: '/api/ideas', headers: { authorization: `Bearer ${config.adminToken}` }, payload: input,
    })
    expect(published.statusCode).toBe(201)
    expect(published.headers.location).toBe('https://publisher.example/ap/objects/ideas/public-reasoning')
    expect(published.json().idea.git_commit.value).toBe('a'.repeat(40))

    const object = await app.inject({ method: 'GET', url: '/ap/objects/ideas/public-reasoning' })
    expect(object.json()).toMatchObject({ type: 'Document', gitCommit: 'a'.repeat(40), gitObjectFormat: 'sha1' })

    const outbox = await app.inject({ method: 'GET', url: '/ap/actors/ideas/outbox?page=true' })
    expect(outbox.json().orderedItems[0]).toMatchObject({ type: 'Create', actor: 'https://publisher.example/ap/actors/ideas' })
    await app.close()
  })

  it('rejects short commit IDs and duplicate slugs', async () => {
    const config = testConfig()
    const app = await buildApp(config)
    const base = {
      slug: 'audit-me', name: 'Audit Me', summary: 'A sufficiently descriptive summary for validation.',
      repository: 'https://git.example/audit.git', spec_yaml: 'idea:\n  name: Audit Me\n',
    }
    const invalid = await app.inject({
      method: 'POST', url: '/api/ideas', headers: { authorization: `Bearer ${config.adminToken}` },
      payload: { ...base, git_commit: { algorithm: 'sha1', value: 'abc1234' } },
    })
    expect(invalid.statusCode).toBe(400)
    const validPayload = { ...base, git_commit: { algorithm: 'sha1', value: 'b'.repeat(40) } }
    expect((await app.inject({ method: 'POST', url: '/api/ideas', headers: { authorization: `Bearer ${config.adminToken}` }, payload: validPayload })).statusCode).toBe(201)
    expect((await app.inject({ method: 'POST', url: '/api/ideas', headers: { authorization: `Bearer ${config.adminToken}` }, payload: validPayload })).statusCode).toBe(409)
    await app.close()
  })
})

describe('historical Git resolution', () => {
  it('fetches an exact commit and reads IRAP metadata from that state', async () => {
    const config = testConfig()
    config.allowInsecureFederation = true
    const source = join(config.gitCachePath, '..', 'source')
    const origin = join(config.gitCachePath, '..', 'origin.git')
    mkdirSync(join(source, '.idea'), { recursive: true })
    writeFileSync(join(source, '.idea', 'manifest.yaml'), `spec_version: "0.1"\nidea:\n  id: https://ideas.example/objects/resolved\n  name: Resolved Idea\nrepository:\n  object_format: sha1\n  canonical_ref: refs/heads/main\nverification:\n  verifiers_path: .idea/verifiers.yaml\n  policy_path: .idea/verification-policy.yaml\n`)
    writeFileSync(join(source, '.idea', 'verifiers.yaml'), 'spec_version: "0.1"\nverifiers: []\n')
    writeFileSync(join(source, '.idea', 'verification-policy.yaml'), 'spec_version: "0.1"\nclaims: {}\n')
    execFileSync('git', ['init', '--initial-branch=main', source])
    execFileSync('git', ['-C', source, 'add', '.idea'])
    execFileSync('git', ['-C', source, '-c', 'user.name=IRAP Test', '-c', 'user.email=irap@example.test', 'commit', '-m', 'fixture'])
    const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    execFileSync('git', ['clone', '--bare', source, origin])
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture.test')
      const child = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: join(config.gitCachePath, '..'),
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method ?? 'GET',
          CONTENT_TYPE: request.headers['content-type'] ?? '',
          CONTENT_LENGTH: request.headers['content-length'] ?? '',
        },
      })
      const chunks: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.on('close', () => {
        const output = Buffer.concat(chunks)
        const separator = output.indexOf('\r\n\r\n')
        if (separator < 0) return response.writeHead(500).end()
        const headers = output.subarray(0, separator).toString('utf8').split('\r\n')
        let status = 200
        for (const header of headers) {
          const colon = header.indexOf(':')
          if (colon < 0) continue
          const name = header.slice(0, colon)
          const value = header.slice(colon + 1).trim()
          if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0])
          else response.setHeader(name, value)
        }
        response.writeHead(status).end(output.subarray(separator + 4))
      })
      request.pipe(child.stdin)
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to TCP.')
    try {
      const repository = `http://127.0.0.1:${address.port}/origin.git`
      const resolver = new GitResolver(config, async (value) => new URL(value))
      const result = await resolver.resolve(repository, 'sha1', commit)
      expect(result).toMatchObject({ ideaId: 'https://ideas.example/objects/resolved', ideaName: 'Resolved Idea', commit, objectFormat: 'sha1' })
      expect(result.verifiersYaml).toContain('verifiers: []')
      await expect(resolver.resolve(repository, 'sha256', commit)).rejects.toThrow('not declared sha256')
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
})

describe('legacy ActivityPub HTTP signatures', () => {
  it('verifies the request target, host, date, digest, and content type', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const body = JSON.stringify({ id: 'https://remote.example/activity/1', type: 'Follow' })
    const keyId = 'https://remote.example/actor#main-key'
    const headers = createSignedPostHeaders('https://publisher.example/ap/inbox', body, keyId, privateKey)
    const resolved = await verifySignedPost({ method: 'POST', path: '/ap/inbox', headers, body }, async () => ({
      id: keyId, owner: 'https://remote.example/actor', publicKeyPem: publicKey,
    }))
    expect(resolved.owner).toBe('https://remote.example/actor')
    await expect(verifySignedPost({ method: 'POST', path: '/ap/inbox', headers, body: `${body} ` }, async () => ({
      id: keyId, owner: 'https://remote.example/actor', publicKeyPem: publicKey,
    }))).rejects.toThrow('digest')
  })
})
