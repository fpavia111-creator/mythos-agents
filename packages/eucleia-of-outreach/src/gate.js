import { toCsv } from 'mythos-agent-core';

export const DEFAULTS = Object.freeze({ max_subject_chars: 30, max_body_words: 100, days: ['Tue', 'Wed'], start_hour: 8, end_hour: 17, time_zone: 'America/Chicago' });
const low = (s) => String(s ?? '').trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function words(text) { return String(text ?? '').trim().split(/\s+/).filter(Boolean).length; }

/** Weekday and hour of an instant in a time zone (default America/Chicago). */
export function localParts(iso, timeZone = DEFAULTS.time_zone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, hour: Number(p.hour), minute: Number(p.minute), date: `${p.year}-${p.month}-${p.day}`, label: `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${timeZone}` };
}

export function inWindow(iso, cfg = DEFAULTS) {
  const lp = localParts(iso, cfg.time_zone);
  if (!lp) return { ok: false, reason: `send_at "${iso}" is not a valid date-time` };
  const dayOk = cfg.days.includes(lp.weekday);
  const hourOk = lp.hour >= cfg.start_hour && lp.hour < cfg.end_hour;
  return { ok: dayOk && hourOk, local: lp.label, reason: dayOk && hourOk ? null : `${lp.label} is outside the send window (${cfg.days.join('/')} ${cfg.start_hour}:00–${cfg.end_hour}:00 ${cfg.time_zone})` };
}

/** Next instant inside the window, searching in 15-minute steps up to 14 days. */
export function nextWindow(fromIso, cfg = DEFAULTS) {
  let t = new Date(fromIso).getTime();
  if (Number.isNaN(t)) return null;
  t = Math.ceil(t / 900000) * 900000;
  for (let i = 0; i < 14 * 96; i++, t += 900000) if (inWindow(new Date(t).toISOString(), cfg).ok) return new Date(t).toISOString();
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
  const from = d.from_name || cfg.from_name, addr = d.postal_address || cfg.postal_address, unsub = d.unsubscribe || cfg.unsubscribe;
  if (!String(from || '').trim()) fails.push('footer: sender name (from_name) missing');
  if (!String(addr || '').trim()) fails.push('footer: postal address missing');
  else if (String(addr).trim().length < 10 || !/\d/.test(addr)) fails.push('footer: postal address looks incomplete');
  if (!String(unsub || '').trim()) fails.push('footer: unsubscribe link or reply-to-opt-out instruction missing');
  else if (/^http:\/\//i.test(unsub)) warns.push('footer: unsubscribe link is not https');
  if (d.send_at) { const w = inWindow(d.send_at, cfg); if (!w.ok) fails.push(`window: ${w.reason}`); }
  else warns.push('send_at not set; check the window before sending');
  if (/[A-Z]{6,}/.test(subj) || /!!/.test(subj)) warns.push('subject: shouting or "!!" tends to read as spam');
  const footer = [String(from || '').trim(), String(addr || '').trim(), unsub ? `Unsubscribe: ${String(unsub).trim()}` : ''].filter(Boolean).join('\n');
  return { to: d.to || '', subject: subj, words: wc, subject_chars: subj.length, ok: fails.length === 0, fails, warns, footer, next_window: d.send_at && fails.some((f) => f.startsWith('window:')) ? nextWindow(d.send_at, cfg) : null };
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
