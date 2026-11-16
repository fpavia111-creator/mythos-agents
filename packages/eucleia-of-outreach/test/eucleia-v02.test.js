import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv, validate, validateIcs, readAudit, sha256 } from 'mythos-agent-core';
import { manifest, CONFIG_SCHEMA, checkDraft, checkBatch, inWindow, nextWindow, suppressionSet, spamHits, placeholders, parseEspExport, detectFormat, planSchedule, scheduleIcs } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const cfg = JSON.parse(readFileSync(join(fixtures, 'eucleia.json'), 'utf8'));
const recs = (f) => parseCsv(readFileSync(join(fixtures, f), 'utf8'));
const sandbox = () => { const root = mkdtempSync(join(tmpdir(), 'eucleia-v02-')); cpSync(fixtures, root, { recursive: true }); return root; };
const good = { to: 'a@b.example', subject: 'Quick idea', body: 'Hi there.', send_at: '2026-11-17T15:00:00Z' };

test('a config change moves the window (days, hours, zone, several windows)', () => {
  const at = '2026-11-16T10:00:00Z'; // Mon 10:00 London, Mon 04:00 Chicago
  assert.equal(inWindow(at, {}).ok, false);
  assert.equal(inWindow(at, { days: ['Mon'], start_hour: 9, end_hour: 12, time_zone: 'Europe/London' }).ok, true);
  assert.equal(inWindow(at, { days: ['Mon'], start_hour: 9, end_hour: 12, time_zone: 'America/New_York' }).ok, false);
  const multi = { windows: [{ days: ['Tue'], start_hour: 8, end_hour: 10 }, { days: ['Thu'], start_hour: 13, end_hour: 15 }] };
  assert.equal(inWindow('2026-11-17T15:00:00Z', multi).ok, true);   // Tue 9:00 CST
  assert.equal(inWindow('2026-11-17T17:00:00Z', multi).ok, false);  // Tue 11:00 CST
  assert.equal(inWindow('2026-11-19T19:30:00Z', multi).ok, true);   // Thu 13:30 CST
  assert.equal(nextWindow('2026-11-17T17:00:00Z', multi), '2026-11-19T19:00:00.000Z');
  assert.equal(checkDraft({ ...good, send_at: at }, { config: { ...cfg, days: ['Mon'], start_hour: 9, end_hour: 12, time_zone: 'Europe/London' } }).ok, true);
});

test('DST boundaries are handled (America/Chicago and Europe/London, both directions)', () => {
  // Chicago falls back on 2026-11-01: Tue 8:00 is 13:00Z before and 14:00Z after.
  assert.equal(nextWindow('2026-10-26T12:00:00Z'), '2026-10-27T13:00:00.000Z');
  assert.equal(nextWindow('2026-10-29T12:00:00Z'), '2026-11-03T14:00:00.000Z');
  assert.equal(inWindow('2026-11-03T13:30:00Z').ok, false); // 7:30 CST
  // Chicago springs forward on 2027-03-14: Tue 8:00 is 14:00Z before, 13:00Z after.
  assert.equal(nextWindow('2027-03-08T00:00:00Z'), '2027-03-09T14:00:00.000Z');
  assert.equal(nextWindow('2027-03-11T00:00:00Z'), '2027-03-16T13:00:00.000Z');
  // London falls back on 2026-10-25: Mon 9:00 is 08:00Z before, 09:00Z after.
  const ldn = { days: ['Mon'], start_hour: 9, end_hour: 17, time_zone: 'Europe/London' };
  assert.equal(nextWindow('2026-10-18T00:00:00Z', ldn), '2026-10-19T08:00:00.000Z');
  assert.equal(nextWindow('2026-10-20T00:00:00Z', ldn), '2026-10-26T09:00:00.000Z');
  // A window on the fall-back Sunday itself: 1:00-2:00 local happens twice; both are in.
  const sun = { days: ['Sun'], start_hour: 1, end_hour: 2 };
  assert.equal(inWindow('2026-11-01T06:30:00Z', sun).ok, true); // 1:30 CDT
  assert.equal(inWindow('2026-11-01T07:30:00Z', sun).ok, true); // 1:30 CST
});

