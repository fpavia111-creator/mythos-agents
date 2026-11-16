import { defineManifest, toCsv, sha256, safeFileName } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { status, trackerCsv, summaryMarkdown, accessDraft, parseDate } from './onboarding.js';
import { offboarding, offboardingMarkdown, ownerActions, actionsCsv, trackerIcs, readiness, readinessHtml } from './offboarding.js';
import { TEMPLATE_SCHEMA } from './schema.js';
import { PROMPT } from './prompt.js';
import { SOURCES } from './sources.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }; const num = { type: 'number' };
const props = {
  people: { ...str, description: 'People CSV/JSON: person_id, name, type (employee, contractor, customer…), role, manager, start_date, end_date' },
  template: { ...str, description: 'Checklist template JSON: { "types": { "<type>": [ { id, title, kind (document|equipment|access|training|meeting|task), owner, system, access_level, requires: [task ids], due_offset_days } ] } }' },
  status: { ...str, description: 'Optional task status CSV/JSON: person_id, task_id, status (done, in_progress, blocked, not_started, n/a), done_on, note' },
  as_of: { ...str, description: 'Date to check as of (YYYY-MM-DD, default today)' }, due_soon_days: num,
};
const windowProp = { type: 'integer', minimum: 0, maximum: 365, description: 'Include people whose end date is within this many days (default 14); past end dates stay in while anything is open' };
function load(a, ctx) {
  for (const k of ['people', 'template']) if (!String(a[k] ?? '').trim()) throw new Error(`${k} is required`);
  const tf = ctx.path(a.template); if (!existsSync(tf)) throw new Error(`template not found: ${a.template}`);
  let t; try { t = ctx.readJson(a.template, 'template'); } catch (e) { if (e instanceof SyntaxError) throw new Error(`template is not valid JSON: ${e.message}`); throw e; }
  return { t, people: ctx.records(a.people), rows: a.status ? ctx.records(a.status) : [] };
}
function run(a, ctx) { const { t, people, rows } = load(a, ctx); return status(people, t, rows, a); }
function runOff(a, ctx) { const { t, people, rows } = load(a, ctx); return offboarding(people, t, rows, a); }
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
  sources: SOURCES,
  name: 'eos-of-onboarding',
  version: pkg.version,
  description: 'Tracks onboarding checklists for new employees, contractors or customers from a people CSV, a JSON template and a status CSV: due dates from the start date, overdue and waiting tasks, readiness for day one, access granted before its prerequisites, contractor access with no end date, and access still marked granted after an engagement ended. Per-role templates (role tasks added or removed, unknown roles flagged). An offboarding mirror checklist from the end date, a prioritised action list per owner, a day-one readiness report with its hash in the audit log, and a calendar file. Drafts access requests once prerequisites are done, and removal drafts for offboarding. Granting and removing access are each one human click; Eos never touches an identity system.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  configSchemas: { template: TEMPLATE_SCHEMA },
  prompts: [PROMPT],
  tools: [
    {
      name: 'eos_status', kind: 'read',
      description: 'Per person: task states (done, overdue, due_soon, waiting, blocked, ready, open), percent done, next tasks and flags; totals of access requests ready and removals due.',
      inputSchema: { type: 'object', required: ['people', 'template'], properties: props },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.people} people, ${r.done}/${r.tasks} tasks done, ${r.overdue} overdue, ${r.waiting} waiting; ${r.access_ready} access request(s) ready, ${r.revoke_due} removal(s) due. Flags: ${r.flagged.join('; ') || 'none'}.`, ...r }; },
    },
    {
      name: 'eos_write_tracker', kind: 'report',
      description: 'Write onboarding-tracker.csv (blank checked_by column), onboarding.md, owner-actions.csv (prioritised per owner, blank done_by column) and onboarding-calendar.ics (open tasks by due date, onboarding and offboarding) into out_dir (default mythos-out/eos).',
      inputSchema: { type: 'object', required: ['people', 'template'], properties: { ...props, window_days: windowProp, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const off = runOff(a, ctx); const acts = ownerActions(r, off); const out = ctx.outDir(a.out_dir || 'mythos-out/eos');
        return { summary: `Tracker written for ${r.people} people; ${acts.actions} open action(s) across ${acts.owners.length} owner(s).`, files: [ctx.writeFile(out, 'onboarding-tracker.csv', trackerCsv(r)), ctx.writeFile(out, 'onboarding.md', summaryMarkdown(r)), ctx.writeFile(out, 'owner-actions.csv', actionsCsv(acts)), ctx.writeFile(out, 'onboarding-calendar.ics', trackerIcs(r, off))] };
      },
    },
    {
      name: 'eos_offboarding', kind: 'read', title: 'Offboarding mirror checklist',
      description: 'For people whose end date is within window_days (or past, while anything is open): a mirror of what was granted. Each access task marked granted becomes remove-<task>, each equipment task marked done becomes return-<task>, plus the template\'s offboarding tasks for the type, all due from the end date, with states and flags (access_removal_overdue, equipment_not_returned).',
      inputSchema: { type: 'object', required: ['people', 'template'], properties: { ...props, window_days: windowProp } },
      handler: async (a, ctx) => { const r = runOff(a, ctx); return { summary: `${r.people} people offboarding: ${r.removals_open} access removal(s) open (${r.removals_overdue} overdue), ${r.returns_open} equipment return(s) open. Flags: ${r.flagged.join('; ') || 'none'}.`, ...r }; },
    },
    {
      name: 'eos_owner_actions', kind: 'read', title: 'Prioritised actions per owner',
      description: 'One prioritised list per owner (IT, Ops, Finance, Manager…) across onboarding and offboarding: overdue access removals, overdue tasks, blocked tasks, day-one blockers, tasks due soon, access requests ready, open and waiting tasks. Every item states its reason.',
      inputSchema: { type: 'object', required: ['people', 'template'], properties: { ...props, window_days: windowProp, owner: { ...str, description: 'Only this owner' } } },
      handler: async (a, ctx) => {
        const r = ownerActions(run(a, ctx), runOff(a, ctx));
        if (a.owner) { r.items = r.items.filter((x) => x.owner.toLowerCase() === a.owner.toLowerCase()); r.owners = r.owners.filter((x) => x.owner.toLowerCase() === a.owner.toLowerCase()); r.actions = r.items.length; }
        return { summary: `${r.actions} open action(s): ${r.owners.map((o) => `${o.owner} ${o.open}${o.overdue ? ` (${o.overdue} overdue)` : ''}`).join(', ') || 'none'}.`, ...r };
      },
    },
    {
      name: 'eos_readiness_report', kind: 'report', title: 'Day-one readiness report',
      description: 'Check people starting within within_days (default 7) of as_of, or the listed person_ids: every task due on or before the start date done, no access granted before its prerequisites, contractors with an end date, a known role. Writes readiness.html (self-contained) and readiness.json; the JSON hash is recorded in the audit log as output_sha256.',
      inputSchema: { type: 'object', required: ['people', 'template'], properties: { ...props, within_days: { type: 'integer', minimum: 0, maximum: 90 }, person_ids: { type: 'array', items: str }, out_dir: str } },
      handler: async (a, ctx) => {
        const r = readiness(run(a, ctx), a); const out = ctx.outDir(a.out_dir || 'mythos-out/eos/readiness');
        const json = JSON.stringify(r, null, 2) + '\n';
        const files = [ctx.writeFile(out, 'readiness.html', readinessHtml(r)), ctx.writeFile(out, 'readiness.json', json)];
        return { summary: `${r.ready} of ${r.people} ready for day one.${r.items.filter((p) => !p.ready).map((p) => ` ${p.person_id} blocked by: ${p.blocking.join('; ')}.`).join('')}`, ...r, output_sha256: sha256(json), files };
      },
    },
    {
      name: 'eos_draft_access_requests', kind: 'write',
      description: 'Write a request draft (marked DRAFT, not submitted) for each access task whose prerequisites are done, and a removal draft for access still granted after an engagement ended, into out_dir/access-requests. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['people', 'template'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const dir = join(ctx.outDir(a.out_dir || 'mythos-out/eos'), 'access-requests'); mkdirSync(dir, { recursive: true }); const files = [];
        for (const p of r.items) for (const t of p.tasks) {
          if (t.ready_to_request) files.push(ctx.writeFile(dir, `${safeFileName(p.person_id)}-${safeFileName(t.task_id)}-grant.md`, accessDraft(p, t, 'grant')));
          if (t.revoke_due) files.push(ctx.writeFile(dir, `${safeFileName(p.person_id)}-${safeFileName(t.task_id)}-remove.md`, accessDraft(p, t, 'remove')));
        }
        return { summary: `${files.length} access draft(s) written (${r.access_ready} grant, ${r.revoke_due} removal). Nothing was submitted or changed.`, files };
      },
    },
    {
      name: 'eos_draft_offboarding', kind: 'write', title: 'Draft offboarding removals',
      description: 'For people in the offboarding window, write offboarding/<person>-offboarding.md (the mirror checklist) and a removal draft (marked DRAFT, not submitted) for every access still marked granted, dated for the end date. Recording a removal is a separate one-click step (eos_request_access_removal). Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['people', 'template'], properties: { ...props, window_days: windowProp, out_dir: str } },
      handler: async (a, ctx) => {
        const r = runOff(a, ctx); const st = run(a, ctx); const dir = join(ctx.outDir(a.out_dir || 'mythos-out/eos'), 'offboarding'); mkdirSync(dir, { recursive: true }); const files = []; let drafts = 0;
        const asOf = parseDate(r.as_of);
        const byPerson = new Map(); for (const x of st.items) if (!byPerson.has(x.person_id)) byPerson.set(x.person_id, x);
        for (const p of r.items) {
          files.push(ctx.writeFile(dir, `${safeFileName(p.person_id)}-offboarding.md`, offboardingMarkdown(p)));
          const person = byPerson.get(p.person_id);
          for (const t of p.tasks) if (t.kind === 'access_removal' && t.state !== 'done') { const orig = person.tasks.find((x) => x.task_id === t.mirrors); files.push(ctx.writeFile(dir, `${safeFileName(p.person_id)}-${safeFileName(t.mirrors)}-remove.md`, accessDraft(person, orig, 'remove', asOf))); drafts++; }
        }
        return { summary: `${r.people} offboarding checklist(s) and ${drafts} removal draft(s) written. Nothing was submitted or changed.`, files };
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
    { tool: 'eos_offboarding', decision: 'allow' },
    { tool: 'eos_owner_actions', decision: 'allow' },
    { tool: 'eos_readiness_report', decision: 'allow' },
    { tool: 'eos_draft_offboarding', decision: 'ask', reason: 'Writing offboarding drafts needs a human yes (or an Auto opt-in).' },
    { tool: 'eos_draft_access_requests', decision: 'ask', reason: 'Writing access request drafts needs a human yes (or an Auto opt-in).' },
    { tool: 'idp_grant_access', decision: 'block', reason: 'Eos never grants access. A person does it in your identity system.' },
    { tool: 'idp_remove_access', decision: 'block', reason: 'Eos never removes access. A person does it in your identity system.' },
    { tool: 'send_email', decision: 'block', reason: 'Eos never sends email.' },
    { tool: 'eos_request_access_grant', decision: 'ask', reason: 'Granting access is one named human click, even in Auto.' },
    { tool: 'eos_request_access_removal', decision: 'ask', reason: 'Removing access is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Eos allowlist.' },
  ] },
});
