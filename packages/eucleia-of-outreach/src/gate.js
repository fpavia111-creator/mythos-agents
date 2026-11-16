import { toCsv } from 'mythos-agent-core';

export const DEFAULTS = Object.freeze({ max_subject_chars: 30, max_body_words: 100, days: ['Tue', 'Wed'], start_hour: 8, end_hour: 17, time_zone: 'America/Chicago', max_links: 3, spam_policy: 'warn', max_per_day: 50, min_gap_minutes: 5 });
const low = (s) => String(s ?? '').trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function words(text) { return String(text ?? '').trim().split(/\s+/).filter(Boolean).length; }

// Building an Intl formatter is slow, so one is kept per time zone (results are identical).
const FMT = new Map(); const TZ_OK = new Map();
export function validTimeZone(tz) {
  const k = String(tz);
  if (!TZ_OK.has(k)) { let ok; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); ok = true; } catch { ok = false; } if (TZ_OK.size < 1000) TZ_OK.set(k, ok); else return ok; }
  return TZ_OK.get(k);
}
function formatterFor(timeZone) {
  let f = FMT.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }); if (FMT.size < 1000) FMT.set(timeZone, f); }
  return f;
}

/** Weekday and hour of an instant in a time zone (default America/Chicago). */
const LP = new Map();
export function localParts(iso, timeZone = DEFAULTS.time_zone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const key = `${timeZone}|${d.getTime()}`; const hit = LP.get(key); if (hit) return { ...hit };
  const f = formatterFor(timeZone);
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const out = { weekday: p.weekday, hour: Number(p.hour), minute: Number(p.minute), date: `${p.year}-${p.month}-${p.day}`, label: `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${timeZone}` };
  if (LP.size >= 200000) LP.clear(); LP.set(key, out);
  return { ...out };
}

/** The configured windows: "windows" if given, else one window from days/start_hour/end_hour. */
export function windowsOf(cfg) {
  return cfg.windows && cfg.windows.length ? cfg.windows : [{ days: cfg.days, start_hour: cfg.start_hour, end_hour: cfg.end_hour }];
}
const describe = (cfg, tz) => `${windowsOf(cfg).map((w) => `${w.days.join('/')} ${w.start_hour}:00–${w.end_hour}:00`).join(', ')} ${tz}`;

/**
 * Is an instant inside the send window? Evaluated in `timeZone` (a recipient's zone when
 * the draft gives one) or the config's zone, so daylight-saving changes are handled by
 * the time-zone database, not by fixed offsets. Blackout dates are local dates.
 */
export function inWindow(iso, cfg = DEFAULTS, timeZone) {
  const c = { ...DEFAULTS, ...cfg };
  const tz = timeZone || c.time_zone;
  const lp = localParts(iso, tz);
  if (!lp) return { ok: false, reason: `send_at "${iso}" is not a valid date-time` };
  if ((c.blackout_dates || []).includes(lp.date)) return { ok: false, local: lp.label, reason: `${lp.label} is a blackout date` };
  const ok = windowsOf(c).some((w) => w.days.includes(lp.weekday) && lp.hour >= w.start_hour && lp.hour < w.end_hour);
  return { ok, local: lp.label, reason: ok ? null : `${lp.label} is outside the send window (${describe(c, tz)})` };
}

/** Next instant inside the window, searching in 15-minute steps up to 60 days. */
const NW = new Map();
export function nextWindow(fromIso, cfg = DEFAULTS, timeZone) {
  let t = new Date(fromIso).getTime();
  if (Number.isNaN(t)) return null;
  t = Math.ceil(t / 900000) * 900000;
  // Many drafts in a batch share a send time; the search is the same for each.
  const key = `${t}|${timeZone}|${JSON.stringify(cfg)}`;
  if (NW.has(key)) return NW.get(key);
  const found = searchWindow(t, cfg, timeZone);
  if (NW.size >= 10000) NW.clear(); NW.set(key, found);
  return found;
}
function searchWindow(t, cfg, timeZone) {
  for (let i = 0; i < 60 * 96; i++, t += 900000) if (inWindow(new Date(t).toISOString(), cfg, timeZone).ok) return new Date(t).toISOString();
  return null;
}

export function suppressionSet(rows) {
  const s = new Set();
  for (const r of rows) {
    const v = low(r.email ?? r.address ?? r.domain ?? Object.values(r)[0]);
    if (v) s.add(v);
  }
  return s;
}

function suppressed(email, set) {
  const e = low(email);
  if (set.has(e)) return `${e} is on the suppression list`;
  const dom = e.split('@')[1];
  if (dom && (set.has(dom) || set.has('@' + dom))) return `domain ${dom} is on the suppression list`;
  return null;
}

