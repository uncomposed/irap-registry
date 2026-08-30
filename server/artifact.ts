import { createHash } from 'node:crypto'
import type { ServiceConfig } from './config.js'
import { assertFederationUrl } from './federation.js'

export type ArtifactInspection = {
  status: 'verified' | 'mismatch' | 'unverified'
  computed_digest?: string
  reason?: string
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
