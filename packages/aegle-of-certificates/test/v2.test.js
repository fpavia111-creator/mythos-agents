import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import { AgentRuntime, ApprovalStore, parseCsv, validateIcs, readAudit, createMcpHandler } from 'mythos-agent-core';
import { manifest, scan, calendarIcs, checkCois, diffInventory, extractCoiText, liveTlsCheck } from '../src/index.js';
import { selfSigned } from './helpers/self-signed.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const rd = (f) => parseCsv(readFileSync(join(fixtures, f), 'utf8'));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const as_of = '2026-11-14';

test('calendar uses core toIcs, validates, and carries reminder offsets', () => {
  const r = scan({ inventory: rd('certificates.csv'), cois: rd('cois.csv'), requirements: rd('requirements.csv'), as_of });
  const ics = calendarIcs(r);
  const v = validateIcs(ics); assert.ok(v.ok, v.errors.join('; ')); assert.equal(v.events, 9, '6 items + 3 vendors');
  for (const d of [30, 14, 1]) assert.match(ics, new RegExp(`TRIGGER:-P${d}D`));
  const custom = calendarIcs(r, [60, 7, 7]);
  assert.ok(validateIcs(custom).ok); assert.match(custom, /TRIGGER:-P60D/); assert.doesNotMatch(custom, /TRIGGER:-P30D/);
  assert.equal(calendarIcs(r), ics, 'deterministic');
});

test('COI requirement profile: per-category requirements and waiver of subrogation', () => {
  const profile = JSON.parse(readFileSync(join(fixtures, 'requirements.json'), 'utf8'));
  const v = Object.fromEntries(checkCois(rd('cois.csv'), profile, { as_of }).map((x) => [x.vendor.split(' ')[0], x]));
  assert.equal(v.Bright.requirement_set, 'electrical');
  assert.deepEqual(v.Bright.gaps.map((g) => g.issue), ['limit_below_required', 'additional_insured_missing', 'waiver_of_subrogation_missing', 'missing_coverage', 'missing_coverage']);
  assert.equal(v.Acme.requirement_set, 'default'); assert.equal(v.Cedar.status, 'ok');
});

test('requirement profile is schema-checked: three mutated configs fail with JSON pointers', async () => {
  const root = tmpRoot('aegle-cfg-');
  const good = JSON.parse(readFileSync(join(fixtures, 'requirements.json'), 'utf8'));
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const ok = await rt.call('aegle_scan', { cois: 'cois.csv', requirements: 'requirements.json', as_of }); assert.equal(ok.status, 'executed');
  const bad = {
    unknown: [{ ...good, defualt_list: [] }, /\/defualt_list is not an allowed property/],
    type: [{ ...good, default: [{ coverage: 'general_liability', min_limit: '1000000' }] }, /\/default\/0\/min_limit expected number/],
    missing: [{ categories: good.categories }, /\/default is required/],
  };
  for (const [k, [cfg, re]] of Object.entries(bad)) {
    writeFileSync(join(root, `bad-${k}.json`), JSON.stringify(cfg));
    const r = await rt.call('aegle_scan', { cois: 'cois.csv', requirements: `bad-${k}.json`, as_of });
    assert.equal(r.status, 'error', k); assert.match(JSON.stringify(r), re, k);
  }
});

test('COI text extraction: limits and dates found, every row marked for review', async () => {
  const acme = extractCoiText(readFileSync(join(fixtures, 'coi-text/acme-plumbing-coi.txt'), 'utf8'), { source: 'acme' });
  assert.equal(acme.insured, 'Acme Plumbing (fictional)'); assert.equal(acme.certificate_holder, 'Example Shop (fictional)');
  const by = Object.fromEntries(acme.rows.map((r) => [r.coverage, r]));
  assert.deepEqual(Object.keys(by), ['general_liability', 'auto_liability', 'workers_comp'], 'description text is not read as a coverage');
  assert.equal(by.general_liability.limit, 1000000); assert.equal(by.general_liability.expires, '2027-03-01'); assert.equal(by.general_liability.additional_insured, 'yes'); assert.equal(by.general_liability.waiver_of_subrogation, 'yes');
  assert.equal(by.workers_comp.limit, 500000); assert.equal(by.workers_comp.effective, '2025-11-25');
  assert.ok(acme.rows.every((r) => r.needs_review === 'yes' && r.source_line > 0));
  const bright = extractCoiText(readFileSync(join(fixtures, 'coi-text/bright-electric-coi.txt'), 'utf8'));
  assert.ok(bright.warnings.some((w) => /umbrella.*dates not found/.test(w)));
  assert.deepEqual(extractCoiText('nothing here').warnings, ['insured name not found', 'no coverage lines recognised']);

  const root = tmpRoot('aegle-x-');
  const r = await new AgentRuntime(manifest, { root }).call('aegle_extract_coi', { files: ['coi-text/acme-plumbing-coi.txt', 'coi-text/bright-electric-coi.txt'] });
  assert.equal(r.status, 'executed'); assert.match(r.result.summary, /5 coverage row\(s\).*needs_review/);
  const rows = parseCsv(readFileSync(r.result.file, 'utf8'));
  assert.ok(rows.every((x) => x.needs_review === 'yes' && x.reviewed_by === ''));
  const v = checkCois(rows, rd('requirements.csv'), { as_of });
  assert.ok(v.find((x) => x.vendor.startsWith('Bright')).gaps.some((g) => g.issue === 'limit_below_required'), 'extracted CSV feeds the COI check');
  const audit = readAudit(join(root, '.mythos/audit.jsonl')); assert.match(audit.at(-1).output_sha256, /^[0-9a-f]{64}$/);
});

