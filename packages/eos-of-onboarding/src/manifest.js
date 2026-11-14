import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { status, trackerCsv, summaryMarkdown, accessDraft } from './onboarding.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }; const num = { type: 'number' };
const props = {
  people: { ...str, description: 'People CSV/JSON: person_id, name, type (employee, contractor, customer…), role, manager, start_date, end_date' },
  template: { ...str, description: 'Checklist template JSON: { "types": { "<type>": [ { id, title, kind (document|equipment|access|training|meeting|task), owner, system, access_level, requires: [task ids], due_offset_days } ] } }' },
  status: { ...str, description: 'Optional task status CSV/JSON: person_id, task_id, status (done, in_progress, blocked, not_started, n/a), done_on, note' },
  as_of: str, due_soon_days: num,
};
function run(a, ctx) {
  for (const k of ['people', 'template']) if (!String(a[k] ?? '').trim()) throw new Error(`${k} is required`);
  const tf = ctx.path(a.template); if (!existsSync(tf)) throw new Error(`template not found: ${a.template}`);
  let t; try { t = JSON.parse(readFileSync(tf, 'utf8')); } catch (e) { throw new Error(`template is not valid JSON: ${e.message}`); }
  return status(ctx.records(a.people), t, a.status ? ctx.records(a.status) : [], a);
}
function find(r, a) {
  const p = r.items.find((x) => x.person_id === a.person_id); if (!p) throw new Error(`person not found: ${a.person_id}`);
  const t = p.tasks.find((x) => x.task_id === a.task_id); if (!t) throw new Error(`task ${a.task_id} is not on ${a.person_id}'s checklist`);
  if (t.kind !== 'access') throw new Error(`${a.task_id} is not an access task`);
  return { p, t };
}
function appendRow(dir, file, row, cols) {
  const f = join(dir, file); const csv = toCsv([row], cols);
  appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv); return f;
}
const COLS = ['requested_at', 'action', 'person_id', 'name', 'task_id', 'system', 'access_level', 'end_date', 'reason', 'status'];

