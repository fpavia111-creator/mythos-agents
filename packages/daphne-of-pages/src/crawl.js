// sitemap.xml and robots.txt consistency, read from the site folder (never fetched).

/** Parse robots.txt into groups [{ agents:[], rules:[{allow, path}] }] and sitemap URLs. */
export function parseRobots(text) {
  const groups = []; const sitemaps = []; let cur = null; let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim(); if (!line) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(); const v = line.slice(i + 1).trim();
    if (k === 'user-agent') { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (k === 'sitemap') { sitemaps.push(v); continue; }
    if (!cur) continue;
    if (k === 'allow' || k === 'disallow') cur.rules.push({ allow: k === 'allow', path: v });
  }
  return { groups, sitemaps };
}
const ruleRe = (p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$').replace(/\$$/, '$'));
/** Google-style evaluation: the most specific (longest) matching rule wins; Allow wins a tie. */
export function robotsAllows(robots, path, agent = '*') {
  const a = agent.toLowerCase();
  const group = robots.groups.find((g) => g.agents.includes(a)) || robots.groups.find((g) => g.agents.includes('*'));
  if (!group) return { allowed: true };
  let best = null;
  for (const r of group.rules) {
    if (!r.path) continue; // "Disallow:" with no path allows everything
    if (!ruleRe(r.path).test(path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? { allowed: best.allow, rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` } : { allowed: true };
}

/** <loc> entries of a sitemap (urlset); a sitemap index returns its child sitemaps separately. */
export function parseSitemap(xml) {
  const s = String(xml || '');
  const locs = [...s.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
  return /<sitemapindex\b/i.test(s) ? { urls: [], children: locs } : { urls: locs, children: [] };
}

/** URL path a page file is served at: index.html -> folder/, other.html -> /other.html. */
export const pagePath = (file) => '/' + file.replace(/(^|\/)index\.html?$/i, '$1');

/** Map a sitemap URL path to a page file in the site, or null. */
export function fileForPath(path, files) {
  let p = decodeURIComponent(path.replace(/[?#].*$/, '')).replace(/^\//, '');
  const c = p === '' || p.endsWith('/') ? [p + 'index.html', p + 'index.htm'] : [p, p + '.html', p + '/index.html'];
  return c.find((x) => files.has(x)) || null;
}

/**
 * Compare pages, sitemap and robots.txt. pages: [{ file, noindex, canonical }].
 * Returns [{ check, page, detail }] and a summary.
 */
export function crawlIssues({ pages, files, sitemapXml, robotsTxt, baseUrl, sitemapName = 'sitemap.xml' }) {
  const out = []; const add = (check, page, detail) => out.push({ check, page, detail });
  const fileSet = files instanceof Set ? files : new Set(files);
  const robots = robotsTxt === null ? null : parseRobots(robotsTxt);
  const sm = sitemapXml === null ? null : parseSitemap(sitemapXml);
  let host = baseUrl ? new URL(baseUrl).host.toLowerCase() : '';
  if (!host && sm && sm.urls[0]) { try { host = new URL(sm.urls[0]).host.toLowerCase(); } catch { /* relative loc */ } }
  const inSitemap = new Map();
  if (sm) {
    if (sm.children.length) add('sitemap_index_not_followed', sitemapName, `${sitemapName} is a sitemap index with ${sm.children.length} child sitemap(s); only files in the site folder are read, child sitemaps are not fetched.`);
    for (const loc of sm.urls) {
      let u; try { u = new URL(loc, baseUrl || 'https://x.invalid'); } catch { add('sitemap_bad_url', sitemapName, `"${loc}" is not a valid URL.`); continue; }
      if (host && u.host.toLowerCase() !== host && !/x\.invalid$/.test(u.host)) { add('sitemap_other_host', sitemapName, `"${loc}" is on ${u.host}, not ${host}.`); continue; }
      const f = fileForPath(u.pathname, fileSet);
      if (!f) { add('sitemap_dead_url', sitemapName, `"${loc}" does not match any page in the site folder.`); continue; }
      inSitemap.set(f, loc);
      if (robots) { const r = robotsAllows(robots, u.pathname); if (!r.allowed) add('sitemap_url_blocked', f, `Listed in ${sitemapName} but blocked by robots.txt (${r.rule}).`); }
    }
  }
  for (const p of pages) {
    if (/(^|\/)(404|500)\.html?$/i.test(p.file)) continue;
    const path = pagePath(p.file);
    const blocked = robots ? robotsAllows(robots, path) : { allowed: true };
    if (p.noindex) { if (inSitemap.has(p.file)) add('sitemap_lists_noindex', p.file, `Listed in ${sitemapName} but the page says noindex.`); continue; }
    if (p.canonicalOther) { if (inSitemap.has(p.file)) add('sitemap_lists_non_canonical', p.file, `Listed in ${sitemapName} but its canonical points at ${p.canonicalOther}.`); continue; }
    if (!blocked.allowed && !inSitemap.has(p.file)) add('robots_blocks_page', p.file, `${path} is blocked by robots.txt (${blocked.rule}) and has no noindex: check it is meant to be hidden.`);
    if (sm && !inSitemap.has(p.file) && blocked.allowed) add('sitemap_missing_page', p.file, `${path} is indexable but not in ${sitemapName}.`);
  }
  if (robots && sm && !robots.sitemaps.length) add('robots_no_sitemap', 'robots.txt', 'robots.txt has no Sitemap: line.');
  if (robots && robots.groups.some((g) => g.agents.includes('*') && g.rules.some((r) => !r.allow && r.path === '/'))) add('robots_blocks_all', 'robots.txt', 'robots.txt disallows the whole site for every crawler (Disallow: /).');
  return { issues: out, sitemap_urls: sm ? sm.urls.length : null, sitemap_pages_matched: inSitemap.size, robots_groups: robots ? robots.groups.length : null };
}
