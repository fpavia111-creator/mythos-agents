import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv, toCsv, validate, sha256, readAudit } from 'mythos-agent-core';
import { manifest, findDuplicates, nameScore, tokenWeights, normName, normTax, sameAddress, mergePreview, RULES_SCHEMA, undoEntry, applyUndo } from '../src/index.js';
import { seededVendors, pairMetrics } from './helpers/seeded-vendors.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const sandbox = () => { const root = mkdtempSync(join(tmpdir(), 'augeas-v02-')); cpSync(fixtures, root, { recursive: true }); return root; };
const approve = (root, id, who = 'Dana Reviewer (fictional)') => new ApprovalStore(join(root, '.mythos')).approve(id, who);
async function approved(rt, root, tool, args) { const a = await rt.call(tool, args); if (a.status !== 'needs_approval') return a; approve(root, a.approval_id); return rt.call(tool, args); }

test('seeded 1k-row fixture: precision and recall are at or above the thresholds', () => {
  const rows = seededVendors({ seed: 20261115 });
  assert.equal(rows.length, 1000);
  assert.ok(rows.every((r) => /\.example$/.test(r.email) && /^00-?\d{7}$|^$/.test(r.taxid) && (!r.phone || /555-01\d\d$/.test(r.phone))), 'fictional data only');
  const r = findDuplicates(rows, { kind: 'vendor' });
  const m = pairMetrics(rows, r.proposals);
  assert.ok(m.precision >= 0.97, `precision ${m.precision}`);
  assert.ok(m.recall >= 0.97, `recall ${m.recall}`);
  assert.equal(r.blocking, true);
  assert.ok(r.compared_pairs < 60000, `blocking keeps comparisons small (${r.compared_pairs} of 499500)`);
  // Blocking finds the same clusters as comparing every pair.
  const full = findDuplicates(rows, { kind: 'vendor', full_compare_below: 5000 });
  assert.deepEqual(pairMetrics(rows, full.proposals), m);
  // Other seeds hold up too.
  for (const seed of [1, 42, 99999]) { const rs = seededVendors({ seed }); const mm = pairMetrics(rs, findDuplicates(rs, { kind: 'vendor' }).proposals); assert.ok(mm.precision >= 0.95 && mm.recall >= 0.95, `seed ${seed}: ${JSON.stringify(mm)}`); }
});

test('seeded fixture is deterministic', () => {
  assert.equal(sha256(toCsv(seededVendors({ seed: 7, rows: 200, duplicates: 30, hardNegatives: 10 }))), sha256(toCsv(seededVendors({ seed: 7, rows: 200, duplicates: 30, hardNegatives: 10 }))));
});

test('name, tax id and address normalization', () => {
  assert.equal(normTax('12-3456789'), normTax('123456789'));
  assert.equal(normTax('DE 123-456-789'), '123456789');
  assert.ok(sameAddress('100 main st austin tx', '100 main st austin tx'));
  assert.equal(sameAddress('100 main st austin tx', '200 main st austin tx'), false);
  const w = tokenWeights(['velora logistics', 'velith logistics', 'tanane logistics', 'corwick logistics']);
  assert.ok(nameScore('velora logistics', 'velroa logistics', w) > 0.92, 'typo in the rare word still matches');
  assert.ok(nameScore('velora logistics', 'velith logistics', w) < 0.9, 'a shared common word does not make a match');
  assert.equal(nameScore(normName('Blue Harbor Logistics'), normName('Logistics Blue Harbor')), 1);
});

test('never clusters two different tax ids, even through a record without one', () => {
  const r = findDuplicates([
    { id: 'A', name: 'Quillane Metals', taxid: '00-1111111' },
    { id: 'B', name: 'Quillane Metals', taxid: '' },
    { id: 'C', name: 'Quillane Metals', taxid: '00-2222222' },
  ], { kind: 'vendor' });
  for (const c of r.proposals) { const taxes = new Set(c.records.map((x) => ({ A: '1', B: '', C: '2' })[x.id]).filter(Boolean)); assert.ok(taxes.size <= 1); }
  assert.ok(r.kept_apart.length >= 1);
  assert.ok(r.proposals[0].pairs[0].signals.name === 1);
});

