import { toCsv, toIcs, sha256, htmlPage, escapeHtml } from 'mythos-agent-core';
import { status, pick, parseDate } from './onboarding.js';

const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const DONE = new Set(['done', 'complete', 'completed', 'n/a', 'na', 'not_applicable', 'waived']);

/**
 * Offboarding mirror checklist for people whose end date is within window_days (or past,
 * while anything is still open). Every access task marked granted becomes "remove-<id>",
 * every equipment task marked done becomes "return-<id>", plus the template's
 * offboarding tasks for the type. Due dates count from the end date.
 */
export function offboarding(people, template, statusRows = [], a = {}) {
  const base = status(people, template, statusRows, a);
  const now = parseDate(base.as_of); const soon = Number(a.due_soon_days) || 3;
  const win = a.window_days !== undefined ? Number(a.window_days) : 14;
  const accessOffset = Number(template.offboarding_access_offset_days) || 0;
  const st = new Map(); for (const r of statusRows) st.set(`${pick(r, 'person_id', 'person')}|${pick(r, 'task_id', 'task')}`, { status: pick(r, 'status').toLowerCase().replace(/\s+/g, '_'), note: pick(r, 'note') });
  const out = [];
  for (const p of base.items) {
    const end = parseDate(p.end_date); if (end === null || !p.tasks.length) continue;
    const daysToEnd = Math.round((end - now) / DAY);
    const mk = (x) => {
      const s = st.get(`${p.person_id}|${x.task_id}`) || { status: 'not_started', note: '' };
      const state = DONE.has(s.status) ? 'done' : s.status === 'blocked' ? 'blocked' : x.due < now ? 'overdue' : x.due - now <= soon * DAY ? 'due_soon' : 'open';
      return { ...x, due: iso(x.due), status: s.status, state, note: s.note };
    };
    const tasks = [];
    for (const t of p.tasks) {
      if (t.kind === 'access' && t.state === 'done') tasks.push(mk({ task_id: `remove-${t.task_id}`, mirrors: t.task_id, title: `Remove ${t.system || t.title} access`, kind: 'access_removal', owner: t.owner, system: t.system, access_level: t.access_level, due: end + accessOffset * DAY }));
      if (t.kind === 'equipment' && t.state === 'done') tasks.push(mk({ task_id: `return-${t.task_id}`, mirrors: t.task_id, title: `Return: ${t.title}`, kind: 'equipment_return', owner: t.owner, system: '', access_level: '', due: end }));
    }
    for (const x of (template.offboarding || {})[p.type] || []) tasks.push(mk({ task_id: x.id, mirrors: '', title: x.title, kind: x.kind || 'task', owner: x.owner || '', system: x.system || '', access_level: x.access_level || '', due: end + (Number(x.due_offset_days) || 0) * DAY }));
    const open = tasks.filter((x) => x.state !== 'done');
    if (daysToEnd > win || (daysToEnd < 0 && !open.length)) continue;
    const flags = [];
    if (open.some((x) => x.kind === 'access_removal' && x.state === 'overdue')) flags.push('access_removal_overdue');
    if (open.some((x) => x.kind === 'equipment_return' && x.state === 'overdue')) flags.push('equipment_not_returned');
    out.push({ person_id: p.person_id, name: p.name, type: p.type, role: p.role, manager: p.manager, start_date: p.start_date, end_date: p.end_date, days_to_end: daysToEnd, flags, percent_done: tasks.length ? Math.round((tasks.length - open.length) / tasks.length * 100) : 100, tasks });
  }
  const flat = out.flatMap((p) => p.tasks);
  return {
    as_of: base.as_of, window_days: win, people: out.length, tasks: flat.length, done: flat.filter((x) => x.state === 'done').length,
    removals_open: flat.filter((x) => x.kind === 'access_removal' && x.state !== 'done').length, removals_overdue: flat.filter((x) => x.kind === 'access_removal' && x.state === 'overdue').length,
    returns_open: flat.filter((x) => x.kind === 'equipment_return' && x.state !== 'done').length,
    flagged: out.filter((p) => p.flags.length).map((p) => `${p.person_id}: ${p.flags.join(', ')}`), items: out,
    note: 'An offboarding checklist, not HR, employment or legal advice. Eos never removes access; removals are recorded only after one named human click.',
  };
}

