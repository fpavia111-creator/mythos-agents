import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv, validateIcs, sha256, createMcpHandler } from 'mythos-agent-core';
import { manifest, reviewLog, ballInCourt, diffLogs, parseTitleBlock, indexFromTitleBlocks, draftTransmittal } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const rd = (f) => parseCsv(readFileSync(join(fixtures, f), 'utf8'));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const as_of = '2026-11-14';
const review = () => reviewLog(rd('documents.csv'), rd('rfis.csv'), rd('submittals.csv'), { as_of });

test('ball-in-court aging by responsible party matches the fixture', () => {
  const b = ballInCourt(review());
  const by = Object.fromEntries(b.parties.map((p) => [p.party, p]));
  assert.deepEqual(Object.keys(by), ['Architect', 'Example Frames Co (fictional)', 'Example Flooring Co (fictional)']);
  assert.deepEqual([by.Architect.open_items, by.Architect.rfis, by.Architect.submittals, by.Architect.overdue], [4, 3, 1, 2]);
  assert.deepEqual(['0-7', '8-14', '15-30', '31+'].map((k) => by.Architect[k]), [1, 1, 1, 1]);
  assert.equal(by.Architect.oldest_item, 'Submittal 08 71 00-01'); assert.equal(by.Architect.oldest_days, 31);
  assert.deepEqual([by['Example Frames Co (fictional)'].overdue, by['Example Frames Co (fictional)']['8-14']], [1, 1]);
  assert.equal(by['Example Flooring Co (fictional)']['15-30'], 1);
  assert.equal(b.open_items, 6, 'answered RFI 001, draft 005 and approved submittal are left out');
  assert.deepEqual(b.chase_list.map((c) => c.item), ['RFI 002', 'Submittal 08 71 00-01', 'Submittal 08 11 13-01', 'Submittal 09 65 00-01', 'RFI 003', 'RFI 004']);
  assert.match(b.chase_list[0].reason, /RFI 002 with Architect: response 18 day\(s\) overdue \(due 2026-10-27\)/);
});

test('log diff: new, closed, moved due dates, ball-in-court changes and newly overdue', () => {
  const d = diffLogs(rd('rfis-previous.csv'), rd('rfis.csv'), { as_of });
  assert.equal(d.previous_as_of, '2026-11-07');
  assert.deepEqual(d.added.map((x) => x.rfi_no), ['004', '005']);
  assert.deepEqual(d.closed.map((x) => [x.rfi_no, x.to]), [['001', 'answered']]);
  assert.deepEqual(d.due_changed, [{ rfi_no: '003', from: '2026-11-13', to: '2026-11-20' }]);
  assert.equal(d.ball_in_court_changed[0].to, 'Architect'); assert.equal(d.newly_overdue.length, 0); assert.equal(d.changes, 6);
  const older = diffLogs(rd('rfis-previous.csv'), rd('rfis.csv'), { as_of, previous_as_of: '2026-10-20' });
  assert.deepEqual(older.newly_overdue.map((x) => x.rfi_no), ['002']);
  assert.deepEqual(diffLogs(rd('rfis.csv'), rd('rfis-previous.csv'), { as_of }).removed.map((x) => x.rfi_no), ['004', '005']);
});

test('title blocks: sheet, title and revision extracted; index compared', () => {
  const p = (f) => parseTitleBlock(readFileSync(join(fixtures, 'titleblocks', f), 'utf8'), f);
  assert.deepEqual(['A-201.txt', 'A-501.txt', 'A-601.txt', 'S-101.txt'].map((f) => { const x = p(f); return [x.doc_id, x.revision, x.issued, x.title]; }), [
    ['A-201', '3', '2026-10-01', 'Floor plan level 2'], ['A-501', '2', '2026-11-05', 'Door and frame details'], ['A-601', '1', '2026-11-05', 'Door schedule'], ['S-101', '1', '2026-07-20', 'Foundation plan']]);
  assert.equal(p('A-201.txt').revisions.length, 3);
  assert.deepEqual(p('scan-cover-page.txt').problems, ['no sheet number or spec section found', 'no revision found', 'no title found']);
  const spec = parseTitleBlock(readFileSync(join(fixtures, 'docs/087100-door-hardware.txt'), 'utf8'), 'x');
  assert.deepEqual([spec.doc_id, spec.type, spec.title], ['08 71 00', 'spec', 'DOOR HARDWARE']);
  const conflict = parseTitleBlock('SHEET NO: A-900\nTITLE: X\nREVISION: 2\n1 2026-01-01 a\n3 2026-02-01 b\n', 'c');
  assert.match(conflict.problems[0], /revision field says 2 but the revision table goes to 3/);
  const r = indexFromTitleBlocks(readdirSync(join(fixtures, 'titleblocks')).sort().map((f) => p(f)), rd('documents.csv'));
  assert.deepEqual(r.findings.map((f) => `${f.check}:${f.doc_id || f.file}`), ['index_behind:A-501', 'new_sheet:A-601', 'unreadable_title_block:scan-cover-page.txt']);
  const a501 = r.rows.filter((x) => x.doc_id === 'A-501'); assert.deepEqual(a501.map((x) => [x.revision, x.status]), [['1', 'superseded'], ['2', 'current']]);
  const stale = indexFromTitleBlocks([parseTitleBlock('SHEET NO: A-201\nSHEET TITLE: Floor plan level 2\nREVISIONS\n2 2026-08-15 Permit set', 'old.txt')], rd('documents.csv'));
  assert.ok(stale.findings.some((f) => f.check === 'stale_sheet_file')); assert.ok(stale.findings.some((f) => f.check === 'no_title_block' && f.doc_id === 'A-501'));
});

