// Pack manifest: identity, pinned model, tool allowlist and Talos-style policy.

export const KINDS = ['read', 'report', 'write', 'action'];
export const DECISIONS = ['allow', 'ask', 'block'];
export const MODES = ['review', 'assist', 'auto'];

/**
 * Categories that always need a named human, even in Auto mode.
 * Auto can prepare the work; a person makes the one click.
 */
export const ONE_CLICK_CATEGORIES = Object.freeze([
  'go_live',
  'revoke_access',
  'delete_personal_data',
  'move_money',
  'binding_send',
  'production_deploy',
]);

export class ManifestError extends Error {}

const NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Validate and freeze a manifest. Fails closed:
 * - the model must be pinned (no "latest", no wildcard);
 * - every tool needs an explicit policy rule (the default is block, but a
 *   write or action with no rule is treated as a pack bug);
 * - write/action tools may not be "allow";
 * - one-click categories must be "ask" or "block".
 */
export function defineManifest(m) {
  const errs = [];
  if (!m || typeof m !== 'object') throw new ManifestError('manifest must be an object');
  if (!m.name || !/^[a-z0-9][a-z0-9-]*$/.test(m.name)) errs.push('name must be a lowercase package-style name');
  if (!m.version) errs.push('version is required');
  const model = m.model || {};
  if (!model.provider || !model.id) errs.push('model.provider and model.id are required (pin a model)');
  else if (/latest|\*|^auto$/i.test(model.id)) errs.push(`model.id "${model.id}" is not a pin; use an exact, dated model id`);
  if (!Array.isArray(m.tools) || !m.tools.length) errs.push('tools must be a non-empty array (the allowlist)');
  const policy = m.policy || {};
  if (policy.default && policy.default !== 'block') errs.push('policy.default must be "block" (fail closed)');
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  for (const r of rules) {
    if (!DECISIONS.includes(r.decision)) errs.push(`policy rule ${JSON.stringify(r)} has an invalid decision`);
    if (!r.tool && !r.category) errs.push(`policy rule ${JSON.stringify(r)} needs "tool" or "category"`);
  }
  const seen = new Set();
  for (const t of m.tools || []) {
    if (!NAME_RE.test(t.name || '')) errs.push(`tool name "${t.name}" must match ${NAME_RE}`);
    if (seen.has(t.name)) errs.push(`duplicate tool ${t.name}`);
    seen.add(t.name);
    if (!KINDS.includes(t.kind)) errs.push(`tool ${t.name}: kind must be one of ${KINDS.join(', ')}`);
    if (!t.description) errs.push(`tool ${t.name}: description is required`);
    if (t.category && typeof t.category !== 'string') errs.push(`tool ${t.name}: category must be a string`);
    const rule = matchRule(rules, t);
    if (!rule) { errs.push(`tool ${t.name}: no policy rule (add an explicit allow/ask/block)`); continue; }
    if ((t.kind === 'write' || t.kind === 'action') && rule.decision === 'allow') {
      errs.push(`tool ${t.name}: ${t.kind} tools must be "ask" or "block", not "allow"`);
    }
    if (ONE_CLICK_CATEGORIES.includes(t.category) && rule.decision === 'allow') {
      errs.push(`tool ${t.name}: category ${t.category} must be "ask" or "block"`);
    }
    if (t.handler && typeof t.handler !== 'function') errs.push(`tool ${t.name}: handler must be a function`);
  }
  if (errs.length) throw new ManifestError('Invalid pack manifest:\n- ' + errs.join('\n- '));
  return Object.freeze({
    description: '',
    caps: {},
    ...m,
    policy: Object.freeze({ default: 'block', rules: Object.freeze(rules.map((r) => Object.freeze({ ...r }))) }),
    tools: Object.freeze(m.tools.map((t) => Object.freeze({ costUsd: 0, inputSchema: { type: 'object', properties: {} }, ...t }))),
  });
}

function globMatch(pattern, value) {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

/** First matching rule wins. A rule can match by tool name (glob) and/or category. */
export function matchRule(rules, tool) {
  for (const r of rules) {
    if (r.tool && !globMatch(r.tool, tool.name)) continue;
    if (r.category && r.category !== tool.category) continue;
    return r;
  }
  return null;
}
