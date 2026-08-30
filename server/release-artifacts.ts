import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

type ReleaseManifest = {
  manifest_version?: unknown
  implementation?: { commit?: unknown }
  assets?: Array<{ path?: unknown; digest?: unknown }>
}

function parseManifest(path: string) {
  const bytes = readFileSync(path)
  const manifest = JSON.parse(bytes.toString('utf8')) as ReleaseManifest
  const commit = manifest.implementation?.commit
  if (manifest.manifest_version !== '1' || typeof commit !== 'string' || !/^[0-9a-f]{40,64}$/.test(commit) || !Array.isArray(manifest.assets)) {
    throw new Error('Release artifact manifest is malformed.')
  }
  return { bytes, manifest, commit }
}

function verifyReleaseDirectory(root: string, manifest: ReleaseManifest) {
  for (const asset of manifest.assets ?? []) {
    if (typeof asset.path !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(asset.path) || asset.path.includes('..')) {
      throw new Error('Release artifact manifest contains an unsafe asset path.')
    }
    if (typeof asset.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(asset.digest)) {
      throw new Error('Release artifact manifest contains an invalid digest.')
    }
    const actual = `sha256:${createHash('sha256').update(readFileSync(join(root, asset.path))).digest('hex')}`
    if (actual !== asset.digest) throw new Error(`Release artifact digest mismatch: ${asset.path}`)
  }
}

export function preserveReleaseArtifact(staticPath: string, databasePath: string) {
  const source = join(staticPath, 'release-artifact')
  const sourceManifestPath = join(source, 'deployment-manifest.json')
  const artifactRoot = join(dirname(databasePath), 'artifacts')
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 })
  if (!existsSync(sourceManifestPath)) return artifactRoot

  const parsed = parseManifest(sourceManifestPath)
  verifyReleaseDirectory(source, parsed.manifest)
  const destination = join(artifactRoot, parsed.commit)
  const destinationManifestPath = join(destination, 'deployment-manifest.json')
  if (existsSync(destinationManifestPath)) {
    const existing = parseManifest(destinationManifestPath)
    if (!existing.bytes.equals(parsed.bytes)) throw new Error(`Release artifact ${parsed.commit} would equivocate with preserved bytes.`)
    verifyReleaseDirectory(destination, existing.manifest)
    return artifactRoot
  }

  const temporary = join(artifactRoot, `.install-${parsed.commit}-${randomUUID()}`)
  cpSync(source, temporary, { recursive: true, errorOnExist: true })
  verifyReleaseDirectory(temporary, parsed.manifest)
  renameSync(temporary, destination)
  return artifactRoot
}
