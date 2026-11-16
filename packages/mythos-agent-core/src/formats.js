// Shared output formats for agents: iCalendar, SARIF 2.1.0, unified diff and a
// self-contained HTML report page. No dependencies, no network.

import { sha256 } from './util.js';
import { HTML_LANG, normLang } from './lang.js';

// ---- iCalendar (RFC 5545) ------------------------------------------------------

const icsEsc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);
function fold(line) {
  // Fold at 75 octets (approximated by UTF-16 units, safe for ASCII-heavy text).
  const out = []; let s = line;
  while (s.length > 75) { out.push(s.slice(0, 75)); s = ' ' + s.slice(75); }
  out.push(s);
  return out.join('\r\n');
}
const icsDate = (d) => String(d).replace(/-/g, '').slice(0, 8);

/**
 * events: [{ uid?, date: 'YYYY-MM-DD', summary, description?, reminders?: [daysBefore, ...], categories? }]
 * All-day events with VALARM reminders. Deterministic: same input, same bytes
 * (DTSTAMP comes from opts.stamp, default 19700101T000000Z).
 */
export function toIcs(events, { prodId = '-//Mythos Machine//mythos-agent-core//EN', calName = 'Mythos', stamp = '19700101T000000Z' } = {}) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${prodId}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEsc(calName)}`];
  for (const e of events) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(e.date || ''))) throw new Error(`event "${e.summary}" needs date YYYY-MM-DD`);
    const start = icsDate(e.date);
    const next = new Date(Date.UTC(+start.slice(0, 4), +start.slice(4, 6) - 1, +start.slice(6, 8) + 1)).toISOString().slice(0, 10);
    const uid = e.uid || `${sha256(`${e.date}|${e.summary}`).slice(0, 24)}@mythos.local`;
    L.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${icsDate(next)}`, `SUMMARY:${icsEsc(e.summary)}`);
    if (e.description) L.push(`DESCRIPTION:${icsEsc(e.description)}`);
    if (e.categories) L.push(`CATEGORIES:${[].concat(e.categories).map(icsEsc).join(',')}`);
    for (const d of e.reminders || []) {
      L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(e.summary)}`, `TRIGGER:-P${Number(d)}D`, 'END:VALARM');
    }
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

/** Light structural validation of an .ics string. Returns { ok, events, errors }. */
export function validateIcs(text) {
  const errors = []; const lines = String(text).split('\r\n');
  if (lines[0] !== 'BEGIN:VCALENDAR') errors.push('must start with BEGIN:VCALENDAR');
  if (!lines.includes('VERSION:2.0')) errors.push('VERSION:2.0 missing');
  if (!lines.some((l) => l.startsWith('PRODID:'))) errors.push('PRODID missing');
  let depth = 0; let events = 0; const stack = [];
  for (const l of lines) {
    if (l.length > 75 && !l.startsWith(' ')) errors.push(`line longer than 75 octets: ${l.slice(0, 20)}…`);
    if (l.startsWith('BEGIN:')) { stack.push(l.slice(6)); depth++; if (l === 'BEGIN:VEVENT') events++; }
    if (l.startsWith('END:')) { if (stack.pop() !== l.slice(4)) errors.push(`mismatched ${l}`); depth--; }
  }
  if (depth !== 0) errors.push('unbalanced BEGIN/END');
  return { ok: errors.length === 0, events, errors };
}

// ---- SARIF 2.1.0 ----------------------------------------------------------------

const SARIF_LEVEL = { critical: 'error', high: 'error', error: 'error', medium: 'warning', warning: 'warning', low: 'note', info: 'note', note: 'note' };

/**
 * findings: [{ ruleId, message, severity, file?, line?, column?, help?, fingerprint? }]
 * rules: [{ id, name?, description, help?, severity? }]
 */
export function toSarif({ tool, version, informationUri, rules = [], findings = [] }) {
  const ruleIds = [...new Set([...rules.map((r) => r.id), ...findings.map((f) => f.ruleId)])];
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: {
        name: tool, version: String(version || '0.0.0'), ...(informationUri ? { informationUri } : {}),
        rules: ruleIds.map((id) => { const r = ruleById.get(id) || {}; return {
          id, name: r.name || id, shortDescription: { text: r.description || id },
          ...(r.help ? { help: { text: r.help } } : {}),
          defaultConfiguration: { level: SARIF_LEVEL[String(r.severity || 'warning').toLowerCase()] || 'warning' },
        }; }),
      } },
      results: findings.map((f) => ({
        ruleId: f.ruleId, ruleIndex: ruleIds.indexOf(f.ruleId),
        level: SARIF_LEVEL[String(f.severity || (ruleById.get(f.ruleId) || {}).severity || 'warning').toLowerCase()] || 'warning',
        message: { text: String(f.message) },
        ...(f.file ? { locations: [{ physicalLocation: { artifactLocation: { uri: String(f.file).replace(/\\/g, '/') }, ...(f.line ? { region: { startLine: Number(f.line), ...(f.column ? { startColumn: Number(f.column) } : {}) } } : {}) } }] } : {}),
        partialFingerprints: { primaryLocationLineHash: f.fingerprint || sha256(`${f.ruleId}|${f.file || ''}|${f.message}`).slice(0, 32) },
      })),
    }],
  };
}

/** Structural SARIF 2.1.0 check (the fields GitHub code scanning requires). */
export function validateSarif(doc) {
  const errors = [];
  if (!doc || doc.version !== '2.1.0') errors.push('/version must be "2.1.0"');
  if (!Array.isArray(doc && doc.runs) || !doc.runs.length) errors.push('/runs must be a non-empty array');
  (doc && doc.runs || []).forEach((run, i) => {
    if (!run.tool || !run.tool.driver || !run.tool.driver.name) errors.push(`/runs/${i}/tool/driver/name is required`);
    const ids = new Set((run.tool && run.tool.driver && run.tool.driver.rules || []).map((r) => r.id));
    (run.results || []).forEach((r, j) => {
      if (!r.message || typeof r.message.text !== 'string') errors.push(`/runs/${i}/results/${j}/message/text is required`);
      if (!['none', 'note', 'warning', 'error'].includes(r.level)) errors.push(`/runs/${i}/results/${j}/level is invalid`);
      if (r.ruleId && !ids.has(r.ruleId)) errors.push(`/runs/${i}/results/${j}/ruleId ${r.ruleId} has no rule`);
      for (const loc of r.locations || []) {
        const reg = loc.physicalLocation && loc.physicalLocation.region;
        if (reg && !(Number.isInteger(reg.startLine) && reg.startLine >= 1)) errors.push(`/runs/${i}/results/${j} startLine must be >= 1`);
      }
    });
  });
  return { ok: errors.length === 0, errors };
}

// ---- Unified diff (Myers via LCS, line-based) ------------------------------------

function lcsOps(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 25e6) throw new Error('files too large to diff in memory');
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

/** Unified diff of two texts ('' when equal). Paths default to a/file b/file. */
export function unifiedDiff(oldText, newText, { oldPath = 'a/file', newPath = 'b/file', context = 3 } = {}) {
  if (oldText === newText) return '';
  const split = (t) => { const s = String(t).split('\n'); if (s[s.length - 1] === '') s.pop(); return s; };
  const a = split(oldText), b = split(newText);
  const ops = lcsOps(a, b);
  // Line numbers before each op.
  const pos = []; let oi = 1, ni = 1;
  for (const op of ops) { pos.push([oi, ni]); if (op[0] !== '+') oi++; if (op[0] !== '-') ni++; }
  const changes = ops.map((op, i) => (op[0] !== ' ' ? i : -1)).filter((i) => i >= 0);
  if (!changes.length) return '';
  const groups = []; let g = [changes[0], changes[0]];
  for (const c of changes.slice(1)) { if (c - g[1] <= context * 2 + 1) g[1] = c; else { groups.push(g); g = [c, c]; } }
  groups.push(g);
  const out = [`--- ${oldPath}`, `+++ ${newPath}`];
  for (const [first, last] of groups) {
    const s0 = Math.max(0, first - context), e0 = Math.min(ops.length - 1, last + context);
    const slice = ops.slice(s0, e0 + 1);
    const ol = slice.filter((o) => o[0] !== '+').length, nl = slice.filter((o) => o[0] !== '-').length;
    const [os, ns] = pos[s0];
    out.push(`@@ -${ol ? os : os - 1},${ol} +${nl ? ns : ns - 1},${nl} @@`, ...slice.map((o) => o[0] + o[1]));
  }
  return out.join('\n') + '\n';
}

/** Apply a unified diff produced by unifiedDiff (strict: context must match). */
export function applyUnifiedDiff(text, patch) {
  if (!patch) return text;
  const src = String(text).split('\n'); const hadNl = src[src.length - 1] === ''; if (hadNl) src.pop();
  const lines = patch.split('\n'); const out = []; let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
    if (!m) continue;
    let start = Number(m[1]) - 1; if (Number(m[2] ?? 1) === 0) start += 1;
    while (pos < start) out.push(src[pos++]);
    for (i++; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const l = lines[i]; if (l === '') continue;
      const tag = l[0], body = l.slice(1);
      if (tag === ' ' || tag === '-') { if (src[pos] !== body) throw new Error(`patch does not apply at line ${pos + 1}`); pos++; if (tag === ' ') out.push(body); }
      else if (tag === '+') out.push(body);
    }
    i--;
  }
  while (pos < src.length) out.push(src[pos++]);
  return out.length ? out.join('\n') + (hadNl || !src.length ? '\n' : '') : '';
}

// ---- HTML report page -------------------------------------------------------------

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Two fixes every report table needs, applied once here so no agent can forget
 * them: a table that is not already inside <div class="wrap"> gets one, so a wide
 * table scrolls inside the page on a phone instead of pushing the page sideways;
 * and header cells get scope="col" (in <thead>, or in a row of only headers) or
 * scope="row", which is what screen readers use to announce a cell with its headers.
 */
export function accessibleTables(html) {
  let out = ''; let i = 0; let depth = 0; const wrapped = [];
  const re = /<table\b|<\/table\s*>/gi; let m;
  while ((m = re.exec(html))) {
    if (m[0][1] !== '/') {
      const inWrap = /<div class="wrap"[^>]*>\s*$/.test(html.slice(Math.max(0, m.index - 120), m.index));
      const wrap = depth === 0 && !inWrap;
      wrapped.push(wrap); depth++;
      if (wrap) { out += html.slice(i, m.index) + '<div class="wrap">'; i = m.index; }
    } else if (depth > 0) {
      depth--; const wrap = wrapped.pop(); const end = m.index + m[0].length;
      if (wrap) { out += html.slice(i, end) + '</div>'; i = end; }
    }
  }
  out += html.slice(i);
  return out.replace(/<table\b[\s\S]*?<\/table\s*>/gi, tidyTable);
}

const CELL = /<(td|th)(?![a-z])([^>]*)>/gi;
const addScope = (row, kind, firstOnly = false) => { let n = 0; return row.replace(/<th(?![a-z])(?![^>]*\bscope=)/gi, (m) => (firstOnly && n++ > 0 ? m : `<th scope="${kind}"`)); };
const addNum = (attrs) => (/\bclass="/.test(attrs) ? (/\bclass="[^"]*\bnum\b/.test(attrs) ? attrs : attrs.replace(/\bclass="/, 'class="num ')) : `${attrs} class="num"`);

function tidyTable(t) {
  const nested = (t.match(/<table\b/gi) || []).length > 1;
  const theadEnd = t.search(/<\/thead\s*>/i);
  const rows = [...t.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi)].map((m, n) => {
    const cells = [...m[0].matchAll(CELL)].map((c) => ({ tag: c[1].toLowerCase(), attrs: c[2] }));
    const allTh = cells.length > 0 && cells.every((c) => c.tag === 'th');
    return { text: m[0], at: m.index, cells, head: (theadEnd >= 0 && m.index < theadEnd) || (theadEnd < 0 && n === 0 && allTh), allTh };
  });
  // Header cells over a column of right-aligned numbers are right-aligned too.
  const numCols = new Set();
  if (!nested && !/\b(col|row)span=/i.test(t)) {
    const body = rows.filter((r) => !r.head && r.cells.some((c) => c.tag === 'td'));
    const width = Math.max(0, ...rows.map((r) => r.cells.length));
    for (let j = 0; j < width; j++) {
      const col = body.map((r) => r.cells[j]).filter(Boolean);
      if (col.length && col.every((c) => c.tag === 'td' && /\bclass="[^"]*\bnum\b/.test(c.attrs))) numCols.add(j);
    }
  }
  let out = ''; let i = 0;
  for (const r of rows) {
    let row = r.text;
    if (r.head) {
      if (numCols.size) { let j = -1; row = row.replace(CELL, (m, tag, attrs) => { j++; return tag.toLowerCase() === 'th' && numCols.has(j) ? `<${tag}${addNum(attrs)}>` : m; }); }
      row = addScope(row, 'col');
    } else row = r.allTh ? addScope(row, 'row', true) : addScope(row, 'row');
    out += t.slice(i, r.at) + row; i = r.at + r.text.length;
  }
  return out + t.slice(i);
}

/**
 * A self-contained HTML page: inline CSS only, no scripts, no fonts, no network.
 * CSP: default-src 'none'; style-src 'unsafe-inline'. bodyHtml must already be escaped.
 */
export function htmlPage({ title, bodyHtml, footer = '', lang = 'en' }) {
  bodyHtml = accessibleTables(String(bodyHtml ?? ''));
  const htmlLang = HTML_LANG[normLang(lang)] || 'en';
  return `<!doctype html>
