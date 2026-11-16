// Ladon's domain memory: facts about one customer's access setup that a person has
// accepted, so the next review does not have to be told again. Every kind only adds
// to a check (a privileged role, a segregation-of-duties rule, a standing reviewer
// delegation). None can raise stale_days, drop a built-in role, remove a rule, or
// touch policy, caps or Auto. A learned fact waits until a named person accepts it.
import { memoryTools } from 'mythos-agent-core';

const role = { type: 'string', minLength: 2, maxLength: 100 };
const roles = { type: 'array', minItems: 1, maxItems: 20, items: role };

export const MEMORY_KINDS = Object.freeze({
  privileged_role: {
    description: 'A role this customer treats as privileged that the built-in list misses, e.g. {"role": "Vault Keeper"}.',
    effect: 'adds the role to the privileged list in every review and diff (more findings, never fewer)',
    schema: { type: 'object', additionalProperties: false, required: ['role'], properties: { role } },
  },
  sod_rule: {
    description: 'A segregation-of-duties rule for this customer: one person must not hold a roles_a role and a roles_b role, e.g. {"name": "vendor-vs-payment", "roles_a": ["Vendor Master"], "roles_b": ["Payment Release"]}.',
    effect: 'adds the rule to the segregation-of-duties check (a policy-file rule with the same name wins)',
    schema: { type: 'object', additionalProperties: false, required: ['name', 'roles_a', 'roles_b'], properties: { name: { type: 'string', minLength: 2, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9 _.-]*$' }, roles_a: roles, roles_b: roles, same_role_counts: { type: 'boolean' } } },
  },
  delegation: {
    description: 'A standing reviewer delegation: lines assigned to "from" go to "to", e.g. {"from": "Ana Ruiz", "to": "Ben Ode", "reason": "Ana is on leave until March"}.',
    effect: 'fills delegated_to for lines assigned to "from", unless the policy file has its own delegation for that person',
    schema: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { type: 'string', minLength: 2, maxLength: 120 }, to: { type: 'string', minLength: 2, maxLength: 120 }, reason: { type: 'string', maxLength: 300 } } },
  },
});

export const MEMORY = memoryTools('ladon', MEMORY_KINDS);

const low = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Add the accepted facts to the options for one run. Policy-file and argument values
 * stay as they are; learned facts are added after them. Returns { opts, memory }
 * where memory lists the facts used and the ones skipped (and why).
 */
export function withMemory(opts, ctx, kinds = ['privileged_role', 'sod_rule', 'delegation']) {
  const facts = (k) => (kinds.includes(k) && ctx && typeof ctx.memoryFacts === 'function' ? ctx.memoryFacts(k) : []);
  const o = { ...opts }; const used = []; const skipped = [];
  const roles = facts('privileged_role');
  if (roles.length) { o.extra_privileged_roles = [...(o.extra_privileged_roles || []), ...roles.map((f) => f.value.role)]; used.push(...roles); }
  const rules = facts('sod_rule');
  if (rules.length) {
    const names = new Set((o.sod_rules || []).map((r) => low(r.name)));
    const add = [];
    for (const f of rules) { if (names.has(low(f.value.name))) skipped.push({ ...f, why: `the policy file has a rule named "${f.value.name}"`, why_code: 'policy_rule', why_params: { name: f.value.name } }); else { names.add(low(f.value.name)); add.push(f.value); used.push(f); } }
    if (add.length) o.sod_rules = [...(o.sod_rules || []), ...add];
  }
  const dels = facts('delegation');
  if (dels.length) {
    const from = new Set((o.delegations || []).map((d) => low(d.from)));
    const add = [];
    for (const f of dels) {
      if (low(f.value.from) === low(f.value.to)) skipped.push({ ...f, why: 'a person cannot delegate to themselves', why_code: 'self' });
      else if (from.has(low(f.value.from))) skipped.push({ ...f, why: `the policy file already delegates for ${f.value.from}`, why_code: 'policy_del', why_params: { from: f.value.from } });
      else { from.add(low(f.value.from)); add.push({ from: f.value.from, to: f.value.to, reason: f.value.reason || 'standing delegation (Ladon memory)' }); used.push(f); }
    }
    if (add.length) o.delegations = [...(o.delegations || []), ...add];
  }
  return { opts: o, memory: used.length || skipped.length ? { used, skipped } : null };
}
