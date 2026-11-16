import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, applyUnifiedDiff, validate } from 'mythos-agent-core';
import { manifest, audit, parseHtml, parseColor, contrastRatio, parseCss, parseSelector, matches, cssPath, focusOutlineRemovals, ariaIssues, accessibleName, parseRobots, robotsAllows, parseSitemap, crawlIssues, topActions, CHECKS } from '../src/index.js';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(pkgDir, 'fixtures');
const shop = join(fixtures, 'shop');
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'daphne-v2-')); cpSync(fixtures, r, { recursive: true }); return r; };
const rtFor = (root, o = {}) => new AgentRuntime(manifest, { root, audit: false, stateDir: join(root, '.mythos'), ...o });
const at = (r, check) => r.items.filter((i) => i.check === check).map((i) => `${i.page}|${i.selector}`);
const pageAudit = (html, files = {}) => {
  const d = mkdtempSync(join(tmpdir(), 'daphne-one-'));
  writeFileSync(join(d, 'index.html'), html); for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v);
  return audit(d, {});
};

test('colour maths and CSS parsing', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('rgb(0, 0, 0)'), { r: 0, g: 0, b: 0, a: 1 });
  assert.equal(parseColor('rgba(0,0,0,0.5)').a, 0.5); assert.equal(parseColor('var(--x)'), null); assert.equal(parseColor('grey').r, 128);
  assert.equal(contrastRatio(parseColor('#000'), parseColor('#fff')).toFixed(1), '21.0');
  assert.equal(contrastRatio(parseColor('#767676'), parseColor('#fff')).toFixed(2), '4.54');
  const rules = parseCss('/* c */ a, .b > p { color: red } @media (min-width: 1px) { #x { color: blue } } a:hover { color: green }');
  assert.deepEqual(rules.map((r) => [r.selector, r.pseudo]), [['a', false], ['.b > p', false], ['#x', false], ['a:hover', true]]);
  assert.equal(parseSelector('div + p'), null, 'sibling combinators are not supported and never match');
  const d = parseHtml('<div class="b"><p id="x">t</p></div>'); const p = d.all.find((e) => e.name === 'p');
  assert.ok(matches(p, parseSelector('.b > p'))); assert.ok(matches(p, parseSelector('div p#x'))); assert.ok(!matches(p, parseSelector('section p')));
  assert.equal(cssPath(p), 'p#x');
});

