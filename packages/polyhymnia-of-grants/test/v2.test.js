import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv, validateIcs, readZip, readAudit, sha256, createMcpHandler } from 'mythos-agent-core';
import { manifest, deadlines, varianceReview, review, templateCheck, deadlineIcs } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const rd = (f) => parseCsv(readFileSync(join(fixtures, f), 'utf8'));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const as_of = '2026-11-14';
const f = { grants: 'grants.csv', budget: 'budget.csv', outcomes: 'outcomes.csv', as_of };
const grant = (id) => deadlines(rd('grants.csv'), { as_of }).find((g) => g.grant_id === id);
const lines = (id) => rd('budget.csv').filter((l) => l.grant_id === id);

test('variance by line: over the threshold carries a required explanation marker', () => {
  const v = varianceReview(grant('G1'), lines('G1'), { as_of });
  assert.equal(v.basis, 'expected_by_now');
  const by = Object.fromEntries(v.lines.map((l) => [l.line, l]));
  assert.equal(by['Books and materials'].explanation_required, true); assert.match(by['Books and materials'].marker, /^\[EXPLAIN VARIANCE — \+2,232\.97 \(\+32\.1%\) vs expected by now\]$/);
  assert.equal(by.Transport.explanation_required, true); assert.match(by.Transport.marker, /explanation given, check it/, 'a given explanation is still checked by a person');
  assert.equal(by.Personnel.explanation_required, false); assert.equal(by.Personnel.marker, '');
  assert.equal(v.lines_needing_explanation, 2);
  const strict = varianceReview(grant('G1'), lines('G1'), { as_of, variance_pct: 0.01 });
  assert.equal(strict.lines_needing_explanation, 3, 'Personnel (+1.4%) crosses a 1% threshold');
  const amt = varianceReview(grant('G1'), lines('G1'), { as_of, variance_amount: 3000 });
  assert.deepEqual(amt.lines.filter((l) => l.explanation_required).map((l) => l.line), ['Transport'], 'both thresholds must be exceeded');
  const fin = varianceReview(grant('G2'), lines('G2'), { as_of });
  assert.equal(fin.basis, 'budget', 'final reports compare with the full budget'); assert.equal(fin.lines_needing_explanation, 0);
  assert.equal(varianceReview(grant('G2'), lines('G2'), { as_of, variance_pct: 0.05 }).lines_needing_explanation, 1, 'Paint −6% crosses 5%');
});

test('spend-down projection flags a likely underspend', () => {
  const v = varianceReview(grant('G3'), lines('G3'), { as_of });
  assert.deepEqual(v.flags, ['projected_underspend']); assert.ok(v.projected_at_end < 30000 * 0.9);
  assert.deepEqual(varianceReview(grant('G1'), lines('G1'), { as_of }).flags, []);
  assert.deepEqual(varianceReview(grant('G3'), lines('G3'), { as_of, underspend_pct: 0.5 }).flags, []);
});

test('packet shows the variance table and every over-threshold line has a marker and a checklist item', async () => {
  const root = tmpRoot('poly-v-');
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['polyhymnia_build_packet'] });
  const p = await rt.call('polyhymnia_build_packet', { ...f, grant_id: 'G1' }); assert.equal(p.status, 'executed');
  const draft = readFileSync(join(root, 'mythos-out/polyhymnia/packets/G1/report-draft.md'), 'utf8');
  assert.match(draft, /## Budget vs actual variance/); assert.equal((draft.match(/\[EXPLAIN VARIANCE/g) || []).length, 2);
  const cl = readFileSync(join(root, 'mythos-out/polyhymnia/packets/G1/checklist.md'), 'utf8');
  assert.match(cl, /- \[ \] Explain the variance on "Books and materials"/);
});

