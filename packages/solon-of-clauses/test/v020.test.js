import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, readAudit, createMcpHandler, writeZip, applyUnifiedDiff } from 'mythos-agent-core';
import { manifest, checkContract, readContractFile, docxContract, definedTerms, compareDrafts } from '../src/index.js';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(pkgDir, 'fixtures');
const pb = JSON.parse(readFileSync(join(fixtures, 'playbook.json'), 'utf8'));
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'solon-v2-')); cpSync(fixtures, r, { recursive: true }); return r; };
const strip = (r) => ({ ...r, file: null, source: null });

test('DOCX input: the .docx fixture gives the same findings and citations as the .md fixture', () => {
  const md = readContractFile(join(fixtures, 'contracts/msa.md'));
  const dx = readContractFile(join(fixtures, 'contracts/msa.docx'));
  assert.equal(dx.text, md.text, 'one paragraph per line, empty paragraphs kept');
  assert.deepEqual(dx.source, { format: 'docx', paragraphs: 43, tracked_insertions: 0, tracked_deletions: 0, first_tracked_paragraph: null, comments: 0, auto_numbered: 0 });
  const a = checkContract(md.text, pb, { file: 'x' }); const b = checkContract(dx.text, pb, { file: 'x', source: dx.source });
  assert.deepEqual(strip(b), strip(a));
  const pay = b.clauses.find((c) => c.id === 'payment_terms');
  assert.deepEqual(pay.citations.map((x) => [x.section, x.line]), [['3 Fees and Payment', 13], ['3 Fees and Payment', 15]]);
  assert.equal(pay.citations[1].quote, 'Customer will pay each undisputed invoice within sixty (60) days of receipt. Late amounts bear interest at 1% per month.');
});

test('DOCX: tracked changes read as accepted and flagged, comments counted, auto-numbering flagged, bad files refused', () => {
  const t = readContractFile(join(fixtures, 'contracts/msa-v2-tracked.docx'));
  assert.match(t.text, /within thirty \(30\) days/); assert.doesNotMatch(t.text, /sixty/);
  assert.deepEqual([t.source.tracked_insertions, t.source.tracked_deletions, t.source.first_tracked_paragraph, t.source.comments], [1, 1, 15, 1]);
  const r = checkContract(t.text, pb, { source: t.source });
  assert.deepEqual(r.document_findings.map((d) => [d.check, d.line]), [['docx_comments', 1], ['docx_tracked_changes', 15], ['broken_cross_reference', 35], ['open_placeholder', 39]]);
  const auto = docxContract(writeZip({ 'word/document.xml': '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Fees &amp; Payment</w:t></w:r></w:p></w:body></w:document>' }));
  assert.equal(auto.text, '## Fees & Payment\n'); assert.equal(auto.source.auto_numbered, 1);
  assert.match(checkContract(auto.text, pb, { source: auto.source }).document_findings[0].detail, /automatic numbering/);
  assert.throws(() => docxContract(Buffer.from('not a zip')), /not a readable \.docx/);
  assert.throws(() => docxContract(writeZip({ 'a.txt': 'x' })), /word\/document\.xml missing/);
});

test('defined terms: used but not defined, defined but unused, defined twice, with lines', () => {
  const t = definedTerms(readFileSync(join(fixtures, 'contracts/msa.md'), 'utf8'));
  assert.deepEqual(t.defined.map((x) => `${x.term}@${x.line}`), ['Customer@3', 'Supplier@3', 'Confidential Information@7', 'Deliverables@7', 'Services@7']);
  assert.deepEqual(t.undefined, [{ term: 'Effective Date', lines: [19] }]);
  assert.deepEqual(t.unused, [{ term: 'Deliverables', line: 7 }]);
  const x = definedTerms('# Purchase Agreement\n\n“Buyer” means Rowan Vale. (the "Seller") and later (the "Seller").\nThe Buyer pays the Purchase Price to the Seller via the Escrow Agent.\nBuyer notes: the Escrow and Escrow fees. Paid by Acme Widgets Inc on Monday.', { ignore: ['Rowan Vale'] });
  assert.deepEqual(x.undefined.map((u) => `${u.term}@${u.lines.join(',')}`), ['Escrow Agent@4', 'Purchase Price@4', 'Escrow@5']);
  assert.deepEqual(x.duplicates, [{ term: 'Seller', lines: [3, 3] }]);
  assert.deepEqual(x.unused, []);
});

