import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
import { manifest, scanInventory, checkCois, expiryStatus, calendarIcs, scan, DEFAULTS } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
async function oneClick(tool, args, root) {
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: [tool] }), /one-click/);
  const rt = new AgentRuntime(manifest, { root, mode: 'auto' });
  const a = await rt.call(tool, args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Dana');
  const b = await rt.call(tool, args); assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Dana');
  assert.equal((await rt.call(tool, args)).status, 'needs_approval', 'approval is single-use');
  return b;
}
const as_of = '2026-11-14';

test('expiry status thresholds', () => {
  assert.equal(expiryStatus(-1), 'expired'); assert.equal(expiryStatus(0), 'critical'); assert.equal(expiryStatus(14), 'critical');
  assert.equal(expiryStatus(15), 'warning'); assert.equal(expiryStatus(31), 'upcoming'); assert.equal(expiryStatus(91), 'ok');
  assert.equal(expiryStatus(null), 'no_expiry_date'); assert.equal(expiryStatus(20, { ...DEFAULTS, warn_days: 10 }), 'upcoming');
});
test('TLS and domain flags, sorted most urgent first', () => {
  const items = scanInventory(parseCsv(readFileSync(join(fixtures, 'certificates.csv'), 'utf8')), { as_of });
  assert.deepEqual(items.map((i) => i.id), ['TLS-2', 'TLS-1', 'DOM-1', 'LIC-1', 'TLS-3', 'DOM-2']);
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(by['TLS-2'].flags, ['weak_key_RSA_1024', 'weak_signature']); assert.equal(by['TLS-2'].days_left, -4);
  assert.ok(by['TLS-3'].flags.includes('self_signed') && by['TLS-3'].flags.includes('no_owner'));
  assert.deepEqual(by['DOM-1'].flags, ['registrar_lock_off', 'auto_renew_off']); assert.deepEqual(by['DOM-1'].needs, ['paid_renewal']);
  assert.deepEqual(by['TLS-1'].needs, [], 'auto-renewing cert is a confirm, not a change');
  assert.ok(scanInventory([{ id: 'X', type: 'tls', name: 'a', expires: '' }], { as_of })[0].flags.includes('no_expiry_date'));
  assert.ok(scanInventory([{ id: 'E', type: 'tls', name: 'a', expires: '2027-01-01', key_type: 'EC', key_bits: '224', owner: 'x' }], { as_of })[0].flags.includes('weak_key_EC_224'));
  assert.throws(() => scanInventory([], { as_of: '14/11/2026' }), /as_of/);
});
test('COI gaps against written requirements', () => {
  const v = checkCois(parseCsv(readFileSync(join(fixtures, 'cois.csv'), 'utf8')), parseCsv(readFileSync(join(fixtures, 'requirements.csv'), 'utf8')), { as_of });
  const by = Object.fromEntries(v.map((x) => [x.vendor.split(' ')[0], x]));
  assert.deepEqual(by.Bright.gaps.map((g) => g.issue), ['limit_below_required', 'additional_insured_missing', 'missing_coverage']);
  assert.deepEqual(by.Acme.gaps.map((g) => g.issue), ['expiring']); assert.equal(by.Cedar.status, 'ok');
  const noReq = checkCois([{ vendor: 'Z', coverage: 'general_liability', limit: '1', expires: '2026-01-01' }], [], { as_of });
  assert.deepEqual(noReq[0].gaps.map((g) => g.issue), ['expired'], 'without requirements only expiry is checked');
});
test('calendar file is valid-looking iCalendar with one event per dated item', () => {
  const r = scan({ inventory: [{ id: 'A', type: 'tls', name: 'a.example', expires: '2026-12-01' }], cois: [], requirements: [], as_of });
  const ics = calendarIcs(r);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/); assert.match(ics, /DTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261202/); assert.match(ics, /TRIGGER:-P30D/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
});
test('chase drafts on Auto; renewal, production change and send are one-click; buy/deploy/send blocked', async () => {
  const root = tmpRoot('aegle-');
  const f = { certificates: 'certificates.csv', cois: 'cois.csv', requirements: 'requirements.csv', as_of };
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['aegle_draft_chase'] });
  const d = await rt.call('aegle_draft_chase', f); assert.equal(d.status, 'executed'); assert.equal(d.result.files.length, 2);
  const text = readFileSync(d.result.files.find((x) => x.includes('bright')), 'utf8');
  assert.match(text, /^DRAFT — not sent/); assert.match(text, /below the required 1,000,000/); assert.match(text, /not insurance or legal advice/);
  const s = await oneClick('aegle_request_chase_send', { vendor: 'Bright Electric', draft: 'mythos-out/aegle/chase-drafts/bright-electric-fictional.md', to: 'office@bright.example' }, root);
  assert.match(readFileSync(s.result.file, 'utf8'), /approved - a person sends it/);
  const r = await oneClick('aegle_request_renewal', { id: 'DOM-1', cost: 24.99, reason: 'expiring' }, root);
  assert.equal(parseCsv(readFileSync(r.result.file, 'utf8'))[0].cost, '24.99');
  await oneClick('aegle_request_production_change', { id: 'TLS-2', change: 'install new cert' }, root);
  for (const t of ['purchase_renewal', 'deploy_certificate', 'send_email', 'shell_exec']) assert.equal((await rt.call(t, {})).status, 'blocked', t);
  const rt2 = new AgentRuntime(manifest, { root, mode: 'auto' });
  const missing = await new AgentRuntime(manifest, { root, audit: false }).call('aegle_scan', {});
  assert.equal(missing.status, 'error');
  assert.equal((await rt2.call('aegle_draft_chase', f)).status, 'needs_approval', 'not on Auto unless opted in');
});
test('report writes markdown, CSV with reviewer columns, and ics', async () => {
  const root = tmpRoot('aegle-r-');
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('aegle_write_report', { certificates: 'certificates.csv', cois: 'cois.csv', requirements: 'requirements.csv', as_of });
  assert.equal(r.status, 'executed'); for (const f of r.result.files) assert.ok(existsSync(f));
  const rows = parseCsv(readFileSync(r.result.files[1], 'utf8')); assert.equal(rows.length, 6); assert.equal(rows[0].reviewed_by, '');
  assert.match(readFileSync(r.result.files[0], 'utf8'), /Not insurance or legal advice/);
});
