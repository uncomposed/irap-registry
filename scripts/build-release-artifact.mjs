import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const distRoot = join(projectRoot, 'dist')
const releaseRoot = join(distRoot, 'release-artifact')
const target = JSON.parse(await readFile(join(projectRoot, 'rendering-target.json'), 'utf8'))

function implementationCommit() {
  const supplied = process.env.IRAP_IMPLEMENTATION_COMMIT?.trim()
  const value = supplied || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40,64}$/.test(value)) throw new Error('IRAP_IMPLEMENTATION_COMMIT must be a full Git object ID.')
  return value
}

function mediaType(path) {
  return ({ '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' })[extname(path)] ?? 'application/octet-stream'
}

async function filesBeneath(root) {
  const output = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) output.push(...await filesBeneath(path))
    else if (entry.isFile()) output.push(path)
  }
  return output
}

const commit = implementationCommit()
const sourceFiles = [join(distRoot, 'index.html'), ...await filesBeneath(join(distRoot, 'assets'))]
await rm(releaseRoot, { recursive: true, force: true })

const assets = []
for (const source of sourceFiles.sort()) {
  const path = relative(distRoot, source)
  const artifactPath = join('site', path)
  const destination = join(releaseRoot, artifactPath)
  const bytes = await readFile(source)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
  assets.push({
    path: artifactPath,
    uri: `${target.public_origin}/artifacts/${commit}/${artifactPath}`,
    media_type: mediaType(source),
    bytes: (await stat(source)).size,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  })
}

const manifest = {
  manifest_version: '1',
  artifact_type: 'irap-deployment-rendering',
  live_url: target.public_origin,
  idea_name: target.idea_name,
  idea_summary: target.idea_summary,
  protocol_spec_uri: target.protocol_spec_uri,
  implementation: { repository: target.implementation_repository, object_format: 'sha1', commit },
  renders: {
    idea_id: target.idea_id,
    git: { repository: target.protocol_repository, object_format: target.protocol_object_format, commit: target.protocol_commit },
  },
  assets,
}
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(join(releaseRoot, 'deployment-manifest.json'), manifestBytes, { mode: 0o644 })
process.stdout.write(JSON.stringify({
  path: join(releaseRoot, 'deployment-manifest.json'),
  uri: `${target.public_origin}/artifacts/${commit}/deployment-manifest.json`,
  digest: `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`,
}) + '\n')
