import { createHash, generateKeyPairSync, sign } from 'node:crypto'
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
import { canonicalize } from '../src/domain/canonicalize'
import { inspectArtifact } from '../server/artifact'

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
    verifyArtifactsOnSubmit: false,
    artifactTimeoutMs: 5_000,
    artifactMaxBytes: 1024 * 1024,
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
    const source256 = join(config.gitCachePath, '..', 'source256')
    const origin256 = join(config.gitCachePath, '..', 'origin256.git')
    mkdirSync(join(source, '.idea'), { recursive: true })
    writeFileSync(join(source, '.idea', 'manifest.yaml'), `spec_version: "0.1"\nidea:\n  id: https://ideas.example/objects/resolved\n  name: Resolved Idea\nrepository:\n  object_format: sha1\n  canonical_ref: refs/heads/main\nverification:\n  verifiers_path: .idea/verifiers.yaml\n  policy_path: .idea/verification-policy.yaml\n`)
    writeFileSync(join(source, '.idea', 'verifiers.yaml'), 'spec_version: "0.1"\nverifiers: []\n')
    writeFileSync(join(source, '.idea', 'verification-policy.yaml'), 'spec_version: "0.1"\nclaims: {}\n')
    execFileSync('git', ['init', '--initial-branch=main', source])
    execFileSync('git', ['-C', source, 'add', '.idea'])
    execFileSync('git', ['-C', source, '-c', 'user.name=IRAP Test', '-c', 'user.email=irap@example.test', 'commit', '-m', 'fixture'])
    const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    execFileSync('git', ['clone', '--bare', source, origin])
    mkdirSync(join(source256, '.idea'), { recursive: true })
    writeFileSync(join(source256, '.idea', 'manifest.yaml'), `spec_version: "0.1"\nidea:\n  id: https://ideas.example/objects/resolved-256\n  name: Resolved SHA-256 Idea\nrepository:\n  object_format: sha256\n  canonical_ref: refs/heads/main\nverification:\n  verifiers_path: .idea/verifiers.yaml\n  policy_path: .idea/verification-policy.yaml\n`)
    writeFileSync(join(source256, '.idea', 'verifiers.yaml'), 'spec_version: "0.1"\nverifiers: []\n')
    writeFileSync(join(source256, '.idea', 'verification-policy.yaml'), 'spec_version: "0.1"\nclaims: {}\n')
    execFileSync('git', ['init', '--object-format=sha256', '--initial-branch=main', source256])
    execFileSync('git', ['-C', source256, 'add', '.idea'])
    execFileSync('git', ['-C', source256, '-c', 'user.name=IRAP Test', '-c', 'user.email=irap@example.test', 'commit', '-m', 'sha256 fixture'])
    const commit256 = execFileSync('git', ['-C', source256, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    execFileSync('git', ['clone', '--bare', source256, origin256])
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
      await expect(resolver.resolve(repository, 'sha256', commit)).rejects.toThrow('full object ID')
      const result256 = await resolver.resolve(`http://127.0.0.1:${address.port}/origin256.git`, 'sha256', 'refs/heads/main')
      expect(result256).toMatchObject({ ideaId: 'https://ideas.example/objects/resolved-256', commit: commit256, objectFormat: 'sha256', sourceRevision: 'refs/heads/main' })
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
})

