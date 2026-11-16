import { appendFileSync, readFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256, canonical } from './util.js';
import { verifySignature } from './signing.js';
import { createPublicKey } from 'node:crypto';
import { keyId as keyIdOf } from './signing.js';

/**
 * Append-only JSONL audit log. Every line carries the hash of the previous
 * line, so edits and deletions show up when the chain is verified.
 *
 * v1 (unsigned): tamper-evident, not tamper-proof. Anyone with write access can
 * rewrite the whole file and re-chain it.
 * v2 (signed): pass a signer (Ed25519 key kept outside --root). Each line also
 * carries key_id and sig = Ed25519(sha256). Re-chaining the file without the
 * private key fails verification with --pubkey.
 *
 * Optional mirror: every line is also appended to a second file you control.
 *
 * Line shape: { v, id, type, date, ts, session, agent, agent_version, model,
 *   mode, tool, kind, category, decision, status, reason, args_sha256,
 *   approved_by, approval_id, summary, requirements, prev_sha256, key_id?, sha256, sig? }
 */
export class AuditLog {
  constructor(file, { signer = null, mirror = null } = {}) {
    this.file = file;
    this.signer = signer;
    this.mirror = mirror;
    this.last = null;
    this.count = 0;
    if (file && existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      this.count = lines.length;
      if (lines.length) { try { this.last = JSON.parse(lines[lines.length - 1]).sha256 || null; } catch { this.last = null; } }
    }
  }

  #append(line) {
    const text = JSON.stringify(line) + '\n';
    if (this.file) { mkdirSync(dirname(this.file), { recursive: true }); appendFileSync(this.file, text); }
    if (this.mirror) { mkdirSync(dirname(this.mirror), { recursive: true }); appendFileSync(this.mirror, text); }
  }

  /** Re-read the chain tip from disk so two writers (agent + approvals page) keep one chain. */
  #syncTip() {
    if (!this.file || !existsSync(this.file)) return;
    const size = statSync(this.file).size; if (!size) return;
    const len = Math.min(size, 256 * 1024); const buf = Buffer.alloc(len);
    const fd = openSync(this.file, 'r'); try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    try { const last = JSON.parse(lines[lines.length - 1]); this.last = last.sha256 || this.last; const n = /^ACT-(\d+)$/.exec(last.id || ''); if (n) this.count = Math.max(this.count, Number(n[1])); } catch { /* keep in-memory tip */ }
  }

  write(entry) {
    this.#syncTip();
    const ts = new Date().toISOString();
    this.count += 1;
    const base = {
      v: this.signer ? 2 : 1, id: `ACT-${String(this.count).padStart(6, '0')}`, type: 'agent-action', date: ts.slice(0, 10), ts,
      requirements: [], ...entry, prev_sha256: this.last,
    };
    if (this.signer) base.key_id = this.signer.keyId;
    const h = sha256(canonical(base));
    const line = { ...base, sha256: h };
    if (this.signer) line.sig = this.signer.sign(h);
    this.last = h;
    this.#append(line);
    return line;
  }

  /** Record a key rotation, signed by the current key, then sign later lines with the new key. */
  rotate(newSigner, { by = 'unknown', note = '' } = {}) {
    if (!this.signer) throw new Error('rotation needs a current signer; start signing with --signing-key first');
    const line = this.write({ type: 'key-rotation', new_key_id: newSigner.keyId, new_public_key: newSigner.publicKeyPem, rotated_by: by, note });
    this.signer = newSigner;
    return line;
  }
}

export function readAudit(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { return { __unparsable: true, line: i + 1 }; }
  });
}

/**
 * Verify the hash chain, and signatures when publicKeys (Map keyId -> KeyObject) are given.
 * Returns { ok, entries, signing, breaks: [{ line, problem }] } where signing is
 * "signed and verified", "signed (not verified: no public key given)", "chained, unsigned"
 * or "mixed".
 */
export function verifyChain(entries, { publicKeys = null } = {}) {
  const breaks = [];
  let prev = null;
  const trusted = publicKeys ? new Map(publicKeys) : null;
  let signed = 0;
  entries.forEach((e, i) => {
    const line = i + 1;
    if (!e || e.__unparsable || typeof e.sha256 !== 'string') { breaks.push({ line, problem: 'not a mythos-agent-core log line (unparsable or no sha256)' }); prev = null; return; }
    const { sha256: h, sig, ...rest } = e;
    if (sha256(canonical(rest)) !== h) breaks.push({ line, problem: 'line content does not match its sha256 (edited)' });
    if (i > 0 && e.prev_sha256 !== prev) breaks.push({ line, problem: 'prev_sha256 does not match the previous line (line removed, inserted or reordered)' });
    if (i === 0 && e.prev_sha256 !== null && e.prev_sha256 !== undefined) breaks.push({ line, problem: 'first line points at a previous line (log truncated at the start)' });
    if (sig) signed += 1;
    if (trusted) {
      if (!sig || !e.key_id) breaks.push({ line, problem: 'line is not signed (a signed log was expected because a public key was given)' });
      else if (!trusted.has(e.key_id)) breaks.push({ line, problem: `signed by unknown key ${e.key_id}` });
      else if (!verifySignature(trusted.get(e.key_id), h, sig)) breaks.push({ line, problem: 'signature does not verify (edited or re-chained without the key)' });
      else if (e.type === 'key-rotation' && e.new_public_key) {
        try { const k = createPublicKey(e.new_public_key); if (keyIdOf(k) === e.new_key_id) trusted.set(e.new_key_id, k); else breaks.push({ line, problem: 'key-rotation new_key_id does not match new_public_key' }); }
        catch { breaks.push({ line, problem: 'key-rotation carries an unreadable public key' }); }
      }
    }
    prev = h;
  });
  const signing = trusted ? 'signed and verified' : signed === 0 ? 'chained, unsigned' : signed === entries.length ? 'signed (not verified: no public key given)' : 'mixed';
  return { ok: breaks.length === 0, entries: entries.length, signing: breaks.length && trusted ? 'failed' : signing, breaks };
}
