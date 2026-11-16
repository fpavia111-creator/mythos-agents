import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AgentRuntime, generateSigningKey, readAudit, verifyChain, loadPublicKeys, sha256, createMcpHandler, validate } from 'mythos-agent-core';
import { manifest, verifyLog, readJsonl, matchControls, diffFolders, listFiles, globToRegExp, controlsSchema } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'eirene-v2-')); cpSync(fixtures, r, { recursive: true }); return r; };
const keys = () => loadPublicKeys([join(fixtures, 'keys/audit-public.pem')]);

test('signed log verifies with its public key, following the signed key rotation', () => {
  const r = verifyLog(readJsonl(join(fixtures, 'signed-audit.jsonl')), { publicKeys: keys() });
  assert.equal(r.ok, true, JSON.stringify(r.breaks));
  assert.equal(r.signing, 'signed and verified');
  assert.equal(r.key_rotations.length, 1);
  assert.equal(r.key_ids.length, 2);
});

test('a re-chained tampered signed log fails with the line number', () => {
  const entries = readJsonl(join(fixtures, 'signed-rechained-audit.jsonl'));
  assert.equal(verifyLog(entries).ok, true, 'the hash chain alone is fooled by re-chaining');
  const r = verifyLog(entries, { publicKeys: keys() });
  assert.equal(r.ok, false);
  assert.equal(r.signing, 'failed');
  assert.deepEqual(r.breaks.map((b) => b.line), [4]);
  assert.match(r.breaks[0].problem, /signature does not verify/);
});

test('stripping signatures fails when a key is given; v1 logs still verify as chained, unsigned', () => {
  const stripped = readJsonl(join(fixtures, 'signed-audit.jsonl')).map(({ sig, ...rest }) => rest);
  assert.equal(verifyLog(stripped, { publicKeys: keys() }).ok, false);
  const v1 = verifyLog(readJsonl(join(fixtures, 'olympus-audit.jsonl')));
  assert.equal(v1.ok, true); assert.equal(v1.signing, 'chained, unsigned');
  assert.match(verifyLog(readJsonl(join(fixtures, 'talos-audit.jsonl')), { publicKeys: keys() }).signing, /not supported for Talos/);
});

test('verify tool with public_keys: signed ok, re-chained fails; key under root is a public key only', async () => {
  const rt = new AgentRuntime(manifest, { root: fixtures, audit: false });
  const ok = await rt.call('eirene_verify_chain', { log: 'signed-audit.jsonl', public_keys: ['keys/audit-public.pem'] });
  assert.equal(ok.result.ok, true); assert.match(ok.result.summary, /signatures verified/);
  const bad = await rt.call('eirene_verify_chain', { log: 'signed-rechained-audit.jsonl', public_keys: ['keys/audit-public.pem'] });
  assert.equal(bad.result.ok, false); assert.match(bad.result.summary, /BROKEN/);
  assert.ok(!readdirSync(join(fixtures, 'keys')).some((f) => /private/.test(f)));
  assert.doesNotMatch(readFileSync(join(fixtures, 'keys/audit-public.pem'), 'utf8'), /PRIVATE/);
});

test('every evidence item cites a control id and unmapped controls are listed as gaps', async () => {
  const root = tmpRoot();
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const r = await rt.call('eirene_build_evidence', { logs: ['talos-audit.jsonl', 'olympus-audit.jsonl'], template: 'itgc-starter', evidence_dir: 'evidence/2026-Q4', as_of: '2026-11-15', out_dir: 'out-map' });
  assert.equal(r.status, 'executed', r.reason);
  const dir = r.result.out_dir;
  const rows = readFileSync(join(dir, 'control-evidence.csv'), 'utf8').trim().split('\n').slice(1);
  assert.ok(rows.length > 0);
  for (const row of rows) assert.match(row, /^ITGC-[A-Z]{2}-\d{2},/, row);
  const gaps = readFileSync(join(dir, 'gaps.csv'), 'utf8');
  assert.match(gaps, /ITGC-CM-02/); assert.match(gaps, /ITGC-OP-01/);
  assert.deepEqual(r.result.gaps.map((g) => g.id).sort(), ['ITGC-CM-02', 'ITGC-OP-01']);
  assert.match(readFileSync(join(dir, 'events.csv'), 'utf8').split('\n')[0], /control_ids$/);
  // Manifest covers every other file; the audit-recorded hash is the manifest's hash.
  const man = readFileSync(join(dir, 'MANIFEST.sha256'), 'utf8');
  assert.equal(r.result.output_sha256, sha256(man));
  const lines = man.trim().split('\n');
  for (const l of lines) { const [h, f] = l.split(/\s+/); assert.equal(createHash('sha256').update(readFileSync(join(dir, f), 'utf8')).digest('hex'), h, f); }
  assert.equal(lines.length, readdirSync(dir).length - 1);
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.match(html, /Evidence, not certification/); assert.doesNotMatch(html, /<script/i);
});

