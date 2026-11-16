import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
import { manifest, checkContract, sections, validatePlaybook, issuesMemo } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const msa = readFileSync(join(fixtures, 'contracts/msa.md'), 'utf8');
const pb = JSON.parse(readFileSync(join(fixtures, 'playbook.json'), 'utf8'));
const run = () => checkContract(msa, pb, { file: 'contracts/msa.md' });
const cl = (r, id) => r.clauses.find((c) => c.id === id);
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'solon-')); cpSync(fixtures, r, { recursive: true }); return r; };

test('sections and playbook validation', () => {
  const s = sections(msa).filter((x) => x.number);
  assert.equal(s.length, 10); assert.deepEqual([s[0].number, s[0].heading, s[0].start], ['1', 'Definitions', 5]);
  assert.deepEqual(sections('1. Scope\nText.\n2.1 Fees\nMore text.').filter((x) => x.number).map((x) => x.number), ['1', '2.1']);
  assert.throws(() => validatePlaybook({ clauses: [] }), /playbook.source is required/);
  assert.throws(() => validatePlaybook({ source: 's', clauses: [{ id: 'a', title: 'A' }] }), /find must list/);
  assert.throws(() => validatePlaybook({ source: 's', clauses: [{ id: 'a', title: 'A', find: ['x'], value: { pattern: '(' } }] }), /not a valid regular expression/);
});
test('statuses, values and citations', () => {
  const r = run();
  assert.equal(r.gaps, 6);
  assert.equal(cl(r, 'payment_terms').status, 'needs_attention'); assert.deepEqual(cl(r, 'payment_terms').value, { found: 60, unit: 'days', line: 15, min: null, max: 45 });
  assert.equal(cl(r, 'limitation_of_liability').value.found, 3);
  assert.equal(cl(r, 'auto_renewal').status, 'prohibited_present'); assert.equal(cl(r, 'auto_renewal').citations[0].line, 19);
  assert.equal(cl(r, 'confidentiality').citations.length, 1, 'a heading match wins over a mention in Definitions');
  assert.equal(cl(r, 'termination_convenience').status, 'missing'); assert.equal(cl(r, 'non_solicit').status, 'absent_optional');
  assert.deepEqual(r.document_findings.map((d) => [d.check, d.line]), [['broken_cross_reference', 35], ['open_placeholder', 39]]);
  const fixed = msa.replace('sixty (60)', 'forty-five (45)').replace('three (3) months', 'twelve (12) months');
  const r2 = checkContract(fixed, pb); assert.equal(cl(r2, 'payment_terms').status, 'present'); assert.equal(cl(r2, 'limitation_of_liability').status, 'present');
  assert.equal(checkContract(msa.replace('It will automatically renew for successive one-year terms unless either party gives notice at least ninety (90) days before the end of the current term.', ''), pb).clauses.find((c) => c.id === 'auto_renewal').status, 'absent_ok');
});
test('memo copies only playbook language and marks every section for counsel', () => {
  const m = issuesMemo(run());
  assert.ok(m.includes('"Customer will pay each undisputed invoice within forty-five (45) days of receipt."'));
  assert.equal((m.match(/\[COUNSEL REVIEW\]/g) || []).length, 8);
  assert.match(m, /Not legal advice/); assert.doesNotMatch(m, /we recommend|you should sign/i);
});
test('send is one-click, needs a named reviewer, hash-bound, marker-gated; send and sign blocked', async () => {
  const root = tmpRoot(); const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['solon_draft_markup'] });
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['solon_request_send'] }), /one-click/);
  const d = await rt.call('solon_draft_markup', { contract: 'contracts/msa.md', playbook: 'playbook.json' }); assert.equal(d.status, 'executed');
  const req = { draft: d.result.draft, draft_sha256: d.result.draft_sha256, to: 'Kettle Labs legal', reviewed_by: 'Morgan' };
  const a = await rt.call('solon_request_send', req); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Jo');
  assert.match((await rt.call('solon_request_send', req)).reason, /COUNSEL REVIEW/);
  const file = join(root, d.result.draft); const reviewed = readFileSync(file, 'utf8').replace(/ ?\[COUNSEL REVIEW\]/g, ''); writeFileSync(file, reviewed);
  const stale = { ...req, to: 'Kettle Labs legal team' };
  new ApprovalStore(join(root, '.mythos')).approve((await rt.call('solon_request_send', stale)).approval_id, 'Jo');
  assert.match((await rt.call('solon_request_send', stale)).reason, /does not match/);
  const req2 = { ...req, draft_sha256: createHash('sha256').update(reviewed).digest('hex') };
  const blank = { ...req2, reviewed_by: ' ' };
  // A blank reviewer is refused before anyone is asked to approve it.
  const refused = await rt.call('solon_request_send', blank); assert.equal(refused.status, 'error'); assert.equal(refused.approval_id, undefined);
  assert.match(refused.reason, /reviewed_by is required/);
  new ApprovalStore(join(root, '.mythos')).approve((await rt.call('solon_request_send', req2)).approval_id, 'Jo');
  const ok = await rt.call('solon_request_send', req2); assert.equal(ok.status, 'executed'); assert.equal(ok.approved_by, 'Jo');
  const row = parseCsv(readFileSync(join(root, 'mythos-out/solon/send-requests.csv'), 'utf8'))[0];
  assert.deepEqual([row.to, row.reviewed_by, row.status], ['Kettle Labs legal', 'Morgan', 'approved - a person sends it']);
  for (const t of ['send_email', 'e_sign']) assert.equal((await rt.call(t, {})).status, 'blocked');
});