export function offboardingMarkdown(p) {
  const L = [`# Offboarding: ${p.name} (${p.type}${p.role ? `, ${p.role}` : ''})`, '', `End date ${p.end_date} (${p.days_to_end >= 0 ? `in ${p.days_to_end} day(s)` : `${-p.days_to_end} day(s) ago`}). Manager: ${p.manager || '—'}.${p.flags.length ? ` **Flags: ${p.flags.join(', ')}**` : ''}`, ''];
  for (const t of p.tasks) L.push(`- [${t.state === 'done' ? 'x' : ' '}] ${t.title} (${t.state}, due ${t.due}${t.owner ? `, ${t.owner}` : ''})`);
  L.push('', 'Removing access is recorded only after one named person approves it (eos_request_access_removal). Eos changes nothing in your systems.', '');
  return L.join('\n');
}

/**
 * One prioritised action list per owner, across onboarding and offboarding. Every item says
 * why it is where it is. Priority: removal overdue > overdue > blocked > day-one blocker >
 * due soon > access ready to request > open > waiting.
 */
export function ownerActions(st, off = null) {
  const now = parseDate(st.as_of); const items = [];
  const days = (d) => Math.round((parseDate(d) - now) / DAY);
  for (const p of st.items) {
    const startSoon = p.flags.includes('not_ready_for_start');
    for (const t of p.tasks) {
      if (t.state === 'done') continue;
      let priority; let reason;
      if (t.state === 'overdue') { priority = 100 + Math.min(50, -days(t.due)); reason = `overdue by ${-days(t.due)} day(s)`; }
      else if (t.state === 'blocked') { priority = 80; reason = `blocked${t.note ? `: ${t.note}` : ''}`; }
      else if (startSoon && t.due && parseDate(t.due) <= parseDate(p.start_date)) { priority = 90; reason = `needed before ${p.name} starts on ${p.start_date}`; }
      else if (t.state === 'due_soon') { priority = 70 - days(t.due); reason = `due in ${days(t.due)} day(s)`; }
      else if (t.ready_to_request) { priority = 50; reason = 'access request ready to draft (prerequisites done)'; }
      else if (t.state === 'waiting') { priority = 10; reason = `waiting on ${t.waiting_on.join(', ')}`; }
      else { priority = 20; reason = t.due ? `open, due ${t.due}` : 'open'; }
      items.push({ owner: t.owner || '(no owner)', priority, person_id: p.person_id, name: p.name, task_id: t.task_id, title: t.title, due: t.due, state: t.state, reason, flow: 'onboarding' });
    }
  }
  for (const p of off ? off.items : []) for (const t of p.tasks) {
    if (t.state === 'done') continue;
    const d = days(t.due); const removal = t.kind === 'access_removal';
    const priority = t.state === 'overdue' ? (removal ? 150 : 100) + Math.min(50, -d) : t.state === 'due_soon' ? 70 - d : 30;
    const reason = t.state === 'overdue' ? `${removal ? 'access still granted ' : ''}overdue by ${-d} day(s) (end date ${p.end_date})` : `due ${t.due} (end date ${p.end_date})`;
    items.push({ owner: t.owner || '(no owner)', priority, person_id: p.person_id, name: p.name, task_id: t.task_id, title: t.title, due: t.due, state: t.state, reason, flow: 'offboarding' });
  }
  items.sort((a, b) => b.priority - a.priority || a.owner.localeCompare(b.owner) || (a.due || '9').localeCompare(b.due || '9') || a.person_id.localeCompare(b.person_id) || a.task_id.localeCompare(b.task_id));
  const owners = [...new Set(items.map((x) => x.owner))].sort().map((o) => { const its = items.filter((x) => x.owner === o); return { owner: o, open: its.length, overdue: its.filter((x) => x.state === 'overdue').length, top: its.slice(0, 5).map((x) => `${x.person_id}/${x.task_id}: ${x.reason}`) }; });
  return { as_of: st.as_of, actions: items.length, owners, items };
}
export const ACTION_COLUMNS = ['owner', 'priority', 'flow', 'person_id', 'name', 'task_id', 'title', 'due', 'state', 'reason', 'done_by'];
export const actionsCsv = (r) => toCsv(r.items.map((x) => ({ ...x, done_by: '' })), ACTION_COLUMNS);

