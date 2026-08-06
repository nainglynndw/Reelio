import { DatabaseSync } from "node:sqlite";
import path from "node:path";

let database;
let databasePath;

export function initializeDatabase(root) {
  if (database) return database;
  databasePath = path.join(root, "reelio.sqlite");
  database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions(user_id);
    CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx ON auth_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_state (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      plan_code TEXT NOT NULL CHECK(plan_code IN ('free', 'creator', 'studio')),
      status TEXT NOT NULL CHECK(status IN ('trialing', 'active', 'past_due', 'canceled')),
      included_renders INTEGER NOT NULL DEFAULT 0,
      renders_used INTEGER NOT NULL DEFAULT 0,
      current_period_start TEXT NOT NULL,
      current_period_end TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at)
    VALUES ('local', 'Creator workspace', NULL, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(now, now);
  database.prepare(`
    INSERT OR IGNORE INTO subscriptions (
      user_id, plan_code, status, included_renders, renders_used,
      current_period_start, current_period_end, created_at, updated_at
    )
    SELECT id, 'studio', 'active', 200, 0, ?, NULL, ?, ? FROM users
  `).run(now, now, now);
  database.prepare(`
    INSERT INTO schema_migrations (version, applied_at)
    VALUES (1, ?)
    ON CONFLICT(version) DO NOTHING
  `).run(now);
  database.prepare(`
    INSERT INTO schema_migrations (version, applied_at)
    VALUES (2, ?)
    ON CONFLICT(version) DO NOTHING
  `).run(now);
  return database;
}

export function getDatabase() {
  if (!database) throw new Error("Reelio database has not been initialized.");
  return database;
}

export function getDatabasePath() {
  if (!databasePath) throw new Error("Reelio database has not been initialized.");
  return databasePath;
}

export function readWorkspaceState(workspaceId = "local") {
  const row = getDatabase().prepare("SELECT state_json FROM workspace_state WHERE workspace_id = ?").get(workspaceId);
  return row?.state_json ? JSON.parse(row.state_json) : null;
}

export function writeWorkspaceState(value, workspaceId = "local") {
  const now = new Date().toISOString();
  getDatabase().prepare(`
    INSERT INTO workspace_state (workspace_id, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
  `).run(workspaceId, JSON.stringify(value), now);
  getDatabase().prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(now, workspaceId);
}

export function claimLocalWorkspace(userId) {
  const result = getDatabase().prepare(`
    UPDATE workspaces
    SET owner_user_id = ?, updated_at = ?
    WHERE id = 'local' AND owner_user_id IS NULL
  `).run(userId, new Date().toISOString());
  return result.changes === 1;
}

export function localWorkspaceOwnerId() {
  return getDatabase().prepare("SELECT owner_user_id FROM workspaces WHERE id = 'local'").get()?.owner_user_id ?? null;
}

export function closeDatabase() {
  if (!database) return;
  database.close();
  database = null;
  databasePath = null;
}
