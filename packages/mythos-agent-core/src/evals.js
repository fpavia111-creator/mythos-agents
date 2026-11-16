import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AgentRuntime } from './runtime.js';

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

/**
 * Fixture-based private evals. Each case:
 * { id, tool, args, mode?, auto_actions?, approve?: "Person name" (approve once, then run),
 *   expect: { status?, decision?, contains?: [..], not_contains?: [..], matches?: [regex..],
 *   equals?: { "result.path": value }, min?/max?: { path: n }, length?: { path: n }, max_ms? } }
 * Paths in args resolve against the cases file's folder, or its "root" field.
 * Evals are deterministic tool-level checks; they do not call a model.
 */
export async function runEvals(manifest, cases, { root, stateDir = null } = {}) {
  const results = [];
  for (const c of cases) {
    const rt = new AgentRuntime(manifest, { root, stateDir, audit: false, mode: c.mode || 'assist', autoActions: c.auto_actions || [] });
    if (c.approve) { const pre = await rt.call(c.tool, c.args || {}); if (pre.approval_id) rt.approvals.approve(pre.approval_id, String(c.approve)); }
    const t0 = Date.now();
    const out = await rt.call(c.tool, c.args || {});
    const ms = Date.now() - t0;
    const textOut = JSON.stringify(out);
    const fails = [];
    const e = c.expect || {};
    if (e.status && out.status !== e.status) fails.push(`status ${out.status} != ${e.status}`);
    if (e.decision && out.decision !== e.decision) fails.push(`decision ${out.decision} != ${e.decision}`);
    for (const s of e.contains || []) if (!textOut.includes(s)) fails.push(`missing "${s}"`);
    for (const s of e.not_contains || []) if (textOut.includes(s)) fails.push(`unexpected "${s}"`);
    for (const s of e.matches || []) if (!new RegExp(s).test(textOut)) fails.push(`no match for /${s}/`);
    if (e.max_ms !== undefined && ms > e.max_ms) fails.push(`took ${ms} ms > ${e.max_ms} ms`);
    for (const [p, v] of Object.entries(e.min || {})) { const got = get(out, p); if (!(Number(got) >= v)) fails.push(`${p} = ${JSON.stringify(got)}, expected >= ${v}`); }
    for (const [p, v] of Object.entries(e.max || {})) { const got = get(out, p); if (!(Number(got) <= v)) fails.push(`${p} = ${JSON.stringify(got)}, expected <= ${v}`); }
    for (const [p, v] of Object.entries(e.length || {})) { const got = get(out, p); if (!Array.isArray(got) || got.length !== v) fails.push(`${p} length ${Array.isArray(got) ? got.length : 'n/a'}, expected ${v}`); }
    for (const [p, v] of Object.entries(e.equals || {})) {
      const got = get(out, p);
      if (JSON.stringify(got) !== JSON.stringify(v)) fails.push(`${p} = ${JSON.stringify(got)}, expected ${JSON.stringify(v)}`);
    }
    results.push({ id: c.id, tool: c.tool, pass: fails.length === 0, fails, ms, status: out.status });
  }
  return { suite: manifest.name, version: manifest.version, node: process.version, ran_at: new Date().toISOString(), passed: results.filter((r) => r.pass).length, total: results.length, results };
}

export async function runEvalFile(manifest, file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return runEvals(manifest, data.cases || data, { root: resolve(dirname(file), data.root || '.') });
}

/** Compare two eval results. Returns { regressions, fixed, added, removed }. */
export function compareEvals(base, cur) {
  const b = new Map((base.results || []).map((r) => [r.id, r])); const c = new Map((cur.results || []).map((r) => [r.id, r]));
  const out = { regressions: [], fixed: [], added: [], removed: [] };
  for (const [id, r] of c) {
    const o = b.get(id);
    if (!o) out.added.push(id);
    else if (o.pass && !r.pass) out.regressions.push(id);
    else if (!o.pass && r.pass) out.fixed.push(id);
  }
  for (const id of b.keys()) if (!c.has(id)) out.removed.push(id);
  return out;
}
