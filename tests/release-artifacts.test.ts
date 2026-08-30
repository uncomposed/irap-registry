import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { preserveReleaseArtifact } from '../server/release-artifacts'

describe('immutable deployment artifacts', () => {
  it('preserves verified assets and refuses same-commit equivocation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'irap-release-'))
    try {
      const staticPath = join(directory, 'dist')
      const source = join(staticPath, 'release-artifact')
      const asset = Buffer.from('exact deployed bytes')
      const commit = 'a'.repeat(40)
      mkdirSync(join(source, 'site'), { recursive: true })
      writeFileSync(join(source, 'site', 'index.html'), asset)
      const manifest = {
        manifest_version: '1', implementation: { commit },
        assets: [{ path: 'site/index.html', digest: `sha256:${createHash('sha256').update(asset).digest('hex')}` }],
      }
      writeFileSync(join(source, 'deployment-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      const databasePath = join(directory, 'data', 'irap.sqlite')
      const root = preserveReleaseArtifact(staticPath, databasePath)
      expect(readFileSync(join(root, commit, 'site', 'index.html'))).toEqual(asset)

      writeFileSync(join(source, 'deployment-manifest.json'), `${JSON.stringify({ ...manifest, live_url: 'https://changed.example' }, null, 2)}\n`)
      expect(() => preserveReleaseArtifact(staticPath, databasePath)).toThrow('would equivocate')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
