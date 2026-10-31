import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { insist, invalid } from './errors.js';
import { authorize, event } from './access.js';

const derive = promisify(scrypt);
export const digest = value => createHash('sha256').update(value).digest('hex');
const csrf = token => digest(`csrf:${token}`);
const emailAddress = value => String(value ?? '').trim().toLowerCase();
const passwordValid = value => typeof value === 'string' && value.length >= 15 && value.length <= 128 && !['passwordpassword', '123456789012345', 'correcthorsebatterystaple'].includes(value.toLowerCase());
export async function hashPassword(password) {
  invalid(passwordValid(password), 'Use a unique password of 15–128 characters.');
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
async function passwordMatches(password, encoded) {
  const [scheme, salt, expected] = String(encoded ?? '').split(':');
  // A fixed-work dummy comparison avoids disclosing unregistered email addresses.
  const actualSalt = scheme === 'scrypt' ? salt : '00000000000000000000000000000000';
  const expectedHash = scheme === 'scrypt' ? Buffer.from(expected, 'hex') : Buffer.alloc(64);
  const hash = await derive(password, actualSalt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return expectedHash.length === hash.length && timingSafeEqual(hash, expectedHash) && scheme === 'scrypt';
}

export async function consumeQuota(db, bucket, limit, seconds, amount = 1) {
  insist(amount > 0 && amount <= limit, 429, 'RATE_LIMITED', 'Request budget reached.');
  const { rows } = await db.query(`INSERT INTO quotas(bucket,used,reset_at) VALUES($1,$4,now()+($3::integer*interval '1 second')) ON CONFLICT(bucket) DO UPDATE SET used=CASE WHEN quotas.reset_at<=now() THEN $4 ELSE quotas.used+$4 END, reset_at=CASE WHEN quotas.reset_at<=now() THEN now()+($3::integer*interval '1 second') ELSE quotas.reset_at END WHERE quotas.reset_at<=now() OR quotas.used+$4<=$2 RETURNING used`, [bucket, limit, seconds, amount]);
  insist(rows.length, 429, 'RATE_LIMITED', 'Request limit reached. Please try later.');
}

export class AuthService {
  constructor(db, { secure = false } = {}) { this.db = db; this.secure = secure; this.cookieName = secure ? '__Host-buildbridge' : 'buildbridge'; this.hashing = 0; }
  cookieOptions() { return { path: '/', httpOnly: true, secure: this.secure, sameSite: 'strict', maxAge: 8 * 3600 }; }
  async issueSession(user, db = this.db) {
    const token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO sessions(token_hash,user_id,csrf_hash,created_at,expires_at,last_seen_at) VALUES($1,$2,$3,now(),now()+interval '8 hours',now())", [digest(token), user.id, digest(csrf(token))]);
    return { token, csrf_token: csrf(token), user: { id: user.id, email: user.email } };
  }
  async login(email, password, ip) {
    invalid(typeof password === 'string' && password.length <= 128, 'Email and password are required.');
    const normalized = emailAddress(email);
    await consumeQuota(this.db, `login-ip:${digest(ip)}`, 20, 900);
    await consumeQuota(this.db, `login-email:${digest(normalized)}`, 5, 900);
    insist(this.hashing < 2, 429, 'RATE_LIMITED', 'Sign-in is busy; try again shortly.');
    const { rows } = await this.db.query('SELECT id,email,password_hash,active FROM users WHERE email=$1', [normalized]);
    this.hashing++;
    let matched;
    try { matched = await passwordMatches(password, rows[0]?.password_hash); } finally { this.hashing--; }
    insist(matched && rows[0]?.active, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    return this.issueSession(rows[0]);
  }
  async authenticate(token) {
    insist(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), 401, 'UNAUTHENTICATED', 'Please sign in.');
    const { rows } = await this.db.query("UPDATE sessions s SET last_seen_at=now() FROM users u WHERE s.token_hash=$1 AND u.id=s.user_id AND u.active=true AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes' RETURNING u.id,u.email,s.csrf_hash", [digest(token)]);
    insist(rows.length, 401, 'UNAUTHENTICATED', 'Session expired; please sign in.');
    return { id: rows[0].id, email: rows[0].email, csrf_hash: rows[0].csrf_hash, csrf_token: csrf(token) };
  }
  checkCsrf(actor, value) {
    insist(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(actor.csrf_hash, 'hex')), 403, 'CSRF_FAILED', 'Refresh your session and try again.');
  }
  async logout(token) { await this.db.query('DELETE FROM sessions WHERE token_hash=$1', [digest(token)]); }
  async changePassword(actor, current, next) {
    const { rows } = await this.db.query('SELECT password_hash FROM users WHERE id=$1', [actor.id]);
    insist(typeof current === 'string' && current.length <= 128 && await passwordMatches(current, rows[0]?.password_hash), 401, 'INVALID_CREDENTIALS', 'Current password is incorrect.');
    const hash = await hashPassword(next);
    await this.db.transaction(async tx => { await tx.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, actor.id]); await tx.query('DELETE FROM sessions WHERE user_id=$1', [actor.id]); });
  }
  async activate(token, password) {
    invalid(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), 'Activation token is invalid.');
    const hash = await hashPassword(password);
    return this.db.transaction(async tx => {
      const { rows } = await tx.query('SELECT t.user_id,u.email FROM activation_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.expires_at>now() AND u.password_hash IS NULL AND u.active=true FOR UPDATE', [digest(token)]);
      insist(rows.length, 400, 'INVALID_TOKEN', 'Activation link is invalid or expired.');
      await tx.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, rows[0].user_id]);
      await tx.query('DELETE FROM activation_tokens WHERE user_id=$1', [rows[0].user_id]);
      return this.issueSession({ id: rows[0].user_id, email: rows[0].email }, tx);
    });
  }
}