test('funder template: packet follows the template, missing sections and attachments are flagged', async () => {
  const t = JSON.parse(readFileSync(join(fixtures, 'templates/lakeside-interim.json'), 'utf8'));
  const r = review({ grants: rd('grants.csv'), budget: rd('budget.csv'), outcomes: rd('outcomes.csv'), exists: (p) => existsSync(join(fixtures, p)), as_of });
  const g1 = r.items.find((g) => g.grant_id === 'G1');
  const tc = templateCheck(t, g1, varianceReview(g1, lines('G1'), { as_of, variance_pct: t.variance_threshold_pct }), (p) => existsSync(join(fixtures, p)));
  assert.deepEqual(tc.gaps.map((x) => x.issue), ['attachment_missing', 'variance_explanations_needed']);
  assert.equal(tc.sections.find((s) => s.id === 'variance').state, 'needs_explanation'); assert.equal(tc.sections.find((s) => s.id === 'progress').state, 'to_write');
  const g3 = r.items.find((g) => g.grant_id === 'G3');
  const tc3 = templateCheck(t, g3, varianceReview(g3, lines('G3'), { as_of }), () => false);
  assert.ok(tc3.gaps.some((x) => x.issue === 'template_funder_mismatch'));
  assert.ok(tc3.gaps.some((x) => x.issue === 'template_section_missing' && x.section === 'evidence'), 'no evidence file found for G3');

  const root = tmpRoot('poly-t-');
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['polyhymnia_build_packet'] });
  const p = await rt.call('polyhymnia_build_packet', { ...f, grant_id: 'G1', template: 'templates/lakeside-interim.json' });
  assert.equal(p.status, 'executed', JSON.stringify(p)); assert.match(p.result.summary, /following template "lakeside-interim" \(2 template gap\(s\)\)/);
  const draft = readFileSync(join(root, 'mythos-out/polyhymnia/packets/G1/report-draft.md'), 'utf8');
  const order = t.sections.map((s) => draft.indexOf(`## ${s.title}`));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'sections in template order');
  assert.match(draft, /\[TO WRITE — a person writes this \(max 500 words\)/); assert.match(draft, /\[MISSING ATTACHMENT — evidence\/g1-board-budget\.pdf\]/);
  assert.match(draft, /_Funder guidance: Describe progress/); assert.ok(!/compliant/i.test(draft));
  assert.match(draft, /Threshold: more than 15%/, 'template threshold used');
  const chk = await rt.call('polyhymnia_template_check', { ...f, template: 'templates/lakeside-interim.json' });
  assert.equal(chk.status, 'executed'); assert.equal(chk.result.grants.length, 3);
});

test('funder template is schema-checked: three mutated configs fail with JSON pointers', async () => {
  const root = tmpRoot('poly-cfg-');
  const good = JSON.parse(readFileSync(join(fixtures, 'templates/lakeside-interim.json'), 'utf8'));
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const bad = {
    unknown: [{ ...good, deadline_days: 30 }, /\/deadline_days is not an allowed property/],
    type: [{ ...good, sections: [{ id: 'x', title: 'X', source: 'narrative', max_words: 'many' }] }, /\/sections\/0\/max_words expected integer/],
    missing: [{ name: 'x' }, /\/sections is required/],
  };
  for (const [k, [cfg, re]] of Object.entries(bad)) {
    writeFileSync(join(root, `bad-${k}.json`), JSON.stringify(cfg));
    const r = await rt.call('polyhymnia_template_check', { ...f, template: `bad-${k}.json` });
    assert.equal(r.status, 'error', k); assert.match(JSON.stringify(r), re, k);
  }
  const enumBad = { ...good, sections: [{ id: 'x', title: 'X', source: 'poetry' }] };
  writeFileSync(join(root, 'bad-enum.json'), JSON.stringify(enumBad));
  assert.match((await rt.call('polyhymnia_template_check', { ...f, template: 'bad-enum.json' })).reason, /\/sections\/0\/source must be one of/);
});