<html lang="${htmlLang}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1c1a;--mut:#6b6760;--line:#e4e0d8;--ok:#1f7a4d;--bad:#b42318;--warn:#a15c07;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161514;--fg:#ecebe8;--mut:#a29d94;--line:#34312d;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--card:#1f1e1c}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,"Hiragino Sans","Yu Gothic UI","Microsoft YaHei","PingFang SC","Malgun Gothic","Apple SD Gothic Neo","Noto Sans CJK",sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.mut{color:var(--mut)}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
table{border-collapse:collapse;width:100%;background:var(--card);font-size:14px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{font-weight:600}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.tiles{display:flex;gap:12px;flex-wrap:wrap}.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:120px}
.tile b{display:block;font-size:22px}code{font-size:13px;overflow-wrap:anywhere}pre{overflow-x:auto}
.wrap{overflow-x:auto;max-width:100%}svg,img{max-width:100%;height:auto}figure{margin:16px 0}p,li,h1,h2,h3{overflow-wrap:break-word}
</style></head><body><main>
${bodyHtml}
<p class="mut" style="margin-top:32px">${escapeHtml(footer)}</p>
</main></body></html>
`;
}

// ---------------------------------------------------------------------------
// Untrusted text in file names and Markdown
// ---------------------------------------------------------------------------

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Turn untrusted text (a vendor id, a contact name, a ticket number) into one
 * safe file-name segment: no slashes, no "..", no control or direction-override
 * characters, no leading dot, no Windows-reserved name. Keeps letters and digits of
 * every script (架空商事, 가상상사, Müller becomes Muller), dot, dash and underscore;
 * everything else becomes a dash. Names in Japanese, Chinese or Korean used to become
 * the fallback, so two such vendors wrote the same file.
 */
export function safeFileName(s, { fallback = 'item', max = 80 } = {}) {
  let t = String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
  t = t.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/\.{2,}/g, '.').replace(/-{2,}/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  if (t.length > max) t = t.slice(0, max).replace(/[.-]+$/, '');
  if (!t) t = fallback;
  if (WIN_RESERVED.test(t.split('.')[0])) t = '_' + t;
  return t;
}

/** Lowercase slug for file names and calendar ids, in any script ("Acme, Inc." -> "acme-inc", "株式会社架空商事" stays). */
export function slugify(s, fallback = 'item', max = 60) {
  const t = String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return t && !WIN_RESERVED.test(t) ? t : t ? '_' + t : fallback;
}

/** Make file names unique within one batch: a second "acme.md" becomes "acme-2.md". */
export function uniqueNames() {
  const seen = new Map();
  return (name) => {
    const k = name.toLowerCase(); const n = (seen.get(k) || 0) + 1; seen.set(k, n);
    if (n === 1) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
  };
}

function escapeMdSegment(seg) {
  // Raw HTML: "<" that could open a tag, comment or declaration becomes "\<",
  // which every CommonMark renderer shows as a literal "<". Plain autolinks
  // (<https://…>, <mailto:…>, <name@host>) are left alone.
  let out = seg.replace(/<(?=[A-Za-z/!?])/g, (m, i) => {
    let b = 0; while (i - 1 - b >= 0 && seg[i - 1 - b] === '\\') b++;
    if (b % 2 === 1) return m;
    const rest = seg.slice(i);
    if (/^<(?:https?:\/\/|mailto:)[^\s<>]*>/i.test(rest)) return m;
    if (/^<[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}>/.test(rest)) return m;
    return '\\<';
  });
  // Inline images that would be fetched from the network when the file is previewed.
  out = out.replace(/!\[(?=[^\]\n]*\]\(\s*<?\s*(?:https?:)?\/\/)/gi, '!\\[');
  // Reference-style images (![alt][ref]) resolve to a URL defined elsewhere, so they are turned into text too.
  out = out.replace(/!\[(?=[^\]\n]*\]\s?\[[^\]\n]*\])/g, '!\\[');
  return out;
}

function mapOutsideCodeSpans(line, fn) {
  let out = ''; let i = 0; let text = '';
  while (i < line.length) {
    if (line[i] !== '`') { text += line[i++]; continue; }
    let n = 0; while (line[i + n] === '`') n++;
    // find a closing run of exactly n backticks on the same line
    let j = i + n; let close = -1;
    while (j < line.length) {
      if (line[j] !== '`') { j++; continue; }
      let k = 0; while (line[j + k] === '`') k++;
      if (k === n) { close = j; break; }
      j += k;
    }
    if (close < 0) { text += line.slice(i, i + n); i += n; continue; }
    out += fn(text) + line.slice(i, close + n); text = ''; i = close + n;
  }
  return out + fn(text);
}

/**
 * Neutralise markup in Markdown built from untrusted data. Outside fenced code
 * and inline code, raw HTML becomes literal text ("<script>" becomes
 * "\<script>"), and remote or reference-style images become plain text, so a
 * Markdown viewer shows what a spreadsheet cell contained instead of rendering
 * it or fetching an image for it. A whole-line, closed HTML comment is kept
 * (agents use it for "draft only" banners). Links are left as they are.
 * Idempotent.
 */
export function safeMarkdown(text) {
  let fence = null;
  return String(text ?? '').split('\n').map((line) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m[0].length).trim()) fence = null;
      return line;
    }
    if (m && !(m[1][0] === '`' && line.slice(m[0].length).includes('`'))) { fence = m[1]; return line; }
    if (/^\s*<!--(?:(?!-->).)*-->\s*$/.test(line)) return line;
    return mapOutsideCodeSpans(line, escapeMdSegment);
  }).join('\n');
}
