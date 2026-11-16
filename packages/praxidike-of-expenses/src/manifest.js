import { defineManifest, toCsv, sha256, sha256File } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { review, findingsCsv, reviewMarkdown, batchCsv } from './expenses.js';
import { normalizeReceipt, receiptView } from './receipts.js';
import { findDuplicates, auditQueue, queueCsv, evidenceHtml } from './audit.js';
import { POLICY_SCHEMA } from './schema.js';
import { PROMPT } from './prompt.js';
import { SOURCES } from './sources.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const props = {
  expenses: { ...str, description: 'Expense lines CSV/JSON: report_id, line_id, employee, date, submitted_on, category, merchant, amount, currency, receipt, purpose, attendees, nights, miles, preapproved_by' },
  policy: { ...str, description: 'Your written policy as JSON rules (source, currency, receipt_required_over, submit_within_days, preapproval_over, categories, disallowed, sections). Every finding cites a section.' },
  receipts: { ...str, description: 'Optional folder of receipt files named in the receipt column. Text receipts are read for totals and dates only.' },
};
const dupProps = {
  history: { ...str, description: 'Optional earlier expense lines (same columns), e.g. last quarter\'s paid reports, to catch claims made twice across periods' },
  date_window_days: { type: 'integer', minimum: 0, maximum: 60, description: 'Days apart that still count as a possible duplicate (default 3)' },
  amount_tolerance_pct: { type: 'number', minimum: 0, maximum: 0.5, description: 'Amount difference that still counts as a possible duplicate (default 0.01 = 1%)' },
};
function loadPolicy(a, ctx) {
  const pf = ctx.path(a.policy); if (!existsSync(pf)) throw new Error(`policy not found: ${a.policy}`);
  try { return ctx.readJson(a.policy, 'policy'); } catch (e) { if (e instanceof SyntaxError) throw new Error(`policy is not valid JSON: ${e.message}`); throw e; }
}
function receiptsDirOf(a, ctx) {
  if (!a.receipts) return null;
  const d = ctx.path(a.receipts); if (!existsSync(d) || !statSync(d).isDirectory()) throw new Error(`receipts folder not found: ${a.receipts}`);
  return d;
}
function run(a, ctx) {
  for (const k of ['expenses', 'policy']) if (!String(a[k] ?? '').trim()) throw new Error(`${k} is required`);
  const policy = loadPolicy(a, ctx);
  return review(ctx.records(a.expenses), policy, { receiptsDir: receiptsDirOf(a, ctx) });
}
function dupes(a, ctx) {
  return findDuplicates(ctx.records(a.expenses), { history: a.history ? ctx.records(a.history) : [], receiptsDir: receiptsDirOf(a, ctx), date_window_days: a.date_window_days, amount_tolerance_pct: a.amount_tolerance_pct });
}
function queueOf(a, ctx) {
  const r = run(a, ctx); const d = dupes(a, ctx); const policy = loadPolicy(a, ctx);
  return { r, d, q: auditQueue(r, d, policy.risk_weights || {}) };
}
const rel = (ctx, f) => relative(ctx.root, f).split('\\').join('/');
function appendRows(dir, file, rows, cols) {
  const f = join(dir, file); const csv = toCsv(rows, cols);
  appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv); return f;
}