export async function inviteUser(db, actor, supplierId, { email, role, grants = [] }) {
  await authorize(db, actor, { supplier_id: supplierId }, { admin: true });
  const normalized = emailAddress(email);
  invalid(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) && normalized.length <= 254, 'A valid email is required.');
  invalid(['admin', 'staff', 'credit_manager', 'contractor'].includes(role), 'Unknown user role.');
  invalid(Array.isArray(grants) && grants.length <= 100 && (role === 'admin' || grants.length > 0), 'Scoped users need explicit account grants.');
  for (const grant of grants) invalid(typeof grant.account_id === 'string' && (role === 'contractor' ? grant.branch_id === null : typeof grant.branch_id === 'string'), 'Contractors need account grants; staff need exact account/branch pairs.');
  return db.transaction(async tx => {
    await tx.query('SELECT id FROM suppliers WHERE id=$1 FOR UPDATE', [supplierId]);
    await authorize(tx, actor, { supplier_id: supplierId }, { admin: true });
    for (const grant of grants) {
      const account = await tx.query('SELECT 1 FROM accounts WHERE supplier_id=$1 AND id=$2', [supplierId, grant.account_id]);
      invalid(account.rows.length > 0, 'Unknown account.');
      if (grant.branch_id !== null) { const branch = await tx.query('SELECT 1 FROM branches WHERE supplier_id=$1 AND id=$2', [supplierId, grant.branch_id]); invalid(branch.rows.length > 0, 'Unknown branch.'); }
    }
    let { rows } = await tx.query('SELECT id,password_hash FROM users WHERE email=$1', [normalized]);
    const userId = rows[0]?.id ?? randomUUID();
    if (!rows.length) await tx.query('INSERT INTO users(id,email) VALUES($1,$2)', [userId, normalized]);
    const existing = await tx.query('SELECT 1 FROM memberships WHERE user_id=$1 AND supplier_id=$2', [userId, supplierId]);
    insist(existing.rows.length === 0, 409, 'CONFLICT', 'User already has a supplier membership. Update its grants explicitly.');
    await tx.query('INSERT INTO memberships(user_id,supplier_id,role) VALUES($1,$2,$3)', [userId, supplierId, role]);
    for (const grant of grants) await tx.query('INSERT INTO access_grants(id,user_id,supplier_id,branch_id,account_id) VALUES($1,$2,$3,$4,$5)', [randomUUID(), userId, supplierId, grant.branch_id, grant.account_id]);
    let token = null;
    if (!rows[0]?.password_hash) {
      token = randomBytes(32).toString('base64url');
      await tx.query("INSERT INTO activation_tokens(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '24 hours')", [digest(token), userId]);
    }
    await event(tx, actor, supplierId, null, null, 'user_invited', { user_id: userId, role, grants });
    return { user_id: userId, activation_token: token, already_active: token === null };
  });
}
