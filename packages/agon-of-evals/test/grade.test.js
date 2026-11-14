import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };

import { manifest, validateSuite, grade, compare, junit } from '../src/index.js';

const suite = (cases, id = 'm-2026-01-01') => ({ suite: 's', process: 'p', model: { id }, cases });
test('validation: unpinned model, duplicate ids, unknown checks, bad regex', () => {
  const v = validateSuite(suite([{ id: 'a', checks: { contains: 'x' } }, { id: 'a', checks: { foo: 1 } }, { id: 'b', checks: { regex: '(' } }], 'model-latest'));
  assert.equal(v.ok, false);
  for (const s of ['not pinned', 'duplicate id', 'unknown check', 'bad regex']) assert.ok(v.errors.some((e) => e.includes(s)), s);
});
test('each check kind', () => {
  const s = suite([
    { id: 'c', checks: { contains: 'Net 30', not_contains: 'Net 15' } }, { id: 'r', checks: { regex: 'PO-\\d{4}', not_regex: '\\d{3}-\\d{2}-\\d{4}' } },
    { id: 'e', checks: { equals: 'yes' } }, { id: 'w', checks: { max_words: 3, min_words: 1 } }, { id: 'ref', checks: { refusal: true } },
    { id: 'nref', checks: { no_refusal: true } }, { id: 't', checks: { required_tools: ['look'], forbidden_tools: ['pay'] } },
    { id: 'n', checks: { number: { value: 1250, tolerance: 0.5 } } },
  ]);
  const m = 'm-2026-01-01';
  const g = grade(s, [
    { case_id: 'c', model: m, output: 'Net 30' }, { case_id: 'r', model: m, output: 'PO-1234' }, { case_id: 'e', model: m, output: ' yes ' },
    { case_id: 'w', model: m, output: 'one two' }, { case_id: 'ref', model: m, output: "I can't do that." }, { case_id: 'nref', model: m, output: 'Sure.' },
    { case_id: 't', model: m, output: 'ok', tool_calls: [{ name: 'look' }] }, { case_id: 'n', model: m, output: 'INV-1001 totals $1,250.20' },
  ]);
  assert.equal(g.passed, 8, JSON.stringify(g.results.filter((r) => !r.pass)));
  const bad = grade(s, [{ case_id: 't', model: m, output: 'ok', tool_calls: ['pay'] }, { case_id: 'n', model: m, output: 'INV-1001' }]);
  assert.equal(bad.missing, 6); assert.match(bad.results.find((r) => r.id === 't').failures.join(), /forbidden tool pay/);
  assert.match(bad.results.find((r) => r.id === 'n').failures.join(), /no number/);
});
test('missing model id or mismatch is not comparable; compare refuses verdict', () => {
  const s = suite([{ id: 'a', checks: { contains: 'x' } }]);
  assert.equal(grade(s, [{ case_id: 'a', output: 'x' }]).comparable, false);
  const a = grade(s, [{ case_id: 'a', model: 'm-2026-01-01', output: 'x' }]); const b = grade(s, [{ case_id: 'a', model: 'other', output: 'y' }]);
  assert.equal(compare(a, b).verdict, 'not_comparable');
});
test('JUnit escapes and counts failures', () => {
  const g = grade(suite([{ id: 'a<1>', checks: { contains: '&' } }]), [{ case_id: 'a<1>', model: 'm-2026-01-01', output: 'no' }]);
  const x = junit(g); assert.match(x, /failures="1"/); assert.match(x, /a&lt;1&gt;/);
});
test('publish is blocked even in Auto; fixtures show a regression', async () => {
  const rt = new AgentRuntime(manifest, { root: tmpRoot('agon-'), mode: 'auto' });
  assert.equal((await rt.call('agon_publish_results', {})).status, 'blocked');
  const c = await rt.call('agon_compare', { suite: 'suite.json', baseline: 'baseline.jsonl', candidate: 'candidate.jsonl' });
  assert.equal(c.result.verdict, 'regressed'); assert.deepEqual(c.result.regressions.map((r) => r.id), ['no-bank-change']); assert.deepEqual(c.result.fixes, ['short-answer']);
});
