import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PolicyEngine } from './policy.js';
import { MODES, ONE_CLICK_CATEGORIES } from './manifest.js';
import { AuditLog } from './audit.js';
import { ApprovalStore } from './approvals.js';
import { sha256, canonical, safePath, readRecords } from './util.js';

export const DEFAULT_CAPS = Object.freeze({ maxSteps: 50, maxSpendUsd: 5 });

/**
 * Runs pack tools behind the policy engine, caps, kill switch, approvals and audit log.
 *
 * options:
 *   mode        'review' | 'assist' (default) | 'auto'
 *   autoActions tool names the buyer opts in to Auto (off by default, per action)
 *   caps        { maxSteps, maxSpendUsd } — enforced in every mode
 *   root        folder the tools may read and write (default: cwd)
 *   stateDir    where audit.jsonl, approvals.jsonl and KILL live (default: <root>/.mythos)
 *   audit       false to keep the log in memory only (tests)
 */
export class AgentRuntime {
  constructor(manifest, options = {}) {
    this.manifest = manifest;
    this.policy = new PolicyEngine(manifest);
    this.mode = options.mode || 'assist';
    if (!MODES.includes(this.mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
    this.autoActions = new Set(options.autoActions || []);
    for (const name of this.autoActions) {
      const t = this.policy.byName.get(name);
      if (!t) throw new Error(`Auto opt-in "${name}" is not a tool in ${manifest.name}`);
      if (ONE_CLICK_CATEGORIES.includes(t.category)) throw new Error(`"${name}" (${t.category}) cannot be put on Auto; it stays one-click`);
    }
    this.caps = { ...DEFAULT_CAPS, ...(manifest.caps || {}), ...(options.caps || {}) };
    this.root = resolve(options.root || process.cwd());
    this.stateDir = options.stateDir === null ? null : resolve(options.stateDir || join(this.root, '.mythos'));
    this.audit = new AuditLog(options.audit === false || !this.stateDir ? null : join(this.stateDir, 'audit.jsonl'));
    this.approvals = new ApprovalStore(options.audit === false ? null : this.stateDir);
    this.session = options.session || randomUUID();
    this.steps = 0;
    this.spendUsd = 0;
    this.killed = false;
    this.log = [];
  }

  kill() { this.killed = true; }

  isKilled() {
    if (this.killed) return true;
    if (/^(1|true|yes)$/i.test(process.env.MYTHOS_KILL || '')) return true;
    return !!(this.stateDir && existsSync(join(this.stateDir, 'KILL')));
  }

  listTools() {
    return this.manifest.tools.map((t) => {
      const d = this.policy.decide(t.name, { mode: this.mode, autoActions: this.autoActions });
      return { name: t.name, kind: t.kind, category: t.category || null, decision: d.decision, reason: d.reason, description: t.description, inputSchema: t.inputSchema };
    });
  }

  approvalId(tool, args) { return sha256(`${this.manifest.name}|${tool}|${canonical(args || {})}`).slice(0, 16); }

  context() {
    const root = this.root;
    return {
      root,
      manifest: this.manifest,
      path: (p) => safePath(root, p),
      records: (p) => readRecords(safePath(root, p)),
      outDir: (p) => { const d = safePath(root, p || 'mythos-out'); mkdirSync(d, { recursive: true }); return d; },
      writeFile: (dir, name, text) => { const f = join(dir, name); writeFileSync(f, text); return f; },
    };
  }

  #record(tool, args, fields) {
    const t = this.policy.byName.get(tool);
    const entry = this.audit.write({
      session: this.session, agent: this.manifest.name, agent_version: this.manifest.version,
      model: `${this.manifest.model.provider}/${this.manifest.model.id}`, mode: this.mode, tool,
      kind: t ? t.kind : null, category: t ? t.category || null : null,
      args_sha256: sha256(canonical(args || {})), ...fields,
    });
    this.log.push(entry);
    return entry;
  }

  async call(tool, args = {}) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {};
    if (this.isKilled()) {
      this.#record(tool, args, { decision: 'block', status: 'blocked', reason: 'kill switch engaged' });
      return { status: 'blocked', decision: 'block', reason: 'Kill switch engaged. Remove .mythos/KILL (or unset MYTHOS_KILL) to resume.' };
    }
    const d = this.policy.decide(tool, { mode: this.mode, autoActions: this.autoActions });
    const t = d.tool;
    const cost = t ? Number(t.costUsd) || 0 : 0;
    if (d.decision !== 'block' && (this.steps >= this.caps.maxSteps || this.spendUsd + cost > this.caps.maxSpendUsd)) {
      const reason = this.steps >= this.caps.maxSteps ? `step cap reached (${this.caps.maxSteps})` : `spend cap reached ($${this.caps.maxSpendUsd})`;
      this.#record(tool, args, { decision: 'block', status: 'blocked', reason });
      return { status: 'blocked', decision: 'block', reason: `${reason}. Stopped and reported; a human can raise the cap.` };
    }
    if (d.decision === 'block') {
      this.#record(tool, args, { decision: 'block', status: 'blocked', reason: d.reason });
      return { status: 'blocked', decision: 'block', reason: d.reason };
    }
    let approvedBy = null, approvalId = null;
    if (d.decision === 'ask') {
      approvalId = this.approvalId(tool, args);
      const rec = this.approvals.consume(approvalId);
      if (!rec) {
        this.#record(tool, args, { decision: 'ask', status: 'needs_approval', reason: d.reason, approval_id: approvalId });
        return {
          status: 'needs_approval', decision: 'ask', reason: d.reason, approval_id: approvalId,
          how_to_approve: `A person runs: npx -y -p mythos-agent-core mythos-approve ${approvalId} --as "Your Name" --dir "${this.stateDir || '.mythos'}" and then the same call is repeated with the same arguments.`,
        };
      }
      approvedBy = rec.approved_by;
    }
    if (!t.handler) {
      this.#record(tool, args, { decision: d.decision, status: 'error', reason: 'tool has no handler in this version' });
      return { status: 'error', decision: d.decision, reason: 'This tool has no handler in this version.' };
    }
    this.steps += 1;
    this.spendUsd += cost;
    try {
      const result = await t.handler(args, this.context());
      const extra = result && Number(result.costUsd) > 0 ? Number(result.costUsd) : 0;
      this.spendUsd += extra;
      this.#record(tool, args, {
        decision: d.decision, status: 'executed', reason: d.reason, approved_by: approvedBy, approval_id: approvalId,
        auto: !!d.auto, summary: result && result.summary ? String(result.summary).slice(0, 500) : null,
      });
      return { status: 'executed', decision: d.decision, approved_by: approvedBy, auto: !!d.auto, result };
    } catch (err) {
      this.#record(tool, args, { decision: d.decision, status: 'error', reason: String(err && err.message || err).slice(0, 500) });
      return { status: 'error', decision: d.decision, reason: String(err && err.message || err) };
    }
  }
}
