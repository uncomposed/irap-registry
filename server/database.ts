import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

export type IdeaRow = {
  id: string
  slug: string
  idea_id: string
  name: string
  summary: string
  repository: string
  commit_algorithm: 'sha1' | 'sha256'
  commit_value: string
  spec_yaml: string
  git_verified: number
  manifest_yaml: string | null
  verifiers_yaml: string | null
  policy_yaml: string | null
  created_at: string
  updated_at: string
}

export type ActivityRow = {
  id: string
  type: string
  object_id: string | null
  body_json: string
  public: number
  published_at: string
}

export type FollowerRow = {
  actor_id: string
  inbox: string
  shared_inbox: string | null
  created_at: string
}

export type DeliveryRow = {
  id: number
  activity_id: string
  inbox: string
  attempts: number
  next_attempt_at: string
  status: string
  last_error: string | null
}

export type IdeaStateRow = {
  id: string
  idea_id: string
  repository: string
  object_format: 'sha1' | 'sha256'
  commit_value: string
  source_revision: string
  manifest_yaml: string
  verifiers_yaml: string
  policy_yaml: string
  resolved_at: string
}

export type RenderingRow = {
  id: string
  rendering_uri: string
  idea_id: string
  state_id: string
  artifact_uri: string
  artifact_digest: string
  digest_verified: number
  creator_uri: string
  title: string | null
  description: string | null
  submitted_at: string
  raw_manifest_json: string
  status: 'active' | 'withdrawn' | 'unreachable'
}

export type AttestationRow = {
  id: string
  attestation_uri: string
  rendering_id: string
  target_commit: string
  verifier_uri: string
  verifier_key_id: string
  claim: string
  result: 'pass' | 'fail' | 'abstain' | 'indeterminate'
  note: string | null
  issued_at: string
  raw_attestation_json: string
  signature_valid: number
  recognition_status: 'recognized' | 'unrecognized' | 'invalid' | 'indeterminate'
  recognition_reasons_json: string
  created_at: string
}

export function openDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try { chmodSync(dirname(path), 0o700) } catch { /* best effort on non-POSIX filesystems */ }
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ideas (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      idea_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      summary TEXT NOT NULL,
      repository TEXT NOT NULL,
      commit_algorithm TEXT NOT NULL CHECK (commit_algorithm IN ('sha1', 'sha256')),
      commit_value TEXT NOT NULL,
      spec_yaml TEXT NOT NULL,
      git_verified INTEGER NOT NULL DEFAULT 0,
      manifest_yaml TEXT,
      verifiers_yaml TEXT,
      policy_yaml TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      object_id TEXT,
      body_json TEXT NOT NULL,
      public INTEGER NOT NULL DEFAULT 0,
      published_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activities_published ON activities(published_at DESC);
    CREATE TABLE IF NOT EXISTS followers (
      actor_id TEXT PRIMARY KEY,
      inbox TEXT NOT NULL,
      shared_inbox TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inbox_activities (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      type TEXT NOT NULL,
      body_json TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      inbox TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      last_error TEXT,
      UNIQUE(activity_id, inbox)
    );
    CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status, next_attempt_at);
    CREATE TABLE IF NOT EXISTS remote_actors (
      id TEXT PRIMARY KEY,
      inbox TEXT NOT NULL,
      shared_inbox TEXT,
      public_key_id TEXT NOT NULL,
      public_key_pem TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idea_states (
      id TEXT PRIMARY KEY,
      idea_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
      commit_value TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      manifest_yaml TEXT NOT NULL,
      verifiers_yaml TEXT NOT NULL,
      policy_yaml TEXT NOT NULL,
      resolved_at TEXT NOT NULL,
      UNIQUE(repository, commit_value)
    );
    CREATE INDEX IF NOT EXISTS idea_states_idea ON idea_states(idea_id, resolved_at DESC);
    CREATE TABLE IF NOT EXISTS renderings (
      id TEXT PRIMARY KEY,
      rendering_uri TEXT NOT NULL UNIQUE,
      idea_id TEXT NOT NULL,
      state_id TEXT NOT NULL REFERENCES idea_states(id),
      artifact_uri TEXT NOT NULL,
      artifact_digest TEXT NOT NULL,
      digest_verified INTEGER NOT NULL DEFAULT 0,
      creator_uri TEXT NOT NULL,
      title TEXT,
      description TEXT,
      submitted_at TEXT NOT NULL,
      raw_manifest_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'unreachable'))
    );
    CREATE INDEX IF NOT EXISTS renderings_idea ON renderings(idea_id, submitted_at DESC);
    CREATE TABLE IF NOT EXISTS attestations (
      id TEXT PRIMARY KEY,
      attestation_uri TEXT NOT NULL UNIQUE,
      rendering_id TEXT NOT NULL REFERENCES renderings(id),
      target_commit TEXT NOT NULL,
      verifier_uri TEXT NOT NULL,
      verifier_key_id TEXT NOT NULL,
      claim TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'abstain', 'indeterminate')),
      note TEXT,
      issued_at TEXT NOT NULL,
      raw_attestation_json TEXT NOT NULL,
      signature_valid INTEGER NOT NULL,
      recognition_status TEXT NOT NULL CHECK (recognition_status IN ('recognized', 'unrecognized', 'invalid', 'indeterminate')),
      recognition_reasons_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attestations_rendering ON attestations(rendering_id, issued_at DESC);
  `)
  ensureColumn(db, 'ideas', 'git_verified', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'ideas', 'manifest_yaml', 'TEXT')
  ensureColumn(db, 'ideas', 'verifiers_yaml', 'TEXT')
  ensureColumn(db, 'ideas', 'policy_yaml', 'TEXT')
  backfillIdeaStates(db)
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
  ensureActorKeys(db)
  return db
}

function backfillIdeaStates(db: Database.Database) {
  const rows = db.prepare(`SELECT * FROM ideas WHERE git_verified = 1 AND manifest_yaml IS NOT NULL AND verifiers_yaml IS NOT NULL AND policy_yaml IS NOT NULL`).all() as IdeaRow[]
  const insert = db.prepare(`INSERT OR IGNORE INTO idea_states
    (id, idea_id, repository, object_format, commit_value, source_revision, manifest_yaml, verifiers_yaml, policy_yaml, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  db.transaction(() => {
    for (const row of rows) insert.run(
      randomUUID(), row.idea_id, row.repository, row.commit_algorithm, row.commit_value, row.commit_value,
      row.manifest_yaml, row.verifiers_yaml, row.policy_yaml, row.updated_at,
    )
  })()
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

function ensureActorKeys(db: Database.Database) {
  const get = db.prepare('SELECT value FROM meta WHERE key = ?')
  if (get.get('actor_private_key')) return
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
  db.transaction(() => {
    insert.run('actor_private_key', privateKey)
    insert.run('actor_public_key', publicKey)
  })()
}

export function metaValue(db: Database.Database, key: string) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) throw new Error(`Missing database metadata: ${key}`)
  return row.value
}
