// Licence keys for the paid tier: signing, checking, and the gate in the runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentRuntime, createMcpHandler, defineManifest, readAudit, generateSigningKey, loadSigner, issueLicense, checkLicense, parseLicense, readLicenseToken,
  licenseHas, licenseView, LICENSE_PUBLIC_KEYS, LICENSE_FILE, ONE_CLICK_CATEGORIES,
} from '../src/index.js';
import { tmp } from './helpers.js';

const keyDir = tmp(); const k = generateSigningKey(join(keyDir, 'k'));
const signer = loadSigner(k.privateKeyFile); const PUB = readFileSync(k.publicKeyFile, 'utf8');
const other = loadSigner(generateSigningKey(join(keyDir, 'other')).privateKeyFile);
const NOW = new Date('2026-11-15T12:00:00Z');
const issue = (f = {}) => issueLicense(signer, { licensee: 'Example Co (fictional)', plan: 'pro', issued: '2026-11-15', ...f });
const check = (t, o = {}) => checkLicense(t, { keys: [PUB], now: NOW, ...o });

const manifest = () => defineManifest({
  name: 'paid-pack', version: '0.0.1', description: 'Test pack with a paid tier.', model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929' },
  tools: [
    { name: 'free_read', kind: 'read', description: 'free', handler: async () => ({ summary: 'free ok' }) },
    { name: 'pro_read', kind: 'read', tier: 'pro', description: 'paid', handler: async (_a, ctx) => ({ summary: 'pro ok', plan: ctx.license.plan }) },
    { name: 'pro_report', kind: 'read', tier: 'pro', feature: 'evidence', description: 'paid feature', handler: async () => ({ summary: 'evidence ok' }) },
    { name: 'pro_write', kind: 'write', tier: 'pro', description: 'paid write', handler: async () => ({ summary: 'wrote' }) },
    { name: 'pro_go_live', kind: 'action', category: 'go_live', tier: 'pro', description: 'paid go-live', handler: async () => ({ summary: 'live' }) },
    { name: 'pro_blocked', kind: 'read', tier: 'pro', description: 'blocked anyway', handler: async () => ({ summary: 'never' }) },
  ],
  policy: { rules: [
    { tool: 'free_read', decision: 'allow' }, { tool: 'pro_read', decision: 'allow' }, { tool: 'pro_report', decision: 'allow' },
    { tool: 'pro_write', decision: 'ask' }, { tool: 'pro_go_live', decision: 'ask' }, { tool: '*', decision: 'block' },
  ] },
});
const rt = (license, o = {}) => new AgentRuntime(manifest(), { audit: false, license, licenseKeys: [PUB], ...o });

