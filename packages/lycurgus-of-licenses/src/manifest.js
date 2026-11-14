import { defineManifest, toCsv, sha256 } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { check, sbom, sarif, reportMarkdown } from './licenses.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const props = {
  project: { ...str, description: 'Project folder with package.json and package-lock.json (or node_modules), relative to --root' },
  policy: { ...str, description: 'Your written license policy as JSON: source, allow, review, deny, unknown, dev_dependencies, exceptions' },
  include_dev: { type: 'boolean', description: 'Override the policy and include (true) or skip (false) dev dependencies' },
  as_of: { ...str, description: 'Date used to expire exceptions (default today), e.g. 2026-11-14' },
};
const rel = (ctx, f) => relative(ctx.root, f).split('\\').join('/');
function load(a, ctx) {
  if (!String(a.project ?? '').trim()) throw new Error('project is required');
  if (!String(a.policy ?? '').trim()) throw new Error('policy is required (your written license policy as JSON)');
  const dir = ctx.path(a.project); if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`project folder not found: ${a.project}`);
  const pf = ctx.path(a.policy); if (!existsSync(pf)) throw new Error(`policy file not found: ${a.policy}`);
  const policyText = readFileSync(pf, 'utf8');
  let policy; try { policy = JSON.parse(policyText); } catch { throw new Error('policy file is not valid JSON'); }
  const r = check(dir, policy, a);
  return { r, policyText };
}
const pub = (r) => { const { _lockText, ...rest } = r; return rest; };
const summaryLine = (r) => `${r.check}: ${r.packages.length} package(s) checked (${r.counts.allow || 0} allow, ${r.counts.review || 0} review, ${r.counts.unknown || 0} unknown, ${r.counts.deny || 0} deny), ${r.skipped.length} skipped, against ${r.policy_source}. Applies your policy; not legal advice.`;

