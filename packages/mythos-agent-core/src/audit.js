import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256, canonical } from './util.js';

/**
 * Append-only JSONL audit log. Every line carries the hash of the previous
 * line, so edits and deletions show up when the chain is verified.
 * This is tamper-evident, not tamper-proof: anyone with write access can
 * rewrite the whole file. Ship copies somewhere you control.
 *
 * Line shape (v1), Alethea-style field names where they overlap:
 * { v, id, type:"agent-action", date, ts, session, agent, agent_version, model,
 *   mode, tool, kind, category, decision, status, reason, args_sha256,
 *   approved_by, approval_id, summary, requirements, prev_sha256, sha256 }
 */
export class AuditLog {
  constructor(file) {
    this.file = file;
    this.last = null;
    this.count = 0;
    if (file && existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      this.count = lines.length;
      if (lines.length) { try { this.last = JSON.parse(lines[lines.length - 1]).sha256 || null; } catch { this.last = null; } }
    }
  }

  write(entry) {
    const ts = new Date().toISOString();
    this.count += 1;
    const base = {
      v: 1, id: `ACT-${String(this.count).padStart(6, '0')}`, type: 'agent-action', date: ts.slice(0, 10), ts,
      requirements: [], ...entry, prev_sha256: this.last,
    };
    const line = { ...base, sha256: sha256(canonical(base)) };
    this.last = line.sha256;
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(line) + '\n');
    }
    return line;
  }
}

export function readAudit(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Verify the hash chain. Returns { ok, entries, breaks: [{ line, problem }] }. */
export function verifyChain(entries) {
  const breaks = [];
  let prev = null;
  entries.forEach((e, i) => {
    if (!e || typeof e.sha256 !== 'string') { breaks.push({ line: i + 1, problem: 'no sha256 field (not a mythos-agent-core log line)' }); prev = null; return; }
    const { sha256: h, ...rest } = e;
    if (sha256(canonical(rest)) !== h) breaks.push({ line: i + 1, problem: 'line content does not match its sha256 (edited)' });
    if (i > 0 && e.prev_sha256 !== prev) breaks.push({ line: i + 1, problem: 'prev_sha256 does not match the previous line (line removed, inserted or reordered)' });
    prev = h;
  });
  return { ok: breaks.length === 0, entries: entries.length, breaks };
}
