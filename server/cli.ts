import { chmod, mkdir } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { parse } from 'yaml'
import { loadConfig } from './config.js'
import { openDatabase, type AttestationRow, type IdeaRow, type IdeaStateRow, type RenderingRow } from './database.js'
import { GitResolver } from './git-resolver.js'
import { attestationDocumentSchema, renderingDocumentSchema } from './irap.js'
import { evaluateAttestation } from './registry-verification.js'
import { randomUUID } from 'node:crypto'

async function main() {
  const config = loadConfig()
  const command = process.argv[2]
  const db = openDatabase(config.databasePath)
  try {
    if (command === 'backup') {
      const dataRoot = dirname(config.databasePath)
      const target = resolve(process.argv[3] ?? `${dataRoot}/backups/irap-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)
      const relation = relative(dataRoot, target)
      if (relation.startsWith('..') || relation === '') throw new Error('Backup target must be a file beneath the configured data directory.')
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await db.backup(target)
      await chmod(target, 0o600)
      process.stdout.write(`${target}\n`)
      return
    }

    if (command === 'verify-all') {
      const rows = db.prepare('SELECT * FROM attestations ORDER BY created_at').all() as AttestationRow[]
      const update = db.prepare('UPDATE attestations SET signature_valid = ?, recognition_status = ?, recognition_reasons_json = ? WHERE id = ?')
      let changed = 0
      for (const row of rows) {
        const rendering = db.prepare('SELECT * FROM renderings WHERE id = ?').get(row.rendering_id) as RenderingRow
        const state = db.prepare('SELECT * FROM idea_states WHERE id = ?').get(rendering.state_id) as IdeaStateRow
        const document = attestationDocumentSchema.parse(JSON.parse(row.raw_attestation_json))
        const renderingDocument = renderingDocumentSchema.parse(JSON.parse(rendering.raw_manifest_json))
        const result = evaluateAttestation(document, rendering, renderingDocument, state)
        const reasons = JSON.stringify(result.recognition_reasons)
        if (row.signature_valid !== Number(result.signature_valid) || row.recognition_status !== result.recognition_status || row.recognition_reasons_json !== reasons) changed += 1
        update.run(Number(result.signature_valid), result.recognition_status, reasons, row.id)
      }
      process.stdout.write(JSON.stringify({ verified: rows.length, changed, raw_records_rewritten: 0 }) + '\n')
      return
    }

    if (command === 'sync') {
      const resolver = new GitResolver(config)
      const ideas = db.prepare('SELECT * FROM ideas WHERE git_verified = 1 ORDER BY created_at').all() as IdeaRow[]
      let advanced = 0
      for (const idea of ideas) {
        const historicalManifest = parse(idea.manifest_yaml ?? '') as { repository?: { canonical_ref?: unknown } }
        if (typeof historicalManifest.repository?.canonical_ref !== 'string') throw new Error(`Idea ${idea.slug} has no canonical ref.`)
        const resolved = await resolver.resolve(idea.repository, idea.commit_algorithm, historicalManifest.repository.canonical_ref)
        if (resolved.ideaId !== idea.idea_id) throw new Error(`Idea identity changed while syncing ${idea.slug}.`)
        const now = new Date().toISOString()
        db.transaction(() => {
          db.prepare(`INSERT OR IGNORE INTO idea_states
            (id, idea_id, repository, object_format, commit_value, source_revision, manifest_yaml, verifiers_yaml, policy_yaml, resolved_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            randomUUID(), resolved.ideaId, idea.repository, resolved.objectFormat, resolved.commit, resolved.sourceRevision,
            resolved.manifestYaml, resolved.verifiersYaml, resolved.policyYaml, now,
          )
          if (resolved.commit !== idea.commit_value) {
            db.prepare(`UPDATE ideas SET commit_value = ?, manifest_yaml = ?, verifiers_yaml = ?, policy_yaml = ?, updated_at = ? WHERE id = ?`).run(
              resolved.commit, resolved.manifestYaml, resolved.verifiersYaml, resolved.policyYaml, now, idea.id,
            )
            advanced += 1
          }
        })()
      }
      process.stdout.write(JSON.stringify({ synced: ideas.length, advanced, historical_rendering_targets_rewritten: 0 }) + '\n')
      return
    }

    throw new Error('Usage: npm run cli -- backup [data-relative-path] | verify-all | sync')
  } finally {
    db.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
