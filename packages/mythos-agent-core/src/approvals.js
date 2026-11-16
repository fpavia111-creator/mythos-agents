import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * File-based human approvals. The agent gets an approval_id; a person approves
 * it (CLI, the local approvals page, or a signed webhook callback). Each
 * approval is used once and expires after ttlHours (default 24).
 *
 * Records (approvals.jsonl):
 *   request  { id, agent, tool, category, one_click, args_sha256, reason, ts }
 *   approve  { id, approved_by, note, via, ts, expires_at }
 *   reject   { id, rejected_by, note, via, ts }
 *   consume  { id, ts }
 *
 * Honest limit: if the agent can run shell commands in the same folder, it can
 * write this file too. Give the agent MCP access only, not a shell, or keep the
 * state dir where the agent cannot write.
 */
export class ApprovalStore {
  constructor(dir, { ttlHours = 24 } = {}) {
    this.file = dir ? join(dir, 'approvals.jsonl') : null;
    this.mem = [];
    this.ttlHours = Number(ttlHours) > 0 ? Number(ttlHours) : 24;
  }

  all() {
    if (!this.file) return this.mem;
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  #append(rec) {
    if (!this.file) { this.mem.push(rec); return; }
    mkdirSync(join(this.file, '..'), { recursive: true });
    appendFileSync(this.file, JSON.stringify(rec) + '\n');
  }

  /** Record that a call is waiting for a person (idempotent per id while pending). */
  request(rec) {
    const st = this.state(rec.id);
    if (st.status === 'pending') return st.request;
    const r = { type: 'request', ts: new Date().toISOString(), ...rec };
    this.#append(r);
    return r;
  }

  #check(id, who) {
    if (!/^[a-f0-9]{16}$/.test(String(id))) throw new Error('approval id must be the 16-character id the agent reported');
    const name = String(who || '').trim();
    if (name.length < 2) throw new Error('a named human approver is required (--as "Your Name")');
    if (/^(agent|ai|bot|claude|assistant|system|auto)$/i.test(name)) throw new Error(`"${name}" is not a person's name`);
    return name;
  }

  approve(id, approvedBy, note = '', via = 'cli') {
    const who = this.#check(id, approvedBy);
    const st = this.state(id);
    if (st.status === 'used') throw new Error(`approval ${id} was already used; the agent must ask again`);
    if (st.status === 'rejected') throw new Error(`approval ${id} was rejected by ${st.rejected_by}; the agent must ask again`);
    const ts = new Date();
    const rec = { type: 'approve', id, approved_by: who, note, via, ts: ts.toISOString(), expires_at: new Date(ts.getTime() + this.ttlHours * 3600e3).toISOString() };
    this.#append(rec);
    return rec;
  }

  reject(id, rejectedBy, note = '', via = 'cli') {
    const who = this.#check(id, rejectedBy);
    const rec = { type: 'reject', id, rejected_by: who, note, via, ts: new Date().toISOString() };
    this.#append(rec);
    return rec;
  }

  /** Current state of one id: none | pending | approved | rejected | expired | used. */
  state(id, now = Date.now()) {
    // Records form cycles: request -> approve|reject -> consume. A new request
    // after a used or rejected cycle starts a fresh cycle for the same id.
    let request = null, approve = null, reject = null, used = false;
    for (const r of this.all()) {
      if (r.id !== id) continue;
      if (r.type === 'request') {
        if (used || reject) { used = false; reject = null; approve = null; }
        request = r;
      } else if (r.type === 'approve') { if (!used) { approve = r; reject = null; } }
      else if (r.type === 'reject') { if (!used) { reject = r; approve = null; } }
      else if (r.type === 'consume') used = true;
    }
    if (used) return { id, status: 'used', request, approve };
    if (reject) return { id, status: 'rejected', request, rejected_by: reject.rejected_by, note: reject.note };
    if (approve) {
      if (approve.expires_at && Date.parse(approve.expires_at) < now) return { id, status: 'expired', request, approve };
      return { id, status: 'approved', request, approve };
    }
    if (request) return { id, status: 'pending', request };
    return { id, status: 'none' };
  }

  /** Pending requests (no decision yet), newest first. */
  pending() {
    const ids = [...new Set(this.all().filter((r) => r.type === 'request').map((r) => r.id))];
    return ids.map((id) => this.state(id)).filter((s) => s.status === 'pending').map((s) => s.request).reverse();
  }

  /** Returns the approval record and marks it used, or null (none, rejected, expired or used). */
  consume(id) {
    const st = this.state(id);
    if (st.status !== 'approved') return null;
    this.#append({ type: 'consume', id, ts: new Date().toISOString() });
    return st.approve;
  }
}

// ---- Signed webhook callbacks -------------------------------------------------

/** HMAC-SHA256 signature for a webhook body: "t=<unix>,v1=<hex>". The secret comes from env, never disk. */
export function signWebhook(body, secret, t = Math.floor(Date.now() / 1000)) {
  if (!secret) throw new Error('webhook secret is required (set MYTHOS_WEBHOOK_SECRET)');
  const mac = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${mac}`;
}

/**
 * Verify a signed callback. Returns { ok, reason, payload }.
 * Rejects: bad or missing signature, timestamps older than maxSkewSec (default 300),
 * unparsable JSON, and approvals without a person's name.
 */
export function verifyWebhook(body, header, secret, { maxSkewSec = 300, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!secret) return { ok: false, reason: 'no webhook secret configured' };
  const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(String(header || ''));
  if (!m) return { ok: false, reason: 'missing or malformed signature header' };
  const t = Number(m[1]);
  if (Math.abs(now - t) > maxSkewSec) return { ok: false, reason: 'signature timestamp outside the allowed window (replay?)' };
  const want = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: 'bad signature' };
  let payload;
  try { payload = JSON.parse(body); } catch { return { ok: false, reason: 'body is not JSON' }; }
  if (!payload || !/^[a-f0-9]{16}$/.test(String(payload.id || ''))) return { ok: false, reason: 'payload.id must be an approval id' };
  if (!['approve', 'reject'].includes(payload.decision)) return { ok: false, reason: 'payload.decision must be approve or reject' };
  if (String(payload.by || '').trim().length < 2) return { ok: false, reason: 'payload.by must name the person who decided' };
  return { ok: true, payload };
}
