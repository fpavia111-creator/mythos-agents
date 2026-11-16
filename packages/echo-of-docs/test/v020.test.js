import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, readAudit, validateSarif, createMcpHandler } from 'mythos-agent-core';
import { manifest, check, checkOpenapi, checkChangelog, specOperations, docEndpoints, compareBaseline, gate } from '../src/index.js';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(pkgDir, 'fixtures');
const ladle = join(fixtures, 'ladle-of-api');
const spec = JSON.parse(readFileSync(join(ladle, 'openapi.json'), 'utf8'));
const bin = join(pkgDir, 'bin/echo-of-docs.js');
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'echo-v2-')); cpSync(fixtures, r, { recursive: true }); return r; };
const at = (r, c) => r.findings.filter((f) => f.check === c);
const ownTools = () => ({ tools: new AgentRuntime(manifest, { audit: false }).listTools() });

test('OpenAPI drift: endpoints not in the spec, wrong method, undocumented and deprecated operations', () => {
  const r = check(ladle, null, { openapi: spec, openapiLabel: 'openapi.json' });
  assert.deepEqual(r.findings.map((f) => `${f.check}@${f.line}`), ['endpoint_method_mismatch@11', 'endpoint_not_in_spec@12', 'endpoint_undocumented@null', 'changelog_missing_entry@3', 'endpoint_deprecated@13']);
  assert.match(at(r, 'endpoint_method_mismatch')[0].detail, /`GET`, `PUT`/);
  assert.match(at(r, 'endpoint_undocumented')[0].detail, /POST \/v1\/recipes.*createRecipe/);
  assert.deepEqual(r.openapi, { operations: 5, documented: 4 });
  const ops = specOperations(spec); assert.equal(ops.base, '/v1'); assert.equal(ops.ops.length, 5);
  assert.equal(specOperations({ swagger: '2.0', basePath: '/api', paths: { '/a': { get: {} } } }).base, '/api');
  assert.throws(() => specOperations({ paths: {} }), /OpenAPI 3\.x or Swagger 2\.0/);
  assert.deepEqual(docEndpoints(['Call `GET /notes/:id`, then curl -X DELETE https://h.example/notes/1.']).map((e) => `${e.method} ${e.path}`), ['GET /notes/:id', 'DELETE /notes/1']);
  const ok = checkOpenapi([{ rel: 'README.md', lines: ['GET /items/{id} and GET /items/7 (deprecated)'] }], { openapi: '3.1.0', paths: { '/items/{itemId}': { get: { deprecated: true } } } });
  assert.deepEqual(ok.findings, [], 'templated match, and the doc says deprecated');
});

test('CHANGELOG vs version: missing entry, ahead, duplicate, required', () => {
  assert.deepEqual(checkChangelog('# Changelog\n\n## 1.0.0\n', '1.0.0'), []);
  assert.deepEqual(checkChangelog('## [2.0.0] - x\n## 1.1.0\n## v1.1.0\n', '1.1.0').map((f) => f.check), ['changelog_ahead', 'changelog_duplicate']);
  assert.equal(checkChangelog('## 1.0.0\n', '1.1.0')[0].check, 'changelog_missing_entry');
  assert.equal(checkChangelog('## 1.0.0-beta.1\n', '1.0.0')[0].check, 'changelog_missing_entry');
  assert.deepEqual(checkChangelog(null, '1.0.0'), []);
  assert.equal(checkChangelog(null, '1.0.0', { require: true })[0].check, 'changelog_missing');
  assert.equal(at(check(join(fixtures, 'kettle-of-notes'), null, { require_changelog: true }), 'changelog_missing').length, 1);
  const own = check(pkgDir, ownTools());
  assert.deepEqual(own.findings.filter((f) => f.check.startsWith('changelog')), [], 'this package has a 0.2.0 entry');
});

test('config file: used by the tools, and typos fail with JSON pointers', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root });
  const r = await rt.call('echo_check', { config: 'ladle-of-api/echo.config.json' });
  assert.equal(r.status, 'executed'); assert.ok(r.result.findings.some((f) => f.check === 'endpoint_not_in_spec'));
  const good = JSON.parse(readFileSync(join(root, 'ladle-of-api/echo.config.json'), 'utf8'));
  for (const [name, cfg, re] of [['unknown', { ...good, fail_onn: 'error' }, /fail_onn/], ['wrongtype', { ...good, require_changelog: 'yes' }, /\/require_changelog/], ['missing', { openapi: good.openapi }, /pack/]]) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(cfg));
    const x = await rt.call('echo_check', { config: `${name}.json` });
    assert.equal(x.status, 'error', name); assert.match(x.reason, /not a valid docs_config/); assert.match(x.reason, re);
  }
  assert.match((await rt.call('echo_check', {})).reason, /pack is required/);
  assert.match((await rt.call('echo_check', { pack: 7 })).reason, /invalid arguments/);
  assert.match((await rt.call('echo_check', { pack: 'ladle-of-api', openapi: 'ladle-of-api/openapi.yaml' })).reason, /convert a YAML spec to JSON/);
});

