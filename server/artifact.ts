import { createHash } from 'node:crypto'
import type { ServiceConfig } from './config.js'
import { assertFederationUrl } from './federation.js'

export type ArtifactInspection = {
  status: 'verified' | 'mismatch' | 'unverified'
  computed_digest?: string
  reason?: string
}

export type ArtifactExperience = {
  uri: string
  source: 'live' | 'repository'
}

const experienceKeys = [
  'live_uri',
  'live_url',
  'entry_uri',
  'entry_url',
  'access_uri',
  'access_url',
  'human_uri',
  'human_url',
  'planned_human_uri',
] as const

const experienceCache = new Map<string, { value: ArtifactExperience | null; expiresAt: number }>()

function findStringByKey(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null
  if (!Array.isArray(value)) {
    const object = value as Record<string, unknown>
    if (typeof object[key] === 'string') return object[key]
    for (const child of Object.values(object)) {
      const found = findStringByKey(child, key)
      if (found) return found
    }
    return null
  }
  for (const child of value) {
    const found = findStringByKey(child, key)
    if (found) return found
  }
  return null
}

function publicHttpUri(value: unknown, config: ServiceConfig) {
  if (typeof value !== 'string') return null
  try {
    const uri = new URL(value)
    if (uri.username || uri.password) return null
    if (uri.protocol === 'https:' || (!config.production && uri.protocol === 'http:')) return uri.toString()
  } catch { /* not a URL */ }
  return null
}

function repositoryFallback(document: unknown, config: ServiceConfig) {
  const repositoryUri = (value: unknown) => {
    const uri = publicHttpUri(value, config)
    if (!uri) return null
    const parsed = new URL(uri)
    if (['github.com', 'gitlab.com', 'codeberg.org'].includes(parsed.hostname) && parsed.pathname.endsWith('.git')) {
      parsed.pathname = parsed.pathname.slice(0, -4)
      return parsed.toString()
    }
    return uri
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null
  const root = document as Record<string, unknown>
  const source = root.source
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    return repositoryUri((source as Record<string, unknown>).repository)
  }
  const rendering = root.rendering
  if (rendering && typeof rendering === 'object' && !Array.isArray(rendering)) {
    const nestedSource = (rendering as Record<string, unknown>).source
    if (nestedSource && typeof nestedSource === 'object' && !Array.isArray(nestedSource)) {
      return repositoryUri((nestedSource as Record<string, unknown>).repository)
    }
  }
  return null
}

function experienceFromDocument(document: unknown, artifactUri: string, config: ServiceConfig): ArtifactExperience | null {
  for (const key of experienceKeys) {
    const uri = publicHttpUri(findStringByKey(document, key), config)
    if (uri && uri !== artifactUri) return { uri, source: 'live' }
  }
  if (document && typeof document === 'object' && !Array.isArray(document)) {
    const root = document as Record<string, unknown>
    for (const candidate of [root.url, (root.product as Record<string, unknown> | undefined)?.url, (root.rendering as Record<string, unknown> | undefined)?.url]) {
      const uri = publicHttpUri(candidate, config)
      if (uri && uri !== artifactUri) return { uri, source: 'live' }
    }
  }
  const repository = repositoryFallback(document, config)
  return repository && repository !== artifactUri ? { uri: repository, source: 'repository' } : null
}

export async function discoverArtifactExperience(
  artifactUri: string,
  declaredDigest: string,
  config: ServiceConfig,
  validateUrl: (value: string, config: ServiceConfig) => Promise<URL> = assertFederationUrl,
  fetchImplementation: typeof fetch = fetch,
): Promise<ArtifactExperience | null> {
  const cacheKey = `${artifactUri}\n${declaredDigest}`
  const useCache = validateUrl === assertFederationUrl && fetchImplementation === fetch
  const cached = useCache ? experienceCache.get(cacheKey) : undefined
  if (cached && cached.expiresAt > Date.now()) return cached.value

  let value: ArtifactExperience | null = null
  try {
    await validateUrl(artifactUri, config)
    const response = await fetchImplementation(artifactUri, {
      method: 'GET',
      headers: { accept: 'application/json, application/*+json, text/json;q=0.9, */*;q=0.1', 'user-agent': 'IRAP-Registry/0.6 experience-resolver' },
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.min(config.artifactTimeoutMs, 5_000)),
    })
    if (!response.ok || !response.body || (response.status >= 300 && response.status < 400)) throw new Error('Artifact manifest is unavailable.')
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > config.artifactMaxBytes) throw new Error('Artifact manifest is too large.')
    const reader = response.body.getReader()
    const hash = createHash('sha256')
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      total += chunk.byteLength
      if (total > config.artifactMaxBytes) {
        await reader.cancel()
        throw new Error('Artifact manifest exceeded the fetch-size limit.')
      }
      hash.update(chunk)
      chunks.push(chunk)
    }
    if (`sha256:${hash.digest('hex')}` !== declaredDigest) throw new Error('Artifact manifest digest changed.')
    const document = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    value = experienceFromDocument(document, artifactUri, config)
  } catch { /* A missing experience never prevents the rendering record from loading. */ }

  if (useCache) experienceCache.set(cacheKey, { value, expiresAt: Date.now() + (value ? 24 * 60 * 60_000 : 60_000) })
  return value
}

export async function inspectArtifact(
  uri: string,
  declaredDigest: string,
  config: ServiceConfig,
  validateUrl: (value: string, config: ServiceConfig) => Promise<URL> = assertFederationUrl,
  fetchImplementation: typeof fetch = fetch,
): Promise<ArtifactInspection> {
  if (!config.verifyArtifactsOnSubmit) return { status: 'unverified', reason: 'Artifact fetching is disabled in this environment.' }
  try {
    await validateUrl(uri, config)
    const response = await fetchImplementation(uri, {
      method: 'GET',
      headers: { accept: '*/*', 'user-agent': 'IRAP-Registry/0.5 artifact-verifier' },
      redirect: 'manual',
      signal: AbortSignal.timeout(config.artifactTimeoutMs),
    })
    if (response.status >= 300 && response.status < 400) return { status: 'unverified', reason: 'Artifact redirects are rejected to prevent SSRF bypass.' }
    if (!response.ok || !response.body) return { status: 'unverified', reason: `Artifact server returned ${response.status}.` }
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > config.artifactMaxBytes) return { status: 'unverified', reason: 'Artifact exceeds the configured fetch-size limit.' }
    const reader = response.body.getReader()
    const hash = createHash('sha256')
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > config.artifactMaxBytes) {
        await reader.cancel()
        return { status: 'unverified', reason: 'Artifact exceeded the configured fetch-size limit while streaming.' }
      }
      hash.update(value)
    }
    const computedDigest = `sha256:${hash.digest('hex')}`
    return computedDigest === declaredDigest
      ? { status: 'verified', computed_digest: computedDigest }
      : { status: 'mismatch', computed_digest: computedDigest, reason: 'Fetched artifact bytes do not match the submitted digest.' }
  } catch (error) {
    return { status: 'unverified', reason: error instanceof Error ? error.message : 'Artifact could not be fetched safely.' }
  }
}
