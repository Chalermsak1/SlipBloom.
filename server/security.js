import { randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID } from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$16384$8$1$${salt}$${digest}`;
}
export function verifyPassword(password, stored) {
  const [scheme, ns, rs, ps, salt, hex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  try {
    const expected = Buffer.from(hex, 'hex');
    const actual = scryptSync(password, salt, expected.length, { N:Number(ns), r:Number(rs), p:Number(ps) });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const newId = () => randomUUID();
export const newToken = () => randomBytes(32).toString('base64url');

export function createSession(db, userId) {
  const token = newToken(), csrfToken = newToken(), now = new Date(), expires = new Date(now.getTime() + 30 * 86400_000);
  db.prepare('INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?,?)')
    .run(newId(), userId, sha256(token), csrfToken, expires.toISOString(), now.toISOString());
  return { token, csrfToken, expires };
}
export function getSession(db, token) {
  if (!token) return null;
  return db.prepare(`SELECT sessions.id, sessions.user_id, sessions.csrf_token, sessions.expires_at, users.email
      FROM sessions JOIN users ON users.id=sessions.user_id
      WHERE sessions.token_hash=? AND sessions.expires_at>?`)
    .get(sha256(token), new Date().toISOString()) || null;
}
export function cookieValue(cookieHeader, name) {
  return String(cookieHeader || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) || '';
}
