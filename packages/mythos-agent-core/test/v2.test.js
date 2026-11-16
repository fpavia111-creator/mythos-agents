import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentRuntime, ApprovalStore, AuditLog, readAudit, verifyChain, validate, assertValid, generateSigningKey, loadSigner, loadPublicKeys,
  signWebhook, verifyWebhook, serveApprovals, createMcpHandler, defineManifest, toIcs, validateIcs, toSarif, validateSarif, unifiedDiff,
  applyUnifiedDiff, jaroWinkler, nameSimilarity, normalizeAddress, shannonEntropy, writeZip, readZip, docxText, writeEvalReport, runEvals, safePath, capHit,
} from '../src/index.js';
import { sampleManifest, tmp } from './helpers.js';

test('schema: JSON pointers for type, required, enum, pattern, additionalProperties', () => {
  const s = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'string', pattern: '^x' }, n: { type: 'integer', minimum: 1 }, e: { enum: ['p', 'q'] }, list: { type: 'array', items: { type: 'object', required: ['id'] } } } };
  assert.equal(validate(s, { a: 'xy', n: 2, e: 'p', list: [{ id: 1 }] }).ok, true);
  const r = validate(s, { a: 'y', n: 0.5, e: 'z', extra: 1, list: [{}] });
  const paths = r.errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['/a', '/e', '/extra', '/list/0/id', '/n']);
  assert.throws(() => assertValid(s, {}, 'cfg'), /cfg: \/a is required/);
  assert.equal(validate({ $defs: { d: { type: 'string', format: 'date' } }, $ref: '#/$defs/d' }, '2026-02-30').ok, true, 'Date.parse rolls over; regex shape still enforced');
  assert.equal(validate({ type: 'string', format: 'date' }, '2026/01/01').ok, false);
  assert.equal(validate({ oneOf: [{ type: 'string' }, { type: 'number' }] }, true).ok, false);
});