test('stale evidence is flagged by frequency; undated or fresh evidence is not', () => {
  const files = listFiles(join(fixtures, 'evidence/2026-Q3'));
  const controls = [{ id: 'AC', title: 'Access review', evidence_files: ['access-review*'], frequency: 'quarterly' }, { id: 'BK', title: 'Backup', evidence_files: ['backup-*'], frequency: 'annual' }, { id: 'X', title: 'None', match: { tool: 'nope' } }];
  const fresh = matchControls(controls, [], { files, asOf: '2026-11-15' });
  assert.deepEqual(fresh.map((c) => c.state), ['evidence_found', 'evidence_found', 'no_evidence_in_period']);
  const later = matchControls(controls, [], { files, asOf: '2027-01-15' });
  assert.equal(later[0].state, 'stale'); assert.match(later[0].reason, /2026-09-28 is 109 day\(s\) before 2027-01-15; quarterly allows 92/);
  assert.equal(later[1].state, 'evidence_found');
});

test('match_any and glob values', () => {
  const c = matchControls([{ id: 'A', title: 'a', match_any: [{ tool: '*_report' }, { approved_by: '?*', status: 'executed' }] }], [{ tool: 'olympus_readiness_report', ts: '2026-01-01' }, { tool: 'x', approved_by: 'Dana', status: 'executed', ts: '2026-01-02' }, { tool: 'y', approved_by: '', status: 'executed', ts: '2026-01-03' }]);
  assert.equal(c[0].events, 2);
  assert.ok(globToRegExp('**/access-review*').test('2026-Q4/access-review-1.csv'));
  assert.ok(!globToRegExp('*.csv').test('a/b.csv'));
});

test('evidence folder diff lists added, removed and changed items with hashes', () => {
  const d = diffFolders(listFiles(join(fixtures, 'evidence/2026-Q3')), listFiles(join(fixtures, 'evidence/2026-Q4')));
  assert.deepEqual(d.added.map((f) => f.path), ['access-review-2026-11-12.csv', 'incident-drill-2026-10-05.md']);
  assert.deepEqual(d.removed.map((f) => f.path), ['access-review-2026-09-28.csv', 'backup-restore-test-2026-07-20.md']);
  assert.deepEqual(d.changed.map((f) => f.path), ['change-log-2026-08.csv']);
  for (const f of [...d.added, ...d.removed]) assert.match(f.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(d.changed[0].previous_sha256, d.changed[0].sha256);
  const same = diffFolders([{ path: 'a.txt', sha256: 'h1' }], [{ path: 'b.txt', sha256: 'h1' }]);
  assert.deepEqual(same.carried_over, [{ path: 'b.txt', same_as_previous: 'a.txt', sha256: 'h1' }]);
});

test('build with previous_evidence_dir writes evidence-diff.csv covered by the manifest', async () => {
  const root = tmpRoot();
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const r = await rt.call('eirene_build_evidence', { logs: ['olympus-audit.jsonl'], controls: 'controls.json', evidence_dir: 'evidence/2026-Q4', previous_evidence_dir: 'evidence/2026-Q3', out_dir: 'out-diff' });
  assert.equal(r.status, 'executed', r.reason);
  const dir = r.result.out_dir;
  const diff = readFileSync(join(dir, 'evidence-diff.csv'), 'utf8');
  assert.match(diff, /^change,path,previous_sha256,sha256/); assert.match(diff, /removed,backup-restore-test-2026-07-20\.md,[0-9a-f]{64},/);
  assert.match(readFileSync(join(dir, 'MANIFEST.sha256'), 'utf8'), /evidence-diff\.csv/);
  assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /evidence-diff\.csv/);
});

