import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AgentRuntime } from './runtime.js';

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

/**
 * Fixture-based private evals. Each case:
 * { id, tool, args, mode?, auto_actions?, expect: { status?, decision?, contains?: [..],
 *   not_contains?: [..], equals?: { "result.path": value } } }
 * Paths in args resolve against the cases file's folder, or its "root" field.
 * Evals are deterministic tool-level checks; they do not call a model.
 */
export async function runEvals(manifest, cases, { root, stateDir = null } = {}) {
  const results = [];
  for (const c of cases) {
    const rt = new AgentRuntime(manifest, { root, stateDir, audit: false, mode: c.mode || 'assist', autoActions: c.auto_actions || [] });
    const out = await rt.call(c.tool, c.args || {});
    const textOut = JSON.stringify(out);
    const fails = [];
    const e = c.expect || {};
    if (e.status && out.status !== e.status) fails.push(`status ${out.status} != ${e.status}`);
    if (e.decision && out.decision !== e.decision) fails.push(`decision ${out.decision} != ${e.decision}`);
    for (const s of e.contains || []) if (!textOut.includes(s)) fails.push(`missing "${s}"`);
    for (const s of e.not_contains || []) if (textOut.includes(s)) fails.push(`unexpected "${s}"`);
    for (const [p, v] of Object.entries(e.equals || {})) {
      const got = get(out, p);
      if (JSON.stringify(got) !== JSON.stringify(v)) fails.push(`${p} = ${JSON.stringify(got)}, expected ${JSON.stringify(v)}`);
    }
    results.push({ id: c.id, pass: fails.length === 0, fails });
  }
  return { suite: manifest.name, passed: results.filter((r) => r.pass).length, total: results.length, results };
}

export async function runEvalFile(manifest, file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return runEvals(manifest, data.cases || data, { root: resolve(dirname(file), data.root || '.') });
}