test('echo_ci: SARIF with repo-relative paths, fail_on, baseline and new_only; hash in the audit log', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root });
  const k = { pack: 'kettle-of-notes', tools: 'kettle-of-notes/tools.json' };
  const a = await rt.call('echo_ci', { ...k, out_dir: 'ci/a' }); assert.equal(a.status, 'executed'); assert.equal(a.decision, 'allow');
  assert.equal(a.result.pass, false); assert.equal(a.result.failing.length, 9);
  const sarif = JSON.parse(readFileSync(join(root, 'ci/a/echo-of-docs.sarif'), 'utf8'));
  const v = validateSarif(sarif); assert.ok(v.ok, v.errors.join('; '));
  const uris = sarif.runs[0].results.map((x) => x.locations?.[0]?.physicalLocation.artifactLocation.uri).filter(Boolean);
  assert.ok(uris.includes('kettle-of-notes/README.md')); assert.ok(uris.includes('kettle-of-notes/tools.json'));
  assert.equal(sarif.runs[0].results.length, 19);
  const line = readAudit(join(root, '.mythos/audit.jsonl')).filter((e) => e.tool === 'echo_ci').pop(); assert.equal(line.output_sha256, a.result.output_sha256);
  assert.equal((await rt.call('echo_ci', { ...k, fail_on: 'none', out_dir: 'ci/b' })).result.pass, true);
  assert.equal((await rt.call('echo_ci', { ...k, fail_on: 'any', out_dir: 'ci/c' })).result.failing.length, 19);
  // baseline: fix one README problem, add a new one
  writeFileSync(join(root, 'kettle-of-notes/README.md'), readFileSync(join(root, 'kettle-of-notes/README.md'), 'utf8').replace('npm run lint\n', '').replace('## Modes', 'See [setup](docs/setup.md).\n\n## Modes'));
  const b = await rt.call('echo_ci', { ...k, baseline: 'ci/a/drift.json', new_only: true, out_dir: 'ci/d' });
  assert.equal(b.result.new, 1); assert.equal(b.result.fixed, 1); assert.equal(b.result.failing[0].check, 'broken_link');
  assert.match(b.result.fixed_findings[0].detail, /npm run lint/);
  const unchanged = compareBaseline([{ check: 'x', file: 'a', detail: 'd', fingerprint: 'f' }], { findings: [{ fingerprint: 'f', line: 99 }] });
  assert.deepEqual([unchanged.new.length, unchanged.fixed.length], [0, 0]);
  assert.throws(() => gate([], 'all'), /fail_on/);
  assert.match((await rt.call('echo_ci', { ...k, baseline: 'kettle-of-notes/package.json' })).reason, /drift\.json written by echo_ci/);
});

