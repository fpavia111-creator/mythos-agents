import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv, validate, validateIcs, validateSarif, createMcpHandler } from 'mythos-agent-core';
import { manifest, check, sbom, sarif, identifyLicense, TEMPLATES, notices, diffSbom, detectEcosystem, parseYamlLite, splitPnpmKey, pyLicense, parseMetadata, readGo, NO_ATTRIBUTION_DEFAULT } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const bin = fileURLToPath(new URL('../bin/lycurgus-of-licenses.js', import.meta.url));
const json = (f) => JSON.parse(readFileSync(join(fixtures, f), 'utf8'));
const policy = json('license-policy.json'); const policyGo = json('license-policy-go.json');
const text = (f) => readFileSync(join(fixtures, 'license-texts', f), 'utf8');
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'lyc2-')); cpSync(fixtures, r, { recursive: true }); return r; };
const as_of = '2026-11-14';
const run = (dir, o = {}, p = policy) => check(join(fixtures, dir), p, { as_of, ...o });
const pkgOf = (r, n) => r.packages.find((p) => p.name === n);
const NPM = { modules_dir: '../installed-npm' };

test('pnpm, yarn, Python and Go lockfiles give the same counts as the npm fixture', () => {
  const npm = run('project');
  const others = { pnpm: run('project-pnpm', NPM), yarn: run('project-yarn', NPM), python: run('project-python'), go: run('project-go', {}, policyGo) };
  for (const [eco, r] of Object.entries(others)) {
    assert.equal(r.ecosystem, eco); assert.deepEqual(r.counts, npm.counts, eco); assert.equal(r.check, 'fail', eco); assert.equal(r.packages.length, 15, eco);
    assert.ok(r.findings.some((f) => f.check === 'exception_expired'), `${eco}: expired exception`); assert.ok(r.findings.some((f) => f.check === 'exception_applied'), `${eco}: exception applied`);
  }
  assert.deepEqual(npm.counts, { allow: 8, deny: 2, review: 3, unknown: 2 });
  for (const eco of ['pnpm', 'yarn', 'python']) assert.deepEqual(others[eco].skipped.map((s) => s.name), ['test-runner-gpl', 'my-plugin'], `${eco}: dev dependency and workspace link skipped`);
  assert.deepEqual(others.go.skipped.map((s) => s.name), ['example.test/fict/my-plugin'], 'go.mod has no dev dependencies; the replaced local module is skipped');
  assert.deepEqual([others.pnpm.lockfile, others.yarn.lockfile, others.python.lockfile, others.go.lockfile], ['pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'vendor/modules.txt']);
  assert.equal(run('project-pnpm', { ...NPM, include_dev: true }).counts.deny, 3, 'pnpm: dev dependency found through the importer');
  assert.equal(run('project-yarn', { ...NPM, include_dev: true }).counts.deny, 3, 'yarn: dev dependency found by reachability');
  assert.equal(pkgOf(others.yarn, 'tiny-fmt').dev, false, 'a transitive production dependency is not dev');
  assert.equal(run('project-python', { include_dev: true }).counts.deny, 3);
});

test('lockfile parsing details', () => {
  assert.equal(detectEcosystem(join(fixtures, 'project')), 'npm'); assert.equal(detectEcosystem(join(fixtures, 'project-go')), 'go'); assert.equal(detectEcosystem(join(fixtures, 'license-texts')), null);
  assert.deepEqual(splitPnpmKey('/@scope/name@1.2.3(react@18.0.0)'), { name: '@scope/name', version: '1.2.3' }); assert.deepEqual(splitPnpmKey('/left@1.0.0'), { name: 'left', version: '1.0.0' });
  const y = parseYamlLite("a:\n  'k@1': {}\n  b:\n    c: 'x: y'\nd: 1\n"); assert.equal(y.a.b.c, 'x: y'); assert.equal(y.d, '1'); assert.equal(y.a['k@1'], '{}');
  assert.deepEqual(pyLicense(parseMetadata('Name: x\nLicense-Expression: MIT\nLicense: BSD\n')), { value: 'MIT', via: 'License-Expression' });
  assert.equal(pyLicense(parseMetadata('Name: x\nClassifier: License :: OSI Approved :: Apache Software License\n')).value, 'Apache-2.0');
  assert.equal(pyLicense(parseMetadata('Name: x\nClassifier: License :: Other/Proprietary License\n')).value, 'UNLICENSED');
  assert.equal(pyLicense(parseMetadata('Name: x\nLicense: Permission is hereby granted, free of charge, to any person obtaining a copy of this software\n')).value, null, 'a full text in License is not an id');
  const py = run('project-python'); assert.equal(pkgOf(py, 'express-lite').license_source, 'METADATA (classifier)'); assert.equal(pkgOf(py, 'internal-sdk').license, 'UNLICENSED');
  const d = mkdtempSync(join(tmpdir(), 'lyc-req-')); writeFileSync(join(d, 'requirements.txt'), '# pinned\nexpress-lite==4.0.0\n-e ./packages/my-plugin\nnolicense-pkg==0.1.0 ; python_version >= "3.9"\n');
  cpSync(join(fixtures, 'project-python/site-packages'), join(d, 'site-packages'), { recursive: true });
  const rq = check(d, policy, { as_of }); assert.equal(rq.lockfile, 'requirements.txt'); assert.deepEqual(rq.counts, { allow: 1, unknown: 1 }); assert.equal(rq.skipped.length, 1);
  const g = mkdtempSync(join(tmpdir(), 'lyc-go-')); writeFileSync(join(g, 'go.mod'), 'module example.test/x\n\nrequire example.test/fict/a v1.0.0\nrequire (\n\texample.test/fict/b v2.0.0 // indirect\n)\n');
  const gm = readGo(g); assert.deepEqual(gm.pkgs.map((p) => `${p.name}@${p.version}`), ['example.test/fict/a@v1.0.0', 'example.test/fict/b@v2.0.0']); assert.equal(gm.lockFile, 'go.mod');
  assert.deepEqual(check(g, policy, { as_of }).counts, { unknown: 2 }, 'no vendor folder: nothing to read, so unknown, never allow');
  assert.throws(() => check(join(fixtures, 'project'), policy, { ecosystem: 'yarn' }), /yarn.lock not found/);
});

test('license text detection: MIT, ISC and BSD texts are identified; low confidence is never high', () => {
  for (const [f, id] of [['MIT.txt', 'MIT'], ['ISC.txt', 'ISC'], ['BSD-2-Clause.txt', 'BSD-2-Clause'], ['BSD-3-Clause.txt', 'BSD-3-Clause']]) { const r = identifyLicense(text(f)); assert.deepEqual([r.id, r.level], [id, 'high'], f); assert.ok(r.confidence >= 0.97); }
  assert.deepEqual([identifyLicense(TEMPLATES['0BSD']).id, identifyLicense(TEMPLATES.Unlicense).id], ['0BSD', 'Unlicense']);
  const reflowed = text('MIT.txt').split('\n\n').map((para) => para.replace(/\s+/g, ' ')).join('\n\n').replace(/"/g, '\u201c').toUpperCase(); assert.equal(identifyLicense(reflowed).level, 'high', 'line wrapping, case and quote style do not matter');
  assert.equal(identifyLicense(text('MIT.txt').replace(/\s+/g, ' ')).level, 'low', 'squashed onto one line the copyright notice cannot be told from extra terms, so a person looks');
  const extra = identifyLicense(text('MIT-with-extra-clause.txt')); assert.deepEqual([extra.id, extra.level], ['MIT', 'low']); assert.match(extra.note, /differs from the standard wording/);
  assert.equal(identifyLicense(`${TEMPLATES.MIT} The Software shall be used for Good, not Evil.`).level, 'low', 'an added restriction is not a clean MIT');
  assert.equal(identifyLicense(TEMPLATES.MIT.split(' ').slice(0, 90).join(' ')).level !== 'high', true, 'a truncated text is not high');
  const gpl = identifyLicense(text('GPL-3.0-heading-only.txt')); assert.deepEqual([gpl.id, gpl.level], ['GPL-3.0-only', 'low']); assert.match(gpl.note, /"only" or "or later"/);
  assert.deepEqual([identifyLicense(text('custom.txt')).id, identifyLicense(text('custom.txt')).level], [null, 'none']); assert.equal(identifyLicense('MIT').level, 'none');
  const apache = readFileSync(join(fixtures, 'project-go/vendor/example.test/fict/req-cli/LICENSE'), 'utf8');
  const a = identifyLicense(apache); assert.deepEqual([a.id, a.level], ['Apache-2.0', 'high']); assert.match(a.method, /fingerprint/);
  const clause = identifyLicense(`${apache}\n\n${'Additional condition (fictional): the grant of rights does not include the right to sell the software or a service built mainly on it. '.repeat(6)}`);
  assert.deepEqual([clause.id, clause.level], ['Apache-2.0', 'low']); assert.match(clause.note, /words longer than the official text/);
  assert.equal(identifyLicense(apache.slice(0, 5000)).level, 'low', 'half an Apache text is only a title match');
});

test('text detection in a check: close match is used, low confidence goes to review or stricter, mismatch is flagged', () => {
  const pn = run('project-pnpm', NPM);
  assert.deepEqual([pkgOf(pn, 'hashy').license, pkgOf(pn, 'hashy').decision, pkgOf(pn, 'hashy').license_source], ['BSD-3-Clause', 'allow', 'license text (LICENSE)']);
  assert.ok(pn.findings.some((f) => f.check === 'license_from_text' && f.package === 'hashy' && f.severity === 'advisory'));
  const mm = pn.findings.find((f) => f.check === 'license_text_mismatch'); assert.equal(mm.package, '@fict/logger'); assert.match(mm.detail, /Metadata says MIT, but LICENSE matches the ISC text/);
  assert.equal(pkgOf(pn, '@fict/logger').license, 'MIT', 'the declared license still decides');
  assert.equal(pkgOf(pn, 'custom-fonts').decision, 'unknown'); assert.match(pkgOf(pn, 'custom-fonts').why, /does not match a known license text/);
  assert.equal(pkgOf(run('project-pnpm', { ...NPM, detect_text: false }), 'hashy').decision, 'unknown', 'detect_text: false keeps the 0.1.0 behaviour');
  const go = run('project-go', {}, policyGo); const g = (n) => pkgOf(go, `example.test/fict/${n}`);
  assert.deepEqual([g('gpl-widget').decision, g('gpl-widget').license, g('gpl-widget').detected.level], ['deny', null, 'low'], 'low confidence GPL: the stricter policy answer stands');
  assert.deepEqual([g('lgpl-codec').decision, g('mpl-thing').decision, g('icons-cc').decision], ['review', 'review', 'review']);
  assert.equal(go.findings.filter((f) => f.check === 'license_text_low_confidence').length, 5);
  // An allow-listed license matched with low confidence must not be allowed.
  const d = mkdtempSync(join(tmpdir(), 'lyc-low-')); mkdirSync(join(d, 'node_modules/almost-mit'), { recursive: true });
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', license: 'MIT' })); writeFileSync(join(d, 'LICENSE'), 'x');
  writeFileSync(join(d, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/almost-mit': { version: '1.0.0' } } }));
  writeFileSync(join(d, 'node_modules/almost-mit/package.json'), JSON.stringify({ name: 'almost-mit', version: '1.0.0' })); writeFileSync(join(d, 'node_modules/almost-mit/LICENSE'), text('MIT-with-extra-clause.txt'));
  const low = check(d, policy, { as_of }); assert.equal(low.packages[0].decision, 'review'); assert.equal(low.check, 'pass_with_review'); assert.equal(low.packages[0].license, null);
  assert.match(low.findings.find((f) => f.check === 'license_text_low_confidence').detail, /low confidence, so a person must confirm/);
  assert.equal(check(d, { ...policy, unknown: 'deny' }, { as_of }).packages[0].decision, 'review', 'MIT is allow-listed, so low confidence means review, not deny');
  assert.ok(!JSON.stringify(low).includes('cleared for distribution"'));
});

test('SBOM purls and SARIF lines follow the ecosystem', () => {
  const tool = { name: 'lycurgus-of-licenses', version: '0.2.0' };
  assert.equal(sbom(run('project-python'), tool).components.find((c) => c.name === 'fict-logger').purl, 'pkg:pypi/fict-logger@1.0.0');
  assert.equal(sbom(run('project-go', {}, policyGo), tool).components[0].purl, 'pkg:golang/example.test/fict/express-lite@v4.0.0');
  for (const [dir, o, p, file] of [['project-pnpm', NPM, policy, 'pnpm-lock.yaml'], ['project-yarn', NPM, policy, 'yarn.lock'], ['project-python', {}, policy, 'poetry.lock'], ['project-go', {}, policyGo, 'vendor/modules.txt']]) {
    const s = sarif(run(dir, o, p), tool); assert.ok(validateSarif(s).ok, dir);
    const den = s.runs[0].results.find((x) => /gpl-widget/.test(x.message.text) && x.level === 'error'); assert.equal(den.locations[0].physicalLocation.artifactLocation.uri, file); assert.ok(den.locations[0].physicalLocation.region.startLine > 1, `${dir}: line found`);
  }
});

test('notices: every allow-listed package that needs attribution is included; not legal advice', () => {
  const r = run('project-pnpm', NPM); const n = notices(r, policy, { name: 'lycurgus-of-licenses', version: '0.2.0' });
  const need = r.packages.filter((p) => p.decision === 'allow' && !p.dev && p.license && !NO_ATTRIBUTION_DEFAULT.includes(p.license)).map((p) => p.name).sort();
  assert.deepEqual(need, ['@fict/logger', 'dual-lib', 'express-lite', 'hashy', 'old-parse', 'req-cli', 'tiny-fmt']);
  for (const name of need) { assert.ok(n.entries.some((e) => e.name === name), `${name} is in the entries`); assert.ok(n.text.includes(`### ${name} `), `${name} is in the file`); }
  assert.ok(!n.entries.some((e) => ['gpl-widget', 'expired-ex', 'internal-sdk', 'nolicense-pkg', 'custom-fonts'].includes(e.name)));
  assert.ok(n.left_out.some((x) => /gpl-widget/.test(x.package) && /denied/.test(x.why))); assert.ok(n.left_out.some((x) => /internal-sdk/.test(x.package) && /not_required/.test(x.why)));
  assert.match(n.text, /Copyright \(c\) 2026 Express Lite Authors \(fictional\)/); assert.match(n.text, /not legal advice/);
  const mit = n.entries.find((e) => e.name === 'express-lite').text_refs[0]; assert.equal(n.entries.find((e) => e.name === 'dual-lib').text_refs[0], mit, 'identical license texts are printed once');
  assert.ok(n.text.includes(`### [${mit}] MIT\n\nUsed by: dual-lib@1.0.0, express-lite@4.0.0`), 'texts are labelled by what they are, not by what metadata says');
  assert.ok(n.needs_person.some((x) => /@fict\/logger@1.0.0: metadata says MIT, but its license file matches ISC/.test(x)));
  assert.match(n.text, /\[TO ADD: license text and copyright notice for req-cli/); assert.match(n.text, /NOTICE:\n\n {4}req-cli/); assert.equal(n.missing_texts, 5);
  assert.ok(n.needs_person.some((x) => /lgpl-codec.*the policy says review/.test(x))); assert.ok(n.needs_person.some((x) => /nolicense-pkg.*license not identified/.test(x)));
  assert.ok(!/cleared|compliant/i.test(n.text));
  const all = notices(r, { ...policy, attribution: { not_required: ['MIT', 'ISC'] } }); assert.ok(!all.entries.some((e) => e.name === 'express-lite'), 'the policy can say MIT needs no entry'); assert.ok(all.entries.some((e) => e.name === 'internal-sdk'));
  assert.equal(notices(run('project'), policy).missing_texts, 10, 'nothing installed: every entry is marked, none is guessed');
});

test('SBOM diff: added, removed, version and license changes; new problems first', () => {
  const d = diffSbom(json('baseline/sbom.cdx.json'), run('project'));
  assert.deepEqual(d.added.map((x) => x.name), ['gpl-widget']); assert.deepEqual(d.removed.map((x) => x.name), ['old-util']);
  assert.deepEqual(d.version_changed.map((x) => x.name), ['hashy', 'icons-cc']);
  assert.deepEqual(d.license_changed, [{ name: 'icons-cc', from: 'MIT', to: 'CC-BY-4.0', version_from: '0.9.0', version_to: '1.0.0', decision: 'review' }]);
  assert.deepEqual(d.new_problems.map((x) => `${x.name}:${x.decision}`), ['gpl-widget:deny', 'icons-cc:review']); assert.equal(d.changes, 5);
  assert.equal(diffSbom({ components: [{ name: 'express-lite', version: '4.0.0', licenses: [{ license: { id: 'MIT' } }] }] }, run('project')).license_changed.length, 0, 'license.id form is read too');
  assert.throws(() => diffSbom({}, run('project')), /CycloneDX SBOM/);
});

test('exception hygiene: unused and expiring exceptions', () => {
  const p = { ...policy, exceptions: [...policy.exceptions, { package: 'gone-pkg', reason: 'x', approved_by: 'Dana Counsel (fictional)', expires: '2027-01-01' }] };
  const r = check(join(fixtures, 'project'), p, { as_of: '2027-06-10' });
  assert.ok(r.findings.some((f) => f.check === 'exception_unused' && f.package === 'gone-pkg' && f.severity === 'advisory'));
  const ex = r.findings.find((f) => f.check === 'exception_expiring'); assert.equal(ex.package, 'internal-sdk'); assert.match(ex.detail, /expires on 2027-06-30 \(20 day\(s\)/);
  assert.ok(!run('project').findings.some((f) => /exception_(unused|expiring)/.test(f.check)));
});

test('tools: notices, diff and report through the runtime, with output hashes in the audit log', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root });
  const f = { project: 'project-pnpm', policy: 'license-policy.json', modules_dir: '../installed-npm', as_of };
  const n = await rt.call('lycurgus_write_notices', f); assert.equal(n.status, 'executed', n.reason); assert.match(n.result.summary, /10 package\(s\), 3 distinct license text\(s\), 5 with no local license text/);
  assert.match(readFileSync(n.result.files[0], 'utf8'), /^# Third-party notices for kettle-app 1.4.0/); assert.equal(parseCsv(readFileSync(n.result.files[1], 'utf8')).find((x) => x.name === 'req-cli').license_text, 'TO ADD');
  const w = await rt.call('lycurgus_write_report', f); assert.match(w.result.output_sha256, /^[0-9a-f]{64}$/);
  const ics = w.result.files.find((x) => x.endsWith('exceptions.ics')); const v = validateIcs(readFileSync(ics, 'utf8')); assert.ok(v.ok, v.errors.join('; ')); assert.equal(v.events, 2);
  const csv = parseCsv(readFileSync(w.result.files[1], 'utf8')); assert.equal(csv.find((x) => x.name === 'hashy').text_match, 'BSD-3-Clause (high 1)');
  const lines = readFileSync(join(root, '.mythos/audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].output_sha256, n.result.output_sha256); assert.equal(lines[1].output_sha256, w.result.output_sha256);
  assert.equal((await new AgentRuntime(manifest, { root, audit: false }).call('lycurgus_write_report', { ...f, out_dir: 'mythos-out/again' })).result.output_sha256, w.result.output_sha256, 'same inputs, same output hash');
  const c = await rt.call('lycurgus_check', f); assert.ok(!JSON.stringify(c).includes(root), 'no absolute paths in results'); assert.equal(c.result.packages[0]._dir, undefined);
  const d = await rt.call('lycurgus_diff_sbom', { baseline: 'baseline/sbom.cdx.json', project: 'project', policy: 'license-policy.json', as_of });
  assert.equal(d.status, 'executed'); assert.match(d.result.summary, /5 change\(s\) since the baseline: 1 added, 1 removed, 2 version change\(s\), 1 license change\(s\); 2 need a look/); assert.match(d.result.markdown, /Not legal advice/);
  assert.equal((await rt.call('lycurgus_check', { ...f, modules_dir: '../../outside' })).status, 'error', 'modules_dir cannot leave --root');
  assert.equal((await rt.call('lycurgus_check', { ...f, ecosystem: 'cargo' })).status, 'error');
});

test('release request re-hashes a non-npm lockfile', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root }); const store = new ApprovalStore(join(root, '.mythos'));
  const lockFile = join(root, 'project-go/vendor/modules.txt');
  const mod = readFileSync(lockFile, 'utf8').split('\n').filter((l) => !/gpl-widget|expired-ex/.test(l)).join('\n').replace(/## explicit; go 1\.20\n(?=## explicit)/g, ''); writeFileSync(lockFile, mod);
  const w = await rt.call('lycurgus_write_report', { project: 'project-go', policy: 'license-policy-go.json', as_of }); assert.equal(w.result.check, 'pass_with_review');
  const a = { check_summary: w.result.check_summary, check_summary_sha256: w.result.check_summary_sha256, review_note: 'Dana Counsel (fictional) read the LGPL, MPL and CC-BY files' };
  store.approve((await rt.call('lycurgus_request_release', a)).approval_id, 'Robin'); assert.equal((await rt.call('lycurgus_request_release', a)).status, 'executed');
  const b = { ...a, review_note: 'second request' }; store.approve((await rt.call('lycurgus_request_release', b)).approval_id, 'Robin');
  writeFileSync(lockFile, mod + '\n# example.test/fict/new v1.0.0\n'); assert.match((await rt.call('lycurgus_request_release', b)).reason, /vendor\/modules.txt changed after the check/);
});

test('policy schema: unknown key, wrong type and missing required fail with JSON pointers', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root, audit: false });
  const bad = { unknown_key: { ...policy, alow: ['MIT'] }, wrong_type: { ...policy, deny: 'GPL-*' }, missing_required: { allow: policy.allow }, bad_enum: { ...policy, unknown: 'allow' }, bad_date: { ...policy, exceptions: [{ package: 'x', expires: 'next year' }] } };
  const want = { unknown_key: /\/alow is not an allowed property/, wrong_type: /\/deny expected array, got string/, missing_required: /\/source is required/, bad_enum: /\/unknown must be one of "review", "deny"/, bad_date: /\/exceptions\/0\/expires must be a valid date/ };
  for (const [k, v] of Object.entries(bad)) {
    writeFileSync(join(root, `${k}.json`), JSON.stringify(v));
    const r = await rt.call('lycurgus_check', { project: 'project', policy: `${k}.json` }); assert.equal(r.status, 'error', k); assert.match(r.reason, want[k]); assert.match(r.reason, /is not a valid license_policy/);
    assert.notEqual(spawnSync(process.execPath, [bin, 'validate-config', 'license_policy', join(root, `${k}.json`)], { encoding: 'utf8' }).status, 0, `validate-config rejects ${k}`);
  }
  assert.ok(validate(manifest.configSchemas.license_policy, policy).ok); assert.ok(validate(manifest.configSchemas.license_policy, policyGo).ok);
  assert.equal(spawnSync(process.execPath, [bin, 'validate-config', 'license_policy', join(fixtures, 'license-policy.json')], { encoding: 'utf8' }).status, 0);
  writeFileSync(join(root, 'broken.json'), '{'); assert.match((await rt.call('lycurgus_check', { project: 'project', policy: 'broken.json' })).reason, /not valid JSON/);
});

test('CLI check reads other lockfiles; MCP prompt covers the workflow', async () => {
  const r = spawnSync(process.execPath, [bin, 'check', '--root', fixtures, '--project', 'project-yarn', '--policy', 'license-policy.json', '--modules-dir', '../installed-npm', '--state-dir', mkdtempSync(join(tmpdir(), 'lyc-st2-'))], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr); assert.match(r.stdout, /^fail: 15 package/);
  const p = manifest.prompts[0]; assert.equal(p.name, 'lycurgus_license_review');
  for (const t of ['lycurgus_check', 'lycurgus_diff_sbom', 'lycurgus_write_report', 'lycurgus_write_notices', 'lycurgus_draft_exceptions', 'lycurgus_request_release', 'validate-config license_policy']) assert.ok(p.text.includes(t), t);
  assert.match(p.text, /not legal advice/); assert.match(p.text, /one named human click/);
  const h = createMcpHandler(new AgentRuntime(manifest, { root: fixtures, audit: false }));
  const got = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: p.name, arguments: { project: 'project', policy: 'license-policy.json' } } });
  assert.match(got.result.messages[0].content.text, /project=project, policy=license-policy.json/);
});