test('contrast from static CSS: seeded failures flagged with selectors; large text and skips', () => {
  const r = audit(shop, { base_url: 'https://shop.example.com' });
  assert.deepEqual(at(r, 'contrast_low').sort(), ['about.html|body > p.muted', 'cart.html|body > p.muted', 'index.html|body > main > a.btn-primary', 'index.html|body > p.muted', 'private/index.html|body > p.muted', 'products.html|body > p.muted']);
  const btn = r.items.find((i) => i.check === 'contrast_low' && i.selector.includes('btn-primary'));
  assert.equal(btn.wcag, '1.4.3'); assert.equal(btn.ratio, 2.14); assert.match(btn.detail, /#ffffff on #7fb3ff/);
  assert.ok(!r.items.some((i) => i.check === 'contrast_low' && /hero|h1/.test(i.selector)), '#767676 at 4.54:1 passes');
  assert.equal(r.contrast.elements_skipped, 1, 'text on a background image is skipped, not guessed');
  // Large text gets 3:1; inline style wins; print-only rules are ignored.
  const big = pageAudit('<html lang="en"><body><h1 style="color:#949494">Big heading</h1><p style="color:#949494">Small text</p></body></html>');
  assert.deepEqual(at(big, 'contrast_low'), ['index.html|body > p']);
  const css = pageAudit('<html lang="en"><head><link rel="stylesheet" href="s.css"><style>.x{color:#aaa !important}</style></head><body><p class="x" style="color:#000">Text</p><p class="y">Y</p></body></html>', { 's.css': '.y { color: #000; background: #111 }' });
  assert.deepEqual(at(css, 'contrast_low').sort(), ['index.html|body > p.x', 'index.html|body > p.y'], '!important beats inline; linked stylesheet read');
});

test('focus indicator removal and focusable content inside aria-hidden', () => {
  const rules = parseCss('a:focus{outline:none} button:focus{outline:0;box-shadow:0 0 0 3px #00f} .c:focus{outline:none} .c:focus-visible{outline:2px solid}');
  assert.deepEqual(focusOutlineRemovals(rules).map((r) => r.selector), ['a:focus']);
  const r = audit(shop, {});
  assert.equal(at(r, 'focus_outline_removed').length, 5); assert.ok(at(r, 'focus_outline_removed').every((x) => x.endsWith('|a:focus')));
  assert.ok(at(r, 'focusable_in_aria_hidden').includes('index.html|body > div.site-header > a.nav-cart'));
});

test('ARIA misuse: seeded failures flagged with selectors', () => {
  const r = audit(shop, {});
  assert.deepEqual(at(r, 'aria_role_invalid'), ['index.html|body > main > div']);
  assert.deepEqual(at(r, 'aria_role_not_focusable'), ['index.html|body > main > span']);
  assert.deepEqual(at(r, 'aria_reference_missing'), ['index.html|body > main > input']);
  assert.deepEqual(at(r, 'aria_value_invalid'), ['index.html|body > main > button']);
  assert.deepEqual(at(r, 'aria_attr_invalid'), ['index.html|ul#menu > li > a']);
  const d = parseHtml('<body aria-hidden="true"><div role="img"></div><a href="/" role="presentation">x</a><div role="button" tabindex="0">ok</div><nav role="navigation" aria-current="page"></nav></body>');
  const got = ariaIssues(d.all, new Set(), accessibleName).map((x) => x.check).sort();
  assert.deepEqual(got, ['aria_hidden_body', 'aria_img_name_missing', 'aria_presentation_focusable', 'focusable_in_aria_hidden', 'focusable_in_aria_hidden']);
});

test('sitemap and robots consistency', () => {
  const rb = parseRobots('User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /cart\nDisallow: /private/\nAllow: /private/open.html\nDisallow: /*.pdf$\nSitemap: https://x.example.com/sitemap.xml');
  assert.equal(robotsAllows(rb, '/cart.html').allowed, false); assert.equal(robotsAllows(rb, '/private/open.html').allowed, true, 'longest match wins');
  assert.equal(robotsAllows(rb, '/a.pdf').allowed, false); assert.equal(robotsAllows(rb, '/a.pdf?x').allowed, true);
  assert.equal(robotsAllows(rb, '/g', 'googlebot').allowed, false); assert.equal(robotsAllows(rb, '/cart', 'googlebot').allowed, true, 'a named group replaces *');
  assert.deepEqual(parseSitemap('<sitemapindex><sitemap><loc>https://x/s1.xml</loc></sitemap></sitemapindex>').children, ['https://x/s1.xml']);
  const r = audit(shop, { base_url: 'https://shop.example.com' });
  const crawl = r.items.filter((i) => i.category === 'crawl').map((i) => `${i.check}@${i.page}`).sort();
  assert.deepEqual(crawl, ['robots_blocks_page@cart.html', 'robots_no_sitemap@robots.txt', 'sitemap_dead_url@sitemap.xml', 'sitemap_missing_page@about.html', 'sitemap_url_blocked@private/index.html']);
  assert.equal(r.crawl.checked, true); assert.equal(r.crawl.sitemap_urls, 4);
  // noindex pages are expected to be out of the sitemap; listing one is flagged.
  const c = crawlIssues({ pages: [{ file: 'index.html' }, { file: 'hidden.html', noindex: true }], files: new Set(['index.html', 'hidden.html']), sitemapXml: '<urlset><url><loc>https://a.example.com/</loc></url><url><loc>https://a.example.com/hidden.html</loc></url></urlset>', robotsTxt: 'User-agent: *\nDisallow: /\nSitemap: https://a.example.com/sitemap.xml', baseUrl: 'https://a.example.com' });
  assert.deepEqual(c.issues.map((x) => x.check).sort(), ['robots_blocks_all', 'sitemap_lists_noindex', 'sitemap_url_blocked', 'sitemap_url_blocked']);
  // Original site has neither file: checks are skipped and the counts are unchanged.
  const old = audit(join(fixtures, 'site'), {}); assert.equal(old.crawl.checked, false); assert.equal(old.issues, 25);
});

test('fix drafts as one unified diff that applies cleanly to a copy', async () => {
  const root = tmpRoot(); const rt = rtFor(root, { mode: 'auto', autoActions: ['daphne_draft_fixes'] });
  const d = await rt.call('daphne_draft_fixes', { site: 'site', lang: 'en' });
  assert.equal(d.status, 'executed'); assert.match(d.result.output_sha256, /^[0-9a-f]{64}$/);
  const diff = readFileSync(join(root, 'mythos-out/daphne/fixes.diff'), 'utf8');
  assert.match(diff, /^--- a\/contact\.html\n\+\+\+ b\/contact\.html\n@@ /);
  const p = JSON.parse(readFileSync(join(root, 'mythos-out/daphne/proposal.json'), 'utf8'));
  for (const f of p.files) {
    const part = diff.split(/(?=^--- a\/)/m).find((x) => x.startsWith(`--- a/${f.page}\n`));
    const copy = readFileSync(join(root, 'site', f.page), 'utf8');
    assert.equal(applyUnifiedDiff(copy, part), readFileSync(join(root, 'mythos-out/daphne', f.proposed), 'utf8'), `${f.page}: diff reproduces the proposed copy`);
  }
  // Several pages in one diff.
  writeFileSync(join(root, 'site/about.html'), readFileSync(join(root, 'site/about.html'), 'utf8').replace('<html lang="en">', '<html>'));
  const d2 = await rt.call('daphne_draft_fixes', { site: 'site', lang: 'fr', out_dir: 'mythos-out/d2' });
  const diff2 = readFileSync(join(root, 'mythos-out/d2/fixes.diff'), 'utf8');
  assert.equal((diff2.match(/^--- a\//gm) || []).length, 2);
  for (const part of diff2.split(/(?=^--- a\/)/m)) { const page = /^--- a\/(\S+)/.exec(part)[1]; assert.match(applyUnifiedDiff(readFileSync(join(root, 'site', page), 'utf8'), part), /<html lang="fr">/); }
  // Publish refuses a diff edited after the proposal.
  writeFileSync(join(root, 'mythos-out/d2/fixes.diff'), diff2 + '+tampered\n');
  const args = { proposal: d2.result.proposal, proposal_sha256: d2.result.proposal_sha256 };
  const a = await rt.call('daphne_request_publish', args); rt.approvals.approve(a.approval_id, 'Sam');
  const t = await rt.call('daphne_request_publish', args); assert.equal(t.status, 'error'); assert.match(t.reason, /fixes.diff changed/);
});

test('config file: merged under arguments; schema errors fail with JSON pointers', async () => {
  const root = tmpRoot(); const rt = rtFor(root);
  const ok = await rt.call('daphne_audit', { site: 'shop', config: 'daphne.config.json' });
  assert.equal(ok.status, 'executed'); assert.ok(ok.result.top_actions[0].template_likely);
  const ign = await rt.call('daphne_audit', { site: 'shop', config: 'daphne.config.json', ignore: ['contrast_low'] });
  assert.ok(!JSON.stringify(ign.result.items).includes('contrast_low'), 'argument ignore adds to config ignore');
  const good = JSON.parse(readFileSync(join(fixtures, 'daphne.config.json'), 'utf8'));
  const mutated = {
    'unknown-key.json': [{ ...good, wcag_level: 'AA' }, /\/wcag_level is not an allowed property/],
    'wrong-type.json': [{ ...good, contrast: { normal: '4.5', large: 3 } }, /\/contrast\/normal expected number/],
    'missing-required.json': [{ ...good, contrast: { normal: 4.5 } }, /\/contrast\/large is required/],
    'unknown-check.json': [{ ...good, ignore: ['contrast_lo'] }, /\/ignore\/0 must be one of/],
  };
  for (const [name, [doc, re]] of Object.entries(mutated)) {
    writeFileSync(join(root, name), JSON.stringify(doc));
    const r = await rt.call('daphne_audit', { site: 'shop', config: name });
    assert.equal(r.status, 'error', name); assert.match(r.reason, /not a valid audit_config/); assert.match(r.reason, re);
    assert.equal(validate(manifest.configSchemas.audit_config, doc).ok, false);
  }
  assert.equal(validate(manifest.configSchemas.audit_config, good).ok, true);
  const tight = { ...good, contrast: { normal: 7, large: 4.5 }, ignore_pages: ['private/'] };
  writeFileSync(join(root, 'tight.json'), JSON.stringify(tight));
  const t = await rt.call('daphne_audit', { site: 'shop', config: 'tight.json' });
  assert.ok(!t.result.by_page.some((p) => p.page.startsWith('private/'))); assert.ok(t.result.items.some((i) => i.check === 'contrast_low' && /hero/.test(i.selector) === false));
});

test('prioritised actions, HTML report and selector column', async () => {
  const items = [{ check: 'contrast_low', severity: 'error', selector: 'body > p.muted', page: 'a.html', line: 1 }, { check: 'contrast_low', severity: 'error', selector: 'body > p.muted', page: 'b.html', line: 1 }, { check: 'h1_missing', severity: 'warning', selector: '', page: 'a.html', line: 1, detail: 'No <h1>' }];
  const t = topActions(items); assert.equal(t[0].check, 'contrast_low'); assert.ok(t[0].template_likely); assert.deepEqual(t[0].pages, ['a.html', 'b.html']);
  const root = tmpRoot(); const w = await rtFor(root).call('daphne_write_report', { site: 'shop', base_url: 'https://shop.example.com' });
  assert.equal(w.status, 'executed'); assert.match(w.result.output_sha256, /^[0-9a-f]{64}$/);
  const html = readFileSync(w.result.files[2], 'utf8');
  assert.match(html, /default-src 'none'/); assert.doesNotMatch(html, /<script/i); assert.match(html, /Do these first/); assert.match(html, /body &gt; p\.muted/);
  assert.match(readFileSync(w.result.files[1], 'utf8').split('\n')[0], /^page,line,selector,/);
  assert.match(readFileSync(w.result.files[0], 'utf8'), /## Do these first/);
});

test('no claim of WCAG conformance anywhere (code, docs, prompt, outputs)', async () => {
  const root = tmpRoot(); const rt = rtFor(root, { mode: 'auto', autoActions: ['daphne_draft_fixes'] });
  const outs = [];
  for (const site of ['site', 'shop']) {
    outs.push(JSON.stringify(await rt.call('daphne_audit', { site })));
    const w = await rt.call('daphne_write_report', { site, out_dir: `mythos-out/${site}` });
    for (const f of w.result.files) outs.push(readFileSync(f, 'utf8'));
    const d = await rt.call('daphne_draft_fixes', { site, lang: 'en', out_dir: `mythos-out/${site}` });
    for (const f of d.result.files) outs.push(readFileSync(f, 'utf8'));
  }
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const shipped = ['README.md', 'CHANGELOG.md', 'package.json'].map((f) => readFileSync(join(pkgDir, f), 'utf8')).concat(walk(join(pkgDir, 'src')).map((f) => readFileSync(f, 'utf8')));
  const texts = [...outs, ...shipped, JSON.stringify(manifest.prompts), manifest.description, ...manifest.tools.map((t) => t.description)];
  const claim = /(wcag|ada|section 508|en 301 549)[^.\n]{0,40}(conformant|conforms|compliant|certified|passes)|(conformant|compliant|certified) (with|to) (wcag|ada)|makes (your|the|a) site[^.\n]{0,30}(compliant|conformant|accessible)/i;
  const negation = /\b(not|never|no|does not|doesn't|cannot|isn't|without)\b/i;
  for (const t of texts) for (const sentence of t.split(/(?<=[.!?\n])\s+/)) if (claim.test(sentence)) assert.ok(negation.test(sentence), `conformance claim: "${sentence.trim().slice(0, 160)}"`);
  for (const t of Object.values(CHECKS)) assert.doesNotMatch(t.fix, /conform|complian/i);
});

test('MCP prompt walks the workflow; new tools keep the policy', () => {
  const p = manifest.prompts.find((x) => x.name === 'daphne_site_review');
  for (const t of ['daphne_audit', 'daphne_write_report', 'daphne_draft_fixes', 'daphne_request_publish']) assert.ok(p.text.includes(t), t);
  assert.match(p.text, /one named human click/); assert.match(p.text, /not a legal opinion or a conformance claim/); assert.match(p.text, /\{\{site\}\}/);
  assert.equal(manifest.policy.rules.find((r) => r.tool === 'daphne_request_publish').decision, 'ask');
  assert.equal(manifest.policy.rules.find((r) => r.tool === 'http_fetch').decision, 'block');
});
