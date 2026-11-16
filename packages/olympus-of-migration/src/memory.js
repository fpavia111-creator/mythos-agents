// Olympus's domain memory: facts about one customer's migration exports that a person
// has accepted, so the next trial load does not have to be told again. Two kinds can
// change a check: a column name for a setting the call and the config leave unset, and
// an extra field rule (more checks, never fewer). Tolerance, FX rates and the base
// currency are deliberately not learnable: a remembered number could hide a difference.
// Nothing here can approve go-live.
import { memoryTools } from 'mythos-agent-core';
import { fieldRuleSchema } from './schemas.js';

export const COLUMN_SETTINGS = Object.freeze(['key', 'target_key', 'amount_column', 'account_column', 'balance_column', 'subsidiary_column', 'currency_column']);

// Nested quantifiers like (a+)+ can take exponential time on a long cell value.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

export const MEMORY_KINDS = Object.freeze({
  column_setting: {
    description: `The column this customer's exports use for one setting, e.g. {"setting": "key", "column": "legacy_id"}. Settings: ${COLUMN_SETTINGS.join(', ')}.`,
    effect: 'names the column for that setting when neither the call nor the config names one (the call and the config always win)',
    schema: { type: 'object', additionalProperties: false, required: ['setting', 'column'], properties: { setting: { enum: [...COLUMN_SETTINGS] }, column: { type: 'string', minLength: 1, maxLength: 120 } } },
  },
  field_rule: {
    description: 'An extra field rule for the target export, in the same shape as a migration_rules field rule, e.g. {"id": "vendor-terms", "column": "terms", "enum": ["Net 30", "Net 60"]}.',
    effect: 'adds the rule to every field check and readiness report (more checks, never fewer; a config rule with the same id wins)',
    schema: { ...fieldRuleSchema, properties: { ...fieldRuleSchema.properties, pattern: { type: 'string', maxLength: 200 } } },
    check: (v) => {
      if (v.pattern !== undefined) {
        try { new RegExp(v.pattern); } catch { return 'pattern is not a valid regular expression'; }
        if (NESTED_QUANTIFIER.test(v.pattern)) return 'pattern has a nested quantifier (like (a+)+) that can hang on long values';
      }
      if (v.min !== undefined && v.max !== undefined && v.min > v.max) return 'min is larger than max';
      if (!['required', 'unique', 'type', 'enum', 'pattern', 'min', 'max', 'max_length'].some((k) => v[k] !== undefined && v[k] !== false)) return 'the rule checks nothing (give at least one of required, unique, type, enum, pattern, min, max, max_length)';
      return null;
    },
  },
});

export const MEMORY = memoryTools('olympus', MEMORY_KINDS);

/**
 * Fill column settings the call and config left unset, and add learned field rules
 * after the config's own. Returns { settings, memory } where memory lists the facts
 * used and the ones skipped (and why), or null when no fact applied.
 */
export function withMemory(s, ctx, { fields = true } = {}) {
  const facts = (k) => (ctx && typeof ctx.memoryFacts === 'function' ? ctx.memoryFacts(k) : []);
  const out = { ...s }; const used = []; const skipped = [];
  const cols = facts('column_setting');
  const bySetting = new Map();
  for (const f of cols) { if (!bySetting.has(f.value.setting)) bySetting.set(f.value.setting, []); bySetting.get(f.value.setting).push(f); }
  for (const [setting, list] of bySetting) {
    const distinct = new Set(list.map((f) => f.value.column));
    if (out[setting] !== undefined && out[setting] !== null && out[setting] !== '') { for (const f of list) skipped.push({ ...f, why: `the call or the config already sets ${setting}`, why_code: 'already_set', why_params: { setting } }); continue; }
    if (distinct.size > 1) { for (const f of list) skipped.push({ ...f, why: `accepted facts disagree on ${setting} (${[...distinct].join(', ')}); retire one`, why_code: 'disagree', why_params: { setting, values: [...distinct].join(', ') } }); continue; }
    out[setting] = list[0].value.column; used.push(...list);
  }
  if (fields) {
    const rules = facts('field_rule');
    if (rules.length) {
      const ids = new Set((out.field_rules || []).map((r) => r.id).filter(Boolean));
      const add = [];
      for (const f of rules) {
        const id = f.value.id || f.id;
        if (ids.has(id)) { skipped.push({ ...f, why: `the config has a field rule with id "${id}"`, why_code: 'rule_id', why_params: { id } }); continue; }
        ids.add(id); add.push({ ...f.value, id }); used.push(f);
      }
      if (add.length) out.field_rules = [...(out.field_rules || []), ...add];
    }
  }
  return { settings: out, memory: used.length || skipped.length ? { used, skipped } : null };
}

/** One line on a fact, in English or (with t from the report's language) translated. */
export const memoryText = (f, t = null) => (f.kind === 'column_setting' ? (t ? t('mem_column', { setting: f.value.setting, column: f.value.column }) : `${f.value.setting} is column "${f.value.column}"`) : f.kind === 'field_rule' ? (t ? t('mem_rule', { id: f.value.id || f.id, column: f.value.column }) : `field rule ${f.value.id || f.id} on "${f.value.column}"`) : JSON.stringify(f.value));
