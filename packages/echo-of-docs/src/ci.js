// CI gate: turn a drift check into SARIF for code scanning, compare with a baseline so a
// pipeline can fail on new drift only, and decide pass/fail from a severity threshold.
import { sha256, toSarif } from 'mythos-agent-core';

export const FAIL_ON = ['error', 'warning', 'any', 'none'];
const RANK = { error: 0, warning: 1, advisory: 2 };
const LIMIT = { error: 0, warning: 1, any: 2 };

export const RULES = {
  tool_not_in_code: 'Docs name a tool that is not in the tool list',
  tool_undocumented: 'A tool in the tool list is not in any doc',
  policy_mismatch: 'Docs give a different allow/ask/block label than the tool list',
  one_click_not_stated: 'A one-click tool\'s docs do not say it stays one-click',
  param_not_in_schema: 'A CLI example passes a parameter the input schema does not have',
  example_missing_required: 'A CLI example leaves out a required parameter',
  example_invalid_json: 'A CLI example\'s arguments are not valid JSON',
  script_missing: 'Docs run an npm script package.json does not have',
  bin_missing: 'Docs run npx for a package with no bin',
  version_mismatch: 'Docs pin a version that differs from package.json',
  engines_mismatch: 'Docs give a Node version that differs from package.json engines',
  count_mismatch: 'Docs give the wrong number of tools',
  license_mismatch: 'The License section differs from package.json',
  broken_link: 'A relative link points at a missing file',
  broken_anchor: 'An #anchor matches no heading',
  skill_frontmatter: 'SKILL.md frontmatter is missing or malformed',
  endpoint_not_in_spec: 'Docs name an endpoint the OpenAPI spec does not have',
  endpoint_method_mismatch: 'Docs use a different HTTP method than the OpenAPI spec',
  endpoint_undocumented: 'An OpenAPI operation is not in any doc',
  endpoint_deprecated: 'Docs use a deprecated operation without saying so',
  changelog_missing: 'There is no CHANGELOG.md',
  changelog_missing_entry: 'CHANGELOG.md has no entry for the package.json version',
  changelog_ahead: 'CHANGELOG.md has an entry newer than package.json',
  changelog_duplicate: 'CHANGELOG.md has two entries for one version',
};

/** Line-independent fingerprint, so moving text up or down does not make it "new". */
export const fingerprint = (f) => sha256(`${f.check}|${f.file}|${f.detail}`).slice(0, 32);

export function compareBaseline(findings, baseline) {
  const old = new Set((baseline?.findings || []).map((f) => f.fingerprint || fingerprint(f)));
  const cur = new Set(findings.map((f) => f.fingerprint));
  return { new: findings.filter((f) => !old.has(f.fingerprint)), fixed: (baseline?.findings || []).filter((f) => !cur.has(f.fingerprint || fingerprint(f))) };
}

/** Which findings fail the gate. */
export function gate(findings, failOn = 'error') {
  if (!FAIL_ON.includes(failOn)) throw new Error(`fail_on must be one of ${FAIL_ON.join(', ')}`);
  if (failOn === 'none') return [];
  return findings.filter((f) => RANK[f.severity] <= LIMIT[failOn]);
}

/** SARIF 2.1.0 with paths relative to the repository root (prefix = pack folder). */
export function driftSarif(r, { prefix = '', toolsFile = null, version, informationUri }) {
  const path = (f) => { if (f.file === '(tool list)') return toolsFile; if (f.file === '(openapi)') return r.openapiFile || null; if (String(f.file).startsWith('(')) return prefix ? `${prefix}/package.json` : 'package.json'; return prefix ? `${prefix}/${f.file}` : f.file; };
  const used = [...new Set(r.findings.map((f) => f.check))];
  return toSarif({
    tool: 'echo-of-docs', version, informationUri,
    rules: used.map((id) => ({ id, description: RULES[id] || id, severity: r.findings.find((f) => f.check === id).severity })),
    findings: r.findings.map((f) => ({ ruleId: f.check, message: f.detail, severity: f.severity === 'advisory' ? 'note' : f.severity, file: path(f) || undefined, line: f.line || undefined, fingerprint: f.fingerprint })),
  });
}