test('inventory diff: riskiest changes first', async () => {
  const d = diffInventory(rd('certificates-previous.csv'), rd('certificates.csv'), { as_of });
  assert.equal(d.changes[0].change, 'expiry_moved_earlier'); assert.equal(d.changes[0].id, 'LIC-1');
  assert.deepEqual(d.counts, { expiry_moved_earlier: 1, auto_renew_turned_off: 1, removed: 1, status_worse: 1, new_flags: 1, owner_removed: 1, added: 1, renewed: 1 });
  assert.ok(d.changes.some((c) => c.change === 'removed' && c.id === 'TLS-9'));
  assert.deepEqual(diffInventory(rd('certificates.csv'), rd('certificates.csv'), { as_of }).changes, [], 'no change, no noise');
});

test('write_report adds HTML and records the output hash in the audit line', async () => {
  const root = tmpRoot('aegle-h-');
  const r = await new AgentRuntime(manifest, { root }).call('aegle_write_report', { certificates: 'certificates.csv', cois: 'cois.csv', requirements: 'requirements.json', as_of, reminder_days: [45, 7] });
  assert.equal(r.status, 'executed'); assert.equal(r.result.files.length, 4);
  const html = readFileSync(r.result.files[3], 'utf8');
  assert.match(html, /Content-Security-Policy/); assert.doesNotMatch(html, /<script/i); assert.match(html, /Not insurance or legal advice/);
  assert.match(readFileSync(r.result.files[2], 'utf8'), /TRIGGER:-P45D/);
  assert.equal(readAudit(join(root, '.mythos/audit.jsonl')).at(-1).output_sha256, r.result.output_sha256);
});

// A fake TLS socket: no network at all.
function fakeConnect(cert, { authorized = false, err = null, error = null } = {}) {
  const calls = [];
  const connect = (o) => {
    calls.push(o); const s = new EventEmitter();
    s.getPeerCertificate = () => cert; s.authorized = authorized; s.authorizationError = err ? { code: err } : null; s.getProtocol = () => 'TLSv1.3'; s.destroy = () => {};
    setImmediate(() => (error ? s.emit('error', Object.assign(new Error(error), { code: error })) : s.emit('secureConnect')));
    return s;
  };
  return { connect, calls };
}

