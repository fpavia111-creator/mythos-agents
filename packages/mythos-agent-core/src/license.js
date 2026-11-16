// Offline licence keys for a paid tier (node:crypto, no dependencies, no network).
//
// A licence key is a short signed text:
//     MYTHOS1.<payload, base64url JSON>.<Ed25519 signature, base64url>
// payload: { v, id, licensee, plan, agents, features, issued, expires, seats?, kid }
//   agents    ['*'] or package names the key covers
//   features  ['*'] or feature names (a tool may name one with `feature`)
//   expires   'YYYY-MM-DD' (valid through that day, UTC) or null for no end date
//   kid       id of the signing key (see keyId in signing.js)
//
// A tool is paid when its manifest entry says `tier: 'pro'`. The check is an
// extra gate in front of the tool: it never changes an allow/ask/block decision,
// never puts anything on Auto and never touches a one-click category.
//
// What this is not: copy protection. The packages are MIT-licensed source, so
// anyone can read or remove the check. It keeps honest customers honest and
// makes the paid tier a clear line; it does not stop a determined fork.

import { randomBytes, createPublicKey } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { keyId, verifySignature } from './signing.js';
import { canonical } from './util.js';
import { LICENSE_PUBLIC_KEYS, LICENSE_REVOKED_IDS } from './license-keys.js';

export const LICENSE_PREFIX = 'MYTHOS1';
export const LICENSE_FILE = 'license.key';
export const TIERS = Object.freeze(['free', 'pro']);
const MAX_TOKEN = 8192;
const DAY = 86400000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const list = (v, fallback) => (v === undefined || v === null ? fallback : [].concat(v).map((x) => String(x).trim()).filter(Boolean));
const validDay = (s) => ISO_DAY.test(String(s)) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/**
 * Sign a licence. signer: from loadSigner(privateKeyFile). fields: licensee and
 * plan are required; agents and features default to ['*']; give `expires`
 * (YYYY-MM-DD) or `days`, or neither for no end date.
 */