test('transmittal cites only indexed documents; markers for unknown and old revisions', () => {
  const t = draftTransmittal({ subject: 'Door package', items: ['A-201', 'A-501', '08 71 00', 'M-401', 'A-201 rev 2'], to: 'GC', from: 'Architect', project: 'P', date: as_of, purpose: 'For construction' }, rd('documents.csv'), fixtures, sha256);
  assert.deepEqual(t.documents.map((d) => `${d.doc_id} ${d.revision}`), ['A-201 3', 'A-501 1', '08 71 00 1', 'A-201 2']);
  assert.match(t.text, /\[MISSING REFERENCE: "M-401" is not in the document index\]/); assert.match(t.text, /\[CHECK REVISION: current is rev 3\]/);
  assert.ok(!/M-401 \|/.test(t.text.replace(/\[MISSING REFERENCE[^\]]*\]/g, '')), 'M-401 never appears as a listed document');
  assert.equal(t.documents[0].extract_sha256_12, sha256(readFileSync(join(fixtures, 'docs/A-201-notes.txt'), 'utf8')).slice(0, 12));
  assert.throws(() => draftTransmittal({ subject: 'x', items: [] }, [], fixtures, sha256), /items is required/);
});

test('transmittal tool on Auto; sending it stays one-click and marker-gated', async () => {
  const root = tmpRoot('epeius-tr-'); const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['epeius_draft_transmittal'] }); const store = new ApprovalStore(join(root, '.mythos'));
  const base = { documents: 'documents.csv', subject: 'Door package', to: 'Example Builders (fictional)', from: 'Example Architects (fictional)', project: 'P', date: as_of, purpose: 'For construction' };
  const t1 = await rt.call('epeius_draft_transmittal', { ...base, items: ['A-201', 'A-501'] });
  assert.equal(t1.status, 'executed', t1.reason); assert.equal(t1.result.transmittal_no, 'TR-001'); assert.equal(t1.result.open_markers, 0);
  const t2 = await rt.call('epeius_draft_transmittal', { ...base, items: ['M-401'] }); assert.equal(t2.result.transmittal_no, 'TR-002'); assert.ok(t2.result.markers.includes('MISSING REFERENCE'));
  assert.equal((await rt.call('epeius_draft_transmittal', { ...base, items: ['A-201'], purpose: 'Because' })).status, 'error', 'purpose enum is enforced');
  const s2 = { draft: t2.result.draft, draft_sha256: t2.result.draft_sha256, to: base.to };
  store.approve((await rt.call('epeius_request_send', s2)).approval_id, 'Pat');
  assert.match((await rt.call('epeius_request_send', s2)).reason, /open marker/);
  const s1 = { draft: t1.result.draft, draft_sha256: t1.result.draft_sha256, to: base.to };
  const ask = await rt.call('epeius_request_send', s1); assert.equal(ask.status, 'needs_approval'); assert.equal(ask.one_click ?? true, true);
  store.approve(ask.approval_id, 'Pat');
  const ok = await rt.call('epeius_request_send', s1); assert.equal(ok.status, 'executed'); assert.match(ok.result.summary, /^Transmittal TR-001 approved to send/);
  assert.equal(parseCsv(readFileSync(ok.result.file, 'utf8')).at(-1).rfi_no, 'TR-001');
});