test('merge preview shows field-level winners, rules and conflicts; bank columns never change', () => {
  const rows = [
    { id: 'A', name: 'Fenmere Paper', taxid: '', phone: '555-0101', address: '1 Oak St', bank_account: '****1111', isinactive: 'F' },
    { id: 'B', name: 'FENMERE PAPER LLC', taxid: '00-3333333', phone: '555-0101', address: '1 Oak Street Suite 4', bank_account: '****2222', isinactive: 'T' },
  ];
  const p = mergePreview(rows, { survivor: 'A', merge: ['B'], rules: { default_rule: 'survivor_fill_blank', fields: { address: 'longest' } } });
  const f = (k) => p.fields.find((x) => x.field === k);
  assert.equal(f('taxid').winner, '00-3333333'); assert.equal(f('taxid').winner_from, 'B'); assert.equal(f('taxid').rule, 'survivor_fill_blank');
  assert.equal(f('address').winner, '1 Oak Street Suite 4'); assert.equal(f('address').rule, 'longest'); assert.equal(f('address').conflict, true);
  assert.equal(f('bank_account').rule, 'never'); assert.equal(f('bank_account').winner, '****1111');
  assert.equal(f('name').winner, 'Fenmere Paper');
  assert.deepEqual(p.changes.map((c) => c.field).sort(), ['address', 'taxid']);
  assert.equal(p.golden_record.id, 'A');
});

test('applying a previewed merge changes only the copy, and only the merged rows', async () => {
  const root = sandbox();
  const before = readFileSync(join(root, 'vendors.csv'), 'utf8');
  const rt = new AgentRuntime(manifest, { root });
  const pv = await rt.call('augeas_merge_preview', { path: 'vendors.csv', survivor: 'V102', merge: ['V103'], rules: 'augeas-rules.json' });
  assert.equal(pv.status, 'executed', pv.reason);
  const r = await approved(rt, root, 'augeas_apply_merge', { path: 'vendors.csv', survivor: 'V102', merge: ['V103'], fill_survivor: true, rules: 'augeas-rules.json' });
  assert.equal(r.status, 'executed', r.reason);
  assert.equal(readFileSync(join(root, 'vendors.csv'), 'utf8'), before, 'input untouched');
  const orig = parseCsv(before), copy = parseCsv(readFileSync(r.result.file, 'utf8'));
  for (let i = 0; i < orig.length; i++) {
    const { merged_into, ...rest } = copy[i];
    if (orig[i].internalid === 'V102') { for (const c of pv.result.changes) assert.equal(rest[c.field], c.to); }
    else assert.deepEqual(rest, orig[i], `row ${orig[i].internalid} unchanged`);
    assert.equal(merged_into, orig[i].internalid === 'V103' ? 'V102' : '');
  }
  const line = readAudit(join(root, '.mythos', 'audit.jsonl')).filter((e) => e.tool === 'augeas_apply_merge' && e.status === 'executed').pop();
  assert.equal(line.output_sha256, sha256(readFileSync(r.result.file, 'utf8')));
});