describe('IRAP registry submission and historical recognition', () => {
  it('freezes a branch, preserves historical policy, and keeps disagreement visible', async () => {
    const config = testConfig()
    config.allowInsecureFederation = true
    config.verifyGitOnPublish = true
    const directory = join(config.gitCachePath, '..')
    const source = join(directory, 'registry-source')
    const origin = join(directory, 'registry-origin.git')
    const alice = generateKeyPairSync('ed25519')
    const bob = generateKeyPairSync('ed25519')
    const rawKey = (key: typeof alice.publicKey) => (key.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64')
    mkdirSync(join(source, '.idea'), { recursive: true })
    writeFileSync(join(source, '.idea', 'manifest.yaml'), `spec_version: "0.1"\nidea:\n  id: https://ideas.example/objects/history\n  name: Historical Idea\nrepository:\n  object_format: sha1\n  canonical_ref: refs/heads/main\nverification:\n  verifiers_path: .idea/verifiers.yaml\n  policy_path: .idea/verification-policy.yaml\n`)
    writeFileSync(join(source, '.idea', 'verifiers.yaml'), `spec_version: "0.1"\nverifiers:\n  - id: https://reviewers.example/alice\n    display_name: Alice\n    keys:\n      - id: alice-key\n        algorithm: Ed25519\n        public_key_base64: ${rawKey(alice.publicKey)}\n  - id: https://reviewers.example/bob\n    display_name: Bob\n    keys:\n      - id: bob-key\n        algorithm: Ed25519\n        public_key_base64: ${rawKey(bob.publicKey)}\n`)
    writeFileSync(join(source, '.idea', 'verification-policy.yaml'), 'spec_version: "0.1"\nclaims:\n  faithful_rendering:\n    recognition:\n      eligible_verifiers:\n        ids: [https://reviewers.example/alice]\n      rule:\n        type: any_one_pass\n')
    execFileSync('git', ['init', '--initial-branch=main', source])
    execFileSync('git', ['-C', source, 'add', '.idea'])
    execFileSync('git', ['-C', source, '-c', 'user.name=IRAP Test', '-c', 'user.email=irap@example.test', 'commit', '-m', 'policy A'])
    const commitA = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    execFileSync('git', ['clone', '--bare', source, origin])

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture.test')
      const child = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: directory,
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
        let status = 200
        for (const header of output.subarray(0, separator).toString('utf8').split('\r\n')) {
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
    const repository = `http://127.0.0.1:${address.port}/registry-origin.git`
    const resolver = new GitResolver(config, async (value) => new URL(value))
    const app = await buildApp(config, { gitResolver: resolver })
    const admin = { authorization: `Bearer ${config.adminToken}` }
    try {
      const idea = await app.inject({
        method: 'POST', url: '/api/ideas', headers: admin,
        payload: {
          slug: 'history', name: 'Historical Idea', summary: 'An idea used to prove historical recognition remains stable.', repository,
          git_commit: { algorithm: 'sha1', value: commitA }, spec_yaml: 'idea:\n  name: Historical Idea\n  version: 1\n',
        },
      })
      expect(idea.statusCode).toBe(201)

      const submitted = await app.inject({
        method: 'POST', url: '/api/v1/renderings', headers: admin,
        payload: {
          idea_slug: 'history', title: 'Historical rendering',
          artifact: { uri: 'https://artifacts.example/history.html', digest: `sha256:${'1'.repeat(64)}` },
          target: { repository, object_format: 'sha1', revision: 'refs/heads/main' },
          creator: { id: 'https://creators.example/alex' },
        },
      })
      expect(submitted.statusCode).toBe(201)
      expect(submitted.json().state).toMatchObject({ commit: commitA, source_revision: 'refs/heads/main' })
      const renderingId = submitted.json().id as string
      const renderingUri = submitted.json().uri as string

      const makeAttestation = (id: string, verifierId: string, keyId: string, privateKey: typeof alice.privateKey, digest = `sha256:${'1'.repeat(64)}`) => {
        const unsigned = {
          irap_version: '0.1',
          attestation: {
            id,
            rendering: { id: renderingUri, artifact_digest: digest },
            against: { idea_id: 'https://ideas.example/objects/history', git: { repository, object_format: 'sha1', commit: commitA } },
            verifier: { id: verifierId, key_id: keyId },
            judgment: { claim: 'faithful_rendering', result: 'pass', note: 'Reviewed against the frozen state.' },
            evidence: [{ uri: 'https://evidence.example/review.txt', digest: `sha256:${'2'.repeat(64)}` }],
            issued_at: '2026-08-29T20:00:00Z',
          },
        }
        return {
          ...unsigned,
          attestation: {
            ...unsigned.attestation,
            signature: {
              algorithm: 'Ed25519', canonicalization: 'RFC8785-JCS',
              value: sign(null, Buffer.from(canonicalize(unsigned)), privateKey).toString('base64url'),
            },
          },
        }
      }
      const aliceAttestation = makeAttestation('https://attestations.example/alice', 'https://reviewers.example/alice', 'alice-key', alice.privateKey)
      const verified = await app.inject({ method: 'POST', url: '/api/v1/attestations/verify', payload: aliceAttestation })
      expect(verified.json()).toMatchObject({ signature_valid: true, recognized: true, recognition_status: 'recognized', policy_commit: commitA })
      const tampered = structuredClone(aliceAttestation)
      tampered.attestation.judgment.note = 'Changed after signing.'
      expect((await app.inject({ method: 'POST', url: '/api/v1/attestations/verify', payload: tampered })).json()).toMatchObject({ signature_valid: false, recognized: false, recognition_status: 'invalid' })
      expect((await app.inject({ method: 'POST', url: '/api/v1/attestations', payload: aliceAttestation })).statusCode).toBe(201)

      const bobAttestation = makeAttestation('https://attestations.example/bob', 'https://reviewers.example/bob', 'bob-key', bob.privateKey)
      const bobResult = await app.inject({ method: 'POST', url: '/api/v1/attestations', payload: bobAttestation })
      expect(bobResult.json().verification).toMatchObject({ signature_valid: true, recognized: false, recognition_status: 'unrecognized' })

      const damaged = makeAttestation('https://attestations.example/damaged', 'https://reviewers.example/alice', 'alice-key', alice.privateKey, `sha256:${'9'.repeat(64)}`)
      expect((await app.inject({ method: 'POST', url: '/api/v1/attestations', payload: damaged })).json().verification).toMatchObject({ recognized: false, recognition_status: 'invalid' })

      writeFileSync(join(source, '.idea', 'verification-policy.yaml'), 'spec_version: "0.1"\nclaims:\n  faithful_rendering:\n    recognition:\n      eligible_verifiers:\n        ids: [https://reviewers.example/bob]\n      rule:\n        type: any_one_pass\n')
      execFileSync('git', ['-C', source, 'add', '.idea/verification-policy.yaml'])
      execFileSync('git', ['-C', source, '-c', 'user.name=IRAP Test', '-c', 'user.email=irap@example.test', 'commit', '-m', 'policy B'])
      execFileSync('git', ['-C', source, 'push', origin, 'main'])

      const detail = (await app.inject({ method: 'GET', url: `/api/v1/renderings/${renderingId}` })).json()
      expect(detail.document.rendering.renders.git.commit).toBe(commitA)
      expect(detail.historical_state.commit).toBe(commitA)
      expect(detail.recognition.faithful_rendering).toMatchObject({ recognized: true, attestation_count: 3 })
      expect(detail.attestations.map((entry: { recognition_status: string }) => entry.recognition_status).sort()).toEqual(['invalid', 'recognized', 'unrecognized'])
      expect((await app.inject({ method: 'GET', url: `/api/v1/ideas/history/states/${commitA}` })).json().verification_policy.claims.faithful_rendering.recognition.eligible_verifiers.ids).toEqual(['https://reviewers.example/alice'])
    } finally {
      await app.close()
      server.close()
      await once(server, 'close')
    }
  })
})

describe('artifact retrieval boundary', () => {
  it('distinguishes verified bytes, mismatches, redirects, and size failures', async () => {
    const config = testConfig()
    config.verifyArtifactsOnSubmit = true
    config.allowInsecureFederation = true
    config.artifactMaxBytes = 32
    const bytes = Buffer.from('canonical artifact bytes')
    const server = createServer((request, response) => {
      if (request.url === '/redirect') return response.writeHead(302, { location: 'http://127.0.0.1/private' }).end()
      if (request.url === '/large') return response.writeHead(200, { 'content-length': '1000' }).end('too large')
      return response.writeHead(200, { 'content-length': String(bytes.length) }).end(bytes)
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to TCP.')
    const base = `http://127.0.0.1:${address.port}`
    const validator = async (value: string) => new URL(value)
    try {
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      await expect(inspectArtifact(`${base}/artifact`, digest, config, validator)).resolves.toMatchObject({ status: 'verified', computed_digest: digest })
      await expect(inspectArtifact(`${base}/artifact`, `sha256:${'0'.repeat(64)}`, config, validator)).resolves.toMatchObject({ status: 'mismatch' })
      await expect(inspectArtifact(`${base}/redirect`, digest, config, validator)).resolves.toMatchObject({ status: 'unverified', reason: expect.stringContaining('redirect') })
      await expect(inspectArtifact(`${base}/large`, digest, config, validator)).resolves.toMatchObject({ status: 'unverified', reason: expect.stringContaining('size limit') })
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
