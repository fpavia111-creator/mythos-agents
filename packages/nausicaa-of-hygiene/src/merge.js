// Merge suggestions for duplicate contacts: pick a survivor and a winner for each field,
// with the rule that decided it. Suggestions only; your CRM admin merges.
import { toCsv } from 'mythos-agent-core';

const t = (d) => { const x = Date.parse(d); return Number.isFinite(x) ? x : -Infinity; };
const filled = (c) => ['email', 'name', 'company', 'last_activity', 'consent', 'consent_date', 'consent_source'].filter((k) => c[k]).length;
const hardBounced = (c) => /hard|permanent|invalid|5\d\d/.test(c.bounce || '') || c.status === 'bounced';
const optedOut = (c) => /^(yes|true|1|y|opted.?out|unsubscribed)$/i.test(c.unsubscribed || '') || c.status === 'unsubscribed' || /^(no|false|0|n|opted.?out|withdrawn|unsubscribed|none)$/i.test(c.consent || '');
const optedIn = (c) => /^(yes|true|1|y|opted.?in|granted|subscribed)$/i.test(c.consent || '');

export const SURVIVOR_RULES = Object.freeze([
  'S1 a record that has not hard-bounced',
  'S2 the most recent last_activity',
  'S3 the most complete record (most fields filled)',
  'S4 the earliest row in the export',
]);

function pickSurvivor(group) {
  return [...group].sort((a, b) => (hardBounced(a) - hardBounced(b)) || (t(b.last_activity) - t(a.last_activity)) || (filled(b) - filled(a)) || (a.row - b.row))[0];
}
function why(survivor, group) {
  const others = group.filter((c) => c !== survivor);
  if (others.some((c) => hardBounced(c)) && !hardBounced(survivor)) return 'S1: the other record(s) hard-bounced';
  if (others.every((c) => t(survivor.last_activity) > t(c.last_activity))) return `S2: most recent activity (${survivor.last_activity})`;
  if (others.every((c) => filled(survivor) > filled(c))) return 'S3: most complete record';
  return 'S4: earliest row (other rules tied)';
}
const mostRecent = (group, field) => [...group].filter((c) => c[field]).sort((a, b) => (t(b.last_activity) - t(a.last_activity)) || (String(b[field]).length - String(a[field]).length) || (a.row - b.row))[0];

/**
 * contacts: normContacts output; items: audit(...).items (for canonical keys).
 * Returns groups with survivor, merge ids and per-field winners with the rule applied.
 */
export function mergePlan(contacts, items) {
  const groups = new Map();
  items.forEach((it, i) => { if (!it.canonical) return; const g = groups.get(it.canonical) || []; g.push(contacts[i]); groups.set(it.canonical, g); });
  const out = [];
  for (const [key, g] of groups) {
    if (g.length < 2) continue;
    const s = pickSurvivor(g); const fields = [];
    const add = (field, from, rule) => fields.push({ field, value: from ? from[field] || '' : '', from_id: from ? from.id : '', rule });
    add('email', s, 'F1 survivor\'s address (all variants share the canonical form)');
    const nm = mostRecent(g, 'name'); add('name', nm, 'F2 most recently active non-empty value; longer wins a tie');
    const co = mostRecent(g, 'company'); add('company', co, 'F2 most recently active non-empty value; longer wins a tie');
    const la = [...g].sort((a, b) => t(b.last_activity) - t(a.last_activity))[0]; add('last_activity', la, 'F3 latest date across the records');
    const out1 = g.find(optedOut);
    if (out1) {
      fields.push({ field: 'consent', value: 'no', from_id: out1.id, rule: 'F4 an opt-out on any record carries over (most restrictive wins)' });
      fields.push({ field: 'unsubscribed', value: 'yes', from_id: out1.id, rule: 'F4 an opt-out on any record carries over (most restrictive wins)' });
    } else {
      const yesDated = [...g].filter((c) => optedIn(c)).sort((a, b) => (!!b.consent_date - !!a.consent_date) || (!!b.consent_source - !!a.consent_source) || (t(b.consent_date) - t(a.consent_date)) || (a.row - b.row))[0];
      for (const f of ['consent', 'consent_date', 'consent_source']) add(f, yesDated || null, yesDated ? 'F5 consent fields come together from one opted-in record, preferring one with a date and source, then the most recent' : 'F5 no record holds an opt-in');
    }
    const hb = g.find(hardBounced);
    if (hb) fields.push({ field: 'bounce', value: hb.bounce || 'hard', from_id: hb.id, rule: 'F6 a hard bounce on any variant of the address carries over' });
    out.push({ canonical: key, survivor_id: s.id, merge_ids: g.filter((c) => c !== s).map((c) => c.id), survivor_rule: why(s, g), records: g.map((c) => ({ id: c.id, row: c.row })), fields });
  }
  return { groups: out.length, contacts_merged_away: out.reduce((n, g) => n + g.merge_ids.length, 0), survivor_rules: SURVIVOR_RULES, plan: out,
    note: 'Suggested merges for a person to review. Opt-outs and hard bounces always carry over to the merged record. Nausicaa does not merge in your CRM.' };
}

export const MERGE_COLUMNS = ['group', 'canonical', 'survivor_id', 'merge_ids', 'survivor_rule', 'field', 'value', 'from_id', 'rule', 'reviewer_decision', 'reviewer_name'];
export const mergeCsv = (p) => toCsv(p.plan.flatMap((g, i) => g.fields.map((f) => ({ group: i + 1, canonical: g.canonical, survivor_id: g.survivor_id, merge_ids: g.merge_ids.join('; '), survivor_rule: g.survivor_rule, ...f, reviewer_decision: '', reviewer_name: '' }))), MERGE_COLUMNS);