// ---- Content checks ----------------------------------------------------------------

/** Common spam-trigger phrases. A hit is cited with where it was found; by default it is a warning. */
export const SPAM_PHRASES = Object.freeze(['free', 'guarantee', 'guaranteed', 'no obligation', 'risk-free', 'risk free', 'act now', 'limited time', 'urgent', 'winner', 'cash', '100%', 'click here', 'buy now', 'order now', 'special promotion', 'earn money', 'make money', 'double your', 'no cost', 'lowest price', 'once in a lifetime', 'congratulations', 'dear friend', 'this is not spam', 'increase sales', 'miracle', 'no catch', 'what are you waiting for', 'exclusive deal']);

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PHRASE_RE = new Map();
export function spamHits(fields, extra = []) {
  const hits = [];
  for (const phrase of [...SPAM_PHRASES, ...extra.map((x) => x.toLowerCase())]) {
    let re = PHRASE_RE.get(phrase); if (!re) { re = new RegExp(`(^|[^a-z0-9])(${reEsc(phrase)})(?![a-z0-9])`, 'gi'); if (PHRASE_RE.size < 5000) PHRASE_RE.set(phrase, re); }
    re.lastIndex = 0;
    for (const [field, text] of Object.entries(fields)) {
      let m; while ((m = re.exec(text))) {
        const at = m.index + m[1].length;
        hits.push({ phrase, field, index: at, snippet: text.slice(Math.max(0, at - 20), at + phrase.length + 20).replace(/\s+/g, ' ').trim() });
      }
    }
  }
  return hits.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : a.index - b.index));
}

/** Unfilled merge tags: {{first_name}}, {first}, [FirstName], *|FNAME|*, %FNAME%. */
export const PLACEHOLDER = /\{\{\s*[\w.-]+\s*\}\}|\{[A-Za-z_][\w.]*\}|\[(?:first|last|company|name|title|city)[\w ]*\]|\*\|[A-Z0-9_]+\|\*|%[A-Z][A-Z0-9_]+%/gi;
export function placeholders(text) { return [...String(text ?? '').matchAll(PLACEHOLDER)].map((m) => m[0]); }

export const SHORTENERS = Object.freeze(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'lnkd.in']);
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()"'\]]+/gi;
export function links(text) {
  return [...String(text ?? '').matchAll(URL_RE)].map((m) => {
    const raw = m[0].replace(/[.,;:!?]+$/, '');
    const url = /^www\./i.test(raw) ? 'https://' + raw : raw;
    let host = ''; try { host = new URL(url).hostname.toLowerCase(); } catch { host = ''; }
    return { url: raw, host, https: /^https:/i.test(url) };
  });
}
const allowed = (host, list) => list.some((d) => { const x = low(d).replace(/^\*\./, ''); return host === x || host.endsWith('.' + x); });

/** Link checks: shorteners and raw IPs hold; hosts outside link_allowlist hold (when set); http and too many links warn. */
export function linkFindings(body, unsub, cfg) {
  const fails = [], warns = [];
  const L = [...links(body).map((l) => ({ ...l, where: 'body' })), ...links(unsub).map((l) => ({ ...l, where: 'unsubscribe' }))];
  for (const l of L) {
    if (!l.host) { fails.push(`link: "${l.url}" in ${l.where} could not be read`); continue; }
    if (SHORTENERS.includes(l.host)) fails.push(`link: ${l.host} is a URL shortener (${l.where}); use the full link`);
    else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(l.host) || l.host.startsWith('[')) fails.push(`link: ${l.url} points at a raw IP address (${l.where})`);
    else if (cfg.link_allowlist && cfg.link_allowlist.length && !allowed(l.host, cfg.link_allowlist)) fails.push(`link: ${l.host} is not on the link allowlist (${l.where})`);
    if (!l.https && l.where === 'body') warns.push(`link: ${l.url} is not https`);
  }
  const bodyLinks = L.filter((l) => l.where === 'body').length;
  if (bodyLinks > (cfg.max_links ?? DEFAULTS.max_links)) warns.push(`link: ${bodyLinks} links in the body (more than ${cfg.max_links ?? DEFAULTS.max_links})`);
  return { fails, warns, links: L };
}

/**
 * Check one draft. Fails closed: a missing field is a failure, not a warning.
 * Footer fields follow the CAN-SPAM basics (sender identity, valid postal address,
 * a clear way to opt out). This checks that the fields are present; it is not legal advice.
 */