test('compare drafts: clause by clause better/worse, new and resolved findings, changed sections', () => {
  const a = readContractFile(join(fixtures, 'contracts/msa.md')); const b = readContractFile(join(fixtures, 'contracts/msa-v2-tracked.docx'));
  const c = compareDrafts(checkContract(a.text, pb, { file: 'msa.md' }), checkContract(b.text, pb, { file: 'v2.docx', source: b.source }), a.text, b.text);
  assert.deepEqual(c.clauses[0], { id: 'payment_terms', title: 'Payment terms', before: 'needs_attention', after: 'present', change: 'better', value_before: 60, value_after: 30, issues_after: [] });
  assert.deepEqual(c.counts, { better: 1, unchanged: 9 }); assert.deepEqual([c.gaps_before, c.gaps_after], [6, 5]);
  assert.deepEqual(c.sections.changed, ['3 Fees and Payment']);
  assert.deepEqual(c.document_findings_new.map((d) => d.check), ['docx_comments', 'docx_tracked_changes']);
  const worse = a.text.replace('three (3) years', 'three (3) years. Supplier may keep copies').replace('Supplier will defend and indemnify Customer against third-party claims that the Services infringe intellectual property rights.', 'Reserved.');
  const w = compareDrafts(checkContract(a.text, pb), checkContract(worse, pb), a.text, worse);
  assert.equal(w.clauses[0].change, 'worse'); assert.equal(w.clauses[0].id, 'indemnification');
});

test('playbook schema: unknown key, wrong type and missing field fail with JSON pointers', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root });
  const cases = [
    ['unknown', { ...pb, clauses: pb.clauses.map((c, i) => (i === 0 ? { ...c, must_includes: ['x'] } : c)) }, /\/clauses\/0/],
    ['wrongtype', { ...pb, clauses: pb.clauses.map((c, i) => (i === 2 ? { ...c, required: 'yes' } : c)) }, /\/clauses\/2\/required/],
    ['missing', { clauses: pb.clauses }, /source/],
  ];
  for (const [name, p, re] of cases) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(p));
    const r = await rt.call('solon_check', { contract: 'contracts/msa.md', playbook: `${name}.json` });
    assert.equal(r.status, 'error', name); assert.match(r.reason, /not a valid playbook/); assert.match(r.reason, re);
  }
  writeFileSync(join(root, 'broken.json'), '{ "source": ');
  assert.match((await rt.call('solon_check', { contract: 'contracts/msa.md', playbook: 'broken.json' })).reason, /playbook is not valid JSON/);
});

test('memo cites the playbook version and hash, redlines against the previous memo; report hash in the audit log', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['solon_draft_markup'] });
  const first = await rt.call('solon_draft_markup', { contract: 'contracts/msa.md', playbook: 'playbook.json', out_dir: 'mythos-out/v1' });
  const memo1 = readFileSync(join(root, first.result.draft), 'utf8');
  const sha = createHash('sha256').update(readFileSync(join(root, 'playbook.json'))).digest('hex');
  assert.match(memo1, new RegExp(`playbook version 3\\.0\\.0 \\(playbook file sha256 ${sha.slice(0, 12)}\\)`));
  assert.equal(first.result.playbook_sha256, sha);
  assert.match(memo1, /Capitalised term "Effective Date" is used \(line 19\) but not defined/);
  assert.equal((memo1.match(/\[COUNSEL REVIEW\]/g) || []).length, 8);
  const second = await rt.call('solon_draft_markup', { contract: 'contracts/msa-v2-tracked.docx', playbook: 'playbook.json', previous_contract: 'contracts/msa.md', previous_draft: 'mythos-out/v1/issues-for-counsel.md', out_dir: 'mythos-out/v2' });
  assert.equal(second.status, 'executed'); assert.ok(second.result.redline.added > 0);
  const memo2 = readFileSync(join(root, second.result.draft), 'utf8');
  assert.match(memo2, /## Changes since contracts\/msa\.md \[COUNSEL REVIEW\]/); assert.match(memo2, /Payment terms: needs_attention → present \(better\), value 60 → 30/);
  const diff = readFileSync(join(root, 'mythos-out/v2/issues-for-counsel.diff'), 'utf8');
  assert.equal(applyUnifiedDiff(memo1, diff), memo2, 'the redline turns the old memo into the new one');
  const w = await rt.call('solon_write_report', { contract: 'contracts/msa-v2-tracked.docx', previous_contract: 'contracts/msa.md', playbook: 'playbook.json', out_dir: 'mythos-out/rep' });
  assert.match(readFileSync(join(root, 'mythos-out/rep/contract.diff'), 'utf8'), /^-.*sixty \(60\)/m);
  assert.match(readFileSync(join(root, 'mythos-out/rep/draft-changes.md'), 'utf8'), /\| Payment terms \| needs_attention \(60\) \| present \(30\) \| better \|/);
  const lineRec = readAudit(join(root, '.mythos/audit.jsonl')).filter((e) => e.tool === 'solon_write_report').pop();
  assert.equal(lineRec.output_sha256, w.result.output_sha256);
});

