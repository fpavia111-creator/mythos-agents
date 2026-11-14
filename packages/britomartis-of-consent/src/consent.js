// Britomartis of Consent: an honest inventory of the cookies and third-party requests a site
// sets and makes, compared with what its cookie policy and banner say. Reads exported HTML
// and browser HAR captures. Makes no network calls and changes no files.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

export const LIMITS = 'Britomartis reports what the files you give it show: the HTML you exported and the HAR captures you recorded. Cookies set only on pages or flows you did not capture are not seen. Purposes for undeclared cookies and hosts come from a small built-in list of well-known vendors and are marked as guesses. It is a technical inventory, not legal advice, and it never says a site is GDPR, CCPA/CPRA or ePrivacy compliant.';
export const PURPOSES = ['necessary', 'preferences', 'analytics', 'marketing', 'other'];
const NONESSENTIAL = new Set(['analytics', 'marketing']);

// Heuristic vendor list. Purposes are guesses until your policy declares them.
export const KNOWN_HOSTS = [
  ['google-analytics.com', 'Google Analytics', 'analytics'], ['analytics.google.com', 'Google Analytics', 'analytics'], ['googletagmanager.com', 'Google Tag Manager', 'analytics'],
  ['doubleclick.net', 'Google Ads (DoubleClick)', 'marketing'], ['googlesyndication.com', 'Google AdSense', 'marketing'], ['googleadservices.com', 'Google Ads', 'marketing'],
  ['connect.facebook.net', 'Meta Pixel', 'marketing'], ['facebook.com', 'Meta', 'marketing'], ['hotjar.com', 'Hotjar', 'analytics'], ['clarity.ms', 'Microsoft Clarity', 'analytics'],
  ['bat.bing.com', 'Microsoft Advertising', 'marketing'], ['segment.com', 'Segment', 'analytics'], ['segment.io', 'Segment', 'analytics'], ['ads-twitter.com', 'X Ads', 'marketing'],
  ['licdn.com', 'LinkedIn Insight', 'marketing'], ['ads.linkedin.com', 'LinkedIn Ads', 'marketing'], ['analytics.tiktok.com', 'TikTok Pixel', 'marketing'], ['hs-scripts.com', 'HubSpot', 'marketing'],
  ['hs-analytics.net', 'HubSpot', 'marketing'], ['plausible.io', 'Plausible (cookieless analytics)', 'analytics'], ['youtube.com', 'YouTube', 'marketing'], ['youtube-nocookie.com', 'YouTube (privacy-enhanced)', 'other'],
  ['fonts.googleapis.com', 'Google Fonts', 'other'], ['fonts.gstatic.com', 'Google Fonts', 'other'], ['js.stripe.com', 'Stripe', 'necessary'], ['m.stripe.network', 'Stripe', 'necessary'],
  ['cookielaw.org', 'OneTrust (consent manager)', 'necessary'], ['cookiebot.com', 'Cookiebot (consent manager)', 'necessary'], ['cookieyes.com', 'CookieYes (consent manager)', 'necessary'], ['usercentrics.eu', 'Usercentrics (consent manager)', 'necessary'],
];
const CMP_HOSTS = ['cookielaw.org', 'cookiebot.com', 'cookieyes.com', 'usercentrics.eu'];
export const KNOWN_COOKIES = [
  ['_ga', 'Google Analytics', 'analytics'], ['_ga_*', 'Google Analytics', 'analytics'], ['_gid', 'Google Analytics', 'analytics'], ['_gat*', 'Google Analytics', 'analytics'], ['_gcl_*', 'Google Ads', 'marketing'],
  ['_fbp', 'Meta Pixel', 'marketing'], ['_fbc', 'Meta Pixel', 'marketing'], ['_hj*', 'Hotjar', 'analytics'], ['_clck', 'Microsoft Clarity', 'analytics'], ['_clsk', 'Microsoft Clarity', 'analytics'],
  ['_uetsid', 'Microsoft Advertising', 'marketing'], ['_uetvid', 'Microsoft Advertising', 'marketing'], ['IDE', 'Google Ads (DoubleClick)', 'marketing'], ['test_cookie', 'Google Ads (DoubleClick)', 'marketing'],
  ['hubspotutk', 'HubSpot', 'marketing'], ['__hs*', 'HubSpot', 'marketing'], ['li_*', 'LinkedIn', 'marketing'], ['bcookie', 'LinkedIn', 'marketing'], ['VISITOR_INFO1_LIVE', 'YouTube', 'marketing'], ['YSC', 'YouTube', 'marketing'],
  ['__cf_bm', 'Cloudflare bot management', 'necessary'], ['cf_clearance', 'Cloudflare', 'necessary'], ['__stripe_mid', 'Stripe', 'necessary'], ['__stripe_sid', 'Stripe', 'necessary'], ['OptanonConsent', 'OneTrust', 'necessary'], ['CookieConsent', 'Cookiebot', 'necessary'],
];
const TRACKER_CALLS = [[/\bgtag\s*\(/, 'Google tag (gtag)', 'analytics'], [/\bfbq\s*\(/, 'Meta Pixel (fbq)', 'marketing'], [/_paq\.push/, 'Matomo', 'analytics'], [/\bclarity\s*\(/, 'Microsoft Clarity', 'analytics'], [/\bhj\s*\(/, 'Hotjar', 'analytics'], [/analytics\.load\s*\(/, 'Segment', 'analytics'], [/\bdataLayer\.push\s*\(/, 'Google Tag Manager dataLayer', 'analytics']];
const CLAIMS = [
  [/\bno cookies\b|\b(?:do not|don't|never) (?:use|set) (?:any )?cookies\b/i, 'any_cookie', 'no cookies'],
  [/\bno (?:tracking|advertising|marketing|third[- ]party) cookies\b|\b(?:do not|don't|never) (?:use|set) (?:any )?(?:tracking|advertising|marketing|third[- ]party) cookies\b/i, 'tracking_cookie', 'no tracking cookies'],
  [/\bno (?:trackers|tracking)\b(?! cookies)|\b(?:do not|don't|never) track\b/i, 'tracker', 'no trackers'],
  [/\bno analytics\b|\b(?:do not|don't|never) use (?:any )?analytics\b/i, 'analytics', 'no analytics'],
];

const glob = (p, v) => new RegExp('^' + String(p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(v);
const hostMatch = (pattern, host) => { const p = String(pattern).toLowerCase().replace(/^\*\./, ''); const h = String(host).toLowerCase(); return h === p || h.endsWith('.' + p); };
export const knownHost = (host) => { const k = KNOWN_HOSTS.find(([d]) => hostMatch(d, host)); return k ? { vendor: k[1], purpose: k[2] } : null; };
export const knownCookie = (name) => { const k = KNOWN_COOKIES.find(([n]) => glob(n, name)); return k ? { vendor: k[1], purpose: k[2] } : null; };
const site2 = (h) => String(h).toLowerCase().split('.').slice(-2).join('.');
const sameSite = (a, b) => site2(a) === site2(b);
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } };

export function validateDeclared(d) {
  if (!d || typeof d !== 'object') throw new Error('declared must be a JSON object');
  if (!String(d.source || '').trim()) throw new Error('declared.source is required (which policy page or banner text this comes from, and its date)');
  for (const c of d.cookies || []) { if (!c.name) throw new Error('every declared cookie needs a name'); if (c.purpose && !PURPOSES.includes(c.purpose)) throw new Error(`cookie ${c.name}: purpose must be one of ${PURPOSES.join(', ')}`); }
  for (const t of d.third_parties || []) { if (!t.host) throw new Error('every declared third party needs a host'); if (t.purpose && !PURPOSES.includes(t.purpose)) throw new Error(`third party ${t.host}: purpose must be one of ${PURPOSES.join(', ')}`); }
  return { cookies: [], third_parties: [], ...d };
}

// ---------- HTML ----------
function attrs(s) { const o = {}; for (const m of s.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) o[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''; return o; }
const lineAt = (text, i) => text.slice(0, i).split('\n').length;
const stripTags = (s) => s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;|&rsquo;/g, "'").replace(/\s+/g, ' ');
const isGated = (a) => (a.type && a.type.toLowerCase() === 'text/plain') && ('data-category' in a || 'data-cookiecategory' in a || 'data-cookieconsent' in a || 'data-consent' in a || /optanon-category/i.test(a.class || ''));

export function scanHtml(text, page, siteHost) {
  const items = []; const claims = []; let policyLink = false; let consentUi = false;
  for (const m of text.matchAll(/<(script|iframe|img|link|a|div|section|aside|dialog|form)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase(); const a = attrs(m[2]); const line = lineAt(text, m.index);
    if (tag === 'a') { const end = text.indexOf('</a>', m.index); const label = stripTags(text.slice(m.index, end > 0 ? end : m.index + 200)); if (/cookie|privacy/i.test(`${label} ${a.href || ''}`)) policyLink = true; continue; }
    if (/consent|cookie[-_]?banner|cookie[-_]?notice|cookies?[-_]?bar/i.test(`${a.id || ''} ${a.class || ''}`)) consentUi = true;
    const url = tag === 'link' ? (/preconnect|dns-prefetch|stylesheet|preload/i.test(a.rel || '') ? a.href : null) : (a.src || a['data-src'] || null);
    if (tag === 'script' && !a.src) {
      const end = text.indexOf('</script>', m.index); const body = text.slice(m.index + m[0].length, end > 0 ? end : undefined);
      const hit = TRACKER_CALLS.find(([re]) => re.test(body)); if (hit) items.push({ kind: 'inline_script', page, line, host: null, vendor: hit[1], purpose: hit[2], purpose_source: 'known_list', gated: isGated(a) });
      continue;
    }
    if (!url) continue;
    const abs = /^\/\//.test(url) ? 'https:' + url : url; const host = hostOf(abs);
    if (!host || (siteHost && sameSite(host, siteHost))) continue;
    if (tag === 'img' && !(a.width === '1' || a.height === '1' || /pixel|track|collect/i.test(abs))) { items.push({ kind: 'img', page, line, host, url: abs, gated: false }); continue; }
    items.push({ kind: tag === 'img' ? 'pixel' : tag, page, line, host, url: abs, gated: tag === 'script' ? isGated(a) : !!a['data-src'] && !a.src });
  }
  const txt = stripTags(text);
  for (const [re, kind, label] of CLAIMS) { const m = re.exec(txt); if (m) claims.push({ page, kind, label, quote: txt.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim() }); }
  if (/cookielaw|cookiebot|cookieyes|usercentrics|klaro|cookieconsent|tarteaucitron|osano/i.test(text)) consentUi = true;
  return { items, claims, policyLink, consentUi };
}
export function listHtml(dir) {
  const out = [];
  const walk = (d) => { for (const n of readdirSync(d).sort()) { const f = join(d, n); if (statSync(f).isDirectory()) { if (!n.startsWith('.') && n !== 'node_modules') walk(f); } else if (/\.html?$/i.test(n)) out.push(f); } };
  walk(dir); return out;
}

// ---------- HAR ----------
export function parseSetCookie(header, startedMs) {
  const parts = String(header).split(';').map((s) => s.trim());
  const [nv, ...rest] = parts; const i = nv.indexOf('='); if (i < 1) return null;
  const c = { name: nv.slice(0, i).trim(), domain: null, secure: false, httponly: false, samesite: null, lifetime_days: null };
  let maxAge = null; let expires = null;
  for (const p of rest) {
    const [k, ...v] = p.split('='); const key = k.trim().toLowerCase(); const val = v.join('=').trim();
    if (key === 'domain') c.domain = val.replace(/^\./, '').toLowerCase(); else if (key === 'secure') c.secure = true; else if (key === 'httponly') c.httponly = true; else if (key === 'samesite') c.samesite = val || null;
    else if (key === 'max-age') maxAge = Number(val); else if (key === 'expires') expires = Date.parse(val);
  }
  if (maxAge !== null && !Number.isNaN(maxAge)) c.lifetime_days = Math.round((maxAge / 86400) * 10) / 10;
  else if (expires && !Number.isNaN(expires)) c.lifetime_days = Math.round(((expires - (startedMs || Date.now())) / 864e5) * 10) / 10;
  return c;
}
export function readHar(text, label) {
  let har; try { har = JSON.parse(text); } catch { throw new Error(`${label}: not a valid HAR (JSON) file`); }
  const entries = har?.log?.entries; if (!Array.isArray(entries)) throw new Error(`${label}: no log.entries; export the capture as HAR from the browser's network panel`);
  const requests = []; const cookies = [];
  for (const e of entries) {
    const url = e.request?.url; const host = hostOf(url); if (!host) continue;
    const started = Date.parse(e.startedDateTime || '') || null;
    requests.push({ host, url, method: e.request.method || 'GET' });
    const setHeaders = (e.response?.headers || []).filter((h) => String(h.name).toLowerCase() === 'set-cookie').flatMap((h) => String(h.value).split('\n'));
    const seen = new Set();
    for (const h of setHeaders) { const c = parseSetCookie(h, started); if (c) { seen.add(c.name); cookies.push({ ...c, domain: c.domain || host, set_by: 'header', host }); } }
    for (const rc of e.response?.cookies || []) if (!seen.has(rc.name)) { const exp = rc.expires ? Date.parse(rc.expires) : null; cookies.push({ name: rc.name, domain: (rc.domain || host).replace(/^\./, ''), secure: !!rc.secure, httponly: !!rc.httpOnly, samesite: rc.sameSite || null, lifetime_days: exp ? Math.round(((exp - (started || Date.now())) / 864e5) * 10) / 10 : null, set_by: 'header', host }); }
    const cookieHeader = (e.request?.headers || []).filter((h) => String(h.name).toLowerCase() === 'cookie').map((h) => h.value).join('; ');
    for (const part of cookieHeader.split(';')) { const n = part.split('=')[0].trim(); if (n) cookies.push({ name: n, domain: host, secure: null, httponly: null, samesite: null, lifetime_days: null, set_by: 'sent', host }); }
  }
  return { requests, cookies, pages: (har.log.pages || []).map((p) => p.title).filter(Boolean) };
}

// ---------- audit ----------
const parseDuration = (s) => { const t = String(s || '').toLowerCase().trim(); if (!t) return null; if (/session/.test(t)) return 0; const m = /(\d+(?:\.\d+)?)\s*(minute|hour|day|week|month|year)/.exec(t); if (!m) return null; return Number(m[1]) * { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30.44, year: 365.25 }[m[2]]; };
const SEV = { error: 0, warning: 1, advisory: 2 };

export function audit({ siteDir = null, siteHost = null, hars = {}, declared: decl = null, ignore = [], https = true, maxLifetimeDays = 395 }) {
  const declared = decl ? validateDeclared(decl) : null;
  const html = { pages: 0, items: [], claims: [], policyLink: false, consentUi: false };
  if (siteDir) for (const f of listHtml(siteDir)) { const r = scanHtml(readFileSync(f, 'utf8'), relative(siteDir, f).split('\\').join('/'), siteHost); html.pages++; html.items.push(...r.items); html.claims.push(...r.claims); html.policyLink ||= r.policyLink; html.consentUi ||= r.consentUi; }
  const caps = {}; for (const [k, v] of Object.entries(hars)) if (v) caps[k] = v;
  const host0 = siteHost || Object.values(caps)[0]?.requests[0]?.host || null;
  const findings = []; const add = (check, severity, subject, detail, where = null) => findings.push({ check, severity, subject, detail, where });
  const decCookie = (n) => declared?.cookies.find((c) => glob(c.name, n)) || null;
  const decHost = (h) => declared?.third_parties.find((t) => hostMatch(t.host, h)) || null;
  const purposeOf = (dec, known) => (dec?.purpose ? { purpose: dec.purpose, purpose_source: 'declared' } : known ? { purpose: known.purpose, purpose_source: 'known_list (guess)' } : { purpose: null, purpose_source: 'unknown' });

  // cookie inventory
  const cmap = new Map();
  for (const [cap, h] of Object.entries(caps)) for (const c of h.cookies) {
    const key = `${c.name}|${site2(c.domain)}`; const cur = cmap.get(key);
    if (!cur) cmap.set(key, { ...c, seen_in: [cap] });
    else { if (!cur.seen_in.includes(cap)) cur.seen_in.push(cap); if (c.set_by === 'header' && cur.set_by !== 'header') Object.assign(cur, { ...c, seen_in: cur.seen_in }); }
  }
  const cookies = [...cmap.values()].map((c) => {
    const party = host0 && !sameSite(c.domain, host0) ? 'third' : 'first'; const dec = decCookie(c.name); const known = knownCookie(c.name);
    return { name: c.name, domain: c.domain, party, set_by: c.set_by === 'header' ? 'Set-Cookie header' : 'script (seen in a later request)', ...purposeOf(dec, known), vendor: dec?.provider || known?.vendor || null, declared: !!dec, declared_duration: dec?.duration || null, lifetime_days: c.lifetime_days, secure: c.secure, httponly: c.httponly, samesite: c.samesite, seen_in: c.seen_in };
  }).sort((a, b) => a.name.localeCompare(b.name));
  // third-party inventory
  const tmap = new Map();
  const addHost = (host, where, gated) => { if (!host || (host0 && sameSite(host, host0))) return; const t = tmap.get(host) || { host, seen_in: [], ungated_in_html: false }; if (!t.seen_in.includes(where)) t.seen_in.push(where); if (where.startsWith('html:') && !gated) t.ungated_in_html = true; tmap.set(host, t); };
  for (const i of html.items) if (i.host) addHost(i.host, `html:${i.page}`, i.gated);
  for (const [cap, h] of Object.entries(caps)) for (const r of h.requests) addHost(r.host, cap, false);
  const third_parties = [...tmap.values()].map((t) => { const dec = decHost(t.host); const known = knownHost(t.host); return { ...t, vendor: dec?.name || known?.vendor || null, ...purposeOf(dec, known), declared: !!dec }; }).sort((a, b) => a.host.localeCompare(b.host));

  // gaps
  for (const c of cookies) {
    const subj = `cookie ${c.name} (${c.domain})`;
    if (declared && !c.declared) add('undeclared_cookie', 'warning', subj, `${c.party === 'third' ? 'Third-party' : 'First-party'} cookie not in ${declared.source}${c.vendor ? `; looks like ${c.vendor} (${c.purpose}, a guess)` : ''}.`);
    if (!c.purpose) add('cookie_purpose_unknown', 'warning', subj, 'Not declared and not on the built-in vendor list; a person needs to say what it is for.');
    const nonEss = c.purpose && NONESSENTIAL.has(c.purpose);
    if (nonEss && c.seen_in.includes('first_visit')) add('nonessential_before_consent', 'error', subj, `Set on the first visit before any choice was made; its purpose is ${c.purpose} (${c.purpose_source}).`, 'first_visit');
    if (nonEss && c.seen_in.includes('after_reject')) add('nonessential_after_reject', 'error', subj, `Still set or sent after the visitor rejected non-essential cookies; its purpose is ${c.purpose} (${c.purpose_source}).`, 'after_reject');
    if (c.lifetime_days !== null && c.lifetime_days > maxLifetimeDays) add('cookie_long_lifetime', 'advisory', subj, `Lasts about ${Math.round(c.lifetime_days)} days. Many regulators' guidance suggests about 13 months for consent-based cookies; check yours.`);
    if (c.set_by === 'Set-Cookie header' && c.samesite && /^none$/i.test(c.samesite) && !c.secure) add('samesite_none_insecure', 'error', subj, 'SameSite=None without Secure; current browsers reject this cookie.');
    else if (https && c.set_by === 'Set-Cookie header' && c.secure === false) add('cookie_not_secure', 'warning', subj, 'No Secure attribute on an https site, so it can be sent over plain http.');
    if (c.declared && c.declared_duration && c.lifetime_days !== null) { const d = parseDuration(c.declared_duration); if (d !== null && (d === 0 ? c.lifetime_days > 0 : Math.abs(c.lifetime_days - d) > Math.max(2, d * 0.25))) add('duration_mismatch', 'advisory', subj, `Policy says ${c.declared_duration}; observed about ${Math.round(c.lifetime_days)} day(s).`); }
  }
  for (const t of third_parties) {
    const subj = `host ${t.host}`;
    if (declared && !t.declared) add('undeclared_third_party', 'warning', subj, `Loaded but not listed in ${declared.source}${t.vendor ? `; looks like ${t.vendor} (${t.purpose}, a guess)` : ''}. Every third-party request shares the visitor's IP address with that host.`);
    const nonEss = t.purpose && NONESSENTIAL.has(t.purpose);
    if (nonEss && t.seen_in.includes('first_visit')) add('nonessential_before_consent', 'error', subj, `Requested on the first visit before any choice was made (${t.purpose}, ${t.purpose_source}).`, 'first_visit');
    if (nonEss && t.seen_in.includes('after_reject')) add('nonessential_after_reject', 'error', subj, `Still requested after the visitor rejected non-essential cookies (${t.purpose}, ${t.purpose_source}).`, 'after_reject');
    if (nonEss && t.ungated_in_html) { const pages = t.seen_in.filter((s) => s.startsWith('html:')).map((s) => s.slice(5)); add('ungated_tracker_script', 'warning', subj, `Loaded directly in the HTML (${pages.join(', ')}) with no consent gating (for example type="text/plain" with a data-category); it runs before any choice.`); }
  }
  for (const i of html.items.filter((x) => x.kind === 'inline_script' && !x.gated && NONESSENTIAL.has(x.purpose))) add('ungated_tracker_script', 'warning', `inline ${i.vendor}`, `Inline ${i.vendor} call in ${i.page}:${i.line} with no consent gating.`, `${i.page}:${i.line}`);
  if (declared) {
    for (const c of declared.cookies) if (!cookies.some((o) => glob(c.name, o.name))) add('declared_not_seen', 'advisory', `cookie ${c.name}`, 'Declared in the policy but not seen in these captures. It may only be set on pages you did not capture, or it may be out of date.');
    for (const t of declared.third_parties) if (!third_parties.some((o) => hostMatch(t.host, o.host))) add('declared_not_seen', 'advisory', `host ${t.host}`, 'Declared in the policy but not seen in these captures.');
  }
  const tracking = cookies.some((c) => NONESSENTIAL.has(c.purpose)) || third_parties.some((t) => NONESSENTIAL.has(t.purpose)) || html.items.some((i) => i.kind === 'inline_script' && NONESSENTIAL.has(i.purpose));
  for (const cl of html.claims) {
    const bad = cl.kind === 'any_cookie' ? cookies.length > 0 : cl.kind === 'tracking_cookie' ? cookies.some((c) => NONESSENTIAL.has(c.purpose) || c.party === 'third') : cl.kind === 'tracker' ? tracking : [...cookies, ...third_parties].some((x) => x.purpose === 'analytics') || html.items.some((i) => i.purpose === 'analytics');
    if (bad) add('claim_contradicted', 'error', `claim "${cl.label}"`, `${cl.page} says "${cl.quote}", but the captures show ${cl.kind === 'any_cookie' ? `${cookies.length} cookie(s)` : 'tracking or analytics'}.`, cl.page);
  }
  const nonEssAny = tracking;
  if (siteDir && nonEssAny && !html.policyLink) add('no_policy_link', 'warning', 'site', 'Non-essential cookies or trackers were found but no page links to a cookie or privacy policy.');
  const cmp = html.consentUi || third_parties.some((t) => CMP_HOSTS.some((d) => hostMatch(d, t.host)));
  if (nonEssAny && !cmp && (siteDir || Object.keys(caps).length)) add('no_consent_mechanism', 'warning', 'site', 'Non-essential cookies or trackers were found, but no consent banner or consent-manager script was seen in the HTML or captures.');
  const skip = new Set(ignore); const out = findings.filter((f) => !skip.has(f.check)).sort((a, b) => SEV[a.severity] - SEV[b.severity]);
  const by_severity = {}; for (const f of out) by_severity[f.severity] = (by_severity[f.severity] || 0) + 1;
  return { site_host: host0, pages: html.pages, captures: Object.keys(caps), declared_source: declared?.source || null, cookies, third_parties, inline_trackers: html.items.filter((i) => i.kind === 'inline_script').map(({ page, line, vendor, purpose, gated }) => ({ page, line, vendor, purpose, gated })), claims: html.claims, consent_mechanism_seen: cmp, policy_link_seen: html.policyLink, issues: out.length, by_severity, findings: out, limits: LIMITS };
}

export function reportMarkdown(r) {
  const L = [`# Cookie and consent audit${r.site_host ? `: ${r.site_host}` : ''}`, '', `${r.pages} page(s), captures: ${r.captures.join(', ') || 'none'}. Compared with: ${r.declared_source || '(no declared policy given)'}.`, `${r.cookies.length} cookie(s), ${r.third_parties.length} third-party host(s). ${r.issues} issue(s): ${r.by_severity.error || 0} error, ${r.by_severity.warning || 0} warning, ${r.by_severity.advisory || 0} advisory.`, '', '## Gaps', '', '| Severity | Check | Subject | Detail |', '|---|---|---|---|'];
  for (const f of r.findings) L.push(`| ${f.severity} | ${f.check} | ${f.subject} | ${f.detail.replace(/\|/g, '\\|')} |`);
  if (!r.findings.length) L.push('| | none | | |');
  L.push('', '## Cookies', '', '| Name | Domain | Party | Purpose | Source | Lifetime (days) | Secure | SameSite | Seen in |', '|---|---|---|---|---|---|---|---|---|');
  for (const c of r.cookies) L.push(`| ${c.name} | ${c.domain} | ${c.party} | ${c.purpose || '?'} | ${c.purpose_source} | ${c.lifetime_days ?? 'session/unknown'} | ${c.secure ?? '?'} | ${c.samesite || ''} | ${c.seen_in.join(', ')} |`);
  L.push('', '## Third-party hosts', '', '| Host | Vendor | Purpose | Source | Seen in |', '|---|---|---|---|---|');
  for (const t of r.third_parties) L.push(`| ${t.host} | ${t.vendor || ''} | ${t.purpose || '?'} | ${t.purpose_source} | ${t.seen_in.join(', ')} |`);
  L.push('', '## Limits', '', r.limits, '');
  return L.join('\n');
}

/** A proposed cookie table for the policy page: everything observed or declared, unknowns marked. */
export function draftTable(r, declared) {
  const rows = r.cookies.map((c) => ({ name: c.name, provider: c.vendor || (c.party === 'first' ? 'This site' : '[TO CONFIRM provider]'), purpose: c.purpose_source === 'declared' ? c.purpose : `[TO CONFIRM purpose${c.purpose ? `; looks like ${c.purpose}` : ''}]`, duration: c.declared_duration || (c.lifetime_days === null ? '[TO CONFIRM duration]' : c.lifetime_days < 1 ? 'session or under a day' : `about ${Math.round(c.lifetime_days)} days`), status: c.declared ? 'declared' : 'observed, not declared' }));
  for (const d of declared?.cookies || []) if (!r.cookies.some((c) => glob(d.name, c.name))) rows.push({ name: d.name, provider: d.provider || '', purpose: d.purpose || '[TO CONFIRM purpose]', duration: d.duration || '[TO CONFIRM duration]', status: 'declared, not seen: [TO CONFIRM still used]' });
  const hosts = r.third_parties.map((t) => ({ host: t.host, vendor: t.vendor || '[TO CONFIRM vendor]', purpose: t.purpose_source === 'declared' ? t.purpose : `[TO CONFIRM purpose${t.purpose ? `; looks like ${t.purpose}` : ''}]`, status: t.declared ? 'declared' : 'observed, not declared' }));
  const person = r.findings.filter((f) => ['nonessential_before_consent', 'nonessential_after_reject', 'ungated_tracker_script', 'claim_contradicted', 'no_consent_mechanism', 'samesite_none_insecure', 'no_policy_link'].includes(f.check)).map((f) => `${f.check}: ${f.subject}. ${f.detail}`);
  return { rows, hosts, needs_person: [...new Set(person)] };
}
