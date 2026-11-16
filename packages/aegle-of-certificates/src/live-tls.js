// Opt-in live TLS expiry check. One TLS handshake per listed host: it reads the
// certificate the server presents and closes the connection. It sends no
// application data, follows no redirects and changes nothing. The tool that
// calls it is "ask" (a human yes, or an Auto opt-in) and is blocked in review
// mode. Tests inject `connect` or use a local TLS server; no internet calls.
import tls from 'node:tls';
import { isIP } from 'node:net';
import { toCsv } from 'mythos-agent-core';
import { asOfMs, expiryStatus, pick, DEFAULTS } from './certs.js';

const DAY = 86400000;
export const MAX_HOSTS = 25;
export const HOST_RE = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::(\d{1,5}))?$/;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

export function parseTarget(s, defaultPort = 443) {
  const m = HOST_RE.exec(String(s || '').trim());
  if (!m) throw new Error(`not a host or host:port: "${s}"`);
  const host = m[1].replace(/^\[|\]$/g, ''); const port = m[2] ? Number(m[2]) : defaultPort;
  if (!(port >= 1 && port <= 65535)) throw new Error(`port out of range in "${s}"`);
  return { host, port };
}

/** One handshake. Resolves { cert, authorized, authorizationError, protocol } or { error }. Never rejects. */
export function handshake(host, port, { connect = tls.connect, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let done = false; let sock = null; let timer = null;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { sock && sock.destroy(); } catch { /* closed */ } resolve(r); };
    timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);
    try {
      sock = connect({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: false });
    } catch (e) { finish({ error: String(e && (e.code || e.message) || e) }); return; }
    sock.once('secureConnect', () => {
      try {
        const cert = sock.getPeerCertificate(false) || {};
        finish({ cert, authorized: !!sock.authorized, authorizationError: sock.authorizationError ? String(sock.authorizationError.code || sock.authorizationError) : null, protocol: typeof sock.getProtocol === 'function' ? sock.getProtocol() : null });
      } catch (e) { finish({ error: String(e && e.message || e) }); }
    });
    sock.once('error', (e) => finish({ error: String(e && (e.code || e.message) || e) }));
  });
}

const dn = (o) => (o && typeof o === 'object' ? ['CN', 'O', 'OU', 'C'].filter((k) => o[k]).map((k) => `${k}=${[].concat(o[k]).join('+')}`).join(', ') : '');

/** Turn a handshake result into a row with status and flags. `inv` is the matching inventory row, if any. */
export function assess(target, h, { now, thresholds = DEFAULTS, inv = null, checkIdentity = tls.checkServerIdentity } = {}) {
  const row = { host: target.host, port: target.port, reachable: !h.error, error: h.error || '', not_before: '', not_after: '', days_left: null, status: 'unreachable', subject: '', issuer: '', san: '', key: '', protocol: h.protocol || '', fingerprint256: '', inventory_id: inv ? inv.id : '', inventory_expires: inv ? inv.expires : '', flags: [] };
  if (h.error) { row.flags.push('unreachable'); return row; }
  const c = h.cert || {};
  const na = Date.parse(c.valid_to); const nb = Date.parse(c.valid_from);
  if (Number.isFinite(nb)) row.not_before = iso(nb);
  if (Number.isFinite(na)) { row.not_after = iso(na); const day = Date.UTC(new Date(na).getUTCFullYear(), new Date(na).getUTCMonth(), new Date(na).getUTCDate()); row.days_left = Math.round((day - now) / DAY); }
  row.status = expiryStatus(row.days_left, thresholds);
  row.subject = dn(c.subject); row.issuer = dn(c.issuer); row.san = c.subjectaltname || '';
  const ec = c.nistCurve || c.asn1Curve;
  row.key = ec ? `EC ${ec}` : c.bits ? `RSA ${c.bits}` : '';
  row.fingerprint256 = c.fingerprint256 || '';
  if (Number.isFinite(nb) && nb > now + DAY) row.flags.push('not_yet_valid');
  if (row.subject && row.subject === row.issuer) row.flags.push('self_signed');
  if (!h.authorized) row.flags.push(`chain_untrusted${h.authorizationError ? `:${h.authorizationError}` : ''}`);
  let idErr = null; try { idErr = checkIdentity(target.host, c); } catch (e) { idErr = e; }
  if (idErr) row.flags.push('hostname_mismatch');
  if (!ec && c.bits && c.bits < 2048) row.flags.push(`weak_key_RSA_${c.bits}`);
  if (ec && c.bits && c.bits < 256) row.flags.push(`weak_key_EC_${c.bits}`);
  if (!inv) row.flags.push('not_in_inventory');
  else if (row.not_after && inv.expires && inv.expires !== row.not_after) row.flags.push('inventory_mismatch');
  return row;
}

/**
 * targets: ["host[:port]", ...] and/or inventory TLS rows (name, port).
 * opts: { as_of, critical_days, warn_days, upcoming_days, timeoutMs, connect, inventory }
 */
export async function liveTlsCheck(targets, opts = {}) {
  const now = asOfMs(opts.as_of);
  const thresholds = { ...DEFAULTS, ...Object.fromEntries(['critical_days', 'warn_days', 'upcoming_days'].filter((k) => Number.isFinite(opts[k])).map((k) => [k, opts[k]])) };
  const inv = (opts.inventory || []).filter((r) => (pick(r, 'type', 'kind', 'category') || '').toLowerCase() === 'tls').map((r, i) => ({ id: pick(r, 'id', 'certificate_id') || `row${i + 1}`, host: pick(r, 'name', 'common_name', 'cn', 'domain', 'host').toLowerCase(), port: Number(pick(r, 'port')) || 443, expires: (/^\d{4}-\d{2}-\d{2}/.exec(pick(r, 'expires', 'expiry', 'expiration', 'not_after', 'valid_to', 'expires_on')) || [''])[0] }));
  const list = []; const seen = new Set();
  for (const t of targets) { const k = `${t.host.toLowerCase()}:${t.port}`; if (!seen.has(k)) { seen.add(k); list.push(t); } }
  if (!list.length) throw new Error('no hosts to check');
  if (list.length > MAX_HOSTS) throw new Error(`at most ${MAX_HOSTS} hosts per call (got ${list.length})`);
  const rows = [];
  for (const t of list) {
    const h = await handshake(t.host, t.port, { connect: opts.connect, timeoutMs: opts.timeoutMs || 5000 });
    const match = inv.find((x) => x.host === t.host.toLowerCase() && x.port === t.port) || null;
    rows.push(assess(t, h, { now, thresholds, inv: match }));
  }
  const RANK = { unreachable: 0, expired: 1, critical: 2, no_expiry_date: 3, warning: 4, upcoming: 5, ok: 6 };
  rows.sort((a, b) => RANK[a.status] - RANK[b.status] || (a.days_left ?? 1e9) - (b.days_left ?? 1e9));
  return { as_of: iso(now), checked: rows.length, reachable: rows.filter((r) => r.reachable).length, mismatches: rows.filter((r) => r.flags.includes('inventory_mismatch')).length, rows };
}

export const LIVE_COLUMNS = ['host', 'port', 'status', 'days_left', 'not_after', 'not_before', 'inventory_id', 'inventory_expires', 'flags', 'subject', 'issuer', 'san', 'key', 'protocol', 'fingerprint256', 'error'];
export const liveCsv = (r) => toCsv(r.rows.map((x) => ({ ...x, flags: x.flags.join('; ') })), LIVE_COLUMNS);
