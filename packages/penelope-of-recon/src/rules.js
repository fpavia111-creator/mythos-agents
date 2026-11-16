// Learned match rules. A rule is suggested from matches a person already accepted and is
// applied only after a person accepts the rule itself (penelope_accept_rule) and passes the
// rules file to penelope_reconcile. Deterministic: same inputs, same rules.

import { sha256 } from 'mythos-agent-core';

/** Words of a description without digits or punctuation: "ACH Acme Supply #77" -> "ach acme supply". */
export const pattern = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !/\d/.test(w)).join(' ');
const tokens = (s) => new Set(pattern(s).split(' ').filter(Boolean));
const covers = (desc, pat) => { const t = tokens(desc); const p = String(pat).split(' ').filter(Boolean); return p.length > 0 && p.every((w) => t.has(w)); };
export const ruleId = (bankPattern, glPattern, direction) => 'R-' + sha256(`${bankPattern}|${glPattern}|${direction}`).slice(0, 8);

export const MATCH_RULES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['version', 'rules'],
  properties: {
    version: { const: 1 },
    note: { type: 'string' },
    rules: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'bank_pattern', 'gl_pattern', 'max_days', 'direction'],
      properties: {
        id: { type: 'string', pattern: '^R-[0-9a-f]{8}$' },
        bank_pattern: { type: 'string', minLength: 1, description: 'Words that must all appear in the bank description (digits ignored)' },
        gl_pattern: { type: 'string', minLength: 1, description: 'Words that must all appear in the GL memo (digits ignored)' },
        max_days: { type: 'integer', minimum: 0, maximum: 31 },
        direction: { enum: ['in', 'out'] },
        amount_tolerance: { type: 'number', minimum: 0 },
        support: { type: 'integer', minimum: 0 },
        accepted_at: { type: 'string' },
        note: { type: 'string' },
      },
    } },
  },
};

/**
 * Suggest rules from accepted one-to-one matches. Pairs that already share a reference are skipped
 * (the reference pass finds them). Each suggestion lists the accepted pairs it came from.
 */
export function suggestRules(bank, gl, accepted, { min_support = 1, existing = [] } = {}) {
  const B = new Map(bank.map((x) => [x.id, x])), G = new Map(gl.map((x) => [x.id, x]));
  const have = new Set(existing.map((r) => r.id)); const groups = new Map(); const skipped = [];
  for (const a of accepted) {
    const bi = String(a.bank_ids || '').split(/[\s,;+]+/).filter(Boolean), gi = String(a.gl_ids || '').split(/[\s,;+]+/).filter(Boolean);
    if (bi.length !== 1 || gi.length !== 1) { skipped.push({ bank_ids: a.bank_ids, gl_ids: a.gl_ids, reason: 'not one-to-one' }); continue; }
    const b = B.get(bi[0]), g = G.get(gi[0]);
    if (!b || !g) { skipped.push({ bank_ids: a.bank_ids, gl_ids: a.gl_ids, reason: 'id not in these files' }); continue; }
    if (b.reference && g.reference && b.reference.toLowerCase() === g.reference.toLowerCase()) { skipped.push({ bank_ids: b.id, gl_ids: g.id, reason: 'same reference; no rule needed' }); continue; }
    const bp = pattern(b.description), gp = pattern(g.description);
    if (!bp || !gp) { skipped.push({ bank_ids: b.id, gl_ids: g.id, reason: 'description has no words to learn from' }); continue; }
    const direction = (b.amount ?? 0) >= 0 ? 'in' : 'out'; const id = ruleId(bp, gp, direction);
    const days = Math.abs(Math.round((Date.parse(b.date) - Date.parse(g.date)) / 86400000)) || 0;
    const r = groups.get(id) || { id, bank_pattern: bp, gl_pattern: gp, direction, max_days: 0, support: 0, examples: [] };
    r.support++; r.max_days = Math.min(31, Math.max(r.max_days, days)); r.examples.push({ bank: b.id, gl: g.id, bank_description: b.description, gl_description: g.description, amount: b.amount, days_apart: days });
    groups.set(id, r);
  }
  const rules = [...groups.values()].filter((r) => r.support >= min_support).sort((a, b) => b.support - a.support || a.id.localeCompare(b.id))
    .map((r) => ({ ...r, already_accepted: have.has(r.id), plain: `Bank lines with "${r.bank_pattern}" match a GL line with "${r.gl_pattern}", same amount, money ${r.direction}, up to ${r.max_days} day(s) apart.` }));
  return { suggestions: rules, skipped, note: 'Suggestions only. A rule is used only after a person accepts it with penelope_accept_rule and the rules file is passed to penelope_reconcile.' };
}

/** Apply accepted rules to unmatched lines; marks ids used and returns matches. */
export function applyRules(bank, gl, rules, { usedB, usedG, tol, day }) {
  const out = [];
  for (const rule of rules) {
    const t = rule.amount_tolerance ?? tol;
    for (const b of bank) {
      if (usedB.has(b.id) || b.amount === null) continue;
      if ((b.amount >= 0 ? 'in' : 'out') !== rule.direction || !covers(b.description, rule.bank_pattern)) continue;
      const db = day(b.date);
      const c = gl.filter((g) => !usedG.has(g.id) && g.amount !== null && Math.abs(g.amount - b.amount) <= t + 1e-9 && covers(g.description, rule.gl_pattern) && db !== null && day(g.date) !== null && Math.abs(day(g.date) - db) <= rule.max_days)
        .sort((x, y) => Math.abs(day(x.date) - db) - Math.abs(day(y.date) - db) || x.row - y.row);
      if (!c.length) continue;
      usedB.add(b.id); usedG.add(c[0].id);
      out.push({ type: 'rule', confidence: c.length > 1 ? 'medium' : 'high', bank: [b.id], gl: [c[0].id], amount: b.amount, rule: rule.id, note: `accepted rule ${rule.id}${c.length > 1 ? ` (${c.length} candidates; nearest date)` : ''}` });
    }
  }
  return out;
}
