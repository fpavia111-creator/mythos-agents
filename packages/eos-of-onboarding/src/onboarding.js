import { toCsv, slugify } from 'mythos-agent-core';

const DAY = 86400000;
const norm = (k) => String(k).trim().toLowerCase().replace(/[\s-]+/g, '_');
export function pick(r, ...keys) {
  for (const k of keys) for (const key of Object.keys(r || {})) if (norm(key) === k && String(r[key] ?? '').trim() !== '') return String(r[key]).trim();
  return '';
}
export function parseDate(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim()); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; }
const iso = (t) => new Date(t).toISOString().slice(0, 10);
function asOfMs(as_of) {
  if (as_of) { const t = parseDate(as_of); if (t === null) throw new Error(`as_of must be YYYY-MM-DD, got "${as_of}"`); return t; }
  const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}
export const slug = (s) => slugify(s, '');
const DONE = new Set(['done', 'complete', 'completed', 'n/a', 'na', 'not_applicable', 'waived']);

export function validateTemplate(t) {
  if (!t || typeof t !== 'object' || !t.types || typeof t.types !== 'object') throw new Error('template must be JSON with a "types" object (employee, contractor, customer, …)');
  const check = (label, tasks, extraIds = []) => {
    if (!Array.isArray(tasks)) throw new Error(`${label} must be an array of tasks`);
    const ids = new Set([...tasks.map((x) => x.id), ...extraIds]);
    for (const x of tasks) {
      if (!x.id || !x.title) throw new Error(`${label}: every task needs id and title`);
      for (const r of x.requires || []) if (!ids.has(r)) throw new Error(`${label}.${x.id} requires unknown task "${r}"`);
    }
  };
  for (const [type, tasks] of Object.entries(t.types)) check(`template.types.${type}`, tasks);
  const allIds = Object.values(t.types).flatMap((ts) => ts.map((x) => x.id));
  for (const [role, r] of Object.entries(t.roles || {})) {
    if (r.type && !t.types[r.type]) throw new Error(`template.roles.${role}.type "${r.type}" is not a type in the template`);
    const base = r.type ? t.types[r.type].map((x) => x.id) : allIds;
    check(`template.roles.${role}.add`, r.add || [], base);
    for (const id of r.remove || []) if (!base.includes(id)) throw new Error(`template.roles.${role}.remove names unknown task "${id}"`);
  }
  for (const [type, tasks] of Object.entries(t.offboarding || {})) check(`template.offboarding.${type}`, tasks);
  return t;
}

/** The checklist for a person: the type's tasks, with the role's removals and additions. */
export function checklistFor(t, type, role) {
  const base = t.types[type]; if (!base) return { tasks: null, role_template: null, role_known: false };
  if (!t.roles) return { tasks: base, role_template: null, role_known: true };
  const key = Object.keys(t.roles).find((k) => k.trim().toLowerCase() === String(role || '').trim().toLowerCase());
  const r = key ? t.roles[key] : null;
  if (!r || (r.type && r.type !== type)) return { tasks: base, role_template: null, role_known: false, role_type: r ? r.type : null };
  const drop = new Set(r.remove || []);
  return { tasks: base.filter((x) => !drop.has(x.id)).concat(r.add || []), role_template: key, role_known: true, removed: base.filter((x) => drop.has(x.id)) };
}
/** Task ids used by offboarding (mirror ids and template offboarding tasks) for a type's checklist. */
const offIds = (t, type, tasks) => new Set([...tasks.filter((x) => x.kind === 'access').map((x) => `remove-${x.id}`), ...tasks.filter((x) => x.kind === 'equipment').map((x) => `return-${x.id}`), ...((t.offboarding || {})[type] || []).map((x) => x.id)]);

/**
 * Onboarding status per person. Task states: done, overdue, due_soon, blocked, waiting, ready, open.
 * Access tasks become ready_to_request only when everything they require is done.
 */