test('live TLS assessment with an injected transport (no network)', async () => {
  const cert = { valid_from: 'Jan  1 00:00:00 2026 GMT', valid_to: 'Nov 10 12:00:00 2026 GMT', subject: { CN: 'api.example.com' }, issuer: { CN: 'Example Public CA' }, subjectaltname: 'DNS:api.example.com', bits: 1024, fingerprint256: 'AA:BB' };
  const f = fakeConnect(cert, { authorized: true });
  const r = await liveTlsCheck([{ host: 'api.example.com', port: 443 }, { host: 'api.example.com', port: 443 }], { as_of, connect: f.connect, inventory: rd('certificates.csv') });
  assert.equal(f.calls.length, 1, 'duplicates are checked once'); assert.equal(f.calls[0].servername, 'api.example.com'); assert.equal(f.calls[0].rejectUnauthorized, false);
  const row = r.rows[0];
  assert.equal(row.status, 'expired'); assert.equal(row.days_left, -4); assert.equal(row.inventory_id, 'TLS-2');
  assert.deepEqual(row.flags, ['weak_key_RSA_1024']);
  const moved = await liveTlsCheck([{ host: 'shop.example.com', port: 443 }], { as_of, connect: fakeConnect({ ...cert, valid_to: 'Feb 18 00:00:00 2027 GMT', subject: { CN: 'shop.example.com' }, subjectaltname: 'DNS:shop.example.com', bits: 2048 }, { authorized: true }).connect, inventory: rd('certificates.csv') });
  assert.deepEqual(moved.rows[0].flags, ['inventory_mismatch'], 'live cert renewed but inventory still says 2026-11-20');
  const down = await liveTlsCheck([{ host: 'down.example.com', port: 443 }], { as_of, connect: fakeConnect(null, { error: 'ECONNREFUSED' }).connect });
  assert.equal(down.rows[0].status, 'unreachable'); assert.equal(down.rows[0].error, 'ECONNREFUSED');
  const hang = await liveTlsCheck([{ host: 'slow.example.com', port: 443 }], { as_of, timeoutMs: 50, connect: () => Object.assign(new EventEmitter(), { destroy() {} }) });
  assert.equal(hang.rows[0].error, 'timeout');
  await assert.rejects(liveTlsCheck(Array.from({ length: 26 }, (_, i) => ({ host: `h${i}.example.com`, port: 443 })), { as_of }), /at most 25/);
});

test('live TLS check: ask in assist, blocked in review, runs against a local TLS server after a human yes', async () => {
  const { key, cert } = selfSigned({ notAfter: '2026-12-01T00:00:00Z' });
  const server = tls.createServer({ key, cert }, (s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const root = tmpRoot('aegle-live-');
    writeFileSync(join(root, 'local-inventory.csv'), `id,type,name,port,expires,owner\nLOCAL-1,tls,127.0.0.1,${port},2026-11-20,Web team\n`);
    const args = { certificates: 'local-inventory.csv', from_inventory: true, as_of };
    assert.equal((await new AgentRuntime(manifest, { root, audit: false, mode: 'review' }).call('aegle_tls_live_check', args)).status, 'blocked', 'off in review mode');
    const rt = new AgentRuntime(manifest, { root });
    const a = await rt.call('aegle_tls_live_check', args); assert.equal(a.status, 'needs_approval', 'off until a person says yes');
    new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Dana');
    const b = await rt.call('aegle_tls_live_check', args); assert.equal(b.status, 'executed', JSON.stringify(b));
    const row = b.result.rows[0];
    assert.equal(row.not_after, '2026-12-01'); assert.equal(row.days_left, 17); assert.equal(row.status, 'warning'); assert.match(row.key, /^EC (P-256|prime256v1)$/);
    for (const f of ['self_signed', 'hostname_mismatch', 'inventory_mismatch']) assert.ok(row.flags.includes(f), f);
    assert.ok(row.flags.some((f) => f.startsWith('chain_untrusted')));
    assert.equal(parseCsv(readFileSync(b.result.file, 'utf8'))[0].not_after, '2026-12-01');
    assert.equal((await rt.call('aegle_tls_live_check', args)).status, 'needs_approval', 'approval is single-use');
    const auto = new AgentRuntime(manifest, { root, audit: false, mode: 'auto', autoActions: ['aegle_tls_live_check'] });
    const c = await auto.call('aegle_tls_live_check', { hosts: [`127.0.0.1:${port}`], as_of });
    assert.equal(c.status, 'executed'); assert.ok(c.result.rows[0].flags.includes('not_in_inventory'));
    const bad = await rt.call('aegle_tls_live_check', { hosts: ['https://example.com/x'] });
    assert.equal(bad.status, 'error'); assert.match(bad.reason, /invalid arguments: \/hosts\/0/);
    const tool = manifest.tools.find((t) => t.name === 'aegle_tls_live_check'); assert.equal(tool.openWorld, true);
  } finally { server.close(); }
});

test('MCP prompt walks the workflow and names the one-click steps', async () => {
  const h = createMcpHandler(new AgentRuntime(manifest, { audit: false }));
  const list = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
  assert.deepEqual(list.result.prompts.map((p) => p.name), ['aegle_renewal_review']);
  const g = await h({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'aegle_renewal_review', arguments: { certificates: 'inv.csv' } } });
  const text = g.result.messages[0].content.text;
  for (const s of ['inv.csv', 'aegle_scan', 'aegle_diff_inventory', 'aegle_tls_live_check', 'aegle_write_report', 'aegle_request_renewal', 'not insurance or legal advice']) assert.ok(text.includes(s), s);
  assert.equal((await h({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'aegle_renewal_review', arguments: {} } })).error.code, -32602);
});