export const manifest = defineManifest({
  name: 'eos-of-onboarding',
  version: pkg.version,
  description: 'Tracks onboarding checklists for new employees, contractors or customers from a people CSV, a JSON template and a status CSV: due dates from the start date, overdue and waiting tasks, readiness for day one, access granted before its prerequisites, contractor access with no end date, and access still marked granted after an engagement ended. Drafts access requests once prerequisites are done. Granting and removing access are each one human click; Eos never touches an identity system.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'eos_status', kind: 'read',
      description: 'Per person: task states (done, overdue, due_soon, waiting, blocked, ready, open), percent done, next tasks and flags; totals of access requests ready and removals due.',
      inputSchema: { type: 'object', required: ['people', 'template'], properties: props },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.people} people, ${r.done}/${r.tasks} tasks done, ${r.overdue} overdue, ${r.waiting} waiting; ${r.access_ready} access request(s) ready, ${r.revoke_due} removal(s) due. Flags: ${r.flagged.join('; ') || 'none'}.`, ...r }; },
    },
    {
      name: 'eos_write_tracker', kind: 'report',
      description: 'Write onboarding-tracker.csv (blank checked_by column) and onboarding.md into out_dir (default mythos-out/eos).',
      inputSchema: { type: 'object', required: ['people', 'template'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => { const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/eos'); return { summary: `Tracker written for ${r.people} people.`, files: [ctx.writeFile(out, 'onboarding-tracker.csv', trackerCsv(r)), ctx.writeFile(out, 'onboarding.md', summaryMarkdown(r))] }; },
    },
    {
      name: 'eos_draft_access_requests', kind: 'write',
      description: 'Write a request draft (marked DRAFT, not submitted) for each access task whose prerequisites are done, and a removal draft for access still granted after an engagement ended, into out_dir/access-requests. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['people', 'template'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const dir = join(ctx.outDir(a.out_dir || 'mythos-out/eos'), 'access-requests'); mkdirSync(dir, { recursive: true }); const files = [];
        for (const p of r.items) for (const t of p.tasks) {
          if (t.ready_to_request) files.push(ctx.writeFile(dir, `${p.person_id}-${t.task_id}-grant.md`, accessDraft(p, t, 'grant')));
          if (t.revoke_due) files.push(ctx.writeFile(dir, `${p.person_id}-${t.task_id}-remove.md`, accessDraft(p, t, 'remove')));
        }
        return { summary: `${files.length} access draft(s) written (${r.access_ready} grant, ${r.revoke_due} removal). Nothing was submitted or changed.`, files };
      },
    },
    {
      name: 'eos_request_access_grant', kind: 'action', category: 'go_live',
      description: 'After one named human click (even in Auto), record an approved access grant in access-requests.csv for IT to carry out. Re-checks the checklist first and refuses if a prerequisite is not done or the engagement has ended. Eos never grants access.',
      inputSchema: { type: 'object', required: ['people', 'template', 'person_id', 'task_id'], properties: { ...props, person_id: str, task_id: str, out_dir: str } },
      handler: async (a, ctx) => {
        const { p, t } = find(run(a, ctx), a);
        if (t.state === 'done') throw new Error(`${a.task_id} is already marked done for ${a.person_id}`);
        if (!t.ready_to_request) throw new Error(t.waiting_on.length ? `prerequisites not done: ${t.waiting_on.join(', ')}` : `${a.task_id} is not ready to request (${t.state}${p.end_date ? `, end ${p.end_date}` : ''})`);
        const file = appendRow(ctx.outDir(a.out_dir || 'mythos-out/eos'), 'access-requests.csv', { requested_at: new Date().toISOString(), action: 'grant', person_id: p.person_id, name: p.name, task_id: t.task_id, system: t.system, access_level: t.access_level, end_date: p.end_date, reason: 'onboarding', status: 'approved - a person grants it' }, COLS);
        return { summary: `Grant of ${t.system || t.title} for ${p.name} approved and recorded. Access was not changed.`, file };
      },
    },
    {
      name: 'eos_request_access_removal', kind: 'action', category: 'revoke_access',
      description: 'After one named human click (even in Auto), record an approved access removal in access-requests.csv for IT to carry out. Eos never removes access.',
      inputSchema: { type: 'object', required: ['people', 'template', 'person_id', 'task_id', 'reason'], properties: { ...props, person_id: str, task_id: str, reason: str, out_dir: str } },
      handler: async (a, ctx) => {
        if (!String(a.reason ?? '').trim()) throw new Error('reason is required');
        const { p, t } = find(run(a, ctx), a);
        if (t.state !== 'done') throw new Error(`${a.task_id} is not marked granted for ${a.person_id}`);
        const file = appendRow(ctx.outDir(a.out_dir || 'mythos-out/eos'), 'access-requests.csv', { requested_at: new Date().toISOString(), action: 'remove', person_id: p.person_id, name: p.name, task_id: t.task_id, system: t.system, access_level: t.access_level, end_date: p.end_date, reason: a.reason, status: 'approved - a person removes it' }, COLS);
        return { summary: `Removal of ${t.system || t.title} for ${p.name} approved and recorded. Access was not changed.`, file };
      },
    },
    { name: 'idp_grant_access', kind: 'action', category: 'go_live', description: 'Listed so agents can see it is refused. Eos never writes to an identity provider, directory or app.', inputSchema: { type: 'object', properties: {} } },
    { name: 'idp_remove_access', kind: 'action', category: 'revoke_access', description: 'Listed so agents can see it is refused. Eos never removes access itself.', inputSchema: { type: 'object', properties: {} } },
    { name: 'send_email', kind: 'action', category: 'binding_send', description: 'Listed so agents can see it is refused. Eos never sends email.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'eos_status', decision: 'allow' },
    { tool: 'eos_write_tracker', decision: 'allow' },
    { tool: 'eos_draft_access_requests', decision: 'ask', reason: 'Writing access request drafts needs a human yes (or an Auto opt-in).' },
    { tool: 'idp_grant_access', decision: 'block', reason: 'Eos never grants access. A person does it in your identity system.' },
    { tool: 'idp_remove_access', decision: 'block', reason: 'Eos never removes access. A person does it in your identity system.' },
    { tool: 'send_email', decision: 'block', reason: 'Eos never sends email.' },
    { tool: 'eos_request_access_grant', decision: 'ask', reason: 'Granting access is one named human click, even in Auto.' },
    { tool: 'eos_request_access_removal', decision: 'ask', reason: 'Removing access is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Eos allowlist.' },
  ] },
});
