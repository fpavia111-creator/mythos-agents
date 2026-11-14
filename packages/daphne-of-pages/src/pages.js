import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname, posix } from 'node:path';
import { toCsv, sha256 } from 'mythos-agent-core';

// ---------- a small, dependency-free HTML reader ----------
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decode = (s) => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
const blank = (m) => m.replace(/[^\n]/g, ' ');
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
function parseAttrs(s) {
  const a = {}; let m; ATTR.lastIndex = 0;
  while ((m = ATTR.exec(s || ''))) { const k = m[1].toLowerCase(); if (!(k in a)) a[k] = decode(m[2] ?? m[3] ?? m[4] ?? ''); }
  return a;
}
/** Parse HTML into a light element tree. Comments, scripts, styles and templates are skipped; positions are kept. */
export function parseHtml(html) {
  const src = String(html).replace(/<!--[\s\S]*?-->/g, blank).replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, blank);
  const root = { name: '#root', attrs: {}, children: [], pos: 0 };
  const stack = [root]; const all = [];
  const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
  let last = 0; let m;
  const text = (s) => { if (s) stack[stack.length - 1].children.push({ text: decode(s) }); };
  while ((m = TAG.exec(src))) {
    text(src.slice(last, m.index)); last = TAG.lastIndex;
    const name = m[2].toLowerCase();
    if (m[1]) {
      const i = stack.map((n) => n.name).lastIndexOf(name);
      if (i > 0) { for (let j = stack.length - 1; j >= i; j--) stack[j].end = m.index; stack.length = i; }
      continue;
    }
    const el = { name, attrs: parseAttrs(m[3]), children: [], pos: m.index, tagEnd: TAG.lastIndex, raw: m[0], parent: stack[stack.length - 1] };
    stack[stack.length - 1].children.push(el); all.push(el);
    if (!VOID.has(name) && !m[4]) stack.push(el);
  }
  text(src.slice(last));
  return { root, all, src };
}
export function textOf(el) {
  if (el.text !== undefined) return el.text;
  if (el.name === 'img' || (el.name === 'input' && el.attrs.type === 'image')) return el.attrs.alt || '';
  if (el.attrs && (el.attrs['aria-hidden'] === 'true')) return '';
  return (el.children || []).map(textOf).join(' ');
}
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
export const accessibleName = (el) => clean(el.attrs['aria-label']) || (el.attrs['aria-labelledby'] ? '(aria-labelledby)' : '') || clean(textOf(el)) || clean(el.attrs.title);
const lineAt = (src, pos) => src.slice(0, pos).split('\n').length;
const ancestor = (el, name) => { for (let p = el.parent; p; p = p.parent) if (p.name === name) return p; return null; };

