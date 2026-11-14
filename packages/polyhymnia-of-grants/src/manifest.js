import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { review, deadlines, packetFiles } from './grants.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }; const num = { type: 'number' };
const props = {
  grants: { ...str, description: 'Grants CSV/JSON: grant_id, funder, program, award_amount, period_start, period_end, report_due, report_type, status' },
  budget: { ...str, description: 'Budget lines CSV/JSON: grant_id, line, budgeted, spent' },
  outcomes: { ...str, description: 'Outcomes CSV/JSON: grant_id, metric, target, actual, evidence (file path relative to the outcomes file, inside --root)' },
  as_of: str, due_soon_days: num, pace_tolerance: { ...num, description: 'Spend-pace tolerance vs. time elapsed (default 0.25)' },
};
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
      name: 'polyhymnia_build_packet', kind: 'write',
      description: 'Write a draft packet per grant (report-draft.md, checklist.md, evidence-index.csv) into out_dir/packets/<grant_id>. Narrative is left for a person; gaps are marked. Skips submitted grants. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['grants'], properties: { ...props, grant_id: str, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const base = join(ctx.outDir(a.out_dir || 'mythos-out/polyhymnia'), 'packets');
        const pick = r.items.filter((g) => (a.grant_id ? g.grant_id === a.grant_id : g.status !== 'submitted'));
        if (a.grant_id && !pick.length) throw new Error(`grant ${a.grant_id} not found`);
        const files = [];
        for (const g of pick) {
          const dir = join(base, g.grant_id); mkdirSync(dir, { recursive: true });
          for (const [n, t] of Object.entries(packetFiles(g, (p) => readFileSync(evPath(a, ctx, p), 'utf8')))) files.push(ctx.writeFile(dir, n, t));
        }
        return { summary: `${pick.length} draft packet(s) written with ${pick.reduce((t, g) => t + g.open_items, 0)} open item(s) marked. Nothing was submitted.`, files };
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
  policy: { rules: [
    { tool: 'polyhymnia_deadlines', decision: 'allow' },
    { tool: 'polyhymnia_review', decision: 'allow' },
    { tool: 'polyhymnia_build_packet', decision: 'ask', reason: 'Writing draft packets needs a human yes (or an Auto opt-in).' },
    { tool: 'funder_portal_submit', decision: 'block', reason: 'Polyhymnia never submits to a funder.' },
    { tool: 'polyhymnia_request_submission', decision: 'ask', reason: 'Submitting a report is a binding send: one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Polyhymnia allowlist.' },
  ] },
});