test('ci command: exit 1 on drift, 0 on this package, 2 on bad usage', () => {
  const root = tmpRoot(); const state = mkdtempSync(join(tmpdir(), 'echo-ci-state-'));
  const run = (...a) => spawnSync(process.execPath, [bin, 'ci', '--root', root, '--state-dir', state, ...a], { encoding: 'utf8' });
  const bad = run('--pack', 'kettle-of-notes', '--tools', 'kettle-of-notes/tools.json');
  assert.equal(bad.status, 1, bad.stderr); assert.match(bad.stdout, /^FAIL/); assert.match(bad.stdout, /SARIF: mythos-out\/echo\/echo-of-docs\.sarif/);
  assert.ok(existsSync(join(root, 'mythos-out/echo/echo-of-docs.sarif')));
  assert.equal(run('--pack', 'kettle-of-notes', '--fail-on', 'none').status, 0);
  assert.equal(run('--pack', 'kettle-of-notes', '--bogus', 'x').status, 2);
  assert.equal(run().status, 2);
  // this package, checked against its own tool list, has no drift at all
  const self = mkdtempSync(join(tmpdir(), 'echo-self-')); mkdirSync(join(self, 'echo-of-docs'));
  for (const f of ['README.md', 'CHANGELOG.md', 'package.json']) cpSync(join(pkgDir, f), join(self, 'echo-of-docs', f));
  writeFileSync(join(self, 'tools.json'), JSON.stringify(ownTools()));
  const ok = spawnSync(process.execPath, [bin, 'ci', '--root', self, '--state-dir', state, '--pack', 'echo-of-docs', '--tools', 'tools.json', '--fail-on', 'any', '--require-changelog'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.match(ok.stdout, /^PASS: echo-of-docs@0\.2\.0: 0 drift/);
});

test('GitHub Action: the composite step fails on drift, passes on this package, and produces SARIF', { skip: process.platform === 'win32' && 'needs bash' }, () => {
  const yml = readFileSync(join(pkgDir, 'action.yml'), 'utf8');
  const lines = yml.split('\n'); const start = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l)); const indent = lines[start + 1].match(/^\s*/)[0];
  const script = lines.slice(start + 1).filter((l, i, arr) => arr.slice(0, i + 1).every((x) => x.startsWith(indent) || !x.trim())).map((l) => l.slice(indent.length)).join('\n');
  assert.match(script, /npx -y "echo-of-docs@\$ECHO_VERSION"/);
  for (const flag of script.match(/--[a-z-]+/g)) assert.ok(['--root', '--state-dir', '--pack', '--fail-on', '--out-dir', '--tools', '--openapi', '--config', '--baseline', '--new-only', '--require-changelog'].includes(flag), flag);
  for (const input of ['pack', 'tools', 'openapi', 'config', 'fail-on', 'baseline', 'new-only', 'require-changelog', 'out-dir', 'version']) assert.match(yml, new RegExp(`\\n  ${input}:\\n`), input);
  const runAction = (workspace, env) => {
    const out = join(mkdtempSync(join(tmpdir(), 'echo-gh-')), 'out');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: mkdtempSync(join(tmpdir(), 'echo-rt-')), GITHUB_OUTPUT: out, ECHO_CMD: bin, ECHO_TOOLS: '', ECHO_OPENAPI: '', ECHO_CONFIG: '', ECHO_BASELINE: '', ECHO_NEW_ONLY: 'false', ECHO_REQUIRE_CHANGELOG: 'false', ECHO_FAIL_ON: 'error', ECHO_OUT_DIR: 'mythos-out/echo', ECHO_VERSION: '0.2.0', ...env } });
    return { ...r, output: readFileSync(out, 'utf8') };
  };
  const ws = tmpRoot();
  const drift = runAction(ws, { ECHO_PACK: 'ladle-of-api', ECHO_OPENAPI: 'ladle-of-api/openapi.json' });
  assert.equal(drift.status, 1, drift.stderr); assert.equal(drift.output.trim(), 'sarif=mythos-out/echo/echo-of-docs.sarif');
  assert.ok(validateSarif(JSON.parse(readFileSync(join(ws, 'mythos-out/echo/echo-of-docs.sarif'), 'utf8'))).ok);
  const self = mkdtempSync(join(tmpdir(), 'echo-gh-self-'));
  for (const f of ['README.md', 'CHANGELOG.md', 'package.json']) cpSync(join(pkgDir, f), join(self, f));
  writeFileSync(join(self, 'tools.json'), JSON.stringify(ownTools()));
  const pass = runAction(self, { ECHO_PACK: '.', ECHO_TOOLS: 'tools.json', ECHO_REQUIRE_CHANGELOG: 'true' });
  assert.equal(pass.status, 0, pass.stdout + pass.stderr); assert.ok(existsSync(join(self, 'mythos-out/echo/echo-of-docs.sarif')));
  assert.match(readFileSync(join(pkgDir, 'examples/docs-drift.yml'), 'utf8'), /upload-sarif/);
});

test('MCP prompt walks the workflow and marks the human click', async () => {
  const h = createMcpHandler(new AgentRuntime(manifest, { audit: false }));
  assert.deepEqual((await h({ jsonrpc: '2.0', id: 1, method: 'prompts/list' })).result.prompts.map((p) => p.name), ['docs_drift_review']);
  const g = await h({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'docs_drift_review', arguments: { pack: 'ladle-of-api' } } });
  const text = g.result.messages[0].content.text;
  for (const t of ['echo_check', 'echo_write_report', 'echo_ci', 'echo_draft_fixes', 'echo_request_publish', 'one click']) assert.ok(text.includes(t), t);
  assert.match(text, /ladle-of-api/);
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root });
  const w = await rt.call('echo_write_report', { pack: 'kettle-of-notes' }); assert.match(w.result.output_sha256, /^[0-9a-f]{64}$/);
});

test('MCP prompt names are not reported as missing tools', () => {
  const d = mkdtempSync(join(tmpdir(), 'echo-prompt-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
  writeFileSync(join(d, 'README.md'), '# P\n\nUse `p_read`.\n\n### MCP prompt\n\n`p_review` walks the workflow.\n\n## Other\n\nAlso `p_audit_flow` and `p_raed`.\n');
  const tools = { tools: [{ name: 'p_read', decision: 'allow' }], prompts: [{ name: 'p_audit_flow' }] };
  const r = check(d, tools);
  assert.deepEqual(r.findings.map((f) => `${f.check}:${f.line}`), ['tool_not_in_code:11'], 'only the real typo is flagged');
});

test('config schema names that share a tool prefix are not reported as missing tools', () => {
  const d = mkdtempSync(join(tmpdir(), 'echo-schema-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
  writeFileSync(join(d, 'README.md'), '# P\n\nUse `p_read`. Check your file against the `p_template` schema.\n\nAlso `p_raed`.\n');
  const tools = [{ name: 'p_read', decision: 'allow' }];
  assert.deepEqual(check(d, { tools }).findings.map((f) => `${f.check}:${f.line}`), ['tool_not_in_code:3', 'tool_not_in_code:5']);
  assert.deepEqual(check(d, { tools, config_schemas: ['p_template'] }).findings.map((f) => `${f.check}:${f.line}`), ['tool_not_in_code:5'], 'only the real typo is flagged');
});