export const manifest = defineManifest({
  name: 'lycurgus-of-licenses',
  version: pkg.version,
  description: 'Applies your written license policy to an npm project: reads package-lock.json and installed packages, parses SPDX expressions (OR, AND, WITH), sorts every dependency into allow, review, unknown or deny with the policy section, honours exceptions with an approver and expiry, and writes a report, CycloneDX SBOM and SARIF. Fails the check without changing files. Publishing a release is one human click. Not legal advice and never says a project is cleared for distribution.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'lycurgus_check', kind: 'read',
      description: 'Check every dependency\'s declared license against the policy. Returns check (pass, pass_with_review or fail), per-package decisions with the policy section, and findings. Reads files only; no network.',
      inputSchema: { type: 'object', required: ['project', 'policy'], properties: props },
      handler: async (a, ctx) => { const { r } = load(a, ctx); return { summary: summaryLine(r), ...pub(r) }; },
    },
    {
      name: 'lycurgus_write_report', kind: 'report',
      description: 'Write license-report.md, licenses.csv, sbom.cdx.json (CycloneDX 1.5), results.sarif (SARIF 2.1.0 for code scanning) and check-summary.json with the lockfile and policy hashes into out_dir (default mythos-out/lycurgus). The project is not changed.',
      inputSchema: { type: 'object', required: ['project', 'policy'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const { r, policyText } = load(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/lycurgus'); const tool = { name: pkg.name, version: pkg.version };
        const csv = toCsv(r.packages.map((p) => ({ name: p.name, version: p.version || '', dev: p.dev ? 'yes' : 'no', license: p.license || '', decision: p.decision, exception: p.exception ? `${p.exception.approved_by}${p.exception.expires ? ' until ' + p.exception.expires : ''}` : '', policy_section: p.policy_section || '', why: p.why, owner: '', status: '' })), ['name', 'version', 'dev', 'license', 'decision', 'exception', 'policy_section', 'why', 'owner', 'status']);
        const summary = { project: r.project, project_dir: a.project, policy: a.policy, policy_source: r.policy_source, policy_sha256: sha256(policyText), lockfile_sha256: r._lockText ? sha256(r._lockText) : null, check: r.check, counts: r.counts, as_of: r.as_of, created_at: new Date().toISOString(), note: 'Matches the policy as written. Not legal advice and not a clearance for distribution.' };
        const sText = JSON.stringify(summary, null, 2) + '\n';
        const files = [ctx.writeFile(out, 'license-report.md', reportMarkdown(r)), ctx.writeFile(out, 'licenses.csv', csv), ctx.writeFile(out, 'sbom.cdx.json', JSON.stringify(sbom(r, tool), null, 2) + '\n'), ctx.writeFile(out, 'results.sarif', JSON.stringify(sarif(r, tool), null, 2) + '\n'), ctx.writeFile(out, 'check-summary.json', sText)];
        return { summary: `Report, SBOM and SARIF written. ${summaryLine(r)}`, check: r.check, check_summary: rel(ctx, files[4]), check_summary_sha256: sha256(sText), files };
      },
    },
    {
      name: 'lycurgus_draft_exceptions', kind: 'write',
      description: 'For dependencies that need review or have an unknown license, write exceptions-proposed.json (stubs with [TO CONFIRM] reason and approver, 90-day expiry) and review-list.md into out_dir. Denied packages are listed to replace or remove, never as exceptions. Your policy and lockfile are not changed. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['project', 'policy'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const { r } = load(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/lycurgus');
        const exp = new Date(Date.parse(r.as_of) + 90 * 864e5).toISOString().slice(0, 10);
        const stubs = r.packages.filter((p) => p.decision === 'review' || p.decision === 'unknown').map((p) => ({ package: p.name, version: p.version, license: p.license, reason: '[TO CONFIRM why this is acceptable]', approved_by: '', expires: exp, found: p.why }));
        const denied = r.packages.filter((p) => p.decision === 'deny');
        const L = ['# Dependencies that need a decision', '', `Policy: ${r.policy_source}. Not legal advice; a person decides.`, '', `## Review or unknown (${stubs.length})`, '', ...stubs.map((s) => `- [ ] ${s.package}@${s.version} (${s.license || 'no license'}): ${s.found}`), '', `## Denied by the policy: replace or remove (${denied.length})`, '', ...denied.map((p) => `- [ ] ${p.name}@${p.version} (${p.license}): ${p.why}`), ''];
        return { summary: `${stubs.length} exception stub(s) and ${denied.length} package(s) to replace or remove written. Stubs have no approver, so they do not apply until a person fills them in and adds them to the policy. Nothing in the project or policy was changed.`, files: [ctx.writeFile(out, 'exceptions-proposed.json', JSON.stringify({ policy_source: r.policy_source, exceptions: stubs }, null, 2) + '\n'), ctx.writeFile(out, 'review-list.md', L.join('\n'))] };
      },
    },
    {
      name: 'lycurgus_request_release', kind: 'action', category: 'production_deploy',
      description: 'After one named human click (even in Auto), record in release-requests.csv that the checked version is approved to publish. Tied to check_summary_sha256; the lockfile and policy are re-hashed first. Refused when the check failed; a pass with review items needs review_note. A person publishes; Lycurgus never does.',
      inputSchema: { type: 'object', required: ['check_summary', 'check_summary_sha256'], properties: { check_summary: str, check_summary_sha256: str, review_note: { ...str, description: 'Required when the check is pass_with_review: who reviewed the open items and what they decided' }, out_dir: str } },
      handler: async (a, ctx) => {
        const sf = ctx.path(a.check_summary); if (!existsSync(sf)) throw new Error(`check summary not found: ${a.check_summary}`);
        const text = readFileSync(sf, 'utf8'); if (sha256(text) !== a.check_summary_sha256) throw new Error('check_summary_sha256 does not match the file; run lycurgus_write_report again and review it');
        const s = JSON.parse(text);
        const lock = join(ctx.path(s.project_dir), 'package-lock.json');
        if (s.lockfile_sha256 && (!existsSync(lock) || sha256(readFileSync(lock, 'utf8')) !== s.lockfile_sha256)) throw new Error('package-lock.json changed after the check; run the check again');
        if (sha256(readFileSync(ctx.path(s.policy), 'utf8')) !== s.policy_sha256) throw new Error('the policy file changed after the check; run the check again');
        if (s.check === 'fail') throw new Error('the license check failed; fix or replace the denied dependencies first');
        if (s.check === 'pass_with_review' && !String(a.review_note || '').trim()) throw new Error('the check passed with review items; add review_note saying who reviewed them');
        const dir = ctx.outDir(a.out_dir || 'mythos-out/lycurgus'); const f = join(dir, 'release-requests.csv');
        const row = toCsv([{ requested_at: new Date().toISOString(), project: `${s.project.name}@${s.project.version}`, check: s.check, check_summary_sha256: a.check_summary_sha256, review_note: a.review_note || '', status: 'approved - a person publishes' }], ['requested_at', 'project', 'check', 'check_summary_sha256', 'review_note', 'status']);
        appendFileSync(f, existsSync(f) ? row.split('\n').slice(1).join('\n') : row);
        return { summary: `Release of ${s.project.name}@${s.project.version} approved and recorded (${s.check}). Nothing was published.`, file: f };
      },
    },
    { name: 'write_lockfile', kind: 'action', category: 'production_deploy', description: 'Listed so agents can see it is refused. Lycurgus never edits package.json, the lockfile or node_modules.', inputSchema: { type: 'object', properties: {} } },
    { name: 'npm_publish', kind: 'action', category: 'production_deploy', description: 'Listed so agents can see it is refused. Lycurgus never publishes a package or release.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'lycurgus_check', decision: 'allow' },
    { tool: 'lycurgus_write_report', decision: 'allow' },
    { tool: 'lycurgus_draft_exceptions', decision: 'ask', reason: 'Writing exception stubs needs a human yes (or an Auto opt-in).' },
    { tool: 'write_lockfile', decision: 'block', reason: 'Lycurgus never changes your project files.' },
    { tool: 'npm_publish', decision: 'block', reason: 'Lycurgus never publishes. A person does.' },
    { tool: 'lycurgus_request_release', decision: 'ask', reason: 'Publishing a release is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Lycurgus allowlist.' },
  ] },
});