test('evidence folder hash lands in a signed audit log; sending stays blocked', async () => {
  const root = tmpRoot();
  const k = generateSigningKey(mkdtempSync(join(tmpdir(), 'eirene-key-')), { root });
  const state = mkdtempSync(join(tmpdir(), 'eirene-state-'));
  const rt = new AgentRuntime(manifest, { root, stateDir: state, signingKey: k.privateKeyFile });
  const r = await rt.call('eirene_build_evidence', { logs: ['signed-audit.jsonl'], public_keys: ['keys/audit-public.pem'], template: 'agent-guardrails', out_dir: 'out-signed' });
  assert.equal(r.status, 'executed', r.reason);
  assert.deepEqual(r.result.signing, [{ file: 'signed-audit.jsonl', signing: 'signed and verified' }]);
  const entries = readAudit(join(state, 'audit.jsonl'));
  assert.equal(entries.at(-1).output_sha256, r.result.output_sha256);
  assert.equal(verifyChain(entries, { publicKeys: loadPublicKeys([k.publicKeyFile]) }).ok, true);
  assert.ok(!existsSync(join(root, 'private.pem')));
  for (const mode of ['review', 'assist', 'auto']) assert.equal((await new AgentRuntime(manifest, { root, audit: false, mode }).call('eirene_send_to_auditor', {})).status, 'blocked');
  assert.throws(() => new AgentRuntime(manifest, { root, audit: false, mode: 'auto', autoActions: ['eirene_send_to_auditor'] }), /one-click/);
});

test('controls config: three mutated configs fail with JSON pointers; both shapes and templates are valid', async () => {
  const root = tmpRoot();
  const legacy = JSON.parse(readFileSync(join(fixtures, 'controls.json'), 'utf8'));
  assert.ok(validate(controlsSchema, legacy).ok);
  const tpl = JSON.parse(readFileSync(fileURLToPath(new URL('../templates/itgc-starter.json', import.meta.url)), 'utf8'));
  assert.ok(validate(controlsSchema, tpl).ok);
  const cases = {
    'unknown.json': [{ ...tpl, controls: [{ ...tpl.controls[0], frequncy: 'monthly' }] }, /\/controls\/0\/frequncy is not an allowed property/],
    'wrongtype.json': [[{ ...legacy[0], match: 'blocked' }], /\/0\/match expected object/],
    'missing.json': [[{ title: 'no id', match: { status: 'blocked' } }], /\/0\/id is required/],
    'badmatchkey.json': [[{ id: 'A', title: 't', match: { stauts: 'blocked' } }], /\/0\/match\/stauts is not an allowed property/],
    'badfreq.json': [[{ id: 'A', title: 't', frequency: 'hourly' }], /\/0\/frequency must be one of/],
  };
  const rt = new AgentRuntime(manifest, { root, audit: false });
  for (const [file, [cfg, re]] of Object.entries(cases)) {
    writeFileSync(join(root, file), JSON.stringify(cfg));
    const r = await rt.call('eirene_map_controls', { logs: ['talos-audit.jsonl'], controls: file });
    assert.equal(r.status, 'error', file);
    assert.match(r.reason, re, file);
  }
});

test('templates list and load; unknown template names are refused by the schema', async () => {
  const rt = new AgentRuntime(manifest, { root: fixtures, audit: false });
  const l = await rt.call('eirene_list_templates', {});
  assert.deepEqual(l.result.templates.map((t) => t.template), ['agent-guardrails', 'itgc-starter']);
  const t = await rt.call('eirene_list_templates', { template: 'agent-guardrails' });
  assert.equal(t.result.controls.length, 6);
  for (const x of l.result.templates) assert.doesNotMatch(`${x.name} ${x.description}`, /\bcertified\b|makes you compliant/i);
  assert.equal((await rt.call('eirene_list_templates', { template: 'soc2' })).status, 'error');
});

test('MCP prompt walks the workflow', async () => {
  const h = createMcpHandler(new AgentRuntime(manifest, { root: fixtures, audit: false }));
  const got = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'eirene_evidence_review', arguments: { logs: '.mythos/audit.jsonl' } } });
  const text = got.result.messages[0].content.text;
  for (const s of ['eirene_verify_chain', 'eirene_map_controls', 'eirene_diff_evidence', 'eirene_build_evidence', 'named person', 'not certification']) assert.ok(text.includes(s), s);
});