// ---------- the checks ----------
/** WCAG 2.2 success criteria these automated checks map to. A mapping, not a conformance claim. */
export const CHECKS = {
  broken_link: { category: 'links', severity: 'error', fix: 'Point the link at a page that exists, or remove it.' },
  broken_anchor: { category: 'links', severity: 'error', fix: 'Add the target id, or fix the #fragment.' },
  broken_image: { category: 'links', severity: 'error', fix: 'Fix the image path or add the file.' },
  javascript_link: { category: 'links', severity: 'warning', wcag: '2.1.1', fix: 'Use a real link (href to a URL) or a button.' },
  empty_href: { category: 'links', severity: 'warning', fix: 'Give the link a destination, or use a button.' },
  title_missing: { category: 'seo', severity: 'error', wcag: '2.4.2', fix: 'Add a unique, descriptive <title>.' },
  title_length: { category: 'seo', severity: 'warning', fix: 'Keep the title between 10 and 60 characters so it is not cut off in results.' },
  duplicate_title: { category: 'seo', severity: 'warning', wcag: '2.4.2', fix: 'Give each page its own title.' },
  meta_description_missing: { category: 'seo', severity: 'warning', fix: 'Add a meta description (about 50–160 characters) a person has written.' },
  meta_description_length: { category: 'seo', severity: 'advisory', fix: 'Aim for about 50–160 characters.' },
  duplicate_description: { category: 'seo', severity: 'warning', fix: 'Give each page its own description.' },
  h1_missing: { category: 'seo', severity: 'warning', fix: 'Add one <h1> that says what the page is.' },
  multiple_h1: { category: 'seo', severity: 'advisory', fix: 'Consider one <h1> per page.' },
  noindex: { category: 'seo', severity: 'warning', fix: 'Confirm the page is meant to be hidden from search engines.' },
  canonical_missing: { category: 'seo', severity: 'advisory', fix: 'Add <link rel="canonical"> if the page is reachable at more than one URL.' },
  viewport_missing: { category: 'seo', severity: 'warning', wcag: '1.4.10', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.' },
  html_lang_missing: { category: 'accessibility', severity: 'error', wcag: '3.1.1', fix: 'Set the page language, for example <html lang="en">.' },
  img_alt_missing: { category: 'accessibility', severity: 'error', wcag: '1.1.1', fix: 'Add alt text a person writes; use alt="" only if the image is decorative.' },
  input_label_missing: { category: 'accessibility', severity: 'error', wcag: '1.3.1, 4.1.2', fix: 'Add a <label for>, wrap the field in a label, or add aria-label.' },
  link_name_missing: { category: 'accessibility', severity: 'error', wcag: '2.4.4, 4.1.2', fix: 'Give the link visible text, or an aria-label on an icon link.' },
  button_name_missing: { category: 'accessibility', severity: 'error', wcag: '4.1.2', fix: 'Give the button text or an aria-label.' },
  link_text_vague: { category: 'accessibility', severity: 'advisory', wcag: '2.4.4', fix: 'Say where the link goes ("Read the pricing guide", not "click here").' },
  heading_skip: { category: 'accessibility', severity: 'advisory', wcag: '1.3.1', fix: 'Do not skip heading levels (an h2 followed by an h4).' },
  iframe_title_missing: { category: 'accessibility', severity: 'error', wcag: '4.1.2', fix: 'Add a title that says what the frame contains.' },
  positive_tabindex: { category: 'accessibility', severity: 'warning', wcag: '2.4.3', fix: 'Use tabindex="0" or remove it, and order the page in the source instead.' },
  zoom_disabled: { category: 'accessibility', severity: 'error', wcag: '1.4.4', fix: 'Remove user-scalable=no and maximum-scale below 2 from the viewport.' },
  meta_refresh: { category: 'accessibility', severity: 'warning', wcag: '2.2.1', fix: 'Use a server redirect, or let people control the timing.' },
  autoplay_media: { category: 'accessibility', severity: 'advisory', wcag: '1.4.2', fix: 'Do not autoplay sound; if it must autoplay, mute it and give a pause control.' },
  duplicate_id: { category: 'markup', severity: 'warning', fix: 'Make ids unique so labels, anchors and ARIA references point at one element.' },
};
const VAGUE = /^(click here|here|read more|more|learn more|this|link|this link|go)$/i;

export function listSite(dir) {
  const out = [];
  const walk = (d) => { for (const f of readdirSync(d).sort()) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) { if (!/^(\.|node_modules$|mythos-out$)/.test(f)) walk(p); } else out.push(relative(dir, p).split('\\').join('/')); } };
  walk(dir); return out;
}
const isPage = (f) => /\.html?$/i.test(f);

/** Resolve an href/src against a page path inside the site. Returns { kind, target, fragment }. */
export function resolveRef(ref, pagePath, files, baseHost) {
  const raw = String(ref ?? '').trim();
  if (raw === '') return { kind: 'empty' };
  if (/^javascript:/i.test(raw)) return { kind: 'javascript' };
  if (/^(mailto|tel|sms|data):/i.test(raw)) return { kind: 'other' };
  let path = raw; let fragment = '';
  const h = path.indexOf('#'); if (h >= 0) { fragment = decodeURIComponent(path.slice(h + 1)); path = path.slice(0, h); }
  path = path.replace(/\?.*$/, '');
  if (/^(https?:)?\/\//i.test(path)) {
    let u; try { u = new URL(path, 'https://x.invalid'); } catch { return { kind: 'external', url: raw }; }
    if (!baseHost || u.host.toLowerCase() !== baseHost) return { kind: 'external', url: raw };
    path = u.pathname;
  }
  if (path === '') return { kind: 'internal', target: pagePath, fragment, raw };
  let p; try { p = decodeURIComponent(path); } catch { p = path; }
  p = p.startsWith('/') ? p.slice(1) : posix.join(posix.dirname(pagePath), p);
  p = posix.normalize(p).replace(/^(\.\/)+/, '');
  if (p.startsWith('..')) return { kind: 'internal', target: null, fragment, raw };
  const set = files instanceof Set ? files : new Set(files);
  const cands = p === '.' || p === '' ? ['index.html'] : p.endsWith('/') ? [p + 'index.html'] : [p, p + '.html', p + '/index.html'];
  const hit = cands.find((c) => set.has(c));
  return { kind: 'internal', target: hit || null, fragment, raw, tried: cands[0] };
}