test('deadline reminders as .ics validate', async () => {
  const items = deadlines(rd('grants.csv'), { as_of });
  const ics = deadlineIcs(items, { as_of });
  const v = validateIcs(ics); assert.ok(v.ok, v.errors.join('; '));
  assert.equal(v.events, 5, 'G1/G2/G3 report due + G1/G3 period end; G4 submitted skipped; G2 period already ended');
  for (const d of [30, 14, 7, 1]) assert.match(ics, new RegExp(`TRIGGER:-P${d}D`));
  assert.doesNotMatch(ics, /Summer reading 2025/);
  assert.equal(deadlineIcs(items, { as_of }), ics, 'deterministic');
  const root = tmpRoot('poly-ics-');
  const r = await new AgentRuntime(manifest, { root }).call('polyhymnia_calendar', { grants: 'grants.csv', as_of, reminder_days: [10, 3], include_period_end: false });
  assert.equal(r.status, 'executed'); assert.equal(r.result.events, 3);
  const text = readFileSync(r.result.file, 'utf8'); assert.ok(validateIcs(text).ok); assert.match(text, /TRIGGER:-P10D/); assert.doesNotMatch(text, /TRIGGER:-P30D/);
  assert.equal(readAudit(join(root, '.mythos/audit.jsonl')).at(-1).output_sha256, sha256(text));
});

test('evidence pack zips the packet, cited evidence, variance and a hash manifest', async () => {
  const root = tmpRoot('poly-z-');
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['polyhymnia_build_packet'] });
  const args = { ...f, grant_id: 'G1' };
  const early = await new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['polyhymnia_evidence_pack'] }).call('polyhymnia_evidence_pack', args);
  assert.equal(early.status, 'error'); assert.match(early.reason, /run polyhymnia_build_packet first/);
  await rt.call('polyhymnia_build_packet', args);
  const a = await rt.call('polyhymnia_evidence_pack', args); assert.equal(a.status, 'needs_approval', 'not on Auto unless opted in');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Morgan');
  const b = await rt.call('polyhymnia_evidence_pack', args); assert.equal(b.status, 'executed');
  const zip = readZip(readFileSync(b.result.file));
  assert.deepEqual([...zip.keys()].sort(), ['evidence/evidence/g1-assessments.csv', 'evidence/evidence/g1-enrollment.csv', 'manifest.json', 'packet/checklist.md', 'packet/evidence-index.csv', 'packet/report-draft.md', 'packet/variance.csv']);
  const m = JSON.parse(zip.get('manifest.json').toString());
  for (const x of m.files) assert.equal(x.sha256, sha256(zip.get(x.name)), x.name);
  assert.match(m.note, /Not submitted/);
  assert.equal(parseCsv(zip.get('packet/variance.csv').toString()).filter((r) => r.explanation_required === 'yes').length, 2);
  assert.equal(readAudit(join(root, '.mythos/audit.jsonl')).at(-1).output_sha256, sha256(readFileSync(b.result.file)));
  const g3 = await new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['polyhymnia_build_packet', 'polyhymnia_evidence_pack'] });
  await g3.call('polyhymnia_build_packet', { ...f, grant_id: 'G3' });
  const z3 = await g3.call('polyhymnia_evidence_pack', { ...f, grant_id: 'G3' });
  assert.deepEqual(z3.result.missing, ['evidence/evidence/g3-signups.csv']);
  assert.equal((await new AgentRuntime(manifest, { root, audit: false, mode: 'review' }).call('polyhymnia_evidence_pack', args)).status, 'blocked');
});

test('MCP prompt walks the cycle and keeps submission a human click', async () => {
  const h = createMcpHandler(new AgentRuntime(manifest, { audit: false }));
  const g = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'polyhymnia_report_cycle', arguments: { grants: 'g.csv', budget: 'b.csv', outcomes: 'o.csv' } } });
  const text = g.result.messages[0].content.text;
  for (const s of ['g.csv', 'polyhymnia_calendar', 'polyhymnia_variance', 'polyhymnia_template_check', 'polyhymnia_build_packet', 'polyhymnia_evidence_pack', 'polyhymnia_request_submission', 'one named human click', 'does not make anyone compliant']) assert.ok(text.includes(s), s);
});
