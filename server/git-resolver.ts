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
}

function safeRepositoryPath(value: unknown, fallback: string) {
  const path = typeof value === 'string' ? value : fallback
  if (!/^\.idea\/[A-Za-z0-9._/-]+\.ya?ml$/.test(path) || path.includes('..')) throw new Error(`Unsafe repository metadata path: ${path}`)
  return path
}

export class GitResolver {
  constructor(
    private config: ServiceConfig,
    private validateUrl: (value: string, config: ServiceConfig) => Promise<URL> = assertFederationUrl,
  ) {}

  async resolve(repository: string, objectFormat: 'sha1' | 'sha256', requestedCommit: string): Promise<ResolvedIdeaState> {
    const url = await this.validateUrl(repository, this.config)
    if (url.protocol !== 'https:' && !(this.config.allowInsecureFederation && url.protocol === 'http:')) {
      throw new Error('Git publication currently supports HTTPS repositories only.')
    }
    await mkdir(this.config.gitCachePath, { recursive: true, mode: 0o700 })
    const cache = join(this.config.gitCachePath, createHash('sha256').update(repository).digest('hex'))
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
    const run = async (args: string[], maxBuffer = 1_000_000) => {
      const result = await runFile('git', args, { env: environment, timeout: this.config.gitTimeoutMs, maxBuffer, encoding: 'utf8' })
      return result.stdout.trim()
    }

    try { await stat(cache) } catch { await run(['init', '--bare', cache]) }
    await run(['-C', cache, 'config', 'remote.origin.url', repository])
    await run(['-C', cache, 'fetch', '--force', '--no-tags', '--depth=1', 'origin', requestedCommit], 4_000_000)
    const commit = await run(['-C', cache, 'rev-parse', '--verify', `${requestedCommit}^{commit}`])
    const detectedFormat = await run(['-C', cache, 'rev-parse', '--show-object-format']) as 'sha1' | 'sha256'
    if (detectedFormat !== objectFormat) throw new Error(`Repository uses ${detectedFormat}, not declared ${objectFormat}.`)
    if (commit !== requestedCommit) throw new Error('Git resolved a different commit than the submitted full object ID.')

    const counts = await run(['-C', cache, 'count-objects', '-v'])
    const packKilobytes = Number(counts.match(/^size-pack:\s*(\d+)$/m)?.[1] ?? 0)
    if (packKilobytes * 1024 > this.config.gitMaxPackBytes) throw new Error('Fetched Git pack exceeds the configured size limit.')

    const show = (path: string) => run(['-C', cache, 'show', `${commit}:${path}`], 512_000)
    const manifestYaml = await show('.idea/manifest.yaml')
    const manifest = parse(manifestYaml) as IdeaManifest
    if (manifest?.spec_version !== '0.1' || typeof manifest.idea?.id !== 'string' || typeof manifest.idea?.name !== 'string') {
      throw new Error('Historical .idea/manifest.yaml is not an IRAP 0.1 idea manifest.')
    }
    new URL(manifest.idea.id)
    if (manifest.repository?.object_format !== objectFormat) throw new Error('Manifest object format differs from the repository.')
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
    }
  }
}