test('blackout dates and recipient time zones', () => {
  assert.equal(inWindow('2026-11-25T15:00:00Z', cfg).ok, false);
  assert.match(inWindow('2026-11-25T15:00:00Z', cfg).reason, /blackout/);
  assert.equal(nextWindow('2026-11-24T23:30:00Z', cfg), '2026-12-01T14:00:00.000Z');
  const tokyo = checkDraft({ ...good, send_at: '2026-11-17T15:00:00Z', time_zone: 'Asia/Tokyo' }, { config: cfg });
  assert.equal(tokyo.ok, false); assert.match(tokyo.fails.join(), /Asia\/Tokyo/);
  assert.equal(tokyo.next_window, '2026-11-17T23:00:00.000Z');
  assert.match(checkDraft({ ...good, time_zone: 'Mars/Olympus' }, { config: cfg }).fails.join(), /not a known IANA/);
});

test('spam words are cited with field, position and snippet; policy can hold', () => {
  const h = spamHits({ subject: 'Act now', body: 'Totally free. Freedom is not a hit.' });
  assert.deepEqual(h.map((x) => [x.phrase, x.field, x.index]), [['free', 'body', 8], ['act now', 'subject', 0]]);
  assert.match(h[0].snippet, /Totally free/);
  const d = { ...good, body: 'Guaranteed savings, click here.' };
  const warn = checkDraft(d, { config: cfg });
  assert.equal(warn.ok, true); assert.ok(warn.warns.some((w) => /spam word: "guaranteed" in body at 0/.test(w)));
  const hold = checkDraft(d, { config: { ...cfg, spam_policy: 'hold', spam_words: ['savings'] } });
  assert.equal(hold.ok, false); assert.ok(hold.fails.some((f) => /"savings"/.test(f)));
});

test('link domains are checked against the allowlist; shorteners and raw IPs hold', () => {
  const at = (body, c = cfg) => checkDraft({ ...good, body }, { config: c });
  assert.equal(at('See https://example.com/a and https://docs.example.com/b.').ok, true);
  assert.match(at('See https://example.org/a').fails.join(), /example\.org is not on the link allowlist/);
  assert.match(at('See https://notexample.com/a').fails.join(), /not on the link allowlist/);
  assert.match(at('See https://bit.ly/x').fails.join(), /URL shortener/);
  assert.match(at('See http://192.0.2.10/x').fails.join(), /raw IP/);
  assert.ok(at('See http://example.com/a').warns.some((w) => /not https/.test(w)));
  const noList = { ...cfg }; delete noList.link_allowlist;
  assert.equal(at('See https://example.org/a', noList).ok, true);
  assert.match(checkDraft(good, { config: { ...cfg, unsubscribe: 'https://unsub.other.example/x' } }).fails.join(), /unsubscribe/);
});

test('unfilled placeholders hold the draft', () => {
  assert.deepEqual(placeholders('Hi {{first_name}}, {Company}, *|FNAME|*, %LNAME%, [First Name]'), ['{{first_name}}', '{Company}', '*|FNAME|*', '%LNAME%', '[First Name]']);
  assert.match(checkDraft({ ...good, subject: 'Hi {{ first }}' }, { config: cfg }).fails.join(), /unfilled placeholder/);
  const b = checkBatch(recs('drafts-checks.csv'), { config: cfg, suppression: suppressionSet(recs('suppression.csv')) });
  assert.equal(b.ready, 3); assert.equal(b.held, 4);
});

test('Mailchimp, HubSpot and Resend export fixtures produce identical suppression sets', () => {
  const sets = ['mailchimp-unsubscribed.csv', 'hubspot-contacts.csv', 'resend-contacts.csv'].map((f) => parseEspExport(recs(`esp/${f}`)));
  assert.deepEqual(sets.map((s) => s.format), ['mailchimp', 'hubspot', 'resend']);
  const emails = sets.map((s) => s.entries.map((e) => e.email));
  assert.deepEqual(emails[0], ['dee@juniper.example', 'lou@quartzline.example', 'sam@tallgrass.example']);
  assert.deepEqual(emails[1], emails[0]); assert.deepEqual(emails[2], emails[0]);
  assert.equal(detectFormat([{ foo: 'x' }]), null);
  assert.throws(() => parseEspExport([{ foo: 'x' }]), /could not tell/);
});

