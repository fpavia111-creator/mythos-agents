import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
import { manifest, audit, parseHtml, textOf, accessibleName, resolveRef, mechanicalFixes } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const site = join(fixtures, 'site');
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const checks = (r, page) => r.items.filter((i) => i.page === page).map((i) => i.check).sort();

test('parser: names, labels, comments and scripts', () => {
  const d = parseHtml('<!-- <a href="x"></a> --><script>var a="<a href=y>"</script><a href="/p"><img src="i.png" alt="Home"></a><a aria-label="Search" href="/s"><svg></svg></a><p>a &amp; b</p>');
  const links = d.all.filter((e) => e.name === 'a');
  assert.equal(links.length, 2); assert.equal(accessibleName(links[0]), 'Home'); assert.equal(accessibleName(links[1]), 'Search');
  assert.match(textOf(d.root), /a & b/);
});
test('link resolution: relative, root, folders, extensionless, own host, external', () => {
  const files = new Set(['index.html', 'about.html', 'blog/index.html', 'blog/post.html']);
  assert.equal(resolveRef('../about.html#x', 'blog/index.html', files).target, 'about.html');
  assert.equal(resolveRef('#x', 'about.html', files).fragment, 'x');
  assert.equal(resolveRef('/blog/', 'about.html', files).target, 'blog/index.html');
  assert.equal(resolveRef('post', 'blog/index.html', files).target, 'blog/post.html');
  assert.equal(resolveRef('https://www.example.com/about.html', 'index.html', files, 'www.example.com').target, 'about.html');
  assert.equal(resolveRef('https://other.example.org/', 'index.html', files, 'www.example.com').kind, 'external');
  assert.equal(resolveRef('../../etc/passwd', 'index.html', files).target, null);
  assert.equal(resolveRef('mailto:a@example.com', 'index.html', files).kind, 'other');
});
test('audit finds the planted issues and leaves the clean page clean', () => {
  const r = audit(site, { base_url: 'https://www.example.com' });
  assert.equal(r.pages, 4); assert.deepEqual(r.by_severity, { error: 11, warning: 7, advisory: 7 });
  assert.deepEqual(checks(r, 'index.html'), []);
  assert.deepEqual(checks(r, 'contact.html'), ['html_lang_missing', 'iframe_title_missing', 'input_label_missing', 'javascript_link', 'positive_tabindex', 'zoom_disabled']);
  assert.ok(checks(r, 'about.html').includes('img_alt_missing') && checks(r, 'about.html').includes('broken_image') && checks(r, 'about.html').includes('heading_skip'));
  assert.deepEqual(checks(r, 'blog/index.html').filter((c) => c.startsWith('broken')), ['broken_anchor', 'broken_link']);
  assert.equal(r.items.find((i) => i.check === 'img_alt_missing').wcag, '1.1.1');
  assert.equal(r.external_links.length, 2); assert.match(r.limits, /not a legal opinion/);
  assert.ok(!r.items.some((i) => i.check === 'img_alt_missing' && i.page === 'blog/index.html'), 'alt="" is decorative, not missing');
  assert.equal(audit(site, { ignore: ['canonical_missing'] }).by_severity.advisory, 5);
});
test('mechanical fixes never invent content', () => {
  const html = '<html><head><meta name="viewport" content="width=device-width, maximum-scale=1, user-scalable=no"></head><body><img src="a.png"><a tabindex="4" href="/">Home</a></body></html>';
  const f = mechanicalFixes(html, { lang: 'en' });
  assert.deepEqual(f.applied.sort(), ['html_lang_missing', 'positive_tabindex', 'zoom_disabled']);
  assert.match(f.text, /<html lang="en">/); assert.match(f.text, /content="width=device-width"/); assert.match(f.text, /tabindex="0"/);
  assert.match(f.text, /<img src="a.png">/, 'no alt text invented');
  assert.deepEqual(mechanicalFixes(html).applied.sort(), ['positive_tabindex', 'zoom_disabled'], 'no lang guessed');
  assert.match(mechanicalFixes('<html lang="en"><head><title>x</title></head></html>').text, /<head>\n  <meta name="viewport"/);
});
test('drafts on Auto; publish is one-click, hash-bound and tamper-checked; deploy blocked', async () => {
  const root = tmpRoot('daphne-');
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['daphne_draft_fixes'] });
  const before = readFileSync(join(root, 'site/contact.html'), 'utf8');
  const d = await rt.call('daphne_draft_fixes', { site: 'site', lang: 'en' }); assert.equal(d.status, 'executed');
  assert.equal(readFileSync(join(root, 'site/contact.html'), 'utf8'), before, 'site untouched');
  const prop = readFileSync(join(root, 'mythos-out/daphne/proposed/contact.html'), 'utf8');
  assert.match(prop, /<html lang="en">/); assert.doesNotMatch(prop, /user-scalable/); assert.match(prop, /tabindex="0"/);
  assert.match(readFileSync(join(root, 'mythos-out/daphne/changes.md'), 'utf8'), /\[TO DO\] `about.html:11` img_alt_missing/);
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['daphne_request_publish'] }), /one-click/);
  const args = { proposal: d.result.proposal, proposal_sha256: d.result.proposal_sha256 };
  const a = await rt.call('daphne_request_publish', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Sam');
  const b = await rt.call('daphne_request_publish', args); assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Sam');
  assert.equal(parseCsv(readFileSync(b.result.file, 'utf8'))[0].status, 'approved - a person publishes it');
  // tamper with a proposed file after approval of a fresh proposal
  const d2 = await rt.call('daphne_draft_fixes', { site: 'site', lang: 'en', out_dir: 'mythos-out/d2' });
  writeFileSync(join(root, 'mythos-out/d2/proposed/contact.html'), 'changed');
  const args2 = { proposal: d2.result.proposal, proposal_sha256: d2.result.proposal_sha256 };
  new ApprovalStore(join(root, '.mythos')).approve((await rt.call('daphne_request_publish', args2)).approval_id, 'Sam');
  const t = await rt.call('daphne_request_publish', args2); assert.equal(t.status, 'error'); assert.match(t.reason, /changed after the proposal/);
  assert.equal((await rt.call('daphne_request_publish', { ...args, proposal_sha256: 'x'.repeat(64) })).status, 'needs_approval');
  assert.equal((await rt.call('deploy_site', {})).status, 'blocked'); assert.equal((await rt.call('http_fetch', {})).status, 'blocked');
});
test('report and fix list', async () => {
  const root = tmpRoot('daphne-r-');
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('daphne_write_report', { site: 'site' });
  const rows = parseCsv(readFileSync(r.result.files[1], 'utf8')); assert.equal(rows.length, 25); assert.equal(rows[0].owner, ''); assert.equal(rows[0].severity, 'error');
  const md = readFileSync(r.result.files[0], 'utf8'); assert.match(md, /not a legal opinion/); assert.match(md, /External links \(not checked\)/);
  assert.ok(existsSync(r.result.files[0]));
});