test('e-signing stays blocked and sending stays one-click after a named reviewer, also for DOCX', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['solon_draft_markup'] });
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['e_sign'] }));
  for (const t of ['e_sign', 'send_email']) { const r = await rt.call(t, {}); assert.equal(r.status, 'blocked'); assert.equal(r.decision, 'block'); }
  const d = await rt.call('solon_draft_markup', { contract: 'contracts/msa.docx', playbook: 'playbook.json', out_dir: 'mythos-out/dx' });
  const file = join(root, d.result.draft); const reviewed = readFileSync(file, 'utf8').replace(/ ?\[COUNSEL REVIEW\]/g, ''); writeFileSync(file, reviewed);
  const req = { draft: d.result.draft, draft_sha256: createHash('sha256').update(reviewed).digest('hex'), to: 'Kettle Labs legal (fictional)', reviewed_by: 'Morgan Counsel (fictional)' };
  const a = await rt.call('solon_request_send', req); assert.equal(a.status, 'needs_approval'); assert.match(a.reason, /binding_send stays one-click/);
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Jo');
  const ok = await rt.call('solon_request_send', req); assert.equal(ok.status, 'executed'); assert.equal(ok.approved_by, 'Jo');
  assert.match((await rt.call('solon_request_send', { ...req, reviewed_by: 'Robin Counsel (fictional)' })).status, /needs_approval/, 'a different request needs its own click');
  assert.equal((await rt.call('solon_request_send', { ...req, reviewed_by: '' })).status, 'error', 'a blank reviewer is refused before any click');
});

test('README still says near the top: not legal advice, does not replace a lawyer, no accuracy guarantee', () => {
  const top = readFileSync(join(pkgDir, 'README.md'), 'utf8').split('\n').slice(0, 8).join('\n');
  assert.match(top, /not legal advice/i); assert.match(top, /does not replace a lawyer/i); assert.match(top, /no guarantee that its .* accurate/i);
  assert.doesNotMatch(readFileSync(join(pkgDir, 'README.md'), 'utf8'), /\b(?:compliant|certified|guaranteed|legally sound|lawyer-approved)\b/i);
});

test('MCP prompt walks the workflow, says not legal advice and marks the human click', async () => {
  const h = createMcpHandler(new AgentRuntime(manifest, { audit: false }));
  assert.deepEqual((await h({ jsonrpc: '2.0', id: 1, method: 'prompts/list' })).result.prompts.map((p) => p.name), ['contract_playbook_review']);
  const g = await h({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'contract_playbook_review', arguments: { contract: 'contracts/msa.docx', playbook: 'playbook.json' } } });
  const text = g.result.messages[0].content.text;
  for (const t of ['solon_check', 'solon_compare_drafts', 'solon_write_report', 'solon_draft_markup', 'solon_request_send', 'reviewed_by', 'one click', 'not legal advice', 'e_sign) is always blocked']) assert.ok(text.includes(t), t);
  assert.match(text, /contracts\/msa\.docx/);
});