test('import adds only new addresses, needs a human yes, and a second ESP adds nothing', async () => {
  const root = sandbox();
  const rt = new AgentRuntime(manifest, { root });
  const args = { suppression: 'suppression.csv', export: 'esp/mailchimp-unsubscribed.csv' };
  const a = await rt.call('eucleia_import_suppression', args);
  assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Dana (fictional)');
  const b = await rt.call('eucleia_import_suppression', args);
  assert.equal(b.status, 'executed'); assert.equal(b.result.added, 3);
  const auto = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['eucleia_import_suppression'] });
  const c = await auto.call('eucleia_import_suppression', { suppression: 'suppression.csv', export: 'esp/hubspot-contacts.csv', format: 'hubspot' });
  assert.equal(c.status, 'executed'); assert.equal(c.result.added, 0); assert.equal(c.result.already, 3);
  const list = recs('suppression.csv').length;
  const after = parseCsv(readFileSync(join(root, 'suppression.csv'), 'utf8'));
  assert.equal(after.length, list + 3);
  assert.equal(after[0].email, 'donotcontact.example', 'existing entries kept');
  const review = new AgentRuntime(manifest, { root, mode: 'review', audit: false });
  assert.equal((await review.call('eucleia_import_suppression', { suppression: 'suppression.csv', export: 'esp/resend-contacts.csv' })).status, 'blocked');
});

test('schedule plan: window per recipient zone, daily cap, gap, blackout, DST; .ics validates; deterministic', () => {
  const drafts = [];
  for (let i = 0; i < 30; i++) drafts.push({ to: `p${i}@d${i}.example`, subject: 'Quick idea', body: 'Hi there.', time_zone: i === 0 ? 'Asia/Tokyo' : '' });
  drafts.push({ to: 'held@x.example', subject: 'Hi {{name}}', body: 'Hi.' });
  const opts = { config: cfg, suppression: new Set(), start_from: '2026-10-26T00:00:00Z', max_per_day: 12, min_gap_minutes: 10 };
  const p = planSchedule(drafts, opts);
  assert.equal(p.scheduled, 30); assert.equal(p.held, 1);
  for (const d of p.days) assert.ok(d.count <= 12);
  const times = p.slots.map((s) => Date.parse(s.send_at)).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 10 * 60000);
  for (const s of p.slots) { const tz = s.to === 'p0@d0.example' ? 'Asia/Tokyo' : 'America/Chicago'; assert.equal(inWindow(s.send_at, cfg, tz).ok, true, s.local); }
  // Before and after the 2026-11-01 DST change, the first Chicago slot is 8:00 local.
  const chi = p.slots.filter((s) => s.local.endsWith('America/Chicago'));
  assert.equal(chi[0].send_at, '2026-10-27T13:00:00.000Z');
  assert.ok(chi.some((s) => s.send_at === '2026-11-03T14:00:00.000Z'));
  assert.ok(!p.slots.some((s) => s.local.includes('2026-11-25')), 'blackout respected');
  const ics = scheduleIcs(p); assert.equal(validateIcs(ics).ok, true); assert.doesNotMatch(ics, /@d\d+\.example/);
  assert.equal(sha256(JSON.stringify(planSchedule(drafts, opts))), sha256(JSON.stringify(p)));
});

