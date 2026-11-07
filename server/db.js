import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(filename) {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shops (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'THB',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS slips (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      shop_id TEXT NOT NULL REFERENCES shops(id),
      stored_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      ocr_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      claimed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS slips_owner ON slips(user_id, shop_id);
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      shop_id TEXT NOT NULL REFERENCES shops(id),
      type TEXT NOT NULL CHECK(type IN ('income','expense','personal')),
      amount_satang INTEGER NOT NULL CHECK(amount_satang > 0),
      transacted_on TEXT NOT NULL,
      category TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL CHECK(source IN ('slip','manual')),
      slip_id TEXT UNIQUE REFERENCES slips(id),
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS transactions_month ON transactions(shop_id, transacted_on, deleted_at);
    CREATE INDEX IF NOT EXISTS transactions_duplicate ON transactions(shop_id, transacted_on, type, amount_satang, deleted_at);
    CREATE TABLE IF NOT EXISTS monthly_goals (
      shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      target_satang INTEGER NOT NULL CHECK(target_satang > 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (shop_id, month)
    );
  `);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
