import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
import { manifest, variances, draftCommentary, checkClaims, numbersIn } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const figs = () => variances(parseCsv(readFileSync(join(fixtures, 'figures.csv'), 'utf8')));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const docs = ['docs/ceo-letter.md', 'docs/ops-update.md'];

test('number parsing skips years, dates and citations; keeps units and precision', () => {
  const n = numbersIn('In 2026 on 2026-10-31 revenue was $1.23M, +12.2%, 26k and (5,000).');
  assert.deepEqual(n.map((x) => x.raw), ['$1.23M', '+12.2%', '26k', '5,000']);
  assert.equal(n[0].value, 1230000); assert.equal(n[0].tolerance > 4999 && n[0].tolerance < 5001, true); assert.ok(n[1].percent);
});
test('variances, basis and materiality', () => {
  const v = Object.fromEntries(figs().map((x) => [x.id, x]));
  assert.equal(v.F1.var_budget, 134000); assert.equal(v.F1.var_budget_pct, 12.18); assert.ok(v.F1.material);
  assert.ok(!v.F2.material && !v.F4.material); assert.ok(v.F5.material, 'material by percent');
  assert.equal(v.F6.basis, 'prior'); assert.equal(v.F6.var_prior, -160000); assert.ok(v.F6.material);
  assert.equal(variances(parseCsv(readFileSync(join(fixtures, 'figures.csv'), 'utf8')), { materiality_abs: 1e9, materiality_pct: 50 }).filter((x) => x.material).length, 0);
  assert.throws(() => variances([{ id: 'A', actual: 1 }, { id: 'A', actual: 2 }]), /duplicate/);
  assert.throws(() => variances([{ id: 'A', actual: '' }]), /no actual/);
});
test('claims check: ok, uncited, unknown citation, mismatch', () => {
  const c = checkClaims(docs.map((p) => ({ path: p, text: readFileSync(join(fixtures, p), 'utf8') })), figs());
  assert.equal(c.claims_checked, 8); assert.equal(c.ok, 5);
  assert.deepEqual(c.claims.filter((x) => x.status !== 'ok').map((x) => `${x.status}@${x.line}`), ['uncited_number@6', 'number_mismatch@4', 'unknown_citation@6']);
  assert.deepEqual(c.claims.find((x) => x.status === 'number_mismatch').unmatched, ['312,000']);
  const t = checkClaims([{ path: 'x', text: '# 2026 heading 999\n```\ncode 123\n```\nRevenue 1.2M [F1]. Cash 2.5M [F6].' }], figs());
  assert.deepEqual(t.claims.map((x) => x.status), ['ok', 'ok'], 'headings and code skipped; precision as written');
  assert.equal(checkClaims([{ path: 'x', text: 'Revenue 1.3M [F1].' }], figs()).number_mismatch, 1);
});
test('drafted commentary passes its own claims check and guesses no causes', () => {
  const text = draftCommentary(figs(), { period: 'Oct' });
  const c = checkClaims([{ path: 'c', text }], figs());
  assert.equal(c.issues, 0); assert.equal(c.claims_checked, 4);
  assert.equal((text.match(/\[TO WRITE — owner explains\]/g) || []).length, 4);
});
test('pack needs a lock; sign-off and distribution are one-click and bound to the pack hash', async () => {
  const root = tmpRoot('urania-');
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['urania_lock_figures', 'urania_draft_commentary'] });
  const pack = { figures: 'figures.csv', docs };
  assert.match((await rt.call('urania_assemble_pack', pack)).reason, /lock the figures first/);
  assert.equal((await rt.call('urania_lock_figures', { figures: 'figures.csv' })).status, 'executed');
  const p1 = await rt.call('urania_assemble_pack', pack); assert.equal(p1.status, 'executed'); assert.equal(p1.result.claims_issues, 3);
  const mf = 'mythos-out/urania/pack-manifest.json'; const sha = () => JSON.parse(readFileSync(join(root, mf), 'utf8')).pack_sha256;
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['urania_record_signoff'] }), /one-click/);
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['urania_request_distribution'] }), /one-click/);
  const approve = async (tool, args) => { const a = await rt.call(tool, args); assert.equal(a.status, 'needs_approval'); new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Riley'); return rt.call(tool, args); };
  const s1 = await approve('urania_record_signoff', { pack_manifest: mf, pack_sha256: sha(), controller: 'Riley' });
  assert.equal(s1.status, 'error'); assert.match(s1.reason, /3 claims issue/);
  const d0 = await approve('urania_request_distribution', { pack_manifest: mf, pack_sha256: sha(), recipients: ['b@example.org'] });
  assert.match(d0.reason, /not signed/);
  const s2 = await approve('urania_record_signoff', { pack_manifest: mf, pack_sha256: sha(), controller: 'Riley', accept_open_issues: true, note: 'known; fixed next month' });
  assert.equal(s2.status, 'executed'); assert.equal(JSON.parse(readFileSync(s2.result.file, 'utf8')).open_issues_accepted, 3);
  writeFileSync(join(root, 'figures.csv'), readFileSync(join(root, 'figures.csv'), 'utf8').replace('310000', '311000'));
  assert.match((await rt.call('urania_assemble_pack', pack)).reason, /changed since they were locked/);
  writeFileSync(join(root, 'figures.csv'), readFileSync(join(fixtures, 'figures.csv'), 'utf8'));
  const d1 = await approve('urania_request_distribution', { pack_manifest: mf, pack_sha256: sha(), recipients: ['board@example.org'] }); // new args: a used approval id is never reusable
  assert.equal(d1.status, 'executed'); assert.equal(parseCsv(readFileSync(d1.result.file, 'utf8'))[0].signed_by, 'Riley');
  writeFileSync(join(root, 'mythos-out/urania/board-pack.md'), 'tampered');
  const d2 = await approve('urania_request_distribution', { pack_manifest: mf, pack_sha256: sha(), recipients: ['c@example.org'] });
  assert.match(d2.reason, /does not match the current pack/);
  for (const t of ['board_portal_upload', 'send_email']) assert.equal((await rt.call(t, {})).status, 'blocked');
  assert.ok(existsSync(join(root, 'mythos-out/urania/citations.csv')));
});
