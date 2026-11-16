import { defineManifest, sha256, safeMarkdown } from 'mythos-agent-core';
import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadSnapshot, diff, timeline, revertPlan, reportMarkdown } from './drift.js';
import { revertPatch } from './patch.js';
import { APPROVED_DRIFT_SCHEMA, PROMPTS, driftSarif } from './config.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const nonEmpty = { type: 'string', minLength: 1 };
const DEFAULT_OUT = 'mythos-out/tiresias';
const snapDesc = 'Snapshot under --root: JSON or YAML config, .env/.properties, schema CSV, Terraform state (.tfstate) or Kubernetes manifests (YAML/JSON)';
const before = { ...nonEmpty, description: `Earlier snapshot. ${snapDesc}` };
const after = { ...nonEmpty, description: 'Later snapshot of the same kind' };
const ignore = { type: 'array', items: { type: 'string' }, description: 'Keys or prefixes to ignore (e.g. "meta.updated_at", "build.*")' };
const approved = { ...str, description: 'Approved-drift baseline JSON (schema "approved_drift", written by tiresias_approve_baseline). Approved changes do not count until their value changes again.' };
const keys = { type: 'array', items: nonEmpty, minItems: 1, uniqueItems: true };
const opts = (a, ctx) => ({ ignore: a.ignore || [], ...(a.approved ? { approved: ctx.readJson(a.approved, 'approved_drift').approvals } : {}) });
const snaps = (a, ctx) => ({ b: loadSnapshot(ctx.path(a.before)), af: loadSnapshot(ctx.path(a.after)) });
const pair = (a, ctx) => { const { b, af } = snaps(a, ctx); return diff(b, af, opts(a, ctx)); };
const counts = (d) => `${d.changes} change(s): high ${d.by_risk.high}, medium ${d.by_risk.medium}, low ${d.by_risk.low}${d.approved ? `; ${d.approved} approved, not counted` : ''}`;

