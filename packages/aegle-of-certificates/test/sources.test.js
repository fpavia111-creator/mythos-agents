// Real-export adapters: sample exports in fixtures/exports are recognised and
// mapped onto Aegle's own columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const scan = async (args, root = fixtures) => {
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('aegle_scan', { as_of: '2026-11-14', ...args });
  assert.equal(r.status, 'executed', r.reason);
  return r;
};
const item = (r, name) => r.result.items.find((i) => i.name === name);

test('native inventory and COI files are read untouched', async () => { assert.equal((await scan({ certificates: 'certificates.csv', cois: 'cois.csv', requirements: 'requirements.csv' })).sources, undefined); });

test('AWS Certificate Manager list: ids from the ARN, key from KeyAlgorithm, auto-renew only when Amazon-issued and eligible', async () => {
  const r = await scan({ certificates: 'exports/acm-list-certificates.json' });
  const s = r.sources[0]; assert.equal(s.profile, 'aws_acm'); assert.equal(s.rows, 3); assert.equal(s.skipped_rows, 1, 'the pending certificate has no expiry yet'); assert.deepEqual(s.warnings, []);
  const shop = item(r, 'shop.example.com'); assert.equal(shop.id, '11111111-aaaa-4bbb-8ccc-000000000001'); assert.equal(shop.type, 'tls', 'the file\'s own Type column does not replace the mapped type');
  assert.equal(shop.expires, '2026-11-20'); assert.equal(shop.auto_renew, true); assert.equal(shop.issuer, 'Amazon');
  const api = item(r, 'api.example.com'); assert.equal(api.auto_renew, false); assert.ok(api.flags.includes('weak_key_RSA_1024'));
  assert.equal(item(r, 'edge.example.com').expires, '2027-05-31', 'epoch seconds from AWS CLI v1'); assert.equal(item(r, 'edge.example.com').auto_renew, false, 'Amazon-issued but not eligible');
  assert.match(s.note, /imported certificates do not renew by themselves/);
});

test('an owner can be set for the whole file in mythos-sources.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aegle-src-')); cpSync(fixtures, root, { recursive: true });
  writeFileSync(join(root, 'mythos-sources.json'), JSON.stringify({ files: { 'exports/acm-list-certificates.json': { set: { owner: 'Web team' } } } }));
  const r = await scan({ certificates: 'exports/acm-list-certificates.json' }, root);
  assert.ok(r.result.items.every((i) => i.owner === 'Web team' && !i.flags.includes('no_owner')));
});

test('crt.sh search: one row per name with the latest expiry, issuer shortened, and the note says what a CT log is', async () => {
  const r = await scan({ certificates: 'exports/crtsh-example.json' });
  const s = r.sources[0]; assert.equal(s.profile, 'crtsh'); assert.equal(s.rows, 2); assert.equal(s.rows_before_grouping, 4);
  assert.equal(item(r, 'shop.example.com').expires, '2026-11-20'); assert.equal(item(r, 'shop.example.com').issuer, 'Example Public CA (Example Issuing CA 1)');
  assert.equal(item(r, 'api.example.com').id, 'crtsh:api.example.com');
  assert.match(s.note, /not what is installed/);
});

test('a registrar or spreadsheet export with other column names, in a day-first locale, compared with an earlier snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aegle-src-'));
  writeFileSync(join(root, 'before.csv'), 'Cert ID;Kind;Domain Name;Registrar;Expiry Date;Auto-Renew;Annual Cost;Team\nD-1;domain;example.com;Example Registrar;05/12/2026;no;24,99;Ops\nD-2;domain;example.org;Example Registrar;20/01/2027;yes;19,00;Ops\n');
  writeFileSync(join(root, 'after.csv'), 'Cert ID;Kind;Domain Name;Registrar;Expiry Date;Auto-Renew;Annual Cost;Team\nD-1;domain;example.com;Example Registrar;05/12/2027;no;24,99;Ops\nD-2;domain;example.org;Example Registrar;20/01/2027;yes;19,00;Ops\n');
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const d = await rt.call('aegle_diff_inventory', { previous: 'before.csv', certificates: 'after.csv', as_of: '2026-11-14' });
  assert.equal(d.status, 'executed', d.reason); assert.deepEqual(d.sources.map((s) => [s.arg, s.dates_read_as]), [['previous', 'day/month/year'], ['certificates', 'day/month/year']]);
  assert.deepEqual(d.result.changes.map((c) => [c.id, c.change]), [['D-1', 'renewed']]);
  const s = await scan({ certificates: 'after.csv' }, root); assert.equal(s.result.items.find((i) => i.id === 'D-1').renewal_cost, 24.99); assert.equal(s.result.items.find((i) => i.id === 'D-2').auto_renew, true);
});

test('a COI tracker export with other column names maps by the "also called" list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aegle-src-')); cpSync(fixtures, root, { recursive: true });
  writeFileSync(join(root, 'tracker.csv'), 'Insured Name,Type of Insurance,Each Occurrence,Policy Expiration,Addl Insd,Subr Wvd,Certificate Number\n"Acme Plumbing (fictional)",general_liability,"$1,000,000",03/01/2027,Y,Y,COI-1\n"Bright Electric (fictional)",general_liability,"$500,000",02/01/2027,N,N,COI-2\n');
  const r = await scan({ cois: 'tracker.csv', requirements: 'requirements.csv' }, root);
  const s = r.sources[0]; assert.equal(s.kind, 'cois'); assert.equal(s.mapped.limit, 'Each Occurrence');
  const v = Object.fromEntries(r.result.vendors.map((x) => [x.vendor, x.status])); assert.equal(v['Bright Electric (fictional)'], 'gaps');
});