test('report writes ball-in-court.csv, a valid .ics, the diff and an output hash', async () => {
  const root = tmpRoot('epeius-w-'); const rt = new AgentRuntime(manifest, { root });
  const r = await rt.call('epeius_write_log_report', { documents: 'documents.csv', rfis: 'rfis.csv', submittals: 'submittals.csv', previous_rfis: 'rfis-previous.csv', as_of });
  assert.equal(r.status, 'executed'); const names = r.result.files.map((f) => f.split(/[\\/]/).pop());
  assert.deepEqual(names, ['rfi-log-review.md', 'rfi-log.csv', 'submittal-log.csv', 'ball-in-court.csv', 'rfi-due-dates.ics', 'rfi-log-diff.md']);
  assert.match(r.result.output_sha256, /^[0-9a-f]{64}$/);
  const ics = readFileSync(r.result.files[4], 'utf8'); const v = validateIcs(ics); assert.ok(v.ok, v.errors.join('; ')); assert.equal(v.events, 3, "RFI 002, RFI 003 and unsent submittal 08 11 13-01");
  assert.match(ics, /DTSTAMP:20261114T000000Z/); assert.match(ics, /RFI 003 response due \(Architect\)/);
  assert.equal(parseCsv(readFileSync(r.result.files[3], 'utf8'))[0].party, 'Architect');
  assert.match(readFileSync(r.result.files[0], 'utf8'), /## Chase list/); assert.match(readFileSync(r.result.files[5], 'utf8'), /## Closed \(1\)/);
  const audit = readFileSync(join(root, '.mythos/audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(audit.at(-1).output_sha256, r.result.output_sha256);
  const again = await new AgentRuntime(manifest, { root, audit: false }).call('epeius_write_log_report', { documents: 'documents.csv', rfis: 'rfis.csv', submittals: 'submittals.csv', previous_rfis: 'rfis-previous.csv', as_of });
  assert.equal(again.result.output_sha256, r.result.output_sha256, 'deterministic');
  const tb = await rt.call('epeius_index_title_blocks', { folder: 'titleblocks', documents: 'documents.csv' });
  assert.equal(tb.status, 'executed'); assert.equal(tb.result.new_sheet, 1); assert.match(tb.result.output_sha256, /^[0-9a-f]{64}$/);
  assert.equal(parseCsv(readFileSync(tb.result.files[0], 'utf8')).length, 8);
  assert.equal((await rt.call('epeius_index_title_blocks', { folder: 'nope' })).status, 'error');
});

test('MCP prompt walks the weekly review and fills placeholders', async () => {
  const p = manifest.prompts.find((x) => x.name === 'epeius_weekly_rfi_review'); assert.ok(p);
  for (const t of ['epeius_index_title_blocks', 'epeius_review_log', 'epeius_ball_in_court', 'epeius_diff_logs', 'epeius_write_log_report', 'epeius_draft_rfi', 'epeius_draft_transmittal', 'epeius_request_send']) assert.ok(p.text.includes(t), t);
  const h = createMcpHandler(new AgentRuntime(manifest, { root: fixtures, audit: false }));
  const got = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: p.name, arguments: { documents: 'documents.csv', rfis: 'rfis.csv', as_of } } });
  assert.match(got.result.messages[0].content.text, /documents=documents.csv, rfis=rfis.csv/);
  assert.match(got.result.messages[0].content.text, /one named human click/);
});

test('duplicate RFIs written in Japanese or Korean are found (they used to have no words to compare)', () => {
  const rfis = [
    { rfi_no: 'J-1', subject: '3階 梁の鉄筋径について', question: 'B3通りの梁の主筋径を確認してください', status: 'answered', sent_date: '2026-10-01', due_date: '2026-10-10', references: 'S-201' },
    { rfi_no: 'J-2', subject: '3階 梁の鉄筋径の確認', question: 'B3通り 梁の主筋径を確認してください', status: 'open', sent_date: '2026-11-01', due_date: '2026-11-30', references: 'S-201' },
    { rfi_no: 'J-3', subject: '屋上防水の仕様', question: '屋上の防水材の製品名を教えてください', status: 'open', sent_date: '2026-11-02', due_date: '2026-11-30', references: 'S-201' },
    { rfi_no: 'K-1', subject: '지하 1층 방수 사양', question: '지하 1층 외벽 방수 사양을 확인 바랍니다', status: 'answered', sent_date: '2026-10-01', due_date: '2026-10-10', references: 'S-201' },
    { rfi_no: 'K-2', subject: '지하 1층 외벽 방수 사양', question: '지하 1층 외벽 방수 사양 확인 바랍니다', status: 'open', sent_date: '2026-11-01', due_date: '2026-11-30', references: 'S-201' },
  ];
  const r = reviewLog([{ doc_id: 'S-201', type: 'drawing', title: '構造図', revision: 'B', status: 'current' }], rfis, [], { as_of });
  const flagged = (no) => r.items.find((x) => x.rfi_no === no).flags.includes('possible_duplicate');
  assert.ok(flagged('J-2'), 'Japanese near-duplicate found'); assert.ok(!flagged('J-3'), 'a different Japanese question is not');
  assert.ok(flagged('K-2'), 'Korean near-duplicate found');
});
