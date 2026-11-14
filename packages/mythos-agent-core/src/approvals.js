import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * File-based human approvals. The agent gets an approval_id; a person runs
 * `mythos-approve <id> --as "Name"`. Each approval is used once.
 *
 * Honest limit: if the agent can run shell commands in the same folder, it can
 * write this file too. Give the agent MCP access only, not a shell, for the
 * approval to mean anything.
 */
export class ApprovalStore {
  constructor(dir) { this.file = dir ? join(dir, 'approvals.jsonl') : null; this.mem = []; }

  #all() {
    if (!this.file) return this.mem;
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  #append(rec) {
    if (!this.file) { this.mem.push(rec); return; }
    mkdirSync(join(this.file, '..'), { recursive: true });
    appendFileSync(this.file, JSON.stringify(rec) + '\n');
  }

  approve(id, approvedBy, note = '') {
    if (!/^[a-f0-9]{16}$/.test(String(id))) throw new Error('approval id must be the 16-character id the agent reported');
    const who = String(approvedBy || '').trim();
    if (who.length < 2) throw new Error('a named human approver is required (--as "Your Name")');
    const rec = { type: 'approve', id, approved_by: who, note, ts: new Date().toISOString() };
    this.#append(rec);
    return rec;
  }

  /** Returns the approval record and marks it used, or null. */
  consume(id) {
    const all = this.#all();
    const used = new Set(all.filter((r) => r.type === 'consume').map((r) => r.id));
    if (used.has(id)) return null;
    const rec = all.find((r) => r.type === 'approve' && r.id === id);
    if (!rec) return null;
    this.#append({ type: 'consume', id, ts: new Date().toISOString() });
    return rec;
  }
}