test('yarn Berry and pnpm v6 lockfile shapes', () => {
  const mk = (files) => { const d = mkdtempSync(join(tmpdir(), 'lyc-shape-')); for (const [f, t] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), t); } return d; };
  const nm = (n, lic) => ({ [`node_modules/${n}/package.json`]: JSON.stringify({ name: n, version: '1.0.0', license: lic }) });
  const pj = JSON.stringify({ name: 'p', version: '1.0.0', license: 'MIT', dependencies: { 'a-lib': '^1.0.0', '@fict/b': '^1.0.0', 'local-ws': 'workspace:*' }, devDependencies: { 'dev-tool': '^1.0.0' } });
  const berry = mk({ 'package.json': pj, LICENSE: 'x', ...nm('a-lib', 'MIT'), ...nm('@fict/b', 'ISC'), ...nm('c-transitive', 'GPL-3.0-only'), ...nm('dev-tool', 'AGPL-3.0-only'),
    'yarn.lock': '# This file is generated by running "yarn install" inside your project.\n\n__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"@fict/b@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "@fict/b@npm:1.0.0"\n  checksum: fictional\n  languageName: node\n  linkType: hard\n\n"a-lib@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "a-lib@npm:1.0.0"\n  dependencies:\n    c-transitive: "npm:^1.0.0"\n  checksum: fictional\n  languageName: node\n  linkType: hard\n\n"c-transitive@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "c-transitive@npm:1.0.0"\n  languageName: node\n  linkType: hard\n\n"dev-tool@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "dev-tool@npm:1.0.0"\n  languageName: node\n  linkType: hard\n\n"local-ws@workspace:*, local-ws@workspace:packages/local-ws":\n  version: 0.0.0-use.local\n  resolution: "local-ws@workspace:packages/local-ws"\n  languageName: unknown\n  linkType: soft\n\n"p@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "p@workspace:."\n  languageName: unknown\n  linkType: soft\n' });
  const b = check(berry, policy, { as_of }); assert.equal(b.lockfile_version, 'berry');
  assert.deepEqual(b.packages.map((p) => `${p.name}:${p.decision}`), ['@fict/b:allow', 'a-lib:allow', 'c-transitive:deny']);
  assert.deepEqual(b.skipped.map((s) => s.name).sort(), ['dev-tool', 'local-ws']);
  const v6 = mk({ 'package.json': pj, LICENSE: 'x', ...nm('a-lib', 'MIT'), ...nm('@fict/b', 'ISC'), ...nm('dev-tool', 'AGPL-3.0-only'),
    'pnpm-lock.yaml': "lockfileVersion: '6.0'\n\ndependencies:\n  '@fict/b':\n    specifier: ^1.0.0\n    version: 1.0.0\n  a-lib:\n    specifier: ^1.0.0\n    version: 1.0.0\n  local-ws:\n    specifier: workspace:*\n    version: link:packages/local-ws\n\ndevDependencies:\n  dev-tool:\n    specifier: ^1.0.0\n    version: 1.0.0\n\npackages:\n\n  /@fict/b@1.0.0:\n    resolution: {integrity: sha512-FICTIONAL}\n    dev: false\n\n  /a-lib@1.0.0:\n    resolution: {integrity: sha512-FICTIONAL}\n    dev: false\n\n  /dev-tool@1.0.0:\n    resolution: {integrity: sha512-FICTIONAL}\n    dev: true\n" });
  const p6 = check(v6, policy, { as_of });
  assert.deepEqual(p6.packages.map((p) => `${p.name}:${p.decision}`), ['@fict/b:allow', 'a-lib:allow']); assert.deepEqual(p6.skipped.map((s) => s.name).sort(), ['dev-tool', 'local-ws']);
  assert.equal(check(v6, policy, { as_of, include_dev: true }).counts.deny, 1);
});