/** All-day calendar events for open tasks with a due date (onboarding and offboarding). */
export function trackerIcs(st, off = null) {
  const ev = [];
  for (const p of st.items) for (const t of p.tasks) if (t.state !== 'done' && t.due) ev.push({ date: t.due, uid: `${sha256(`${p.person_id}|${t.task_id}`).slice(0, 24)}@eos.local`, summary: `${p.name}: ${t.title}${t.owner ? ` (${t.owner})` : ''}`, description: `State ${t.state}${t.waiting_on.length ? `, waiting on ${t.waiting_on.join(', ')}` : ''}.`, categories: ['onboarding'], reminders: [1] });
  for (const p of off ? off.items : []) for (const t of p.tasks) if (t.state !== 'done') ev.push({ date: t.due, uid: `${sha256(`${p.person_id}|${t.task_id}`).slice(0, 24)}@eos.local`, summary: `${p.name}: ${t.title}${t.owner ? ` (${t.owner})` : ''}`, description: `Offboarding, end date ${p.end_date}.`, categories: ['offboarding'], reminders: [1] });
  ev.sort((a, b) => a.date.localeCompare(b.date) || a.summary.localeCompare(b.summary));
  return toIcs(ev, { calName: 'Onboarding and offboarding', prodId: '-//Mythos Machine//eos-of-onboarding//EN' });
}

/**
 * Day-one readiness for people starting within within_days of as_of (or the listed person_ids):
 * every task due on or before the start date is done, no access granted before its prerequisites,
 * contractors with access have an end date.
 */
export function readiness(st, a = {}) {
  const now = parseDate(st.as_of); const within = a.within_days !== undefined ? Number(a.within_days) : 7;
  const inScope = (p) => (a.person_ids && a.person_ids.length ? a.person_ids.includes(p.person_id) : (() => { const s = parseDate(p.start_date); return s !== null && s >= now && s - now <= within * DAY; })());
  const people = st.items.filter((p) => p.tasks.length && inScope(p)).map((p) => {
    const start = parseDate(p.start_date); const checks = [];
    const pre = p.tasks.filter((t) => t.due && start !== null && parseDate(t.due) <= start);
    for (const t of pre) checks.push({ check: `${t.task_id} done before start`, pass: t.state === 'done', detail: t.state === 'done' ? `${t.title}: done` : `${t.title}: ${t.state}${t.waiting_on.length ? ` (waiting on ${t.waiting_on.join(', ')})` : ''}${t.owner ? `, owner ${t.owner}` : ''}` });
    checks.push({ check: 'access only after prerequisites', pass: !p.flags.includes('access_before_prereqs'), detail: p.flags.includes('access_before_prereqs') ? p.tasks.filter((t) => t.risk).map((t) => t.risk).join(' ') : 'no access marked granted early' });
    if (p.type === 'contractor') checks.push({ check: 'contractor has an end date', pass: !!p.end_date, detail: p.end_date ? `ends ${p.end_date}` : 'no end date: access would have no expiry' });
    if (p.flags.includes('unknown_role')) checks.push({ check: 'role has a template', pass: false, detail: `role "${p.role}" is not in the template` });
    const failed = checks.filter((c) => !c.pass);
    return { person_id: p.person_id, name: p.name, type: p.type, role: p.role, start_date: p.start_date, days_to_start: start === null ? null : Math.round((start - now) / DAY), ready: failed.length === 0, blocking: failed.map((c) => c.detail), checks };
  });
  return { as_of: st.as_of, within_days: a.person_ids && a.person_ids.length ? null : within, people: people.length, ready: people.filter((p) => p.ready).length, not_ready: people.filter((p) => !p.ready).length, items: people, note: 'Readiness against your own checklist. Not HR, employment or legal advice.' };
}
export function readinessHtml(r) {
  const e = escapeHtml; const b = [`<h1>Day-one readiness</h1><p class="mut">As of ${e(r.as_of)}. ${r.ready} of ${r.people} ready.</p>`];
  for (const p of r.items) {
    b.push(`<h2>${e(p.name)} <span class="mut">(${e(p.type)}${p.role ? `, ${e(p.role)}` : ''}, starts ${e(p.start_date)})</span> — <span class="${p.ready ? 'ok' : 'bad'}">${p.ready ? 'ready' : 'not ready'}</span></h2>`);
    b.push('<div class="wrap"><table><tr><th>Check</th><th>Result</th><th>Detail</th></tr>' + p.checks.map((c) => `<tr><td>${e(c.check)}</td><td class="${c.pass ? 'ok' : 'bad'}">${c.pass ? 'pass' : 'fail'}</td><td>${e(c.detail)}</td></tr>`).join('') + '</table></div>');
  }
  if (!r.items.length) b.push('<p class="mut">Nobody starts in the window.</p>');
  return htmlPage({ title: 'Day-one readiness', bodyHtml: b.join('\n'), footer: r.note });
}