export function checkDraft(d, { suppression = new Set(), config = {} } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const fails = [], warns = [];
  const subj = String(d.subject ?? ''), body = String(d.body ?? '');
  if (!d.to || !EMAIL.test(String(d.to).trim())) fails.push('to: missing or not an email address');
  else { const s = suppressed(d.to, suppression); if (s) fails.push(`suppressed: ${s}`); }
  if (!subj.trim()) fails.push('subject: empty');
  else if (subj.length >= cfg.max_subject_chars) fails.push(`subject: ${subj.length} characters (must be under ${cfg.max_subject_chars})`);
  if (/^\s*(re|fwd?):/i.test(subj) && !d.is_reply) fails.push('subject: starts with RE:/FWD: but this is not a reply (misleading subject)');
  const wc = words(body);
  if (!wc) fails.push('body: empty');
  else if (wc >= cfg.max_body_words) fails.push(`body: ${wc} words (must be under ${cfg.max_body_words})`);
  for (const [k, v] of [['subject', subj], ['body', body]]) { const p = placeholders(v); if (p.length) fails.push(`${k}: unfilled placeholder ${[...new Set(p)].join(', ')}`); }
  const from = d.from_name || cfg.from_name, addr = d.postal_address || cfg.postal_address, unsub = d.unsubscribe || cfg.unsubscribe;
  if (!String(from || '').trim()) fails.push('footer: sender name (from_name) missing');
  if (!String(addr || '').trim()) fails.push('footer: postal address missing');
  else if (String(addr).trim().length < 10 || !/\d/.test(addr)) fails.push('footer: postal address looks incomplete');
  if (!String(unsub || '').trim()) fails.push('footer: unsubscribe link or reply-to-opt-out instruction missing');
  else if (/^http:\/\//i.test(unsub)) warns.push('footer: unsubscribe link is not https');
  const lf = linkFindings(body, unsub, cfg); fails.push(...lf.fails); warns.push(...lf.warns);
  const tz = String(d.time_zone || d.tz || '').trim() || null;
  if (tz && !validTimeZone(tz)) fails.push(`window: time_zone "${tz}" is not a known IANA time zone`);
  const winTz = tz && validTimeZone(tz) ? tz : undefined;
  if (d.send_at) { const w = inWindow(d.send_at, cfg, winTz); if (!w.ok) fails.push(`window: ${w.reason}`); }
  else warns.push('send_at not set; check the window before sending');
  if (/[A-Z]{6,}/.test(subj) || /!!/.test(subj)) warns.push('subject: shouting or "!!" tends to read as spam');
  const spam = spamHits({ subject: subj, body }, cfg.spam_words || []);
  for (const h of spam) (cfg.spam_policy === 'hold' ? fails : warns).push(`spam word: "${h.phrase}" in ${h.field} at ${h.index} ("…${h.snippet}…")`);
  const footer = [String(from || '').trim(), String(addr || '').trim(), unsub ? `Unsubscribe: ${String(unsub).trim()}` : ''].filter(Boolean).join('\n');
  return { to: d.to || '', subject: subj, words: wc, subject_chars: subj.length, ok: fails.length === 0, fails, warns, spam_hits: spam, links: lf.links, time_zone: winTz || cfg.time_zone, footer, next_window: d.send_at && fails.some((f) => f.startsWith('window:')) && !fails.some((f) => /not a known IANA/.test(f)) ? nextWindow(d.send_at, cfg, winTz) : null };
}

export function checkBatch(drafts, opts) {
  const seen = new Set();
  const results = drafts.map((d, i) => {
    const r = checkDraft(d, opts);
    const key = low(d.to);
    if (key && seen.has(key)) { r.fails.push('duplicate: this address already has a draft in this batch'); r.ok = false; }
    seen.add(key);
    return { row: i + 2, ...r };
  });
  return { drafts: results.length, ready: results.filter((r) => r.ok).length, held: results.filter((r) => !r.ok).length, results };
}

export function draftText(d, r) {
  return `To: ${d.to}\nSubject: ${d.subject}\n${d.send_at ? `Send at: ${d.send_at}\n` : ''}\n${String(d.body).trim()}\n\n--\n${r.footer}\n`;
}

export const heldCsv = (b) => toCsv(b.results.filter((r) => !r.ok).map((r) => ({ row: r.row, to: r.to, subject: r.subject, reasons: r.fails.join('; '), next_window: r.next_window || '' })), ['row', 'to', 'subject', 'reasons', 'next_window']);
export const readyCsv = (b, drafts) => toCsv(b.results.filter((r) => r.ok).map((r) => ({ row: r.row, to: r.to, subject: r.subject, send_at: drafts[r.row - 2].send_at || '', words: r.words, warnings: r.warns.join('; ') })), ['row', 'to', 'subject', 'send_at', 'words', 'warnings']);
