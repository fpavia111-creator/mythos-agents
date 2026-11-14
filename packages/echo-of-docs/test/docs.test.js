import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
import { manifest, check, applyFixes, loadTools, slug } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const pack = join(fixtures, 'kettle-of-notes');
const tools = JSON.parse(readFileSync(join(pack, 'tools.json'), 'utf8'));
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'echo-')); cpSync(fixtures, r, { recursive: true }); return r; };
const at = (r, c) => r.findings.filter((f) => f.check === c);

test('tool list formats and heading slugs', () => {
  const t = loadTools(tools); assert.equal(t.length, 5, 'mythos_info is left out');
  assert.deepEqual(t.find((x) => x.name === 'kettle_request_publish'), { name: 'kettle_request_publish', decision: 'ask', category: 'production_deploy', properties: ['note', 'note_sha256'], required: ['note', 'note_sha256'] });
  assert.equal(loadTools({ name: 'x', tools: [{ name: 'a_b', decision: 'allow' }] })[0].decision, 'allow', 'mythos_info output');
  assert.equal(loadTools({ result: { tools: [{ name: 'a_b' }] } })[0].name, 'a_b');
  assert.throws(() => loadTools({ nope: 1 }), /tools file must be/);
  assert.equal(slug('What it is not'), 'what-it-is-not'); assert.equal(slug('`CLI` & usage'), 'cli--usage');
});
test('planted drift is found with file and line', () => {
  const r = check(pack, tools);
  assert.equal(r.issues, 19);
  assert.deepEqual(at(r, 'tool_not_in_code').map((f) => `${f.file}:${f.line}`), ['README.md:19', 'README.md:21', 'skills/notes/SKILL.md:7']);
  assert.match(at(r, 'policy_mismatch')[0].detail, /kettle_draft_note.*allow.*ask/);
  assert.match(at(r, 'param_not_in_schema')[0].detail, /`dir`.*`folder`/);
  assert.deepEqual(at(r, 'tool_undocumented').map((f) => f.detail.split('`')[1]), ['kettle_summarize', 'kettle_request_publish']);
  assert.equal(at(r, 'broken_anchor').length, 2); assert.equal(at(r, 'skill_frontmatter').length, 2);
  assert.equal(at(r, 'version_mismatch').length, 1, 'the guide already pins the right version');
});
test('clean docs produce no findings; categories are not tool names', () => {
  const d = mkdtempSync(join(tmpdir(), 'echo-clean-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', license: 'MIT', engines: { node: '>=20' }, bin: { p: 'b.js' } }));
  writeFileSync(join(d, 'README.md'), '# P\n\nNode ≥ 20. Two tools. See [tools](#tools).\n\n## Tools\n\n| Tool | Policy |\n|---|---|\n| `p_read` | **allow** |\n| `p_send` | **ask · one-click** (`production_deploy`) |\n\n```bash\nnpx -y p@1.0.0 demo\np call p_read \'{"x":"1"}\'\n```\n\n## License\n\nMIT\n');
  const r = check(d, [{ name: 'p_read', decision: 'allow', inputSchema: { type: 'object', properties: { x: {} }, required: ['x'] } }, { name: 'p_send', decision: 'ask', category: 'production_deploy' }]);
  assert.deepEqual(r.findings, []);
});
test('fixes are mechanical, capped, and only touch copies', () => {
  const r = check(pack, tools); assert.equal(r.fixes.length, 3);
  const before = readFileSync(join(pack, 'README.md'), 'utf8');
  const fx = applyFixes(pack, r.fixes, { maxFixes: 2 });
  assert.equal(fx.skipped.length, 1); assert.match(fx.skipped[0].why, /cap/);
  const readme = fx.files.find((f) => f.file === 'README.md');
  assert.match(readme.after, /`kettle_summarize`/); assert.match(readme.after, /kettle-of-notes@0\.3\.0/);
  assert.equal(readFileSync(join(pack, 'README.md'), 'utf8'), before);
});
test('draft on Auto; publish is one-click, hash-bound, checks originals; overwrite and push blocked', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['echo_draft_fixes'] });
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['echo_request_publish'] }), /one-click/);
  const f = { pack: 'kettle-of-notes', tools: 'kettle-of-notes/tools.json' };
  const d = await rt.call('echo_draft_fixes', f); assert.equal(d.status, 'executed');
  assert.match(readFileSync(join(root, 'mythos-out/echo/proposed/skills/notes/SKILL.md'), 'utf8'), /kettle_summarize/);
  const args = { proposal: d.result.proposal, proposal_sha256: d.result.proposal_sha256 };
  const a = await rt.call('echo_request_publish', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Kai');
  const ok = await rt.call('echo_request_publish', args); assert.equal(ok.status, 'executed'); assert.equal(ok.approved_by, 'Kai');
  assert.equal(parseCsv(readFileSync(join(root, 'mythos-out/echo/publish-requests.csv'), 'utf8'))[0].files, 'README.md; skills/notes/SKILL.md');
  const d2 = await rt.call('echo_draft_fixes', { ...f, out_dir: 'mythos-out/2' });
  const a2 = { proposal: d2.result.proposal, proposal_sha256: d2.result.proposal_sha256 };
  new ApprovalStore(join(root, '.mythos')).approve((await rt.call('echo_request_publish', a2)).approval_id, 'Kai');
  writeFileSync(join(root, 'kettle-of-notes/README.md'), '# edited meanwhile\n');
  assert.match((await rt.call('echo_request_publish', a2)).reason, /changed since the proposal/);
  for (const t of ['write_docs', 'git_push']) assert.equal((await rt.call(t, {})).status, 'blocked');
});