function pageInfo(file, html) {
  const doc = parseHtml(html); const els = doc.all; const issues = [];
  const add = (check, el, detail) => issues.push({ page: file, line: el ? lineAt(doc.src, el.pos) : 1, check, ...CHECKS[check], detail });
  const by = (n) => els.filter((e) => e.name === n);
  const htmlEl = by('html')[0];
  const titleEl = by('title')[0]; const title = titleEl ? clean(textOf(titleEl)) : '';
  const metas = by('meta'); const meta = (n) => metas.find((m) => (m.attrs.name || '').toLowerCase() === n);
  const desc = meta('description'); const description = desc ? clean(desc.attrs.content) : '';
  const viewport = meta('viewport'); const robots = meta('robots');
  const ids = new Map(); for (const e of els) { if (e.attrs.id) ids.set(e.attrs.id, (ids.get(e.attrs.id) || 0) + 1); if (e.name === 'a' && e.attrs.name) ids.set(e.attrs.name, (ids.get(e.attrs.name) || 0) + 1); }

  if (!htmlEl || !String(htmlEl.attrs.lang || '').trim()) add('html_lang_missing', htmlEl, 'The <html> element has no lang attribute.');
  if (!title) add('title_missing', titleEl, 'No <title>, or it is empty.');
  else if (title.length < 10 || title.length > 60) add('title_length', titleEl, `Title is ${title.length} characters: "${title}".`);
  if (!description) add('meta_description_missing', desc, 'No meta description.');
  else if (description.length < 50 || description.length > 160) add('meta_description_length', desc, `Description is ${description.length} characters.`);
  const h1s = by('h1');
  if (!h1s.length) add('h1_missing', null, 'No <h1> on the page.'); else if (h1s.length > 1) add('multiple_h1', h1s[1], `${h1s.length} <h1> elements.`);
  if (robots && /noindex/i.test(robots.attrs.content || '')) add('noindex', robots, 'meta robots contains noindex.');
  if (!els.some((e) => e.name === 'link' && /(^|\s)canonical(\s|$)/i.test(e.attrs.rel || ''))) add('canonical_missing', null, 'No canonical link.');
  if (!viewport) add('viewport_missing', null, 'No meta viewport.');
  else {
    const c = String(viewport.attrs.content || '').toLowerCase();
    const ms = /maximum-scale\s*=\s*([\d.]+)/.exec(c);
    if (/user-scalable\s*=\s*(no|0)\b/.test(c) || (ms && Number(ms[1]) < 2)) add('zoom_disabled', viewport, `Viewport blocks zoom: "${viewport.attrs.content}".`);
  }
  const refresh = metas.find((m) => (m.attrs['http-equiv'] || '').toLowerCase() === 'refresh');
  if (refresh) add('meta_refresh', refresh, `meta refresh "${refresh.attrs.content}".`);

  for (const img of by('img')) {
    if (!('alt' in img.attrs) && img.attrs['aria-hidden'] !== 'true' && !/^(presentation|none)$/i.test(img.attrs.role || '') && !img.attrs['aria-label'] && !img.attrs['aria-labelledby'])
      add('img_alt_missing', img, `<img src="${img.attrs.src || ''}"> has no alt attribute.`);
  }
  const labelFor = new Set(by('label').map((l) => l.attrs.for).filter(Boolean));
  for (const f of els.filter((e) => ['input', 'select', 'textarea'].includes(e.name))) {
    const type = (f.attrs.type || 'text').toLowerCase();
    if (f.name === 'input' && ['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) {
      if (type === 'image' && !clean(f.attrs.alt) && !f.attrs['aria-label']) add('button_name_missing', f, 'Image button has no alt text.');
      if (['submit', 'button', 'reset'].includes(type) && 'value' in f.attrs && !clean(f.attrs.value) && !f.attrs['aria-label']) add('button_name_missing', f, `Empty ${type} button.`);
      continue;
    }
    const named = f.attrs['aria-label'] || f.attrs['aria-labelledby'] || f.attrs.title || (f.attrs.id && labelFor.has(f.attrs.id)) || ancestor(f, 'label');
    if (!named) add('input_label_missing', f, `<${f.name}${f.attrs.name ? ` name="${f.attrs.name}"` : ''}> has no label.`);
  }
  for (const b of by('button')) if (!accessibleName(b)) add('button_name_missing', b, 'Button has no text or aria-label.');
  for (const a of by('a')) {
    if (!('href' in a.attrs)) continue;
    const name = accessibleName(a);
    if (!name) add('link_name_missing', a, `Link to "${a.attrs.href}" has no text.`);
    else if (VAGUE.test(name)) add('link_text_vague', a, `Link text "${name}".`);
  }
  for (const f of by('iframe')) if (!clean(f.attrs.title) && !f.attrs['aria-label']) add('iframe_title_missing', f, `<iframe src="${f.attrs.src || ''}"> has no title.`);
  for (const e of els) if (/^\d+$/.test(e.attrs.tabindex || '') && Number(e.attrs.tabindex) > 0) add('positive_tabindex', e, `<${e.name} tabindex="${e.attrs.tabindex}">.`);
  for (const m of els.filter((e) => (e.name === 'video' || e.name === 'audio') && 'autoplay' in e.attrs && !('muted' in e.attrs))) add('autoplay_media', m, `<${m.name}> autoplays with sound.`);
  let prev = 0;
  for (const h of els.filter((e) => /^h[1-6]$/.test(e.name))) { const lv = Number(h.name[1]); if (prev && lv > prev + 1) add('heading_skip', h, `<h${prev}> is followed by <h${lv}>.`); prev = lv; }
  for (const [id, n] of ids) if (n > 1) add('duplicate_id', els.find((e) => e.attrs.id === id), `id "${id}" is used ${n} times.`);

  const refs = [];
  for (const a of by('a')) if ('href' in a.attrs) refs.push({ el: a, ref: a.attrs.href, kind: 'link' });
  for (const i of by('img')) if (i.attrs.src) refs.push({ el: i, ref: i.attrs.src, kind: 'image' });
  return { file, doc, issues, title, description, ids: new Set(ids.keys()), refs };
}

/** Audit every .html/.htm file under the site folder. */
export function audit(siteDir, a = {}) {
  const files = listSite(siteDir); const set = new Set(files);
  const baseHost = a.base_url ? new URL(a.base_url).host.toLowerCase() : '';
  const pages = files.filter(isPage).map((f) => pageInfo(f, readFileSync(join(siteDir, f), 'utf8')));
  if (!pages.length) throw new Error(`no .html files found under ${a.site || siteDir}`);
  const byFile = new Map(pages.map((p) => [p.file, p]));
  const external = new Map(); const issues = [];
  for (const p of pages) {
    issues.push(...p.issues);
    for (const r of p.refs) {
      const line = lineAt(p.doc.src, r.el.pos);
      const add = (check, detail) => issues.push({ page: p.file, line, check, ...CHECKS[check], detail });
      const res = resolveRef(r.ref, p.file, set, baseHost);
      if (res.kind === 'empty') { if (r.kind === 'link') add('empty_href', 'Link has an empty href.'); continue; }
      if (res.kind === 'javascript') { add('javascript_link', `href="${r.ref}".`); continue; }
      if (res.kind === 'external') { if (!external.has(res.url)) external.set(res.url, []); external.get(res.url).push(p.file); continue; }
      if (res.kind !== 'internal') continue;
      if (!res.target) { add(r.kind === 'image' ? 'broken_image' : 'broken_link', `"${r.ref}" does not resolve to a file in the site folder.`); continue; }
      if (res.fragment && r.kind === 'link') {
        const t = byFile.get(res.target);
        if (t && res.fragment !== 'top' && !t.ids.has(res.fragment)) add('broken_anchor', `"${r.ref}": no id "${res.fragment}" on ${res.target}.`);
      }
    }
  }
  const dup = (key, check, label) => {
    const m = new Map(); for (const p of pages) if (p[key]) { const k = p[key].toLowerCase(); if (!m.has(k)) m.set(k, []); m.get(k).push(p.file); }
    for (const [, fs] of m) if (fs.length > 1) for (const f of fs) issues.push({ page: f, line: 1, check, ...CHECKS[check], detail: `Same ${label} as ${fs.filter((x) => x !== f).join(', ')}.` });
  };
  dup('title', 'duplicate_title', 'title'); dup('description', 'duplicate_description', 'description');
  const ignore = new Set([].concat(a.ignore || []));
  const kept = issues.filter((i) => !ignore.has(i.check));
  const sev = { error: 0, warning: 1, advisory: 2 };
  kept.sort((x, y) => sev[x.severity] - sev[y.severity] || x.page.localeCompare(y.page) || x.line - y.line || x.check.localeCompare(y.check));
  const count = (k) => kept.reduce((o, i) => ((o[i[k]] = (o[i[k]] || 0) + 1), o), {});
  return {
    pages: pages.length, files: files.length, issues: kept.length, by_severity: count('severity'), by_category: count('category'),
    by_page: pages.map((p) => ({ page: p.file, title: p.title, errors: kept.filter((i) => i.page === p.file && i.severity === 'error').length, issues: kept.filter((i) => i.page === p.file).length })),
    external_links: [...external].map(([url, on]) => ({ url, pages: [...new Set(on)] })),
    external_note: 'External links are listed, not fetched. Daphne makes no network calls.',
    items: kept,
    limits: LIMITS,
  };
}
export const LIMITS = 'Automated checks find only part of what WCAG covers. Colour contrast, keyboard use, focus order, captions, reading order and screen-reader behaviour need a person and other tools. This is a technical checklist, not a legal opinion; it does not make a site ADA, WCAG or any other kind of compliant.';

export const FIX_COLUMNS = ['page', 'line', 'category', 'severity', 'check', 'wcag', 'detail', 'suggested_fix', 'owner', 'status'];
export const fixListCsv = (r) => toCsv(r.items.map((i) => ({ ...i, wcag: i.wcag || '', suggested_fix: i.fix, owner: '', status: '' })), FIX_COLUMNS);
export function reportMarkdown(r, siteLabel) {
  const L = [`# Page audit: ${siteLabel}`, '', `${r.pages} page(s), ${r.issues} issue(s): ${Object.entries(r.by_severity).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}.`, '', `> ${r.limits}`, '', '## By page', '', '| Page | Title | Errors | All issues |', '|---|---|---|---|'];
  for (const p of r.by_page) L.push(`| ${p.page} | ${p.title || '—'} | ${p.errors} | ${p.issues} |`);
  L.push('', '## Fix list', '');
  for (const i of r.items) L.push(`- **${i.severity}** \`${i.page}:${i.line}\` ${i.check}${i.wcag ? ` (WCAG ${i.wcag})` : ''}: ${i.detail} ${i.fix}`);
  if (r.external_links.length) { L.push('', '## External links (not checked)', ''); for (const e of r.external_links) L.push(`- ${e.url} (on ${e.pages.join(', ')})`); }
  return L.join('\n') + '\n';
}

/** Mechanical fixes only. Returns { text, applied[] } for one page. Never invents alt text, titles or labels. */
export function mechanicalFixes(html, a = {}) {
  const doc = parseHtml(html); const edits = []; const applied = [];
  const htmlEl = doc.all.find((e) => e.name === 'html');
  if (htmlEl && !String(htmlEl.attrs.lang || '').trim() && a.lang) {
    const raw = htmlEl.raw.replace(/\slang\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/i, '');
    edits.push({ at: htmlEl.pos, len: htmlEl.raw.length, text: raw.replace(/^<html/i, `<html lang="${a.lang}"`) }); applied.push('html_lang_missing');
  }
  const vp = doc.all.find((e) => e.name === 'meta' && (e.attrs.name || '').toLowerCase() === 'viewport');
  if (vp) {
    const c = String(vp.attrs.content || ''); const ms = /maximum-scale\s*=\s*([\d.]+)/i.exec(c);
    if (/user-scalable\s*=\s*(no|0)\b/i.test(c) || (ms && Number(ms[1]) < 2)) {
      const nc = c.split(',').map((x) => x.trim()).filter((x) => x && !/^(user-scalable|maximum-scale)\s*=/i.test(x)).join(', ');
      edits.push({ at: vp.pos, len: vp.raw.length, text: `<meta name="viewport" content="${nc || 'width=device-width, initial-scale=1'}">` }); applied.push('zoom_disabled');
    }
  } else {
    const head = doc.all.find((e) => e.name === 'head');
    if (head) { edits.push({ at: head.tagEnd, len: 0, text: '\n  <meta name="viewport" content="width=device-width, initial-scale=1">' }); applied.push('viewport_missing'); }
  }
  for (const e of doc.all) if (/^\d+$/.test(e.attrs.tabindex || '') && Number(e.attrs.tabindex) > 0) {
    edits.push({ at: e.pos, len: e.raw.length, text: e.raw.replace(/tabindex\s*=\s*("\d+"|'\d+'|\d+)/i, 'tabindex="0"') }); applied.push('positive_tabindex');
  }
  let text = String(html);
  for (const e of edits.sort((x, y) => y.at - x.at)) text = text.slice(0, e.at) + e.text + text.slice(e.at + e.len);
  return { text, applied };
}
export const MECHANICAL = ['html_lang_missing', 'zoom_disabled', 'viewport_missing', 'positive_tabindex'];
export { sha256 };
