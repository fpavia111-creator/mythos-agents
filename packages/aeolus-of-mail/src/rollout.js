// Staged DMARC rollout plan: none -> quarantine -> reject, one stage at a time, with dates.
// The plan never jumps straight to reject: every reject stage comes after a quarantine stage.
// Each stage's record change still goes through the one-click DNS change request.
import { parseTags } from './mail.js';

const RANK = { none: 0, quarantine: 1, reject: 2 };
export const DEFAULT_ROLLOUT = Object.freeze({
  stages: [
    { policy: 'none', pct: 100, min_days: 21 },
    { policy: 'quarantine', pct: 25, min_days: 14 },
    { policy: 'quarantine', pct: 100, min_days: 14 },
    { policy: 'reject', pct: 25, min_days: 14 },
    { policy: 'reject', pct: 100, min_days: 0 },
  ],
  pass_threshold: 98,
  reminder_days: [3, 0],
});

export const ROLLOUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['stages'],
  properties: {
    stages: { type: 'array', minItems: 2, maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['policy', 'pct', 'min_days'], properties: {
      policy: { enum: ['none', 'quarantine', 'reject'] }, pct: { type: 'integer', minimum: 1, maximum: 100 }, min_days: { type: 'integer', minimum: 0, maximum: 365 }, note: { type: 'string', maxLength: 300 },
    } } },
    pass_threshold: { type: 'number', minimum: 50, maximum: 100 },
    reminder_days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 30 }, maxItems: 4 },
    owner: { type: 'string', maxLength: 120 },
  },
};

/** Ordering rules beyond the schema: never weaker, never reject before quarantine, end at reject pct=100. */
export function checkRolloutOrder(cfg) {
  const s = cfg.stages; let sawQuarantine = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i].policy === 'quarantine') sawQuarantine = true;
    if (s[i].policy === 'reject' && !sawQuarantine) throw new Error(`stage ${i + 1} goes to reject before any quarantine stage; the plan never skips straight to reject`);
    if (i && (RANK[s[i].policy] < RANK[s[i - 1].policy] || (s[i].policy === s[i - 1].policy && s[i].pct <= s[i - 1].pct))) throw new Error(`stage ${i + 1} (${s[i].policy} pct=${s[i].pct}) is not a step up from stage ${i} (${s[i - 1].policy} pct=${s[i - 1].pct})`);
  }
  const last = s[s.length - 1]; if (last.policy !== 'reject' || last.pct !== 100) throw new Error('the last stage must be reject at pct=100');
  return cfg;
}

/** Set p= and pct= on a DMARC record, keeping every other tag (rua, sp, adkim...). */
export function setDmarcPolicy(record, policy, pct) {
  const { tags, order } = parseTags(record || 'v=DMARC1');
  const keys = order.filter((k) => !['v', 'p', 'pct'].includes(k) && tags[k] !== undefined);
  const parts = ['v=DMARC1', `p=${policy}`]; if (pct < 100) parts.push(`pct=${pct}`);
  for (const k of keys) parts.push(`${k}=${tags[k]}`);
  return parts.join('; ');
}

const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const stageIndex = (stages, policy, pct) => { let idx = -1; stages.forEach((s, i) => { if (RANK[s.policy] < RANK[policy] || (s.policy === policy && s.pct <= pct)) idx = i; }); return idx; };

/**
 * Build the plan from the audit result. readiness: { ready, reason } from DMARC reports, or null.
 * Returns stages still to do, each with its record and earliest date, plus the next change.
 */