test('runtime validates tool inputs before asking a human', async () => {
  const m = defineManifest({ name: 'v-pack', version: '1', description: 'x', model: { provider: 'a', id: 'm-2025' },
    tools: [{ name: 'wr', kind: 'write', description: 'w', inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' } } }, handler: async () => ({ summary: 'ok' }) }],
    policy: { rules: [{ tool: 'wr', decision: 'ask' }] } });
  const rt = new AgentRuntime(m, { audit: false });
  const r = await rt.call('wr', { file: 3 });
  assert.equal(r.status, 'error'); assert.match(r.reason, /\/file expected string/);
  assert.equal(rt.approvals.pending().length, 0, 'invalid calls never reach the approval queue');
  assert.equal((await rt.call('wr', { file: 'a' })).status, 'needs_approval');
});

test('signed audit: re-chained edits fail with --pubkey; v1 logs verify as chained, unsigned; rotation is trusted', async () => {
  const keys = tmp(); const root = tmp();
  const k1 = generateSigningKey(join(keys, 'k1'), { root });
  assert.throws(() => generateSigningKey(join(root, 'k'), { root }), /under --root/);
  assert.throws(() => loadSigner(join(root, 'nope.pem'), { root }), /must not live under --root/);
  const rt = new AgentRuntime(sampleManifest(), { root, signingKey: k1.privateKeyFile });
  await rt.call('read_thing', { x: 1 }); await rt.call('write_thing', {});
  const file = join(root, '.mythos', 'audit.jsonl');
  const pub = loadPublicKeys(k1.publicKeyFile);
  assert.equal(verifyChain(readAudit(file), { publicKeys: pub }).ok, true);
  assert.ok(!readFileSync(file, 'utf8').includes('PRIVATE KEY'));
  // Attacker edits line 1 and recomputes every hash (re-chain) but has no key.
  const { sha256, canonical } = await import('../src/util.js');
  const lines = readAudit(file); lines[0].decision = 'block';
  let prev = null; for (const l of lines) { delete l.sig; delete l.sha256; l.prev_sha256 = prev; l.sha256 = sha256(canonical(l)); prev = l.sha256; }
  assert.equal(verifyChain(lines).ok, true, 'hash chain alone cannot catch a re-chain');
  const v = verifyChain(lines, { publicKeys: pub });
  assert.equal(v.ok, false); assert.equal(v.breaks[0].line, 1);
  // Rotation
  const k2 = generateSigningKey(join(keys, 'k2'), { root });
  const log = new AuditLog(file, { signer: loadSigner(k1.privateKeyFile) });
  log.rotate(loadSigner(k2.privateKeyFile), { by: 'Kim Owner' });
  log.write({ type: 'agent-action', tool: 'after' });
  const all = readAudit(file);
  assert.equal(all.at(-2).type, 'key-rotation');
  assert.equal(verifyChain(all, { publicKeys: pub }).ok, true, 'new key trusted through the signed rotation');
  assert.equal(verifyChain(all, { publicKeys: loadPublicKeys(k2.publicKeyFile) }).ok, false, 'old lines need the old key');
  // v1
  const r2 = tmp(); const rt2 = new AgentRuntime(sampleManifest(), { root: r2 }); await rt2.call('read_thing');
  assert.equal(verifyChain(readAudit(join(r2, '.mythos', 'audit.jsonl'))).signing, 'chained, unsigned');
});

test('audit mirror receives identical lines; two writers keep one chain', async () => {
  const root = tmp(); const mirror = join(tmp(), 'mirror.jsonl');
  const rt = new AgentRuntime(sampleManifest(), { root, auditMirror: mirror });
  await rt.call('read_thing');
  const other = new AuditLog(join(root, '.mythos', 'audit.jsonl')); other.write({ type: 'approval-decision' });
  await rt.call('read_thing');
  assert.equal(verifyChain(readAudit(join(root, '.mythos', 'audit.jsonl'))).ok, true);
  assert.equal(readAudit(mirror).length, 2);
});

test('approvals: reject, expiry, single use, fresh cycle after use, names only', () => {
  const s = new ApprovalStore(tmp(), { ttlHours: 1 });
  const id = '0123456789abcdef';
  s.request({ id, tool: 't', agent: 'a' });
  assert.equal(s.pending().length, 1);
  assert.throws(() => s.approve(id, 'claude'), /not a person/);
  s.reject(id, 'Ana Ops');
  assert.equal(s.consume(id), null); assert.equal(s.state(id).status, 'rejected');
  s.request({ id, tool: 't', agent: 'a' }); assert.equal(s.state(id).status, 'pending');
  s.approve(id, 'Ana Ops');
  assert.equal(s.state(id, Date.now() + 2 * 3600e3).status, 'expired');
  assert.ok(s.consume(id)); assert.equal(s.consume(id), null);
  assert.throws(() => s.approve(id, 'Ana Ops'), /already used/);
  s.request({ id, tool: 't', agent: 'a' }); s.approve(id, 'Ana Ops'); assert.ok(s.consume(id), 'new request starts a new cycle');
});

test('webhook HMAC: good, bad, stale, nameless', () => {
  const secret = 's3cret'; const body = JSON.stringify({ id: '0123456789abcdef', decision: 'approve', by: 'Ana Ops' });
  assert.equal(verifyWebhook(body, signWebhook(body, secret), secret).ok, true);
  assert.equal(verifyWebhook(body, signWebhook(body, 'other'), secret).reason, 'bad signature');
  assert.match(verifyWebhook(body, signWebhook(body, secret, 1000), secret).reason, /window/);
  const nameless = JSON.stringify({ id: '0123456789abcdef', decision: 'approve' });
  assert.match(verifyWebhook(nameless, signWebhook(nameless, secret), secret).reason, /name the person/);
});

test('approvals page: localhost only, CSP, CSRF token, host check, signed callback audited', async () => {
  const root = tmp(); const stateDir = join(root, '.mythos');
  const rt = new AgentRuntime(sampleManifest(), { root });
  const a = await rt.call('write_thing', { a: 1 });
  const srv = await serveApprovals({ stateDir, secret: 'k' });
  try {
    assert.match(srv.url, /^http:\/\/127\.0\.0\.1:/);
    const page = await fetch(srv.url);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await page.text(); assert.ok(html.includes(a.approval_id)); assert.ok(!/<script/i.test(html));
    const bad = await fetch(srv.url + 'decide', { method: 'POST', body: new URLSearchParams({ id: a.approval_id, name: 'Ana', decision: 'approve', csrf: 'nope' }) });
    assert.equal(bad.status, 403);
    const { request } = await import('node:http');
    const port = new URL(srv.url).port;
    const rebind = await new Promise((res) => request({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example:' + port } }, (r) => res(r.statusCode)).end());
    assert.equal(rebind, 421);
    const ok = await fetch(srv.url + 'decide', { method: 'POST', body: new URLSearchParams({ id: a.approval_id, name: 'Ana Ops', decision: 'approve', csrf: srv.token }) });
    assert.match(await ok.text(), /Approved/);
    const r2 = await rt.call('write_thing', { a: 1 }); assert.equal(r2.status, 'executed'); assert.equal(r2.approved_by, 'Ana Ops');
    const cb = await fetch(srv.url + 'callback', { method: 'POST', headers: { 'x-mythos-signature': 't=1,v1=' + '0'.repeat(64) }, body: '{}' });
    assert.equal(cb.status, 401);
    const log = readAudit(join(stateDir, 'audit.jsonl'));
    assert.ok(log.some((l) => l.type === 'webhook-rejected'));
    assert.equal(verifyChain(log).ok, true);
  } finally { await srv.close(); }
});

test('caps persist across restarts per session and per day; per-tool caps block only that tool', async () => {
  const root = tmp();
  const mk = () => new AgentRuntime(sampleManifest(), { root, session: 'S1', caps: { maxSteps: 4, perTool: { pricey: { maxSteps: 1 } }, maxSpendUsd: 100 } });
  const a = mk(); await a.call('read_thing'); await a.call('read_thing');
  const b = mk();
  assert.equal((await b.call('pricey')).status, 'executed');
  const p2 = await b.call('pricey'); assert.equal(p2.status, 'blocked'); assert.match(p2.reason, /step cap for pricey/);
  assert.equal((await b.call('read_thing')).status, 'executed', 'per-tool cap blocks only that tool');
  const r = await b.call('read_thing'); assert.equal(r.status, 'blocked'); assert.equal(r.cap.cap, 'maxSteps');
  const other = new AgentRuntime(sampleManifest(), { root, session: 'S2', caps: { maxStepsPerDay: 3 } });
  const d = await other.call('read_thing'); assert.equal(d.status, 'blocked'); assert.match(d.reason, /daily step cap/);
  assert.ok(readAudit(join(root, '.mythos', 'audit.jsonl')).some((l) => l.cap));
  assert.throws(() => { b.caps.maxSteps = 999; }, TypeError, 'caps are frozen');
  assert.equal(capHit({ maxSpendUsd: 0 }, { session: { steps: 0, spend_usd: 0, tools: {} }, today: { steps: 0, spend_usd: 0, tools: {} } }, 'x', 0), null);
});

test('safePath refuses symlink escapes and NUL bytes', () => {
  const root = tmp(); const outside = tmp();
  writeFileSync(join(outside, 'secret.txt'), 'x');
  symlinkSync(outside, join(root, 'link'), 'junction'); // 'junction' needs no admin on Windows; ignored elsewhere
  assert.throws(() => safePath(root, 'link/secret.txt'), /symlink/);
  assert.throws(() => safePath(root, 'link/new/deeper.txt'), /symlink/);
  assert.throws(() => safePath(root, 'a\0b'), /NUL/);
  assert.throws(() => safePath(root, '/etc/passwd'), /outside/);
  mkdirSync(join(root, 'ok')); assert.ok(safePath(root, 'ok/file.txt').endsWith('file.txt'));
});

test('safePath refuses over-long paths before touching the disk (Windows mkdir never returns past ~32,767 chars)', () => {
  const root = tmp();
  assert.throws(() => safePath(root, 'A'.repeat(40000)), /too long/);
  assert.throws(() => safePath(root, 'a/' + 'B'.repeat(300) + '/c.txt'), /longer than 255/);
  assert.ok(safePath(root, 'x/'.repeat(200) + 'ok.txt').endsWith('ok.txt'));
});

test('MCP: annotations, prompts, 2025-11-25, usage in mythos_info', async () => {
  const m = sampleManifest({ prompts: [{ name: 'month_end', description: 'Run month end', arguments: [{ name: 'month', required: true }], text: 'Close {{month}} now.' }] });
  const h = createMcpHandler(new AgentRuntime(m, { audit: false }));
  const init = await h({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.equal(init.result.protocolVersion, '2025-11-25'); assert.ok(init.result.capabilities.prompts);
  const tools = (await h({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools;
  const read = tools.find((t) => t.name === 'read_thing'); const live = tools.find((t) => t.name === 'go_live');
  assert.equal(read.annotations.readOnlyHint, true); assert.equal(live.annotations.destructiveHint, true);
  const pr = await h({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'month_end', arguments: { month: '2026-10' } } });
  assert.equal(pr.result.messages[0].content.text, 'Close 2026-10 now.');
  assert.equal((await h({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'month_end' } })).error.code, -32602);
  const info = await h({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'mythos_info' } });
  assert.ok(info.result.structuredContent.usage.today);
});

test('formats: ics validates, sarif validates, diffs apply', () => {
  const ics = toIcs([{ date: '2026-12-01', summary: 'Renew cert, example.com; now', reminders: [30, 7], description: 'line1\nline2' }]);
  const v = validateIcs(ics); assert.equal(v.ok, true, v.errors.join(',')); assert.equal(v.events, 1);
  assert.match(ics, /TRIGGER:-P30D/); assert.equal(ics, toIcs([{ date: '2026-12-01', summary: 'Renew cert, example.com; now', reminders: [30, 7], description: 'line1\nline2' }]));
  const s = toSarif({ tool: 't', version: '1', rules: [{ id: 'R1', description: 'd', severity: 'high' }], findings: [{ ruleId: 'R1', message: 'm', file: 'a.js', line: 3 }] });
  assert.equal(validateSarif(s).ok, true); assert.equal(s.runs[0].results[0].level, 'error');
  assert.equal(validateSarif({ version: '2.0' }).ok, false);
  const a = 'a\nb\nc\nd\ne\nf\ng\nh\n', b = 'a\nB\nc\nd\ne\nf\ng\nh\nI\n';
  assert.equal(applyUnifiedDiff(a, unifiedDiff(a, b)), b); assert.equal(unifiedDiff(a, a), '');
});

test('text helpers and zip/docx', () => {
  assert.ok(jaroWinkler('MARTHA', 'MARHTA') > 0.96);
  assert.ok(nameSimilarity('Acme Widgets, Inc.', 'ACME WIDGETS LLC') > 0.95);
  assert.equal(normalizeAddress('12 North Main Street, Suite 4'), '12 n main st ste 4');
  assert.ok(shannonEntropy('aaaa') < 0.1 && shannonEntropy('q8Zr2Lk9Xw4Vb7Nt') > 3.5);
  const z = writeZip({ 'word/document.xml': '<w:p><w:r><w:t>Hi &amp; bye</w:t></w:r></w:p>' });
  assert.equal(readZip(z).size, 1); assert.equal(docxText(z), 'Hi & bye\n');
});

test('eval report: offline HTML with regression highlighted', async () => {
  const cases = [{ id: 'c1', tool: 'read_thing', args: {}, expect: { status: 'executed' } }, { id: 'c2', tool: 'read_thing', args: {}, expect: { status: 'executed' } }];
  const base = await runEvals(sampleManifest(), cases, { root: tmp() });
  const dir = tmp(); writeFileSync(join(dir, 'base.json'), JSON.stringify(base));
  const cur = await runEvals(sampleManifest(), [cases[0], { ...cases[1], expect: { status: 'blocked' } }], { root: tmp() });
  const w = writeEvalReport(cur, join(dir, 'out'), { baseline: join(dir, 'base.json') });
  assert.deepEqual(w.comparison.regressions, ['c2']);
  const html = readFileSync(w.html, 'utf8');
  assert.match(html, /REGRESSED/); assert.ok(!/<script|<link|https?:\/\/(?!json)/i.test(html.replace(/http-equiv/g, '')));
  assert.match(html, /default-src 'none'/);
});

test('scaffolder writes a complete agent package', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = tmp();
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/mythos-new-agent.js', import.meta.url)), 'iris-of-tests', '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['package.json', 'bin/iris-of-tests.js', 'src/manifest.js', 'evals/cases.json', 'test/logic.test.js', 'LICENSE']) assert.ok(existsSync(join(dir, 'iris-of-tests', f)), f);
  assert.equal(spawnSync(process.execPath, [fileURLToPath(new URL('../bin/mythos-new-agent.js', import.meta.url)), 'Bad Name'], { encoding: 'utf8' }).status, 2);
});

test('MCP openWorldHint follows the tool openWorld flag', async () => {
  const m = defineManifest({ name: 'ow-pack', version: '1', description: 'x', model: { provider: 'a', id: 'm-2025' },
    tools: [{ name: 'net_read', kind: 'read', openWorld: true, description: 'n', handler: async () => ({}) }, { name: 'local_read', kind: 'read', description: 'l', handler: async () => ({}) }],
    policy: { rules: [{ tool: '*', decision: 'allow' }] } });
  const tools = (await createMcpHandler(new AgentRuntime(m, { audit: false }))({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  assert.equal(tools.find((t) => t.name === 'net_read').annotations.openWorldHint, true);
  assert.equal(tools.find((t) => t.name === 'local_read').annotations.openWorldHint, false);
});
