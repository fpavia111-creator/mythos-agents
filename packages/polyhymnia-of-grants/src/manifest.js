import { defineManifest, toCsv, sha256, writeZip, validateIcs, safeFileName } from 'mythos-agent-core';
import { readFileSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { review, deadlines, packetFiles } from './grants.js';
import { varianceReview, varianceCsv, varianceMarkdown, templateCheck, templatedDraft, deadlineIcs, evidenceManifest } from './extras.js';
import { FUNDER_TEMPLATE_SCHEMA } from './schemas.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }; const num = { type: 'number' };
const props = {
  grants: { ...str, description: 'Grants CSV/JSON: grant_id, funder, program, award_amount, period_start, period_end, report_due, report_type, status' },
  budget: { ...str, description: 'Budget lines CSV/JSON: grant_id, line, budgeted, spent' },
  outcomes: { ...str, description: 'Outcomes CSV/JSON: grant_id, metric, target, actual, evidence (file path relative to the outcomes file, inside --root)' },
  as_of: { ...str, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, due_soon_days: { ...num, minimum: 0 }, pace_tolerance: { ...num, minimum: 0, description: 'Spend-pace tolerance vs. time elapsed (default 0.25)' },
};
const vprops = {
  variance_pct: { ...num, minimum: 0, maximum: 10, description: 'Explain a line when its variance is more than this share of the basis (default 0.10; a template can set it)' },
  variance_amount: { ...num, minimum: 0, description: '…and at least this amount (default 0)' },
  underspend_pct: { ...num, minimum: 0, maximum: 1, description: 'Flag a projected under/overspend beyond this share of the award (default 0.10)' },
};
const tprop = { template: { ...str, description: 'Funder template JSON under --root (checked against the funder_template schema)' } };
const loadTemplate = (a, ctx) => (a.template ? ctx.readJson(a.template, 'funder_template') : null);
const vargs = (a, t) => ({ ...a, variance_pct: a.variance_pct ?? (t && t.variance_threshold_pct), variance_amount: a.variance_amount ?? (t && t.variance_threshold_amount) });
const budgetFor = (a, ctx) => (a.budget ? ctx.records(a.budget) : []);
// Budget lines grouped by grant once per file (file order kept).
const LINES = new WeakMap();
const linesOf = (rows, id) => {
  let m = LINES.get(rows);
  if (!m) { m = new Map(); for (const l of rows) { const k = String(l.grant_id ?? l.grant ?? '').trim(); if (!m.has(k)) m.set(k, []); m.get(k).push(l); } LINES.set(rows, m); }
  return (m.get(id) || []).slice();
};
const fileExists = (ctx, p) => { try { const f = ctx.path(p); return existsSync(f) && statSync(f).isFile(); } catch { return false; } };
// Evidence paths are relative to the folder of the outcomes file.
const evPath = (a, ctx, p) => ctx.path(join(dirname(a.outcomes || '.'), p));
const run = (a, ctx) => {
  const isFile = (p) => { try { const f = evPath(a, ctx, p); return existsSync(f) && statSync(f).isFile(); } catch { return false; } };
  return review({ ...a, grants: ctx.records(a.grants), budget: a.budget ? ctx.records(a.budget) : [], outcomes: a.outcomes ? ctx.records(a.outcomes) : [], exists: isFile });
};

export const manifest = defineManifest({
  name: 'polyhymnia-of-grants',
  version: pkg.version,
  description: 'Grant reporting prep from CSV exports: deadlines, budget lines against award and time elapsed, outcomes against targets, and whether each evidence file exists. Builds a draft report packet with the narrative left for a person and every gap marked. Submitting to a funder is a binding send: one human click, never automatic. Does not claim to make you compliant.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'polyhymnia_deadlines', kind: 'read',
      description: 'List report deadlines: overdue, due soon, upcoming, later, submitted.',
      inputSchema: { type: 'object', required: ['grants'], properties: { grants: props.grants, as_of: str, due_soon_days: num } },
      handler: async (a, ctx) => { const d = deadlines(ctx.records(a.grants), a); return { summary: `${d.length} grant(s): ${d.filter((g) => g.status === 'overdue').length} overdue, ${d.filter((g) => g.status === 'due_soon').length} due soon.`, items: d }; },
    },
    {
      name: 'polyhymnia_review', kind: 'read',
      description: 'Per grant: deadline, budget pace and overspend, outcomes vs targets, evidence found or missing, and a list of open items.',
      inputSchema: { type: 'object', required: ['grants'], properties: props },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.grants} grant(s): ${r.overdue} overdue, ${r.due_soon} due soon, ${r.open_items} open item(s).`, ...r }; },
    },
    {
      name: 'polyhymnia_variance', kind: 'read', title: 'Budget vs actual variance',
      description: 'Per grant and budget line: variance against the full budget (final reports, or after the period ends) or against the share expected by now, with explanation_required when it exceeds variance_pct and variance_amount; plus a spend-down projection at the current pace (projected_underspend / projected_overspend).',
      inputSchema: { type: 'object', required: ['grants', 'budget'], properties: { grants: props.grants, budget: props.budget, as_of: props.as_of, grant_id: str, ...vprops, ...tprop } },
      handler: async (a, ctx) => {
        const t = loadTemplate(a, ctx); const blines = budgetFor(a, ctx);
        const list = deadlines(ctx.records(a.grants), a).filter((g) => (a.grant_id ? g.grant_id === a.grant_id : g.status !== 'submitted')).map((g) => varianceReview(g, linesOf(blines, g.grant_id), vargs(a, t)));
        if (a.grant_id && !list.length) throw new Error(`grant ${a.grant_id} not found`);
        const need = list.reduce((n, v) => n + v.lines_needing_explanation, 0);
        return { summary: `${list.length} grant(s): ${need} budget line(s) need a variance explanation; ${list.filter((v) => v.flags.length).length} with a projected under- or overspend.`, grants: list, lines_needing_explanation: need };
      },
    },
    {
      name: 'polyhymnia_template_check', kind: 'read', title: 'Check a funder template',
      description: 'Map a funder template JSON onto each grant: which sections the data fills, which a person writes, which required sections or attachments are missing, and whether the template is for this funder.',
      inputSchema: { type: 'object', required: ['grants', 'template'], properties: { ...props, ...vprops, template: tprop.template, grant_id: str } },
      handler: async (a, ctx) => {
        const t = loadTemplate(a, ctx); const r = run(a, ctx); const blines = budgetFor(a, ctx);
        const list = r.items.filter((g) => (a.grant_id ? g.grant_id === a.grant_id : g.status !== 'submitted')).map((g) => templateCheck(t, g, varianceReview(g, linesOf(blines, g.grant_id), vargs(a, t)), (p) => fileExists(ctx, join(dirname(a.outcomes || '.'), p))));
        if (a.grant_id && !list.length) throw new Error(`grant ${a.grant_id} not found`);
        return { summary: `Template "${t.name}" on ${list.length} grant(s): ${list.reduce((n, x) => n + x.gaps.length, 0)} gap(s).`, template: t.name, grants: list };
      },
    },
    {
      name: 'polyhymnia_calendar', kind: 'report', title: 'Deadline calendar (.ics)',
      description: 'Write grant-deadlines.ics: one all-day event per open report deadline and per grant period end, with reminders (default 30, 14, 7 and 1 days before). Submitted grants are skipped. The file is validated before it is written; the output hash goes into the audit line.',
      inputSchema: { type: 'object', required: ['grants'], properties: { grants: props.grants, as_of: props.as_of, reminder_days: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'integer', minimum: 0, maximum: 365 } }, include_period_end: { type: 'boolean' }, out_dir: str } },
      handler: async (a, ctx) => {
        const items = deadlines(ctx.records(a.grants), a);
        const day = a.as_of || new Date().toISOString().slice(0, 10);
        const ics = deadlineIcs(items, { as_of: day, reminders: [...new Set(a.reminder_days || [30, 14, 7, 1])].sort((x, y) => y - x), includePeriodEnd: a.include_period_end !== false });
        const v = validateIcs(ics); if (!v.ok) throw new Error(`calendar failed validation: ${v.errors.join('; ')}`);
        const file = ctx.writeFile(ctx.outDir(a.out_dir || 'mythos-out/polyhymnia'), 'grant-deadlines.ics', ics);
        return { summary: `${v.events} calendar event(s) written for ${items.filter((g) => g.status !== 'submitted').length} open grant(s).`, events: v.events, file, output_sha256: sha256(ics), as_of: day };
      },
    },
    {
      name: 'polyhymnia_build_packet', kind: 'write',
      description: 'Write a draft packet per grant (report-draft.md, checklist.md, evidence-index.csv) into out_dir/packets/<grant_id>. Includes a budget-vs-actual variance table with [EXPLAIN VARIANCE] markers. With template, the report follows the funder template\'s sections and marks missing sections and attachments. Narrative is left for a person; gaps are marked. Skips submitted grants. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['grants'], properties: { ...props, ...vprops, ...tprop, grant_id: str, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const base = join(ctx.outDir(a.out_dir || 'mythos-out/polyhymnia'), 'packets');
        const t = loadTemplate(a, ctx); const blines = budgetFor(a, ctx);
        const pick = r.items.filter((g) => (a.grant_id ? g.grant_id === a.grant_id : g.status !== 'submitted'));
        if (a.grant_id && !pick.length) throw new Error(`grant ${a.grant_id} not found`);
        const files = []; const templateGaps = {};
        for (const g of pick) {
          const dir = join(base, safeFileName(g.grant_id)); mkdirSync(dir, { recursive: true });
          const v = varianceReview(g, linesOf(blines, g.grant_id), vargs(a, t));
          const tc = t ? templateCheck(t, g, v, (p) => fileExists(ctx, join(dirname(a.outcomes || '.'), p))) : null;
          if (tc) templateGaps[g.grant_id] = tc.gaps.length;
          const opts = { varianceMd: v.lines.length ? varianceMarkdown(v) : '', extraGaps: [...v.lines.filter((l) => l.explanation_required).map((l) => `Explain the variance on "${l.line}" (${l.marker.slice(1, -1)})`), ...(tc ? tc.gaps.map((x) => x.detail) : [])], render: tc ? (bt, ot) => templatedDraft(t, g, v, tc, bt, ot) : null };
          for (const [n, txt] of Object.entries(packetFiles(g, (p) => readFileSync(evPath(a, ctx, p), 'utf8'), opts))) files.push(ctx.writeFile(dir, n, txt));
        }
        return { summary: `${pick.length} draft packet(s) written with ${pick.reduce((n, g) => n + g.open_items, 0)} open item(s) marked${t ? ` following template "${t.name}" (${Object.values(templateGaps).reduce((n, x) => n + x, 0)} template gap(s))` : ''}. Nothing was submitted.`, files };
      },
    },
    {
      name: 'polyhymnia_evidence_pack', kind: 'write', title: 'Evidence pack (.zip)',
      description: 'Zip one grant\'s draft packet (from polyhymnia_build_packet) with the evidence files it cites, a variance.csv (when budget is given) and a manifest.json of SHA-256 hashes into out_dir/packets/<grant_id>-evidence-pack.zip. The zip hash goes into the audit line. Nothing is sent. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['grants', 'outcomes', 'grant_id'], properties: { ...props, ...vprops, ...tprop, grant_id: str, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const g = r.items.find((x) => x.grant_id === a.grant_id);
        if (!g) throw new Error(`grant ${a.grant_id} not found`);
        const pdir = join(ctx.outDir(a.out_dir || 'mythos-out/polyhymnia'), 'packets', safeFileName(g.grant_id));
        const files = {}; const missing = [];
        for (const n of ['report-draft.md', 'checklist.md', 'evidence-index.csv']) { const f = join(pdir, n); if (existsSync(f)) files[`packet/${n}`] = readFileSync(f); else missing.push(`packet/${n}`); }
        if (!Object.keys(files).length) throw new Error(`no packet for ${g.grant_id}: run polyhymnia_build_packet first`);
        if (a.budget) files['packet/variance.csv'] = varianceCsv([varianceReview(g, linesOf(budgetFor(a, ctx), g.grant_id), vargs(a, loadTemplate(a, ctx)))]);
        for (const o of g.outcomes) { if (!o.evidence) continue; if (o.flags.includes('evidence_not_found')) { missing.push(`evidence/${o.evidence}`); continue; } files[`evidence/${o.evidence.replace(/^\.?\/+/, '')}`] = readFileSync(evPath(a, ctx, o.evidence)); }
        const manifest = { ...evidenceManifest(g, files, { as_of: r.as_of }), missing };
        files['manifest.json'] = JSON.stringify(manifest, null, 2) + '\n';
        const zip = writeZip(files); const file = ctx.writeFile(join(ctx.outDir(a.out_dir || 'mythos-out/polyhymnia'), 'packets'), `${safeFileName(g.grant_id)}-evidence-pack.zip`, zip);
        return { summary: `Evidence pack for ${g.grant_id}: ${Object.keys(files).length} file(s)${missing.length ? `, ${missing.length} cited file(s) missing` : ''}. Nothing was sent.`, file, files: manifest.files, missing, output_sha256: sha256(zip) };
      },
    },
    {
      name: 'polyhymnia_request_submission', kind: 'action', category: 'binding_send',
      description: 'After one named human click (even in Auto), record that a reviewed packet is approved for submission in submission-requests.csv. A person submits it in the funder\'s portal; Polyhymnia never submits.',
      inputSchema: { type: 'object', required: ['grant_id', 'packet'], properties: { grant_id: str, packet: { ...str, description: 'Path of the reviewed report-draft.md' }, note: str, out_dir: str } },
      handler: async (a, ctx) => {
        for (const k of ['grant_id', 'packet']) if (!String(a[k] ?? '').trim()) throw new Error(`${k} is required`);
        const p = ctx.path(a.packet); if (!existsSync(p)) throw new Error(`packet not found: ${a.packet}`);
        const open = (readFileSync(p, 'utf8').match(/\[(TO WRITE|EXPLAIN|MISSING)[^\]]*\]/g) || []).length;
        const out = ctx.outDir(a.out_dir || 'mythos-out/polyhymnia'); const f = join(out, 'submission-requests.csv');
        const csv = toCsv([{ requested_at: new Date().toISOString(), grant_id: a.grant_id, packet: a.packet, open_markers: open, note: a.note || '', status: 'approved - a person submits in the funder portal' }], ['requested_at', 'grant_id', 'packet', 'open_markers', 'note', 'status']);
        appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv);
        return { summary: `Submission approved and recorded for ${a.grant_id}${open ? ` (warning: ${open} open marker(s) still in the packet)` : ''}. Nothing was submitted.`, open_markers: open, file: f };
      },
    },
    { name: 'funder_portal_submit', kind: 'action', category: 'binding_send', description: 'Listed so agents can see it is refused. Polyhymnia never submits to a funder.', inputSchema: { type: 'object', properties: {} } },
  ],
  configSchemas: { funder_template: FUNDER_TEMPLATE_SCHEMA },
  prompts: [
    {
      name: 'polyhymnia_report_cycle', title: 'Grant report cycle',
      description: 'Walk through one grant reporting cycle: deadlines and calendar, review, variance and spend-down, funder template mapping, draft packet, evidence pack, and the human submission click.',
      arguments: [
        { name: 'grants', description: 'Grants CSV/JSON under --root', required: true },
        { name: 'budget', description: 'Budget lines CSV/JSON', required: true },
        { name: 'outcomes', description: 'Outcomes CSV/JSON (evidence paths relative to it)', required: true },
        { name: 'template', description: 'Funder template JSON (optional)', required: false },
        { name: 'grant_id', description: 'One grant to focus on (optional)', required: false },
        { name: 'as_of', description: 'YYYY-MM-DD (optional)', required: false },
      ],
      text: [
        'You are preparing grant reports with the polyhymnia-of-grants tools. Grants: {{grants}}. Budget: {{budget}}. Outcomes: {{outcomes}}. Template: {{template}}. Grant: {{grant_id}}. As of: {{as_of}}. Leave out any argument shown in [brackets].',
        '1. Call polyhymnia_deadlines, then polyhymnia_calendar so the person can import grant-deadlines.ics. Start with overdue and due_soon grants.',
        '2. Call polyhymnia_review. List each grant\'s open items in plain words.',
        '3. Call polyhymnia_variance. For every line with explanation_required, ask the person for the reason; do not invent one. Mention projected_underspend or projected_overspend.',
        '4. If a template is given, run `polyhymnia-of-grants validate-config funder_template <file>` (or expect a JSON-pointer error), then polyhymnia_template_check. Report missing required sections and attachments.',
        '5. Call polyhymnia_build_packet (with template if given). It asks for a human yes unless opted in to Auto. The narrative stays [TO WRITE] for a person; never write program claims, results or variance explanations yourself.',
        '6. Call polyhymnia_evidence_pack for the grant being submitted (needs a human yes unless on Auto). Give the person the zip path and any missing files.',
        '7. Human click: after a person has resolved every [TO WRITE], [EXPLAIN] and [MISSING] marker, polyhymnia_request_submission records the packet as approved; it is one named human click even in Auto, and the person submits in the funder\'s own portal. funder_portal_submit is blocked; never try it.',
        'Say clearly that this checks the person\'s own figures and files; it does not make anyone compliant with funder or federal rules.',
      ].join('\n'),
    },
  ],
  policy: { rules: [
    { tool: 'polyhymnia_deadlines', decision: 'allow' },
    { tool: 'polyhymnia_review', decision: 'allow' },
    { tool: 'polyhymnia_variance', decision: 'allow' },
    { tool: 'polyhymnia_template_check', decision: 'allow' },
    { tool: 'polyhymnia_calendar', decision: 'allow' },
    { tool: 'polyhymnia_evidence_pack', decision: 'ask', reason: 'Assembling an evidence pack needs a human yes (or an Auto opt-in).' },
    { tool: 'polyhymnia_build_packet', decision: 'ask', reason: 'Writing draft packets needs a human yes (or an Auto opt-in).' },
    { tool: 'funder_portal_submit', decision: 'block', reason: 'Polyhymnia never submits to a funder.' },
    { tool: 'polyhymnia_request_submission', decision: 'ask', reason: 'Submitting a report is a binding send: one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Polyhymnia allowlist.' },
  ] },
});
