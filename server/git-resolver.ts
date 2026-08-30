import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import type { ServiceConfig } from './config.js'
import { assertFederationUrl } from './federation.js'

const runFile = promisify(execFile)

type IdeaManifest = {
  spec_version?: unknown
  idea?: { id?: unknown; name?: unknown }
  repository?: { object_format?: unknown; canonical_ref?: unknown }
  verification?: { verifiers_path?: unknown; policy_path?: unknown }
}

export type ResolvedIdeaState = {
  ideaId: string
  ideaName: string
  commit: string
  objectFormat: 'sha1' | 'sha256'
  manifestYaml: string
  verifiersYaml: string
  policyYaml: string
  canonicalRef: string
  sourceRevision: string
}

export type ResolvedRepositoryFiles = {
  commit: string
  objectFormat: 'sha1' | 'sha256'
  sourceRevision: string
  files: Record<string, string>
}

function safeRepositoryPath(value: unknown, fallback: string) {
  const path = typeof value === 'string' ? value : fallback
  if (!/^\.idea\/[A-Za-z0-9._/-]+\.ya?ml$/.test(path) || path.includes('..')) throw new Error(`Unsafe repository metadata path: ${path}`)
  return path
}

function safeRevision(value: string, objectFormat: 'sha1' | 'sha256') {
  const fullObject = objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/
  if (fullObject.test(value)) return value
  if (!/^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/.test(value)) throw new Error('Git target must be a full object ID or a full heads/tags ref.')
  if (value.includes('..') || value.includes('//') || value.includes('@{') || value.endsWith('.') || value.endsWith('/') || value.endsWith('.lock')) {
    throw new Error('Git target contains an unsafe ref name.')
  }
  return value
}

function safeContentPath(value: string) {
  const segments = value.split('/')
  if (value.length < 1 || value.length > 240 || value.startsWith('/') || value.includes('\\') || value.includes('\0') ||
      !/^[A-Za-z0-9._/-]+$/.test(value) || segments.some((segment) => !segment || segment === '.' || segment === '..') || segments[0] === '.git') {
    throw new Error(`Unsafe repository content path: ${value}`)
  }
  return value
}

export class GitResolver {
  private cacheQueues = new Map<string, Promise<void>>()

  constructor(
    private config: ServiceConfig,
    private validateUrl: (value: string, config: ServiceConfig) => Promise<URL> = assertFederationUrl,
  ) {}

