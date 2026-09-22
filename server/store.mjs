import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { defaults } from './model.mjs';
export function createStore(directory) {
  mkdirSync(directory, { recursive: true });
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
  const keyPath = join(directory, 'credentials.key'), dbPath = join(directory, 'crossex.sqlite');
  if (!existsSync(keyPath)) { if (existsSync(dbPath)) throw new Error('credentials.key 缺失，请恢复备份'); writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' }); }
  const key = readFileSync(keyPath); if (key.length !== 32) throw new Error('credentials.key 无效');
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS positions (id TEXT PRIMARY KEY, status TEXT NOT NULL, pair_key TEXT NOT NULL, signal_id TEXT UNIQUE NOT NULL, opened_at INTEGER NOT NULL, json TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS one_open_pair ON positions(pair_key) WHERE status='open'; CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, message TEXT NOT NULL);`);
  if (process.platform !== 'win32') chmodSync(dbPath, 0o600);
  const get = (name, fallback = null) => { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(name); return row ? JSON.parse(row.value) : fallback; };
  const set = (name, value) => db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value));
  const event = (at, message) => { db.prepare('INSERT INTO events(at,message) VALUES (?,?)').run(at, message); db.exec('DELETE FROM events WHERE id <= (SELECT MAX(id)-500 FROM events)'); };
  const encrypt = value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64'); };
  const decrypt = value => { if (!value) return ''; const data = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(-16)); return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString('utf8'); };
  const coolingBases = since => db.prepare("SELECT DISTINCT json_extract(json,'$.base') AS base FROM positions WHERE status='closed' AND json_extract(json,'$.closedAt')>?").all(since).map(x => x.base);
  return { db, get, set, event, encrypt, decrypt, coolingBases, config: () => get('config', { ...defaults }), positions: (status = null, limit = 1000000) => db.prepare("SELECT json FROM positions WHERE (? IS NULL OR status=?) ORDER BY CASE WHEN status='closed' THEN json_extract(json,'$.closedAt') ELSE opened_at END DESC LIMIT ?").all(status, status, limit).map(x => JSON.parse(x.json)), findPosition: id => { const row = db.prepare('SELECT json FROM positions WHERE id=?').get(id); return row ? JSON.parse(row.json) : null; }, closedTotals: () => db.prepare("SELECT count(*) AS closedCount, coalesce(sum(json_extract(json,'$.result.net')),0) AS realizedPnl FROM positions WHERE status='closed'").get(), hasSignal: id => !!db.prepare('SELECT id FROM positions WHERE signal_id=?').get(id), savePosition(p) { db.prepare('INSERT INTO positions VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,json=excluded.json').run(p.id, p.status, p.pairKey, p.signalId, p.openedAt, JSON.stringify(p)); }, transaction(callback) { db.exec('BEGIN IMMEDIATE'); try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }, close: () => db.close() };
}