test('config schema: three mutated configs fail with JSON-pointer errors; bad zone and inverted hours too', async () => {
  assert.equal(validate(CONFIG_SCHEMA, cfg).ok, true);
  const root = sandbox();
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const bad = {
    unknown: [{ ...cfg, send_days: ['Tue'] }, /\/send_days/],
    wrongType: [{ ...cfg, start_hour: '8' }, /\/start_hour.*integer/],
    missingRequired: [{ ...cfg, windows: [{ days: ['Tue'], start_hour: 8 }] }, /\/windows\/0.*end_hour/],
    badDay: [{ ...cfg, days: ['Tuesday'] }, /\/days\/0/],
    badZone: [{ ...cfg, time_zone: 'America/Chicgo' }, /\/time_zone .*not a known IANA/],
    inverted: [{ ...cfg, start_hour: 17, end_hour: 8 }, /end_hour must be after/],
  };
  for (const [k, [c, want]] of Object.entries(bad)) {
    writeFileSync(join(root, `${k}.json`), JSON.stringify(c));
    const r = await rt.call('eucleia_check_draft', { ...good, config: `${k}.json` });
    assert.equal(r.status, 'error', k);
    assert.match(r.reason + JSON.stringify(r.errors || []), want, k);
  }
});

test('plan and release write hashes to the audit log; release stays one-click; prompt covers the workflow', async () => {
  const root = sandbox();
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['eucleia_import_suppression'] });
  const base = { drafts: 'drafts-checks.csv', config: 'eucleia.json', suppression: 'suppression.csv' };
  const p = await rt.call('eucleia_plan_schedule', { ...base, start_from: '2026-11-16T00:00:00Z' });
  assert.equal(p.status, 'executed', p.reason);
  assert.equal(validateIcs(readFileSync(p.result.files[1], 'utf8')).ok, true);
  const rel = await rt.call('eucleia_release_batch', base);
  assert.equal(rel.status, 'needs_approval'); assert.match(rel.reason, /one-click/);
  new ApprovalStore(join(root, '.mythos')).approve(rel.approval_id, 'Kim (fictional)');
  const done = await rt.call('eucleia_release_batch', base);
  assert.equal(done.status, 'executed');
  const log = readAudit(join(root, '.mythos', 'audit.jsonl'));
  assert.equal(log.find((e) => e.tool === 'eucleia_plan_schedule').output_sha256, p.result.output_sha256);
  assert.equal(log.filter((e) => e.tool === 'eucleia_release_batch' && e.status === 'executed')[0].output_sha256, sha256(readFileSync(done.result.file, 'utf8')));
  assert.equal((await rt.call('eucleia_send_email', {})).status, 'blocked');
  const t = manifest.prompts[0].text;
  for (const k of ['eucleia_import_suppression', 'eucleia_check_batch', 'eucleia_plan_schedule', 'eucleia_prepare_outbox', 'eucleia_release_batch', '{{drafts}}', '{{config}}', 'one named human click', 'not legal advice']) assert.ok(t.includes(k), k);
});

test('schedule: absurd gap, cap or horizon is refused at once; a full-day gap on a large batch still finishes quickly', async () => {
  const good = recs('drafts.csv')[0];
  const opts = { config: cfg, start_from: '2026-11-16T03:07:00Z' };
  for (const bad of [{ min_gap_minutes: 1e308 }, { min_gap_minutes: 0 }, { min_gap_minutes: 1.5 }, { min_gap_minutes: 1441 }, { max_per_day: 1e308 }, { max_per_day: 0 }, { horizon_days: 1e9 }]) {
    const t0 = Date.now(); assert.throws(() => planSchedule([good], { ...opts, ...bad }), /must be/, JSON.stringify(bad)); assert.ok(Date.now() - t0 < 500);
  }
  const root = sandbox(); const rt = new AgentRuntime(manifest, { root, mode: 'auto' });
  const r = await rt.call('eucleia_plan_schedule', { drafts: 'drafts-checks.csv', config: 'eucleia.json', suppression: 'suppression.csv', start_from: '2026-11-16T00:00:00Z', min_gap_minutes: 1e308 });
  assert.equal(r.status, 'error'); assert.match(r.reason, /min_gap_minutes must be <= 1440/);
  const many = Array.from({ length: 400 }, (_, i) => ({ ...good, to: `person${i}@example.com` }));
  const t0 = Date.now(); const p = planSchedule(many, { ...opts, min_gap_minutes: 1440, max_per_day: 100000 });
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.equal(p.scheduled + p.unplaced + p.held, 400); assert.ok(p.scheduled >= 1);
  const at = p.slots.map((s) => Date.parse(s.send_at)).sort((a, b) => a - b);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 1440 * 60000, 'slots are at least a day apart');
});