export const manifest = defineManifest({
  sources: SOURCES,
  name: 'praxidike-of-expenses',
  version: pkg.version,
  description: 'Compares expense lines and receipt text with your written expense policy: receipts, limits per item, person or night, mileage (rates by date), per diem by location and date, disallowed categories, business purpose, attendees, pre-approval, late submission, currency and possible duplicates (also against earlier reports, by receipt hash and fuzzy match). Normalises receipt text, ranks reports for review with stated reasons and writes a hashed evidence pack. Cites the policy section for every finding and recommends approve, approve with changes, needs info or reject. Pre-stages a reimbursement batch; reimbursing is one human click and paying is blocked. Not fraud detection.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  configSchemas: { policy: POLICY_SCHEMA },
  prompts: [PROMPT],
  tools: [
    {
      name: 'praxidike_review', kind: 'read',
      description: 'Review every line against the policy and recommend per report. Findings cite policy sections. Receipt text is never returned; card-like numbers in purposes are masked.',
      inputSchema: { type: 'object', required: ['expenses', 'policy'], properties: props },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.reports} report(s): approve ${r.approve}, approve with changes ${r.approve_with_changes}, needs info ${r.needs_info}, reject ${r.reject}. Claimed ${r.claimed.toFixed(2)}, recommended ${r.recommended.toFixed(2)} ${r.currency}. Recommendations only.`, ...r }; },
    },
    {
      name: 'praxidike_read_receipts', kind: 'read', title: 'Normalise receipt text',
      description: 'Normalise text receipts (US, European decimal-comma, month-name and "amount due" styles) into merchant, total, date, currency, tax, tip and a content hash. Receipt text itself is never returned; no OCR is done (give it text from your own scanner).',
      inputSchema: { type: 'object', required: ['receipts'], properties: { receipts: props.receipts, files: { type: 'array', items: { type: 'string', pattern: '^[\\w.\\- ]+$' }, description: 'Only these file names (default: every .txt/.md/.text file in the folder)' } } },
      handler: async (a, ctx) => {
        const dir = receiptsDirOf(a, ctx);
        const names = (a.files && a.files.length ? a.files : readdirSync(dir).filter((f) => /\.(txt|md|text)$/i.test(f))).slice().sort();
        const receipts = names.map((f) => { const p = join(dir, f); if (!existsSync(p)) return { file: f, error: 'not found' }; if (!/\.(txt|md|text)$/i.test(f)) return { file: f, skipped: 'not a text receipt', file_sha256: sha256File(p) }; return receiptView(f, normalizeReceipt(readFileSync(p, 'utf8'))); });
        const ok = receipts.filter((r) => r.total !== undefined && r.total !== null).length;
        return { summary: `${receipts.length} receipt(s) read; total found on ${ok}. Receipt text is not returned.`, receipts };
      },
    },
    {
      name: 'praxidike_find_duplicates', kind: 'read', title: 'Find possible duplicate claims',
      description: 'Possible duplicate claims within this export and against earlier reports (history): the same receipt file, identical receipt text under different file names, two receipts with the same merchant, total and date, and fuzzy matches (same employee, similar merchant, amount within tolerance, dates within a window). Each pair has a score with reasons. Not fraud detection.',
      inputSchema: { type: 'object', required: ['expenses'], properties: { expenses: props.expenses, receipts: props.receipts, ...dupProps } },
      handler: async (a, ctx) => { const d = dupes(a, ctx); return { summary: `${d.pairs} possible duplicate pair(s), ${d.cross_period} against earlier reports. For a person to check; not a finding of wrongdoing.`, ...d }; },
    },
    {
      name: 'praxidike_audit_queue', kind: 'read', title: 'Rank reports for review',
      description: 'Rank reports in the order a reviewer should look at them. The score adds up stated weights for each policy finding, possible duplicates against earlier reports and the amount claimed; every point carries its reason. Weights can be set in the policy (risk_weights).',
      inputSchema: { type: 'object', required: ['expenses', 'policy'], properties: { ...props, ...dupProps } },
      handler: async (a, ctx) => { const { q } = queueOf(a, ctx); return { summary: `${q.reports} report(s) ranked: ${q.high} high, ${q.medium} medium, ${q.low} low. Top: ${q.queue.slice(0, 3).map((x) => `${x.report_id} (${x.score})`).join(', ')}.`, ...q }; },
    },
    {
      name: 'praxidike_write_report', kind: 'report',
      description: 'Write expense-review.md and line-findings.csv (blank reviewer columns) into out_dir (default mythos-out/praxidike).',
      inputSchema: { type: 'object', required: ['expenses', 'policy'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => { const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/praxidike'); return { summary: `Review written for ${r.reports} report(s).`, files: [ctx.writeFile(out, 'expense-review.md', reviewMarkdown(r)), ctx.writeFile(out, 'line-findings.csv', findingsCsv(r))] }; },
    },
    {
      name: 'praxidike_write_evidence_pack', kind: 'report', title: 'Write the evidence pack',
      description: 'Write evidence-pack.html (self-contained, no scripts), audit-queue.csv (blank reviewer columns) and evidence-manifest.json with the sha256 of every input (expenses, policy, history, receipts used) and output. The manifest hash is recorded in the audit log as output_sha256. Receipt text is not included.',
      inputSchema: { type: 'object', required: ['expenses', 'policy'], properties: { ...props, ...dupProps, out_dir: str } },
      handler: async (a, ctx) => {
        const { r, d, q } = queueOf(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/praxidike/evidence');
        const inputs = { [a.expenses]: ctx.hashFile(a.expenses), [a.policy]: ctx.hashFile(a.policy) };
        if (a.history) inputs[a.history] = ctx.hashFile(a.history);
        if (a.receipts) for (const f of [...new Set(r.items.map((l) => l.receipt).filter(Boolean))].sort()) { const p = join(a.receipts, f); if (/^[\w.\- ]+$/.test(f) && ctx.exists(p)) inputs[p.split('\\').join('/')] = ctx.hashFile(p); }
        const csv = queueCsv(q);
        const base = { agent: 'praxidike-of-expenses', version: pkg.version, policy_source: r.policy_source, currency: r.currency, reports: r.reports, claimed: r.claimed, recommended: r.recommended, duplicate_pairs: d.pairs, inputs };
        const html = evidenceHtml({ review: r, queue: q, dups: d, manifest: base });
        const fc = ctx.writeFile(out, 'audit-queue.csv', csv); const fh = ctx.writeFile(out, 'evidence-pack.html', html);
        const manifest = { ...base, outputs: { 'audit-queue.csv': sha256(csv), 'evidence-pack.html': sha256(html) }, note: 'Recommendations for a person. Not fraud detection, not tax or legal advice, not an audit opinion.' };
        const mText = JSON.stringify(manifest, null, 2) + '\n'; const fm = ctx.writeFile(out, 'evidence-manifest.json', mText);
        return { summary: `Evidence pack written: ${r.reports} report(s), ${Object.keys(inputs).length} input file(s) hashed, ${d.pairs} possible duplicate pair(s).`, output_sha256: sha256(mText), manifest: rel(ctx, fm), files: [fh, fc, fm] };
      },
    },
    {
      name: 'praxidike_stage_reimbursement', kind: 'write',
      description: 'Pre-stage a reimbursement batch: staged-reimbursements.csv and batch.json (with hashes) for reports recommended approve or approve with changes, at the recommended amounts. Nothing is paid. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['expenses', 'policy'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx);
        const card = ctx.sourceReports().find((s) => s.profile === 'ramp_transactions');
        if (card) throw new Error(`${card.file} is a company card export (${card.system}): the company already paid these, so there is nothing to reimburse. Review and duplicate checks still work on it.`);
        const out = ctx.outDir(a.out_dir || 'mythos-out/praxidike');
        const csv = batchCsv(r); const cf = ctx.writeFile(out, 'staged-reimbursements.csv', csv);
        const staged = r.report_summaries.filter((s) => s.recommended > 0);
        const batch = { created_at: new Date().toISOString(), policy_source: r.policy_source, currency: r.currency, reports: staged.map((s) => ({ report_id: s.report_id, employee: s.employee, amount: s.recommended, recommendation: s.recommendation })), total: Math.round(staged.reduce((t, s) => t + s.recommended, 0) * 100) / 100, csv: 'staged-reimbursements.csv', csv_sha256: sha256(csv), held: r.report_summaries.filter((s) => s.recommended === 0).map((s) => `${s.report_id} (${s.recommendation})`), status: 'staged - not paid' };
        const bText = JSON.stringify(batch, null, 2) + '\n'; const bf = ctx.writeFile(out, 'batch.json', bText);
        return { summary: `Staged ${staged.length} report(s), ${batch.total.toFixed(2)} ${r.currency}; held ${batch.held.length}. Nothing was paid.`, batch: rel(ctx, bf), batch_sha256: sha256(bText), total: batch.total, files: [cf, bf] };
      },
    },
    {
      name: 'praxidike_request_reimbursement', kind: 'action', category: 'move_money',
      description: 'After one named human click (even in Auto), record that the staged batch is approved for payment in reimbursement-approvals.csv. The approval is tied to batch_sha256 and the staged CSV is re-hashed first. A person pays it in your payroll or AP system; Praxidike never pays.',
      inputSchema: { type: 'object', required: ['batch', 'batch_sha256'], properties: { batch: str, batch_sha256: str, out_dir: str } },
      handler: async (a, ctx) => {
        const bf = ctx.path(a.batch); if (!existsSync(bf)) throw new Error(`batch not found: ${a.batch}`);
        const text = readFileSync(bf, 'utf8'); if (sha256(text) !== a.batch_sha256) throw new Error('batch_sha256 does not match the batch file; review the current batch and ask again');
        const b = JSON.parse(text); const cf = join(dirname(bf), b.csv);
        if (!existsSync(cf) || sha256(readFileSync(cf, 'utf8')) !== b.csv_sha256) throw new Error('staged-reimbursements.csv changed after the batch was staged');
        if (!b.reports.length) throw new Error('the batch has no reports to reimburse');
        const at = new Date().toISOString();
        const file = appendRows(ctx.outDir(a.out_dir || 'mythos-out/praxidike'), 'reimbursement-approvals.csv', b.reports.map((r) => ({ approved_at: at, batch_sha256: a.batch_sha256, report_id: r.report_id, employee: r.employee, amount: r.amount.toFixed(2), currency: b.currency, status: 'approved - a person pays it' })), ['approved_at', 'batch_sha256', 'report_id', 'employee', 'amount', 'currency', 'status']);
        return { summary: `Reimbursement of ${b.total.toFixed(2)} ${b.currency} for ${b.reports.length} report(s) approved and recorded. Nothing was paid.`, file };
      },
    },
    { name: 'pay_reimbursement', kind: 'action', category: 'move_money', description: 'Listed so agents can see it is refused. Praxidike never pays anyone or starts a bank or payroll transfer.', inputSchema: { type: 'object', properties: {} } },
    { name: 'ledger_post_expense', kind: 'action', category: 'move_money', description: 'Listed so agents can see it is refused. Praxidike never posts to a ledger or expense system.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'praxidike_review', decision: 'allow' },
    { tool: 'praxidike_write_report', decision: 'allow' },
    { tool: 'praxidike_read_receipts', decision: 'allow' },
    { tool: 'praxidike_find_duplicates', decision: 'allow' },
    { tool: 'praxidike_audit_queue', decision: 'allow' },
    { tool: 'praxidike_write_evidence_pack', decision: 'allow' },
    { tool: 'praxidike_stage_reimbursement', decision: 'ask', reason: 'Staging a reimbursement batch needs a human yes (or an Auto opt-in).' },
    { tool: 'pay_reimbursement', decision: 'block', reason: 'Praxidike never pays. A person pays in your payroll or AP system.' },
    { tool: 'ledger_post_expense', decision: 'block', reason: 'Praxidike never posts to a ledger.' },
    { tool: 'praxidike_request_reimbursement', decision: 'ask', reason: 'Reimbursing moves money: one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Praxidike allowlist.' },
  ] },
});