export function planRollout(audit, { start_date, config = DEFAULT_ROLLOUT, readiness = null, rua = '' } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start_date || '')) || Number.isNaN(Date.parse(start_date))) throw new Error('start_date must be YYYY-MM-DD');
  const cfg = checkRolloutOrder({ ...DEFAULT_ROLLOUT, ...config });
  const d = audit.dmarc; const current = d && !d.inherited_from ? audit.records.dmarc[0] : null;
  const mailbox = rua ? (rua.startsWith('mailto:') ? rua : `mailto:${rua}`) : '[TO CONFIRM report mailbox, e.g. mailto:dmarc@your-domain]';
  let base = current; let cur = { policy: null, pct: 0 }; let at = -1;
  // An inherited (organisational) policy counts too, so a subdomain plan never starts weaker than what applies today.
  if (d && d.policy) { cur = { policy: String(d.policy).toLowerCase(), pct: d.pct ?? 100 }; at = stageIndex(cfg.stages, cur.policy, cur.pct); }
  if (base && !/\brua=/i.test(base)) base = `${base.replace(/;\s*$/, '')}; rua=${mailbox}`;
  if (!base) base = `v=DMARC1; p=none; rua=${mailbox}`;
  const todo = cfg.stages.slice(at + 1);
  let date = start_date; let prev = current;
  const stages = todo.map((s, n) => {
    const record = setDmarcPolicy(base, s.policy, s.pct);
    const gate = s.policy === 'none' ? 'Publish monitoring and collect aggregate reports.' : `Go ahead only if the reports since the last stage show at least ${cfg.pass_threshold}% of your mail passing DMARC and no real sender failing.`;
    const st = { step: n + 1, policy: s.policy, pct: s.pct, earliest_date: date, record, previous: prev, gate, hold_days: s.min_days, ...(s.note ? { note: s.note } : {}) };
    prev = record; date = addDays(date, s.min_days); return st;
  });
  const next = stages[0] || null;
  let marker = null;
  if (next && next.policy !== 'none') {
    if (!readiness) marker = '[TO CONFIRM DMARC reports show every real sender passes; run aeolus_dmarc_reports]';
    else if (!readiness.ready) marker = `[TO CONFIRM not ready: ${readiness.reason}]`;
  }
  const change = next ? { name: `_dmarc.${audit.domain}`, type: 'TXT', action: current ? 'replace' : 'add', current: current ? [current] : [], proposed: next.record, why: `dmarc_rollout_step_${next.step}`, note: [`Stage ${next.step} of the DMARC rollout (${next.policy}${next.pct < 100 ? ` pct=${next.pct}` : ''}). ${next.gate}`, marker].filter(Boolean).join(' ') } : null;
  return { domain: audit.domain, current: current ? { record: current, policy: cur.policy, pct: cur.pct } : (d?.inherited_from ? { inherited_from: d.inherited_from, policy: d.policy } : null), pass_threshold: cfg.pass_threshold, readiness, stages, next_change: change, done: !stages.length, reminder_days: cfg.reminder_days || [3, 0], owner: cfg.owner || null };
}

export function rolloutMarkdown(p) {
  const L = [`# DMARC rollout plan: ${p.domain} (not applied)`, '', `Current: ${p.current ? (p.current.record ? `\`${p.current.record}\`` : `inherited from ${p.current.inherited_from} (p=${p.current.policy})`) : 'no DMARC record'}.`, ''];
  if (p.done) L.push('DMARC is already at p=reject for all mail. Nothing to stage.', '');
  L.push(`Readiness from reports: ${p.readiness ? p.readiness.reason : 'no reports given; each enforcing stage waits for aggregate reports.'}`, '', '| Step | Policy | pct | Earliest date | Record |', '|---|---|---|---|---|');
  for (const s of p.stages) L.push(`| ${s.step} | ${s.policy} | ${s.pct} | ${s.earliest_date} | \`${s.record}\` |`);
  L.push('', 'Each step moves one stage only, and every reject stage comes after quarantine. Dates are earliest dates, not deadlines: hold a stage if the reports show a real sender failing. Every record change is one named human click (aeolus_request_dns_change); Aeolus never edits DNS.', '');
  for (const s of p.stages) L.push(`## Step ${s.step}: ${s.policy}${s.pct < 100 ? ` pct=${s.pct}` : ''} (from ${s.earliest_date})`, '', s.gate, '', `Proposed: \`${s.record}\``, ...(s.note ? ['', s.note] : []), '');
  return L.join('\n');
}