  private async withCacheLock<T>(cache: string, work: () => Promise<T>) {
    const previous = this.cacheQueues.get(cache) ?? Promise.resolve()
    let release = () => {}
    const turn = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.then(() => turn)
    this.cacheQueues.set(cache, queued)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (this.cacheQueues.get(cache) === queued) this.cacheQueues.delete(cache)
    }
  }

  private async withCommit<T>(
    repository: string,
    objectFormat: 'sha1' | 'sha256',
    requestedRevision: string,
    work: (input: {
      commit: string
      objectFormat: 'sha1' | 'sha256'
      sourceRevision: string
      show: (path: string, maxBuffer?: number) => Promise<string>
    }) => Promise<T>,
  ): Promise<T> {
    const url = await this.validateUrl(repository, this.config)
    if (url.protocol !== 'https:' && !(this.config.allowInsecureFederation && url.protocol === 'http:')) {
      throw new Error('Git publication currently supports HTTPS repositories only.')
    }
    await mkdir(this.config.gitCachePath, { recursive: true, mode: 0o700 })
    const cache = join(this.config.gitCachePath, createHash('sha256').update(repository).digest('hex'))
    const revision = safeRevision(requestedRevision, objectFormat)
    const environment = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'never',
      GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
      GIT_CONFIG_KEY_2: 'http.followRedirects', GIT_CONFIG_VALUE_2: 'false',
      GIT_CONFIG_KEY_3: 'fetch.fsckObjects', GIT_CONFIG_VALUE_3: 'true',
      GIT_CONFIG_KEY_4: 'transfer.fsckObjects', GIT_CONFIG_VALUE_4: 'true',
    }
    return this.withCacheLock(cache, async () => {
      const run = async (args: string[], maxBuffer = 1_000_000) => {
        const result = await runFile('git', args, { env: environment, timeout: this.config.gitTimeoutMs, maxBuffer, encoding: 'utf8' })
        return result.stdout.trim()
      }

      try { await stat(cache) } catch { await run(['init', '--bare', `--object-format=${objectFormat}`, cache]) }
      await run(['-C', cache, 'config', 'remote.origin.url', repository])
      await run(['-C', cache, 'fetch', '--force', '--no-tags', '--depth=1', 'origin', revision], 4_000_000)
      const commit = await run(['-C', cache, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
      const detectedFormat = await run(['-C', cache, 'rev-parse', '--show-object-format']) as 'sha1' | 'sha256'
      if (detectedFormat !== objectFormat) throw new Error(`Repository uses ${detectedFormat}, not declared ${objectFormat}.`)
      if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(revision) && commit !== revision) throw new Error('Git resolved a different commit than the submitted full object ID.')

      const counts = await run(['-C', cache, 'count-objects', '-v'])
      const packKilobytes = Number(counts.match(/^size-pack:\s*(\d+)$/m)?.[1] ?? 0)
      if (packKilobytes * 1024 > this.config.gitMaxPackBytes) throw new Error('Fetched Git pack exceeds the configured size limit.')

      const show = (path: string, maxBuffer = 512_000) => run(['-C', cache, 'show', `${commit}:${safeContentPath(path)}`], maxBuffer)
      return work({ commit, objectFormat: detectedFormat, sourceRevision: revision, show })
    })
  }

  async resolve(repository: string, objectFormat: 'sha1' | 'sha256', requestedRevision: string): Promise<ResolvedIdeaState> {
    return this.withCommit(repository, objectFormat, requestedRevision, async ({ commit, objectFormat: detectedFormat, sourceRevision, show }) => {
      const manifestYaml = await show('.idea/manifest.yaml')
      const manifest = parse(manifestYaml) as IdeaManifest
      if (manifest?.spec_version !== '0.1' || typeof manifest.idea?.id !== 'string' || typeof manifest.idea?.name !== 'string') {
        throw new Error('Historical .idea/manifest.yaml is not an IRAP 0.1 idea manifest.')
      }
      new URL(manifest.idea.id)
      if (manifest.repository?.object_format !== objectFormat) throw new Error('Manifest object format differs from the repository.')
      if (typeof manifest.repository?.canonical_ref !== 'string') throw new Error('Historical manifest does not define repository.canonical_ref.')
      const verifiersPath = safeRepositoryPath(manifest.verification?.verifiers_path, '.idea/verifiers.yaml')
      const policyPath = safeRepositoryPath(manifest.verification?.policy_path, '.idea/verification-policy.yaml')
      const [verifiersYaml, policyYaml] = await Promise.all([show(verifiersPath), show(policyPath)])
      parse(verifiersYaml)
      parse(policyYaml)
      return {
        ideaId: manifest.idea.id,
        ideaName: manifest.idea.name,
        commit,
        objectFormat: detectedFormat,
        manifestYaml,
        verifiersYaml,
        policyYaml,
        canonicalRef: manifest.repository.canonical_ref,
        sourceRevision,
      }
    })
  }

  async readFiles(
    repository: string,
    objectFormat: 'sha1' | 'sha256',
    requestedRevision: string,
    paths: string[],
  ): Promise<ResolvedRepositoryFiles> {
    if (paths.length < 1 || paths.length > 100) throw new Error('Repository file reads require between 1 and 100 paths.')
    const safePaths = paths.map(safeContentPath)
    if (new Set(safePaths).size !== safePaths.length) throw new Error('Repository file reads must not contain duplicate paths.')
    return this.withCommit(repository, objectFormat, requestedRevision, async ({ commit, objectFormat: detectedFormat, sourceRevision, show }) => {
      const contents = await Promise.all(safePaths.map(async (path) => [path, await show(path)] as const))
      return { commit, objectFormat: detectedFormat, sourceRevision, files: Object.fromEntries(contents) }
    })
  }
}