test('no trusted key ships in the repository yet, so no licence verifies with the built-in list', () => {
  assert.deepEqual(LICENSE_PUBLIC_KEYS, []);
  assert.equal(checkLicense(issue()).status, 'unknown_key');
  const src = readFileSync(new URL('../src/license-keys.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /PRIVATE KEY/); assert.doesNotMatch(readFileSync(new URL('../src/license.js', import.meta.url), 'utf8'), /process\.env\.[A-Z_]*KEY/);
});

test('issue and check: the payload is what was signed, and nothing else is accepted', () => {
  const t = issue({ days: 30, agents: ['paid-pack'], features: ['evidence'], seats: 5, id: 'lic-0001' });
  assert.match(t, /^MYTHOS1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const s = check(t);
  assert.equal(s.status, 'valid'); assert.equal(s.id, 'lic-0001'); assert.equal(s.expires, '2026-12-15'); assert.equal(s.days_left, 30); assert.deepEqual(s.features, ['evidence']);
  assert.equal(parseLicense(t).payload.seats, 5);
  const [p, body, sig] = t.split('.');
  const forged = JSON.parse(Buffer.from(body, 'base64url')); forged.plan = 'enterprise'; forged.expires = null;
  assert.equal(check(`${p}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`).status, 'bad_signature');
  assert.equal(check(t.slice(0, -4) + 'AAAA').status, 'bad_signature');
  assert.equal(check(issueLicense(other, { licensee: 'X Co', plan: 'pro' })).status, 'unknown_key');
  const unk = check(issueLicense(other, { licensee: 'Forged Name', plan: 'pro' })); assert.equal(unk.licensee, null, 'nothing from an unverified key is echoed');
  for (const bad of ['', '   ', 'MYTHOS1', 'MYTHOS1.a.b', 'JWT.e30.sig', 'x'.repeat(9000), `MYTHOS1.${Buffer.from('[1]').toString('base64url')}.AAAA`]) assert.ok(['none', 'malformed'].includes(check(bad).status), bad.slice(0, 20));
  assert.equal(check(null).status, 'none');
});

test('dates, coverage, revocation and features', () => {
  assert.equal(check(issue({ expires: '2026-11-15' })).status, 'valid', 'valid through its last day');
  const exp = check(issue({ issued: '2025-01-01', expires: '2026-11-14' })); assert.equal(exp.status, 'expired'); assert.equal(exp.days_left, -1); assert.match(exp.reason, /expired on 2026-11-14/);
  assert.equal(check(issue({ issued: '2026-11-16' })).status, 'valid', 'one day of clock slack');
  assert.equal(check(issue({ issued: '2026-11-20' })).status, 'not_yet_valid');
  assert.equal(check(issue()).expires, null); assert.equal(check(issue()).days_left, null);
  assert.equal(check(issue({ agents: ['other-pack'] }), { agent: 'paid-pack' }).status, 'not_for_this_agent');
  assert.equal(check(issue({ agents: ['*'] }), { agent: 'paid-pack' }).status, 'valid');
  assert.equal(check(issue({ id: 'refunded-1' }), { revoked: ['refunded-1'] }).status, 'revoked');
  const f = check(issue({ features: ['evidence'] })); assert.ok(licenseHas(f, 'evidence')); assert.ok(!licenseHas(f, 'other')); assert.ok(licenseHas(f));
  assert.ok(licenseHas(check(issue()), 'anything')); assert.ok(!licenseHas(check(null), null));
  for (const [fields, re] of [[{ licensee: '' }, /licensee/], [{ plan: 'Pro Plan!' }, /plan/], [{ expires: '2026-02-30' }, /expires/], [{ expires: '2026-01-01' }, /before issued/], [{ days: 0 }, /days/], [{ days: 3, expires: '2027-01-01' }, /not both/], [{ id: 'a b' }, /id/], [{ seats: 0 }, /seats/], [{ licensee: 'two\nlines' }, /licensee/]]) assert.throws(() => issue(fields), re);
  assert.throws(() => issueLicense({}, { licensee: 'a', plan: 'pro' }), /signer/);
});

test('the view shown to people and models carries no key and no signature', () => {
  const t = issue({ days: 10 }); const v = licenseView(check(t));
  assert.deepEqual(Object.keys(v).sort(), ['agents', 'days_left', 'expires', 'features', 'id', 'licensee', 'plan', 'status']);
  assert.doesNotMatch(JSON.stringify(v), new RegExp(t.split('.')[2].slice(0, 20)));
  assert.deepEqual(licenseView(check(null)), { status: 'none', reason: 'No licence key is installed.' });
});

test('where the key is read from: option, file, MYTHOS_LICENSE, MYTHOS_LICENSE_FILE, then .mythos/license.key', () => {
  const d = tmp(); const t = issue(); writeFileSync(join(d, 'k.txt'), `\n${t}\n`); mkdirSync(join(d, '.mythos')); writeFileSync(join(d, '.mythos', LICENSE_FILE), t);
  assert.equal(readLicenseToken({ token: t, env: {} }).source, 'option');
  assert.deepEqual(readLicenseToken({ file: join(d, 'k.txt'), env: { MYTHOS_LICENSE: 'x' } }), { token: t, source: 'file' });
  assert.equal(readLicenseToken({ env: { MYTHOS_LICENSE: t }, stateDir: join(d, '.mythos') }).source, 'MYTHOS_LICENSE');
  assert.equal(readLicenseToken({ env: { MYTHOS_LICENSE_FILE: join(d, 'k.txt') } }).source, 'MYTHOS_LICENSE_FILE');
  assert.equal(readLicenseToken({ env: {}, stateDir: join(d, '.mythos') }).source, LICENSE_FILE);
  assert.deepEqual(readLicenseToken({ env: {}, file: join(d, 'missing') }), { token: null, source: null });
  assert.deepEqual(readLicenseToken({ env: {} }), { token: null, source: null });
});

test('runtime: free tools always run; paid tools need a valid licence; the audit says why, without the key', async () => {
  const d = tmp(); const t = issue({ features: ['basic'] });
  const none = new AgentRuntime(manifest(), { root: d, licenseKeys: [PUB] });
  assert.equal((await none.call('free_read', {})).status, 'executed');
  const locked = await none.call('pro_read', {});
  assert.equal(locked.status, 'needs_license'); assert.equal(locked.decision, 'allow'); assert.match(locked.reason, /paid tier.*No licence key is installed.*Free tools keep working/);
  const line = readAudit(join(d, '.mythos', 'audit.jsonl')).pop(); assert.equal(line.status, 'needs_license'); assert.equal(line.license_status, 'none');
  const r = rt(t); const ok = await r.call('pro_read', {}); assert.equal(ok.status, 'executed'); assert.equal(ok.result.plan, 'pro');
  const feat = await r.call('pro_report', {}); assert.equal(feat.status, 'needs_license'); assert.match(feat.reason, /does not include the "evidence" feature/);
  assert.equal((await rt(issue({ features: ['evidence'] })).call('pro_report', {})).status, 'executed');
  assert.equal((await rt(issue({ issued: '2025-01-01', expires: '2025-12-31' })).call('pro_read', {})).status, 'needs_license');
  assert.equal((await rt(issue({ agents: ['someone-else'] })).call('pro_read', {})).status, 'needs_license');
  const paid = new AgentRuntime(manifest(), { root: d, license: t, licenseKeys: [PUB] }); await paid.call('pro_read', {});
  assert.doesNotMatch(readFileSync(join(d, '.mythos', 'audit.jsonl'), 'utf8'), new RegExp(t.split('.')[2].slice(0, 16)));
});

test('a licence never weakens the policy: blocks stay blocked, asks still ask, one-click stays one-click', async () => {
  const r = rt(issue());
  assert.equal((await r.call('pro_blocked', {})).status, 'blocked');
  const w = await r.call('pro_write', {}); assert.equal(w.status, 'needs_approval');
  const g = await r.call('pro_go_live', {}); assert.equal(g.status, 'needs_approval');
  assert.ok(ONE_CLICK_CATEGORIES.includes('go_live'));
  assert.throws(() => new AgentRuntime(manifest(), { audit: false, license: issue(), licenseKeys: [PUB], mode: 'auto', autoActions: ['pro_go_live'] }), /one-click/);
  const noLic = await rt(null).call('pro_write', {}); assert.equal(noLic.status, 'needs_license', 'no approval is requested for a call that cannot run');
});

test('manifest: tier and feature are checked', () => {
  const m = (t) => defineManifest({ name: 'x-pack', version: '0.0.1', description: 'd', model: { provider: 'anthropic', id: 'm' }, tools: [{ name: 'tool_a', kind: 'read', description: 'd', ...t }], policy: { rules: [{ tool: '*', decision: 'allow' }] } });
  assert.throws(() => m({ tier: 'gold' }), /tier must be/); assert.throws(() => m({ feature: 'x' }), /feature only applies/); assert.throws(() => m({ tier: 'pro', feature: 'Bad Name' }), /feature must be/);
  assert.ok(m({ tier: 'pro', feature: 'evidence' })); assert.ok(m({ tier: 'free' }));
});

test('mcp: paid tools are labelled, a locked call is an error result, mythos_info shows the licence without the key', async () => {
  const t = issue({ features: ['basic'] });
  const h = createMcpHandler(rt(t));
  const list = await h({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.match(list.result.tools.find((x) => x.name === 'pro_read').description, /^\[ALLOW · paid tier\]/);
  assert.doesNotMatch(list.result.tools.find((x) => x.name === 'free_read').description, /paid/);
  const locked = await h({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pro_report', arguments: {} } }); assert.equal(locked.result.isError, true);
  const info = await h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mythos_info', arguments: {} } });
  const lic = info.result.structuredContent.license;
  assert.equal(lic.status, 'valid'); assert.equal(lic.read_from, 'option');
  assert.deepEqual(lic.paid_tools.map((x) => [x.name, x.unlocked]), [['pro_read', true], ['pro_report', false], ['pro_write', true], ['pro_go_live', true], ['pro_blocked', true]]);
  assert.doesNotMatch(JSON.stringify(info), new RegExp(t.split('.')[2].slice(0, 16)));
});

test('no agent in this repository marks a tool as paid until the owner sets the tier list', async () => {
  const { readdirSync } = await import('node:fs');
  const pkgs = new URL('../../', import.meta.url);
  const paid = [];
  for (const p of readdirSync(pkgs).filter((n) => /-of-/.test(n))) {
    const { manifest: m } = await import(new URL(`${p}/src/index.js`, pkgs));
    for (const tool of m.tools) if (tool.tier === 'pro') paid.push(`${p}:${tool.name}`);
  }
  assert.deepEqual(paid, []);
});
