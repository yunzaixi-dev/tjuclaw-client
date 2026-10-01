/// <reference lib="webworker" />
// The Web client's device-local SQLite database (same `kv` schema as the
// native Tauri store) on OPFS. The SAH-pool VFS can be held by one worker per
// origin, so tabs elect a leader with a Web Lock; other tabs forward their
// requests to it over a BroadcastChannel and resend them when a new leader
// takes over.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { StoreRequest, StoreResponse, StoreResult } from './local-store';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  ns TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ns, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS git_object (
  repo TEXT NOT NULL,
  oid TEXT NOT NULL,
  type TEXT NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (repo, oid)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS git_ref (
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  oid TEXT NOT NULL,
  PRIMARY KEY (repo, name)
) WITHOUT ROWID;
PRAGMA user_version = 2;`;

type Database = { exec: (options: { sql: string; bind?: unknown[]; returnValue?: 'resultRows'; rowMode?: 'array' }) => unknown[][] };
type Peer = { type: 'leader' } | { type: 'request'; request: StoreRequest } | { type: 'response'; response: StoreResponse };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const channel = new BroadcastChannel('tjuclaw-local-store');
const pending = new Map<string, StoreRequest>();
let database: Database | null = null;

function runGit(db: Database, request: Extract<StoreRequest, { repo: string }>): StoreResult {
  const { repo } = request;
  if (request.op === 'git-read') {
    const rows = db.exec({ sql: 'SELECT type, data FROM git_object WHERE repo = ? AND oid = ?', bind: [repo, request.oid], returnValue: 'resultRows', rowMode: 'array' });
    return rows.length ? { type: String(rows[0]![0]), data: rows[0]![1] as Uint8Array } : null;
  }
  if (request.op === 'git-write') {
    // All or nothing: a ref is only moved after its objects are stored.
    db.exec({ sql: 'BEGIN' });
    try {
      for (const object of request.objects) {
        db.exec({ sql: 'INSERT OR IGNORE INTO git_object (repo, oid, type, data) VALUES (?, ?, ?, ?)', bind: [repo, object.oid, object.type, object.data] });
      }
      db.exec({ sql: 'COMMIT' });
    } catch (error) {
      db.exec({ sql: 'ROLLBACK' });
      throw error;
    }
    return null;
  }
  if (request.op === 'git-ref-get') {
    const rows = db.exec({ sql: 'SELECT oid FROM git_ref WHERE repo = ? AND name = ?', bind: [repo, request.name], returnValue: 'resultRows', rowMode: 'array' });
    return rows.length ? String(rows[0]![0]) : null;
  }
  if (request.op === 'git-ref-set') {
    db.exec({ sql: 'INSERT INTO git_ref (repo, name, oid) VALUES (?, ?, ?) ON CONFLICT (repo, name) DO UPDATE SET oid = excluded.oid', bind: [repo, request.name, request.oid] });
    return null;
  }
  db.exec({ sql: 'DELETE FROM git_ref WHERE repo = ?', bind: [repo] });
  db.exec({ sql: 'DELETE FROM git_object WHERE repo = ?', bind: [repo] });
  return null;
}

function run(db: Database, request: StoreRequest): StoreResult {
  if ('repo' in request) return runGit(db, request);
  const { op, ns } = request;
  if (op === 'get') {
    const rows = db.exec({ sql: 'SELECT value FROM kv WHERE ns = ? AND key = ?', bind: [ns, request.key], returnValue: 'resultRows', rowMode: 'array' });
    return rows.length ? String(rows[0]![0]) : null;
  }
  if (op === 'set') {
    db.exec({
      sql: `INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      bind: [ns, request.key, request.value, Date.now()],
    });
    return null;
  }
  if (op === 'delete') {
    db.exec({ sql: 'DELETE FROM kv WHERE ns = ? AND key = ?', bind: [ns, request.key] });
    return null;
  }
  const rows = db.exec({ sql: 'SELECT key, value FROM kv WHERE ns = ? ORDER BY key', bind: [ns], returnValue: 'resultRows', rowMode: 'array' });
  return rows.map(row => [String(row[0]), String(row[1])] as [string, string]);
}

function answer(request: StoreRequest): StoreResponse {
  try {
    return { id: request.id, ok: true, result: run(database!, request) };
  } catch {
    return { id: request.id, ok: false, error: 'store_failed' };
  }
}

function settle(response: StoreResponse) {
  if (!pending.delete(response.id)) return;
  scope.postMessage(response);
}

function dispatch(request: StoreRequest) {
  if (database) settle(answer(request));
  else channel.postMessage({ type: 'request', request } satisfies Peer);
}

channel.onmessage = (event: MessageEvent<Peer>) => {
  const message = event.data;
  if (message.type === 'request' && database) channel.postMessage({ type: 'response', response: answer(message.request) } satisfies Peer);
  else if (message.type === 'response') settle(message.response);
  // A new leader may have missed requests sent while nobody held the lock.
  else if (message.type === 'leader' && !database) for (const request of pending.values()) dispatch(request);
};

scope.onmessage = (event: MessageEvent<StoreRequest>) => {
  pending.set(event.data.id, event.data);
  dispatch(event.data);
};

async function lead() {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'tjuclaw', directory: '.tjuclaw-sqlite' });
  const db = new pool.OpfsSAHPoolDb('/tjuclaw.sqlite3') as unknown as Database;
  db.exec({ sql: SCHEMA });
  database = db;
  channel.postMessage({ type: 'leader' } satisfies Peer);
  for (const request of pending.values()) settle(answer(request));
}

void navigator.locks.request('tjuclaw-local-store', async () => {
  try {
    await lead();
  } catch {
    scope.postMessage({ type: 'unavailable' });
    return;
  }
  scope.postMessage({ type: 'ready' });
  // Hold the lock (and the OPFS handles) for the life of this tab.
  await new Promise(() => {});
});