export const manifest = defineManifest({
  name: 'tiresias-of-drift',
  version: pkg.version,
  description: 'Compares snapshots over time (JSON/YAML config, .env/.properties, schema CSV, Terraform state, Kubernetes manifests), explains each drift with a risk level, remembers drift a person approved, and drafts a revert plan and patch. Secret values are never shown. Applying a fix to production is always one human click and only records a request.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  configSchemas: { approved_drift: APPROVED_DRIFT_SCHEMA },
  prompts: PROMPTS,
  tools: [
    {
      name: 'tiresias_diff', kind: 'read', title: 'Compare two snapshots',
      description: 'Compare two snapshots (before, after) and explain every change, highest risk first. Terraform state and Kubernetes manifests are grouped by resource. Pass "approved" to leave out drift a person already accepted.',
      inputSchema: { type: 'object', required: ['before', 'after'], properties: { before, after, ignore, approved } },
      handler: async (a, ctx) => { const d = pair(a, ctx); return { summary: `${counts(d)}.`, ...d }; },
    },
    {
      name: 'tiresias_timeline', kind: 'read', title: 'Drift across dated snapshots',
      description: 'Walk a folder of dated snapshots (sorted by file name): changes per step, when each key first drifted, and net drift from the first to the latest.',
      inputSchema: { type: 'object', required: ['dir'], properties: { dir: nonEmpty, ignore, approved } },
      handler: async (a, ctx) => {
        const p = ctx.path(a.dir); if (!statSync(p).isDirectory()) throw new Error(`${a.dir} is not a folder`);
        const t = timeline(p, opts(a, ctx));
        return { summary: `${t.snapshots.length} snapshots; net drift ${t.baseline} → ${t.latest}: ${t.net_drift.changes} change(s), ${t.net_drift.by_risk.high} high.`, ...t };
      },
    },
    {
      name: 'tiresias_write_report', kind: 'report', title: 'Write the drift report',
      description: 'Write drift-report.md, drift.json, drift.sarif (SARIF 2.1.0 for CI code scanning) and revert-plan.json (a proposal back to "before") into out_dir (default mythos-out/tiresias). The report hash is logged in the audit line.',
      inputSchema: { type: 'object', required: ['before', 'after'], properties: { before, after, ignore, approved, out_dir: str, title: str } },
      handler: async (a, ctx) => {
        const { b, af } = snaps(a, ctx); const d = diff(b, af, opts(a, ctx)); const plan = revertPlan(d, a.before); const out = ctx.outDir(a.out_dir || DEFAULT_OUT);
        const md = safeMarkdown(reportMarkdown(d, a.title || `Drift: ${a.before} → ${a.after}`, new Date().toISOString()));
        const sarif = JSON.stringify(driftSarif(d, { afterPath: a.after, afterText: af.text, version: pkg.version }), null, 2);
        const files = [ctx.writeFile(out, 'drift-report.md', md), ctx.writeFile(out, 'drift.json', JSON.stringify(d, null, 2)), ctx.writeFile(out, 'drift.sarif', sarif), ctx.writeFile(out, 'revert-plan.json', JSON.stringify({ proposal: true, back_to: a.before, steps: plan }, null, 2))];
        return { summary: `Drift report written: ${counts(d)}; revert plan with ${plan.length} step(s) (proposal only).`, files, plan_sha256: sha256(JSON.stringify(plan)), sarif_sha256: sha256(sarif), output_sha256: sha256(md) };
      },
    },
    {
      name: 'tiresias_write_revert_patch', kind: 'report', title: 'Write a revert patch',
      description: 'Write revert.patch (a unified diff that puts the later snapshot back to the earlier values; all drifted keys or only "keys") and revert-patch.json (what it reverts, manual steps for secrets) into out_dir. JSON config and .env/.properties only. The patch is checked to apply cleanly before it is written; nothing is applied.',
      inputSchema: { type: 'object', required: ['before', 'after'], properties: { before, after, ignore, approved, keys: { ...keys, description: 'Only revert these keys (default: every drifted key that is not a secret)' }, out_dir: str } },
      handler: async (a, ctx) => {
        const { b, af } = snaps(a, ctx); const r = revertPatch(b, af, { ...opts(a, ctx), keys: a.keys, afterPath: a.after });
        if (!r.patch) return { summary: `Nothing to revert${r.manual_steps.length ? `; ${r.manual_steps.length} secret(s) need a manual step` : ''}. No patch written.`, reverted: [], manual_steps: r.manual_steps, not_reverted: r.not_reverted };
        const out = ctx.outDir(a.out_dir || DEFAULT_OUT);
        const meta = { proposal: true, applies_to: a.after, form: r.applies_to, note: r.applies_to === 'normalized' ? 'The patch applies to the snapshot as 2-space formatted JSON (same content, key order kept). Format the file that way first, or use revert-plan.json.' : 'The patch applies to the snapshot file as it is.', base_sha256: sha256(r.base_text), result_sha256: sha256(r.target_text), patch_sha256: sha256(r.patch), reverted: r.reverted, manual_steps: r.manual_steps, not_reverted: r.not_reverted };
        const files = [ctx.writeFile(out, 'revert.patch', r.patch), ctx.writeFile(out, 'revert-patch.json', JSON.stringify(meta, null, 2))];
        return { summary: `Revert patch written for ${r.reverted.length} key(s) (${r.applies_to} form)${r.manual_steps.length ? `; ${r.manual_steps.length} secret(s) need a manual step` : ''}. Nothing was applied.`, files, ...meta, output_sha256: meta.patch_sha256 };
      },
    },
    {
      name: 'tiresias_approve_baseline', kind: 'write', title: 'Approve drift as the new baseline',
      description: 'Record that a person accepted specific drifted keys (with a reason) in approved-drift.json. Only a fingerprint of each value is stored. Needs a human yes unless opted in to Auto. An approved key alerts again as soon as its value changes.',
      inputSchema: { type: 'object', required: ['before', 'after', 'keys', 'reason'], properties: { before, after, ignore, keys, reason: nonEmpty, out_dir: str } },
      handler: async (a, ctx) => {
        const out = ctx.outDir(a.out_dir || DEFAULT_OUT); const file = relative(ctx.root, join(out, 'approved-drift.json'));
        const doc = ctx.exists(file) ? ctx.readJson(file, 'approved_drift') : { version: 1, note: 'Drift a person approved. Values are stored as fingerprints only.', approvals: [] };
        const d = pair({ before: a.before, after: a.after, ignore: a.ignore }, ctx); const by = new Map(d.items.map((c) => [c.key, c]));
        const missing = a.keys.filter((k) => !by.has(k)); if (missing.length) throw new Error(`no drift on: ${missing.join(', ')}`);
        const at = new Date().toISOString();
        const add = a.keys.map((k) => { const c = by.get(k); return { key: k, after_fp: c.after_fp, change: c.change, risk: c.risk, reason: a.reason, approved_at: at, from: a.before, to: a.after }; });
        doc.approvals = [...doc.approvals.filter((x) => !a.keys.includes(x.key)), ...add].sort((x, y) => x.key.localeCompare(y.key));
        ctx.validate(APPROVED_DRIFT_SCHEMA, doc, 'approved-drift.json');
        const text = JSON.stringify(doc, null, 2) + '\n';
        return { summary: `${add.length} key(s) approved as baseline (${add.filter((x) => x.risk === 'high').length} high risk). Pass approved: "${file}" to leave them out until they change again.`, approved: add.map(({ key, risk, change }) => ({ key, risk, change })), file: ctx.writeFile(out, 'approved-drift.json', text), output_sha256: sha256(text) };
      },
    },
    {
      name: 'tiresias_apply_fix', kind: 'action', category: 'production_deploy', title: 'Record a fix request (one-click)',
      description: 'After one named human click (even in Auto), record an approved fix (keys and target values) in apply-request.json for your change process. Tiresias never touches production.',
      inputSchema: { type: 'object', required: ['environment', 'keys', 'reason'], properties: { environment: nonEmpty, keys: { type: 'array', items: { type: 'string' } }, reason: nonEmpty, before: str, after: str, ignore, out_dir: str } },
      handler: async (a, ctx) => {
        if (!Array.isArray(a.keys) || !a.keys.length) throw new Error('keys must list at least one key');
        let steps = [];
        if (a.before && a.after) { const plan = revertPlan(pair({ before: a.before, after: a.after, ignore: a.ignore }, ctx), a.before); steps = plan.filter((s) => a.keys.includes(s.key)); }
        const out = ctx.outDir(a.out_dir || DEFAULT_OUT);
        const body = { requested_at: new Date().toISOString(), environment: a.environment, keys: a.keys, reason: a.reason, steps, status: 'approved request - apply through your own change process' };
        return { summary: `Fix request recorded for ${a.keys.length} key(s) in ${a.environment}. Nothing was changed.`, file: ctx.writeFile(out, `apply-request-${Date.now()}.json`, JSON.stringify(body, null, 2)) };
      },
    },
    { name: 'production_push_config', kind: 'action', category: 'production_deploy', title: 'Push config (always refused)', description: 'Listed so agents can see it is refused. Tiresias never writes to a live system.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'tiresias_diff', decision: 'allow' },
    { tool: 'tiresias_timeline', decision: 'allow' },
    { tool: 'tiresias_write_report', decision: 'allow' },
    { tool: 'tiresias_write_revert_patch', decision: 'allow' },
    { tool: 'tiresias_approve_baseline', decision: 'ask', reason: 'Accepting drift as the new baseline silences it: a person approves (or opts it in to Auto).' },
    { tool: 'production_push_config', decision: 'block', reason: 'Tiresias never writes to a live system.' },
    { tool: 'tiresias_apply_fix', decision: 'ask', reason: 'Changing production is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Tiresias allowlist.' },
  ] },
});
