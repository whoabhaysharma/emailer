import { mkdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { dirname } from "node:path"
import { dbFile, DATA } from "./paths.js"

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  daily_limit INTEGER DEFAULT 40,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  email TEXT PRIMARY KEY,
  name TEXT,
  company TEXT,
  title TEXT,
  tags TEXT,
  source TEXT,
  status TEXT DEFAULT 'active',
  consent_at TEXT,
  not_before TEXT,
  first_seen_at TEXT,
  last_contacted_at TEXT,
  notes TEXT,
  vars TEXT
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  subject TEXT,
  contact_email TEXT,
  gmail_thread_id TEXT,
  status TEXT DEFAULT 'open',
  unread INTEGER DEFAULT 0,
  last_message_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  thread_id TEXT,
  direction TEXT NOT NULL,
  rfc_message_id TEXT,
  in_reply_to TEXT,
  refs TEXT,
  from_addr TEXT,
  to_addr TEXT,
  cc TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  snippet TEXT,
  folder TEXT,
  imap_uid INTEGER,
  gmail_thread_id TEXT,
  sent_at TEXT,
  received_at TEXT,
  created_at TEXT NOT NULL,
  needs_triage INTEGER DEFAULT 0,
  triage_intent TEXT,
  triage_json TEXT,
  campaign_id TEXT,
  enrolment_id TEXT,
  step INTEGER,
  bulk INTEGER DEFAULT 0,
  status TEXT
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  thread_id TEXT,
  to_addr TEXT,
  cc TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  in_reply_to TEXT,
  refs TEXT,
  rfc_message_id TEXT,
  gmail_uid INTEGER,
  mailbox TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_id TEXT,
  mode TEXT DEFAULT 'draft',
  status TEXT DEFAULT 'draft',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS campaign_steps (
  campaign_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  delay_days INTEGER DEFAULT 0,
  subject TEXT,
  body TEXT,
  html TEXT,
  PRIMARY KEY (campaign_id, position)
);

CREATE TABLE IF NOT EXISTS enrolments (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  step_position INTEGER DEFAULT 0,
  state TEXT DEFAULT 'active',
  next_run_at TEXT,
  last_message_id TEXT,
  thread_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE (campaign_id, contact_email)
);

CREATE TABLE IF NOT EXISTS suppressions (
  email TEXT PRIMARY KEY,
  reason TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  account_id TEXT,
  message_id TEXT,
  email TEXT,
  data TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  account_id TEXT NOT NULL,
  path TEXT NOT NULL,
  uid_validity TEXT,
  uid_next INTEGER DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (account_id, path)
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_rfc ON messages (rfc_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_account_created ON messages (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages (to_addr);
CREATE INDEX IF NOT EXISTS idx_enrolments_due ON enrolments (state, next_run_at);
CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at);
`

/** Additive migrations for databases created by older versions. */
function migrate(db) {
  const columns = (table) => {
    try {
      return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
    } catch {
      return []
    }
  }
  const add = (table, column, definition) => {
    if (!columns(table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  add("contacts", "not_before", "TEXT")
  add("contacts", "vars", "TEXT")
  add("messages", "step", "INTEGER")
  add("messages", "bulk", "INTEGER DEFAULT 0")
  add("enrolments", "thread_id", "TEXT")
  add("drafts", "cc", "TEXT")
}

function normalizeParam(value) {  if (value === undefined) return null
  if (typeof value === "boolean") return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  return value
}

export function openStore(file = dbFile) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  migrate(db)

  const api = {
    raw: db,
    exec: (sql) => db.exec(sql),
    run(sql, ...params) {
      return db.prepare(sql).run(...params.map(normalizeParam))
    },
    get(sql, ...params) {
      return db.prepare(sql).get(...params.map(normalizeParam))
    },
    all(sql, ...params) {
      return db.prepare(sql).all(...params.map(normalizeParam))
    },
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE")
      try {
        const result = fn()
        db.exec("COMMIT")
        return result
      } catch (error) {
        try {
          db.exec("ROLLBACK")
        } catch {}
        throw error
      }
    },
    close() {
      try {
        db.close()
      } catch {}
    },
    getKv(key) {
      const row = api.get("SELECT value FROM kv WHERE key = ?", key)
      return row ? JSON.parse(row.value) : undefined
    },
    setKv(key, value) {
      api.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value))
    },
    event(type, payload = {}) {
      api.run(
        "INSERT INTO events (type, account_id, message_id, email, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        type,
        payload.accountId ?? null,
        payload.messageId ?? null,
        payload.email ?? null,
        JSON.stringify(payload.data ?? payload),
        new Date().toISOString(),
      )
    },
  }

  return api
}

export { DATA }