export function status(people, template, statusRows = [], a = {}) {
  const t = validateTemplate(template); const now = asOfMs(a.as_of); const soon = Number(a.due_soon_days) || 3;
  const st = new Map(); const unknown = [];
  for (const r of statusRows) st.set(`${pick(r, 'person_id', 'person')}|${pick(r, 'task_id', 'task')}`, { status: pick(r, 'status').toLowerCase().replace(/\s+/g, '_'), done_on: pick(r, 'done_on', 'completed_on'), note: pick(r, 'note') });
  // Task ids in the status file per person id, in file order (one pass instead of one scan per person).
  const tidsOf = new Map();
  for (const k of st.keys()) { const [pid, tid] = k.split('|'); if (!tidsOf.has(pid)) tidsOf.set(pid, []); tidsOf.get(pid).push(tid); }
  const out = people.map((p, i) => {
    const person = { person_id: pick(p, 'person_id', 'id') || `P${i + 1}`, name: pick(p, 'name', 'full_name'), type: pick(p, 'type', 'kind').toLowerCase(), role: pick(p, 'role', 'title'), manager: pick(p, 'manager', 'owner'), start_date: pick(p, 'start_date', 'start'), end_date: pick(p, 'end_date', 'end') };
    const cl = checklistFor(t, person.type, person.role); const tasks = cl.tasks; const flags = []; const notes = [];
    if (!tasks) return { ...person, flags: ['unknown_type'], tasks: [], percent_done: 0, overdue: 0, notes: [`No checklist for type "${person.type}" in the template.`] };
    person.role_template = cl.role_template;
    if (!cl.role_known) { flags.push('unknown_role'); notes.push(cl.role_type ? `Role "${person.role}" is set up for type ${cl.role_type}, not ${person.type}; the ${person.type} checklist was used.` : `Role "${person.role || '(none)'}" has no role template; the ${person.type} checklist was used. Add the role to the template or check the spelling.`); }
    const start = parseDate(person.start_date); const end = parseDate(person.end_date);
    for (const x of cl.removed || []) if (x.kind === 'access' && DONE.has((st.get(`${person.person_id}|${x.id}`) || {}).status)) { flags.push('access_outside_role'); notes.push(`${x.system || x.title} access is marked granted, but the ${cl.role_template} role does not include it. Check whether it is needed.`); }
    const known = new Set([...tasks.map((x) => x.id), ...offIds(t, person.type, tasks), ...(cl.removed || []).filter((x) => x.kind === 'access').map((x) => x.id)]);
    for (const tid of tidsOf.get(person.person_id) || []) if (!known.has(tid)) unknown.push(`${person.person_id}/${tid}`);
    const isDone = (id) => DONE.has((st.get(`${person.person_id}|${id}`) || {}).status);
    const rows = tasks.map((x) => {
      const s = st.get(`${person.person_id}|${x.id}`) || { status: 'not_started' };
      const due = start === null || x.due_offset_days === undefined ? null : start + Number(x.due_offset_days) * DAY;
      const missing = (x.requires || []).filter((r) => !isDone(r));
      let state;
      if (DONE.has(s.status)) state = 'done';
      else if (s.status === 'blocked') state = 'blocked';
      else if (missing.length) state = 'waiting';
      else if (due !== null && due < now) state = 'overdue';
      else if (due !== null && due - now <= soon * DAY) state = 'due_soon';
      else state = x.kind === 'access' ? 'ready' : 'open';
      const row = { task_id: x.id, title: x.title, kind: x.kind || 'task', owner: x.owner || '', system: x.system || '', access_level: x.access_level || '', due: due === null ? '' : iso(due), status: s.status, state, requires: x.requires || [], waiting_on: missing, note: s.note || '' };
      if (x.kind === 'access') {
        if (state === 'done' && missing.length) { flags.push('access_before_prereqs'); row.risk = `Marked done before ${missing.join(', ')}.`; }
        row.ready_to_request = state !== 'done' && state !== 'blocked' && !missing.length && !(end !== null && end < now);
        if (state === 'done' && end !== null && end < now) { flags.push('access_after_end'); row.revoke_due = true; row.risk = `Engagement ended ${person.end_date}; access is still marked granted.`; }
      }
      return row;
    });
    if (person.type === 'contractor' && end === null && tasks.some((x) => x.kind === 'access')) flags.push('contractor_no_end_date');
    const open = rows.filter((r) => r.state !== 'done');
    const dayOne = rows.filter((r) => r.due && start !== null && parseDate(r.due) <= start && r.state !== 'done');
    if (start !== null && start >= now && start - now <= soon * DAY && dayOne.length) flags.push('not_ready_for_start');
    return { ...person, flags: [...new Set(flags)], percent_done: Math.round((rows.length - open.length) / rows.length * 100), overdue: rows.filter((r) => r.state === 'overdue').length, next: open.filter((r) => ['overdue', 'due_soon', 'ready', 'open'].includes(r.state)).slice(0, 3).map((r) => r.task_id), tasks: rows, notes };
  });
  const flat = out.flatMap((p) => p.tasks.map((r) => ({ ...r, person_id: p.person_id })));
  return {
    as_of: iso(now), people: out.length, tasks: flat.length, done: flat.filter((r) => r.state === 'done').length, overdue: flat.filter((r) => r.state === 'overdue').length, waiting: flat.filter((r) => r.state === 'waiting').length,
    access_ready: flat.filter((r) => r.ready_to_request).length, revoke_due: flat.filter((r) => r.revoke_due).length,
    flagged: out.filter((p) => p.flags.length).map((p) => `${p.person_id}: ${p.flags.join(', ')}`), unknown_status_rows: unknown,
    items: out,
    note: 'A checklist tracker, not HR, employment or legal advice. Eos never grants or removes access; it drafts requests for a person.',
  };
}
export const TRACKER_COLUMNS = ['person_id', 'name', 'type', 'start_date', 'task_id', 'title', 'kind', 'owner', 'system', 'due', 'status', 'state', 'waiting_on', 'note', 'checked_by'];
export const trackerCsv = (r) => toCsv(r.items.flatMap((p) => p.tasks.map((t) => ({ ...p, ...t, waiting_on: t.waiting_on.join('; '), checked_by: '' }))), TRACKER_COLUMNS);
export function summaryMarkdown(r) {
  const L = ['# Onboarding status', '', `As of ${r.as_of}: ${r.people} people, ${r.done}/${r.tasks} tasks done, ${r.overdue} overdue, ${r.waiting} waiting on another task, ${r.access_ready} access request(s) ready to draft, ${r.revoke_due} access removal(s) due.`, '', `> ${r.note}`, ''];
  for (const p of r.items) {
    L.push(`## ${p.name} (${p.type}${p.role ? `, ${p.role}` : ''}) — ${p.percent_done}% done`, '', `Start ${p.start_date || '—'}${p.end_date ? `, end ${p.end_date}` : ''}. Manager: ${p.manager || '—'}.${p.flags.length ? ` **Flags: ${p.flags.join(', ')}**` : ''}`, '');
    for (const t of p.tasks) L.push(`- [${t.state === 'done' ? 'x' : ' '}] ${t.title} (${t.state}${t.due ? `, due ${t.due}` : ''}${t.waiting_on.length ? `, waiting on ${t.waiting_on.join(', ')}` : ''})${t.risk ? ` — ${t.risk}` : ''}`);
    L.push('');
  }
  return L.join('\n');
}
export function accessDraft(p, t, kind = 'grant', asOf = null) {
  return [`DRAFT — not submitted. Eos does not ${kind === 'grant' ? 'grant' : 'remove'} access.`, '', `Request: ${kind === 'grant' ? 'Grant' : 'Remove'} ${t.system || t.title} access${t.access_level && kind === 'grant' ? ` (${t.access_level})` : ''}`, `For: ${p.name} (${p.person_id}), ${p.type}${p.role ? `, ${p.role}` : ''}`, `Requested by: ${p.manager || '[MANAGER]'}`, kind === 'grant' ? `Start: ${p.start_date || '[START DATE]'}` : `${asOf !== null && parseDate(p.end_date) > asOf ? 'Engagement ends' : 'Engagement ended'}: ${p.end_date}${asOf !== null && parseDate(p.end_date) > asOf ? ' (remove access on that date, not before)' : ''}`, kind === 'grant' && p.type === 'contractor' ? `Access end date: ${p.end_date || '[SET AN END DATE]'}` : '', '', kind === 'grant' ? `Prerequisites done: ${(t.requires || []).join(', ') || 'none listed'}` : (asOf !== null && parseDate(p.end_date) > asOf ? 'Reason: engagement ending.' : 'Reason: engagement ended.'), '', 'Approver: [NAME] — approve in your identity or IT system.', ''].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}
