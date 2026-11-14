import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
async function oneClick(manifest, tool, args, root) {
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: [tool] }), /one-click/);
  const rt = new AgentRuntime(manifest, { root, mode: 'auto' });
  const a = await rt.call(tool, args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Dana');
  const b = await rt.call(tool, args); assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Dana');
  const again = await rt.call(tool, args); assert.equal(again.status, 'needs_approval', 'approval is single-use');
  return b;
}

import { manifest, mapData, findSubject, checklist, dueDate, maskEmail, CHECKLIST_COLUMNS, checklistCsv } from '../src/index.js';

const files = [{ name: 'crm.csv', rows: [{ Email: 'A@x.example', Mobile: '+1 (512) 555-0100', city: 'Austin' }, { Email: 'b@x.example', Mobile: '', city: '' }] }, { name: 'tax-invoices.csv', rows: [{ customer_id: 'K9', total: '1' }] }];
test('maps categories and retention', () => {
  const m = mapData(files);
  assert.deepEqual(m[0].personal_data_columns.map((c) => c.category), ['email', 'phone', 'address']); assert.equal(m[1].retention_flag, true);
});
test('matches by email case-insensitively, phone by last 10 digits, id only in id columns', () => {
  assert.equal(findSubject(files, { email: 'a@X.example' }).rows_found, 1);
  assert.equal(findSubject(files, { phone: '5125550100' }).rows_found, 1);
  assert.equal(findSubject(files, { ids: ['k9'] }).rows_found, 1);
  assert.equal(findSubject([{ name: 'n.csv', rows: [{ note: 'K9' }] }], { ids: ['K9'] }).rows_found, 0);
  assert.throws(() => findSubject(files, {}), /identifier/);
});
test('masking and due dates', () => {
  assert.equal(maskEmail('jamie@example.com'), 'j***@example.com');
  assert.equal(dueDate('2026-11-10', 'gdpr'), '2026-12-10'); assert.equal(dueDate('2026-11-10', 'other'), null);
});
test('checklist: verify first, retention warning, processors, blank owner columns', () => {
  const steps = checklist(findSubject(files, { ids: ['K9'], email: 'a@x.example' }), { received: '2026-11-10', regime: 'ccpa' });
  assert.match(steps[0].action, /Verify/); assert.match(steps[1].action, /2026-12-25/);
  assert.ok(steps.some((s) => s.system_or_file === 'tax-invoices.csv' && /retention/i.test(s.action)));
  assert.ok(steps.some((s) => s.system_or_file === '(processors)'));
  assert.deepEqual(Object.keys(parseCsv(checklistCsv(steps))[0]), CHECKLIST_COLUMNS);
});
test('deletion is one-click even in Auto; outputs never hold the raw email', async () => {
  const root = tmpRoot('mac-');
  const b = await oneClick(manifest, 'macaria_request_deletion', { system: 'CRM', reason: 'verified', email: 'jamie.doe@example.com' }, root);
  assert.ok(!readFileSync(b.result.file, 'utf8').includes('jamie.doe'));
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['macaria_log_request'] });
  const l = await rt.call('macaria_log_request', { email: 'jamie.doe@example.com', received: '2026-11-10', regime: 'gdpr' });
  assert.equal(l.status, 'executed'); assert.ok(!readFileSync(l.result.file, 'utf8').includes('jamie.doe'));
  assert.equal((await rt.call('macaria_delete_records', {})).status, 'blocked');
});