export function issueLicense(signer, fields = {}) {
  if (!signer || typeof signer.sign !== 'function' || !signer.keyId) throw new Error('issueLicense needs a signer (loadSigner(privateKeyFile))');
  const licensee = String(fields.licensee ?? '').trim();
  if (!licensee || licensee.length > 200 || /[\r\n\0]/.test(licensee)) throw new Error('licensee is required (one line, at most 200 characters)');
  const plan = String(fields.plan ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(plan)) throw new Error('plan is required: a short lowercase name such as "pro"');
  const issued = fields.issued || new Date().toISOString().slice(0, 10);
  if (!validDay(issued)) throw new Error('issued must be YYYY-MM-DD');
  let expires = fields.expires ?? null;
  if (fields.days !== undefined && fields.days !== null && fields.days !== '') {
    const n = Number(fields.days); if (!Number.isInteger(n) || n < 1 || n > 36600) throw new Error('days must be a whole number of days, 1 or more');
    if (expires) throw new Error('give expires or days, not both');
    expires = new Date(Date.parse(`${issued}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
  }
  if (expires !== null && !validDay(expires)) throw new Error('expires must be YYYY-MM-DD');
  if (expires !== null && expires < issued) throw new Error('expires is before issued');
  const id = String(fields.id || randomBytes(6).toString('hex')).trim();
  if (!/^[A-Za-z0-9._-]{4,64}$/.test(id)) throw new Error('id must be 4 to 64 letters, digits, dots, dashes or underscores');
  const agents = list(fields.agents, ['*']); const features = list(fields.features, ['*']);
  if (!agents.length || !features.length) throw new Error('agents and features need at least one entry ("*" for all)');
  const payload = { v: 1, id, licensee, plan, agents, features, issued, expires, kid: signer.keyId };
  if (fields.seats !== undefined && fields.seats !== null && fields.seats !== '') { const s = Number(fields.seats); if (!Number.isInteger(s) || s < 1) throw new Error('seats must be a whole number, 1 or more'); payload.seats = s; }
  const body = b64u(canonical(payload));
  const sig = Buffer.from(signer.sign(`${LICENSE_PREFIX}.${body}`), 'base64').toString('base64url');
  return `${LICENSE_PREFIX}.${body}.${sig}`;
}

/** Split a licence key into its parts without checking the signature. null when it is not one. */
export function parseLicense(token) {
  const t = String(token ?? '').trim();
  if (!t || t.length > MAX_TOKEN) return null;
  const parts = t.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.v !== 1) return null;
  if (typeof payload.id !== 'string' || typeof payload.licensee !== 'string' || typeof payload.plan !== 'string' || typeof payload.kid !== 'string') return null;
  if (!Array.isArray(payload.agents) || !Array.isArray(payload.features) || !payload.agents.every((x) => typeof x === 'string') || !payload.features.every((x) => typeof x === 'string')) return null;
  if (!validDay(payload.issued) || (payload.expires !== null && !validDay(payload.expires))) return null;
  return { payload, signed: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url').toString('base64') };
}

/** Trusted keys as a Map keyId -> KeyObject. Accepts a Map, PEM strings or KeyObjects. */
export function licenseKeyMap(keys) {
  if (keys instanceof Map) return keys;
  const m = new Map();
  for (const k of [].concat(keys || [])) { const obj = typeof k === 'string' ? createPublicKey(k) : k; m.set(keyId(obj), obj); }
  return m;
}
let builtIn = null;
/** The keys shipped in license-keys.js. */
export function trustedLicenseKeys() { if (!builtIn) builtIn = licenseKeyMap(LICENSE_PUBLIC_KEYS); return builtIn; }

const NONE = Object.freeze({ id: null, licensee: null, plan: null, agents: [], features: [], issued: null, expires: null, days_left: null });
const REASONS = {
  none: 'No licence key is installed.',
  malformed: 'The licence key is not in the expected form. Check that the whole key was copied.',
  unknown_key: 'The licence key was signed with a key this release does not know. Update the package, or ask the seller for a new key.',
  bad_signature: 'The licence key does not match its signature. It may have been changed or cut short.',
  revoked: 'This licence key has been withdrawn.',
  not_yet_valid: 'This licence key is dated in the future. Check the clock on this computer.',
  expired: 'This licence key has expired.',
  not_for_this_agent: 'This licence key does not cover this agent.',
  valid: 'Licence key is valid.',
};

/**
 * Check a licence key. Never throws and never returns the key itself.
 * options: keys (trusted public keys; default the shipped list), revoked (ids),
 * now (Date), agent (package name to check coverage for).
 * Returns { status, valid, reason, id, licensee, plan, agents, features, issued, expires, days_left }.
 */
export function checkLicense(token, { keys = null, revoked = LICENSE_REVOKED_IDS, now = new Date(), agent = null } = {}) {
  const out = (status, p = NONE, extra = {}) => ({ status, valid: status === 'valid', reason: REASONS[status], id: p.id ?? null, licensee: p.licensee ?? null, plan: p.plan ?? null, agents: p.agents ? [...p.agents] : [], features: p.features ? [...p.features] : [], issued: p.issued ?? null, expires: p.expires ?? null, days_left: null, ...extra });
  if (token === undefined || token === null || String(token).trim() === '') return out('none');
  const parsed = parseLicense(token);
  if (!parsed) return out('malformed');
  const p = parsed.payload;
  let map; try { map = keys ? licenseKeyMap(keys) : trustedLicenseKeys(); } catch { map = new Map(); }
  const key = map.get(p.kid);
  // Nothing from an unverified payload is echoed back: it could say anything.
  if (!key) return out('unknown_key');
  if (!verifySignature(key, parsed.signed, parsed.signature)) return out('bad_signature');
  if ((revoked || []).includes(p.id)) return out('revoked', p);
  const today = new Date(now).toISOString().slice(0, 10);
  // One day of slack for clocks and time zones.
  if (Date.parse(`${p.issued}T00:00:00Z`) - DAY > Date.parse(`${today}T00:00:00Z`)) return out('not_yet_valid', p);
  const daysLeft = p.expires === null ? null : Math.round((Date.parse(`${p.expires}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
  if (daysLeft !== null && daysLeft < 0) return out('expired', p, { days_left: daysLeft, reason: `This licence key expired on ${p.expires}.` });
  if (agent && !p.agents.includes('*') && !p.agents.includes(agent)) return out('not_for_this_agent', p, { days_left: daysLeft, reason: `This licence key covers ${p.agents.join(', ')}, not ${agent}.` });
  return out('valid', p, { days_left: daysLeft });
}

/** Does a checked licence include a feature? */
export const licenseHas = (status, feature) => !!(status && status.valid && (!feature || status.features.includes('*') || status.features.includes(feature)));

/**
 * Find the installed licence key. Order: an explicit token, an explicit file,
 * MYTHOS_LICENSE, MYTHOS_LICENSE_FILE, then <stateDir>/license.key.
 * Returns { token, source } with token null when there is none. Never throws.
 */
export function readLicenseToken({ token = null, file = null, stateDir = null, env = process.env } = {}) {
  const fromFile = (f, source) => {
    try { const abs = resolve(f); if (!existsSync(abs) || statSync(abs).size > MAX_TOKEN * 2) return null; const t = readFileSync(abs, 'utf8').trim(); return t ? { token: t, source } : null; } catch { return null; }
  };
  if (token && String(token).trim()) return { token: String(token).trim(), source: 'option' };
  if (file) return fromFile(file, 'file') || { token: null, source: null };
  if (env && env.MYTHOS_LICENSE && String(env.MYTHOS_LICENSE).trim()) return { token: String(env.MYTHOS_LICENSE).trim(), source: 'MYTHOS_LICENSE' };
  if (env && env.MYTHOS_LICENSE_FILE) return fromFile(env.MYTHOS_LICENSE_FILE, 'MYTHOS_LICENSE_FILE') || { token: null, source: null };
  if (stateDir) return fromFile(join(stateDir, LICENSE_FILE), LICENSE_FILE) || { token: null, source: null };
  return { token: null, source: null };
}

/** What may be shown to a person or a model about a licence: no key, no signature. */
export function licenseView(status) {
  const s = status || checkLicense(null);
  return { status: s.status, ...(s.valid || s.id ? { plan: s.plan, licensee: s.licensee, id: s.id, expires: s.expires ?? 'no end date', ...(s.days_left !== null ? { days_left: s.days_left } : {}), agents: s.agents, features: s.features } : {}), ...(s.valid ? {} : { reason: s.reason }) };
}
