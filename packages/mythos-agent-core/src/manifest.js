// Pack manifest: identity, pinned model, tool allowlist and Talos-style policy.

export const KINDS = ['read', 'report', 'write', 'action'];
export const DECISIONS = ['allow', 'ask', 'block'];
export const MODES = ['review', 'assist', 'auto'];
const SOURCE_FIELD_TYPES = ['text', 'date', 'datetime', 'money', 'number', 'bool', 'email'];

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
  // Accepting or retiring a fact in an agent's domain memory: what the agent will
  // assume on every later run is a person's decision, never the agent's.
  'accept_learning',
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
    if (t.tier !== undefined && !['free', 'pro'].includes(t.tier)) errs.push(`tool ${t.name}: tier must be "free" or "pro"`);
    if (t.feature !== undefined && (typeof t.feature !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(t.feature))) errs.push(`tool ${t.name}: feature must be a short lowercase name`);
    if (t.feature !== undefined && t.tier !== 'pro') errs.push(`tool ${t.name}: feature only applies to a tier "pro" tool`);
    const rule = matchRule(rules, t);
    if (!rule) { errs.push(`tool ${t.name}: no policy rule (add an explicit allow/ask/block)`); continue; }
    if ((t.kind === 'write' || t.kind === 'action') && rule.decision === 'allow') {
      errs.push(`tool ${t.name}: ${t.kind} tools must be "ask" or "block", not "allow"`);
    }
    if (ONE_CLICK_CATEGORIES.includes(t.category) && rule.decision === 'allow') {
      errs.push(`tool ${t.name}: category ${t.category} must be "ask" or "block"`);
    }
    if (t.handler && typeof t.handler !== 'function') errs.push(`tool ${t.name}: handler must be a function`);
    if (t.approvalPreview !== undefined && typeof t.approvalPreview !== 'function') errs.push(`tool ${t.name}: approvalPreview must be a function`);
  }
  for (const p of m.prompts || []) {
    if (!NAME_RE.test(p.name || '')) errs.push(`prompt name "${p.name}" must match ${NAME_RE}`);
    if (!p.description || !p.text) errs.push(`prompt ${p.name}: description and text are required`);
  }
  if (m.memory !== undefined) {
    const mem = m.memory;
    if (!mem || typeof mem !== 'object' || Array.isArray(mem)) errs.push('memory must be an object { prefix, kinds }');
    else {
      if (!/^[a-z][a-z0-9]{1,20}$/.test(mem.prefix || '')) errs.push('memory.prefix must be the agent\'s short tool prefix, e.g. "ladon"');
      const kinds = mem.kinds || {};
      if (typeof kinds !== 'object' || Array.isArray(kinds)) errs.push('memory.kinds must be an object of kinds');
      else for (const [k, def] of Object.entries(kinds)) {
        if (!/^[a-z][a-z0-9_]{1,40}$/.test(k)) errs.push(`memory kind "${k}" must be a short lowercase name`);
        if (k === 'note') errs.push('memory kind "note" is built in; do not redefine it');
        if (!def || !def.description || !def.effect) errs.push(`memory kind ${k}: description and effect (what an accepted fact changes) are required`);
        if (!def || !def.schema || def.schema.type !== 'object') errs.push(`memory kind ${k}: schema must be a JSON Schema for an object`);
        else if (def.schema.additionalProperties !== false) errs.push(`memory kind ${k}: schema must set additionalProperties: false`);
        if (def && def.check !== undefined && typeof def.check !== 'function') errs.push(`memory kind ${k}: check must be a function`);
      }
      const byName = new Map((m.tools || []).map((t) => [t.name, t]));
      for (const [suffix, kind, category] of [['recall', 'read', undefined], ['learn', 'report', undefined], ['accept_learning', 'action', 'accept_learning'], ['retire_memory', 'action', 'accept_learning']]) {
        const t = byName.get(`${mem.prefix}_${suffix}`);
        if (!t) errs.push(`memory: tool ${mem.prefix}_${suffix} is missing (spread memoryTools(prefix, kinds).tools into tools)`);
        else if (t.kind !== kind || (category && t.category !== category)) errs.push(`memory: tool ${t.name} must be kind ${kind}${category ? ` with category ${category}` : ''}`);
      }
    }
  }
  if (m.configSchemas && (typeof m.configSchemas !== 'object' || Array.isArray(m.configSchemas))) errs.push('configSchemas must be an object of JSON Schemas');
  if (m.sources !== undefined) {
    if (!m.sources || typeof m.sources !== 'object' || Array.isArray(m.sources)) errs.push('sources must be an object keyed by source kind');
    else {
      const argNames = new Set((m.tools || []).flatMap((t) => Object.keys((t.inputSchema && t.inputSchema.properties) || {}).flatMap((a) => [a, `${t.name}.${a}`])));
      for (const [kind, def] of Object.entries(m.sources)) {
        if (!def || typeof def !== 'object' || !def.fields || typeof def.fields !== 'object' || !Object.keys(def.fields).length) { errs.push(`source ${kind}: fields (the agent's own columns) are required`); continue; }
        for (const a of def.args || [kind]) if (!argNames.has(a)) errs.push(`source ${kind}: "${a}" is not an argument of any tool`);
        for (const [f, fd] of Object.entries(def.fields)) if (fd && fd.type && !SOURCE_FIELD_TYPES.includes(fd.type)) errs.push(`source ${kind}: field ${f} has unknown type "${fd.type}"`);
        const ids = new Set();
        for (const p of def.profiles || []) {
          if (!p || !p.id || !/^[a-z][a-z0-9_]*$/.test(p.id)) { errs.push(`source ${kind}: every profile needs an id (lowercase letters, digits, _)`); continue; }
          if (ids.has(p.id)) errs.push(`source ${kind}: duplicate profile ${p.id}`); ids.add(p.id);
          if (!p.system) errs.push(`source ${kind}: profile ${p.id} needs "system" (the product the export comes from)`);
          if (p.headerless ? !Array.isArray(p.headerless) || typeof p.detect !== 'function' : !Array.isArray(p.signature) || !p.signature.length) errs.push(`source ${kind}: profile ${p.id} needs "signature" (column names that identify the export)`);
          for (const f of Object.keys(p.map || {})) if (!(f in def.fields)) errs.push(`source ${kind}: profile ${p.id} maps "${f}", which is not one of the fields`);
        }
      }
    }
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
