import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../server/database'

describe('additive database migration', () => {
  it('backfills a v0.2 verified idea into immutable historical states', () => {
    const directory = mkdtempSync(join(tmpdir(), 'irap-migration-'))
    const path = join(directory, 'legacy.sqlite')
    try {
      const legacy = new Database(path)
      legacy.exec(`CREATE TABLE ideas (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, idea_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, summary TEXT NOT NULL,
        repository TEXT NOT NULL, commit_algorithm TEXT NOT NULL, commit_value TEXT NOT NULL, spec_yaml TEXT NOT NULL,
        git_verified INTEGER NOT NULL DEFAULT 0, manifest_yaml TEXT, verifiers_yaml TEXT, policy_yaml TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`)
      legacy.prepare(`INSERT INTO ideas VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(
        'legacy', 'legacy-idea', 'https://ideas.example/legacy', 'Legacy Idea', 'A verified idea from the previous schema.',
        'https://git.example/legacy.git', 'sha1', 'a'.repeat(40), 'idea: legacy',
        'spec_version: "0.1"', 'spec_version: "0.1"\nverifiers: []', 'spec_version: "0.1"\nclaims: {}',
        '2026-08-29T00:00:00Z', '2026-08-29T01:00:00Z',
      )
      legacy.close()

      const migrated = openDatabase(path)
      const state = migrated.prepare('SELECT * FROM idea_states WHERE idea_id = ?').get('https://ideas.example/legacy') as { commit_value: string; source_revision: string }
      expect(state).toMatchObject({ commit_value: 'a'.repeat(40), source_revision: 'a'.repeat(40) })
      migrated.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