test('applying the undo restores a byte-identical copy; edited copies are refused', async () => {
  const root = sandbox();
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['augeas_apply_merge', 'augeas_undo_merge'] });
  const copy = 'mythos-out/augeas/vendors.merged.csv';
  assert.equal((await rt.call('augeas_apply_merge', { path: 'vendors.csv', survivor: 'V100', merge: ['V101'] })).status, 'executed');
  const afterFirst = readFileSync(join(root, copy));
  assert.equal((await rt.call('augeas_apply_merge', { path: 'vendors.csv', survivor: 'V102', merge: ['V103'], fill_survivor: true })).status, 'executed');
  assert.notDeepEqual(readFileSync(join(root, copy)), afterFirst);
  const u = await rt.call('augeas_undo_merge', { copy });
  assert.equal(u.status, 'executed', u.reason); assert.equal(u.auto, true);
  assert.ok(readFileSync(join(root, copy)).equals(afterFirst), 'byte-identical');
  // Edit the copy by hand: the next undo is refused and nothing changes.
  writeFileSync(join(root, copy), readFileSync(join(root, copy), 'utf8') + 'X,hand edit\n');
  const refused = await rt.call('augeas_undo_merge', { copy });
  assert.equal(refused.status, 'error'); assert.match(refused.reason, /changed since this merge/);
  writeFileSync(join(root, copy), afterFirst);
  const last = await rt.call('augeas_undo_merge', { copy });
  assert.equal(last.result.removed_copy, true); assert.equal(existsSync(join(root, copy)), false);
  const empty = await rt.call('augeas_undo_merge', { copy });
  assert.equal(empty.status, 'error');
});

test('undo entries round-trip when the line count changes', () => {
  const a = 'h\n1\n2\n', b = 'h,merged_into\n1,\n2,x\n3\n';
  assert.equal(applyUndo(b, undoEntry(a, b, {})), a);
  assert.equal(applyUndo('h\nZ\n', undoEntry('h\nY\n', 'h\nZ\n', {})), 'h\nY\n');
});

test('undo asks a human in Assist; Review mode blocks it', async () => {
  const root = sandbox();
  const rt = new AgentRuntime(manifest, { root, audit: false });
  assert.equal((await rt.call('augeas_undo_merge', { copy: 'mythos-out/augeas/x.csv' })).status, 'needs_approval');
  const review = new AgentRuntime(manifest, { root, audit: false, mode: 'review' });
  assert.equal((await review.call('augeas_undo_merge', { copy: 'mythos-out/augeas/y.csv' })).status, 'blocked');
  assert.equal((await review.call('augeas_merge_preview', { path: 'vendors.csv', survivor: 'V100', merge: ['V101'] })).status, 'executed');
});

test('rules config: three mutated files fail with JSON-pointer errors; the fixture passes', async () => {
  const good = JSON.parse(readFileSync(join(fixtures, 'augeas-rules.json'), 'utf8'));
  assert.equal(validate(RULES_SCHEMA, good).ok, true);
  const root = sandbox();
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const { default_rule, ...missing } = good;
  const bad = { unknown: { ...good, feilds: {} }, wrongType: { ...good, protected_fields: 'isinactive' }, missingRequired: missing, badEnum: { ...good, fields: { phone: 'newest' } } };
  const want = { unknown: /\/feilds/, wrongType: /\/protected_fields.*array/, missingRequired: /default_rule/, badEnum: /\/fields\/phone/ };
  for (const [k, cfg] of Object.entries(bad)) {
    writeFileSync(join(root, `${k}.json`), JSON.stringify(cfg));
    const r = await rt.call('augeas_find_duplicates', { path: 'vendors.csv', rules: `${k}.json` });
    assert.equal(r.status, 'error', k);
    assert.match(r.reason + JSON.stringify(r.errors || []), want[k], k);
  }
});

test('proposals include a self-contained HTML page; the prompt covers the workflow', async () => {
  const root = sandbox();
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const r = await rt.call('augeas_propose_merges', { path: 'vendors.csv', kind: 'vendor' });
  const html = readFileSync(r.result.files[2], 'utf8');
  assert.match(html, /Content-Security-Policy/); assert.doesNotMatch(html, /<script/i); assert.match(html, /V101/);
  const p = manifest.prompts[0];
  for (const t of ['augeas_find_duplicates', 'augeas_propose_merges', 'augeas_merge_preview', 'augeas_apply_merge', 'augeas_undo_merge', '{{path}}', '{{kind}}']) assert.ok(p.text.includes(t), t);
  assert.equal((await rt.call('augeas_find_duplicates', { path: 'vendors.csv', threshold: 2 })).status, 'error');
});
