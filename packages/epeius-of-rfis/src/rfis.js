import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { toCsv, foldText } from 'mythos-agent-core';

const DAY = 86400000;
const norm = (k) => String(k).trim().toLowerCase().replace(/[\s-]+/g, '_');
export function pick(r, ...keys) {
  for (const k of keys) for (const key of Object.keys(r || {})) if (norm(key) === k && String(r[key] ?? '').trim() !== '') return String(r[key]).trim();
  return '';
}
export function parseDate(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim()); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; }
const iso = (t) => new Date(t).toISOString().slice(0, 10);
function asOfMs(as_of) {
  if (as_of) { const t = parseDate(as_of); if (t === null) throw new Error(`as_of must be YYYY-MM-DD, got "${as_of}"`); return t; }
  const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}
const days = (a, b) => Math.round((a - b) / DAY);
export const docKey = (s) => String(s || '').toUpperCase().replace(/[\s._-]+/g, '');

/** Parse one reference: "A-201", "A-201 rev 2", "Spec 08 71 00 2.3.B", "S-101 detail 4". */
export function parseRef(s) {
  const raw = String(s || '').trim(); if (!raw) return null;
  const spec = /(\d{2})\s?(\d{2})\s?(\d{2})(?:\s*[,§]?\s*(\d+(?:\.\d+)*(?:\.[A-Z])?))?/i.exec(raw);
  const sheet = /\b([A-Z]{1,3})-?(\d{1,4}(?:\.\d+)?)\b/.exec(raw.replace(/^spec(ification)?\s+/i, ''));
  const rev = /\b(?:rev(?:ision)?\.?|r)\s*([0-9A-Z]+)\b/i.exec(raw);
  if (spec && (!sheet || /^spec|^\d/i.test(raw))) return { raw, type: 'spec', id: `${spec[1]} ${spec[2]} ${spec[3]}`, paragraph: spec[4] || '', revision: rev ? rev[1].toUpperCase() : '' };
  if (sheet) return { raw, type: 'drawing', id: `${sheet[1].toUpperCase()}-${sheet[2]}`, paragraph: '', revision: rev ? rev[1].toUpperCase() : '' };
  return { raw, type: 'unknown', id: raw, paragraph: '', revision: rev ? rev[1].toUpperCase() : '' };
}
export const splitRefs = (s) => (Array.isArray(s) ? s : String(s || '').split(/[;\n]+/)).map((x) => String(x).trim()).filter(Boolean);

export function indexDocs(docs) {
  const m = new Map();
  for (const d of docs) {
    const id = pick(d, 'doc_id', 'sheet', 'section', 'id'); if (!id) continue;
    const doc = { doc_id: id, type: pick(d, 'type').toLowerCase(), title: pick(d, 'title', 'name'), revision: pick(d, 'revision', 'rev').toUpperCase(), issued: pick(d, 'issued', 'date'), status: (pick(d, 'status') || 'current').toLowerCase(), file: pick(d, 'file', 'text_file') };
    const k = docKey(id); if (!m.has(k)) m.set(k, []); m.get(k).push(doc);
  }
  return m;
}
/** Resolve a parsed reference against the index. */
export function resolve(ref, index) {
  const list = index.get(docKey(ref.id)) || [];
  if (!list.length) return { ...ref, found: false, problem: 'unknown_reference' };
  const current = list.find((d) => d.status === 'current') || list[list.length - 1];
  const asked = ref.revision ? list.find((d) => d.revision === ref.revision) : current;
  if (ref.revision && !asked) return { ...ref, found: true, doc: current, problem: 'unknown_revision' };
  if (asked.status === 'superseded' || (ref.revision && current.revision !== ref.revision && current.status === 'current')) return { ...ref, found: true, doc: asked, current, problem: 'superseded_reference' };
  return { ...ref, found: true, doc: asked, problem: '' };
}
const NON_ASCII = /[^\x00-\x7f]/;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
/**
 * Word set of a subject or question. Japanese and Chinese have no spaces between words,
 * so their text adds overlapping character pairs (Korean too); accents are ignored.
 * Such subjects used to give no words at all, so their duplicates were never found.
 */
const tokens = (s) => {
  const raw = String(s || '');
  if (!NON_ASCII.test(raw)) return new Set(raw.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
  const t = foldText(raw); const out = new Set();
  for (const w of t.replace(CJK_RUN, ' ').split(/\s+/)) if (w.length > 2 && !STOP.has(w)) out.add(w);
  for (const run of t.match(CJK_RUN) || []) for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  return out;
};
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'are', 'what', 'which', 'this', 'that', 'shall', 'should', 'per', 'please', 'confirm', 'clarify', 'detail', 'at', 'of', 'on', 'in', 'to', 'is']);

const OPEN = new Set(['open', 'sent', 'pending', 'issued', 'in_review']);
export function reviewLog(docs, rfis = [], submittals = [], a = {}) {
  const now = asOfMs(a.as_of); const index = indexDocs(docs); const reviewDays = Number(a.review_days) || 14; const dupAt = Number(a.duplicate_similarity) || 0.6;
  const items = rfis.map((r) => {
    const it = { rfi_no: pick(r, 'rfi_no', 'rfi', 'number', 'id'), subject: pick(r, 'subject', 'title'), status: (pick(r, 'status') || 'open').toLowerCase().replace(/\s+/g, '_'), sent_date: pick(r, 'sent_date', 'sent', 'date_sent'), due_date: pick(r, 'due_date', 'response_due', 'due'), answered_date: pick(r, 'answered_date', 'answered', 'response_date'), ball_in_court: pick(r, 'ball_in_court', 'with', 'assigned_to'), cost_impact: pick(r, 'cost_impact'), schedule_impact: pick(r, 'schedule_impact'), references: splitRefs(pick(r, 'references', 'refs', 'reference')), question: pick(r, 'question', 'description'), flags: [], notes: [] };
    const open = OPEN.has(it.status); const sent = parseDate(it.sent_date); const due = parseDate(it.due_date); const ans = parseDate(it.answered_date);
    it.days_open = sent === null ? null : days(ans !== null && !open ? ans : now, sent);
    if (open && due !== null && due < now) { it.flags.push('overdue'); it.days_overdue = days(now, due); it.notes.push(`Response was due ${it.due_date} (${it.days_overdue} days ago); ball in court: ${it.ball_in_court || 'unknown'}.`); }
    if (open && due === null) it.flags.push('no_due_date');
    if (!it.references.length) it.flags.push('missing_references');
    for (const ref of it.references.map(parseRef)) {
      const res = resolve(ref, index);
      if (res.problem === 'unknown_reference') { it.flags.push('unknown_reference'); it.notes.push(`"${ref.raw}" is not in the document index.`); }
      if (res.problem === 'unknown_revision') { it.flags.push('unknown_revision'); it.notes.push(`"${ref.raw}": revision ${ref.revision} is not in the index (current ${res.doc.revision}).`); }
      if (res.problem === 'superseded_reference') { it.flags.push('superseded_reference'); it.notes.push(`"${ref.raw}" cites ${res.doc.doc_id} rev ${res.doc.revision}; current is rev ${(res.current || res.doc).revision}${res.current && res.current.issued ? ` (${res.current.issued})` : ''}.`); }
    }
    if (open && (!it.cost_impact || !it.schedule_impact)) it.flags.push('impact_unstated');
    return it;
  });
  // Possible duplicates: an open or draft RFI against every earlier RFI. Word sets are
  // built once, and only RFIs that share one of the rarest words of each can reach the
  // similarity (prefix filtering); same result as comparing every pair.
  const sets = items.map((x) => tokens(`${x.subject} ${x.question}`));
  const sim = (x, y) => { let i = 0; for (const w of x) if (y.has(w)) i++; return x.size + y.size - i ? i / (x.size + y.size - i) : 0; };
  const earlier = (i) => {
    if (!(dupAt > 0)) return Array.from({ length: i }, (_, j) => j);
    const js = new Set(); for (const w of prefixOf[i]) for (const j of post.get(w)) { if (j >= i) break; js.add(j); }
    return [...js].sort((p, q) => p - q);
  };
  const df = new Map(); for (const x of sets) for (const w of x) df.set(w, (df.get(w) || 0) + 1);
  const prefixOf = sets.map((x) => { const ws = [...x].sort((p, q) => df.get(p) - df.get(q) || (p < q ? -1 : p > q ? 1 : 0)); return ws.slice(0, Math.max(0, ws.length - Math.ceil(dupAt * ws.length - 1e-9) + 1)); });
  const post = new Map(); prefixOf.forEach((ws, i) => { for (const w of ws) { if (!post.has(w)) post.set(w, []); post.get(w).push(i); } });
  for (let i = 0; i < items.length; i++) {
    const x = items[i]; if (!(OPEN.has(x.status) || x.status === 'draft')) continue;
    // At most five are named, so a log full of near-identical RFIs stays readable.
    let similar = 0;
    for (const j of earlier(i)) { const y = items[j]; if (sim(sets[i], sets[j]) >= dupAt) { similar++; if (similar === 1) x.flags.push('possible_duplicate'); if (similar <= 5) x.notes.push(`Similar to RFI ${y.rfi_no} (${y.status}).`); } }
    if (similar > 5) x.notes.push(`Similar to ${similar - 5} more earlier RFI(s).`);
  }
  for (const it of items) it.flags = [...new Set(it.flags)];
  const specIds = new Set([...index.values()].flat().filter((d) => d.type === 'spec').map((d) => docKey(d.doc_id)));
  const subs = submittals.map((s) => {
    const it = { submittal_no: pick(s, 'submittal_no', 'submittal', 'number', 'id'), spec_section: pick(s, 'spec_section', 'section'), description: pick(s, 'description', 'title'), status: (pick(s, 'status') || 'not_submitted').toLowerCase().replace(/\s+/g, '_'), required_by: pick(s, 'required_by', 'due'), submitted_date: pick(s, 'submitted_date', 'submitted'), returned_date: pick(s, 'returned_date', 'returned'), revision: pick(s, 'revision', 'rev'), ball_in_court: pick(s, 'ball_in_court', 'with', 'assigned_to'), flags: [], notes: [] };
    const req = parseDate(it.required_by); const sub = parseDate(it.submitted_date); const ret = parseDate(it.returned_date);
    if (it.status === 'not_submitted' && req !== null && req < now) { it.flags.push('overdue_submission'); it.notes.push(`Required by ${it.required_by}.`); }
    if (['submitted', 'in_review'].includes(it.status) && sub !== null && ret === null && days(now, sub) > reviewDays) { it.flags.push('review_overdue'); it.notes.push(`With the reviewer for ${days(now, sub)} days (review period ${reviewDays}).`); }
    if (['revise_resubmit', 'rejected'].includes(it.status)) { it.flags.push('resubmit_pending'); it.notes.push(`Returned ${it.returned_date || ''} as ${it.status.replace(/_/g, ' ')}; resubmit.`); }
    if (it.spec_section && specIds.size && !specIds.has(docKey(it.spec_section))) it.flags.push('unknown_spec_section');
    return it;
  });
  const n = (arr, f) => arr.filter((x) => x.flags.includes(f)).length;
  return {
    as_of: iso(now), review_days: reviewDays, rfis: items.length, open: items.filter((x) => OPEN.has(x.status)).length, overdue: n(items, 'overdue'), superseded_reference: n(items, 'superseded_reference'), unknown_reference: n(items, 'unknown_reference'), missing_references: n(items, 'missing_references'), possible_duplicate: n(items, 'possible_duplicate'),
    submittals: subs.length, submittal_issues: subs.filter((x) => x.flags.length).length,
    items, submittal_items: subs,
    note: 'A log check against the index you provide. Epeius does not interpret drawings, give design or engineering advice, or decide responsibility.',
  };
}
export const RFI_COLUMNS = ['rfi_no', 'subject', 'status', 'sent_date', 'due_date', 'days_open', 'ball_in_court', 'references', 'flags', 'notes', 'next_action', 'owner'];
export const SUB_COLUMNS = ['submittal_no', 'spec_section', 'description', 'status', 'required_by', 'submitted_date', 'returned_date', 'ball_in_court', 'flags', 'notes', 'owner'];
export const rfiCsv = (r) => toCsv(r.items.map((i) => ({ ...i, references: i.references.join('; '), flags: i.flags.join('; '), notes: i.notes.join(' '), next_action: '', owner: '' })), RFI_COLUMNS);
export const subCsv = (r) => toCsv(r.submittal_items.map((i) => ({ ...i, flags: i.flags.join('; '), notes: i.notes.join(' '), owner: '' })), SUB_COLUMNS);
export function logMarkdown(r) {
  const L = ['# RFI and submittal log review', '', `As of ${r.as_of}: ${r.rfis} RFI(s), ${r.open} open, ${r.overdue} overdue; ${r.superseded_reference} cite a superseded revision, ${r.unknown_reference} cite a document not in the index. ${r.submittals} submittal(s), ${r.submittal_issues} with issues.`, '', `> ${r.note}`, '', '## RFIs', ''];
  for (const i of r.items) L.push(`- **RFI ${i.rfi_no}** ${i.subject} (${i.status}${i.days_open !== null ? `, ${i.days_open} days` : ''})${i.flags.length ? `: ${i.flags.join(', ')}` : ''}${i.notes.length ? ` — ${i.notes.join(' ')}` : ''}`);
  L.push('', '## Submittals', '');
  for (const s of r.submittal_items) L.push(`- **${s.submittal_no}** ${s.spec_section} ${s.description} (${s.status})${s.flags.length ? `: ${s.flags.join(', ')}` : ''}${s.notes.length ? ` — ${s.notes.join(' ')}` : ''}`);
  return L.join('\n') + '\n';
}

/** Cite lines from a document's text extract that contain any search term. */
export function citeLines(text, terms, max = 3) {
  const ts = terms.map((t) => String(t).toLowerCase()).filter(Boolean); if (!ts.length) return [];
  return String(text).split('\n').map((l, i) => ({ line: i + 1, text: l.trim() })).filter((l) => l.text && ts.some((t) => l.text.toLowerCase().includes(t))).slice(0, max).map((l) => ({ ...l, text: l.text.length > 200 ? l.text.slice(0, 197) + '…' : l.text }));
}
export const nextRfiNo = (rfis) => String(Math.max(0, ...rfis.map((r) => parseInt(pick(r, 'rfi_no', 'rfi', 'number', 'id'), 10)).filter(Number.isFinite)) + 1).padStart(3, '0');
export const MARKERS = /\[(MISSING REFERENCE|CHECK REVISION|NO CITATION|TO CONFIRM)[^\]]*\]/g;

/** Build an RFI draft that cites only the documents provided. */
export function draftRfi(a, docs, rfis, rootDir) {
  for (const k of ['subject', 'question']) if (!String(a[k] ?? '').trim()) throw new Error(`${k} is required (Epeius does not write the question for you)`);
  const index = indexDocs(docs); const refs = splitRefs(a.references); const terms = [].concat(a.search || []);
  const no = a.rfi_no || nextRfiNo(rfis); const cites = []; const L = [];
  for (const raw of refs) {
    const res = resolve(parseRef(raw), index);
    if (!res.found) { cites.push(`- [MISSING REFERENCE: "${raw}" is not in the document index]`); continue; }
    const d = res.doc; const head = `- ${d.doc_id} rev ${d.revision || '—'}, ${d.title}${res.paragraph ? `, ¶${res.paragraph}` : ''}${d.issued ? ` (issued ${d.issued})` : ''}`;
    if (res.problem === 'superseded_reference' || res.problem === 'unknown_revision') cites.push(`${head} [CHECK REVISION: current is rev ${(res.current || d).revision}]`); else cites.push(head);
    const fp = d.file ? join(rootDir, d.file) : null;
    if (fp && existsSync(fp) && terms.length) {
      const lines = citeLines(readFileSync(fp, 'utf8'), terms);
      if (lines.length) for (const l of lines) cites.push(`    - ${d.file}:${l.line} "${l.text}"`); else cites.push(`    - [NO CITATION: no line in ${d.file} mentions ${terms.map((t) => `"${t}"`).join(', ')}]`);
    } else if (!fp) cites.push('    - (no text extract in the index; cite the sheet or section above)');
  }
  if (!refs.length) cites.push('- [MISSING REFERENCE: no drawing or spec reference given]');
  L.push('DRAFT — not sent. A person reviews and sends it.', '', `RFI ${no}: ${a.subject}`, `Project: ${a.project || '[TO CONFIRM: project]'}`, `To: ${a.to || '[TO CONFIRM: architect, engineer or GC]'}`, `From: ${a.from || '[TO CONFIRM: your name and company]'}`, `Response needed by: ${a.needed_by || '[TO CONFIRM: date]'}`, '', '## Question', '', String(a.question).trim(), '', '## References', '', ...cites, '');
  if (a.suggested_solution) L.push('## Suggested solution (for the design team to accept or reject)', '', String(a.suggested_solution).trim(), '');
  L.push('## Impact', '', `Cost: ${a.cost_impact || '[TO CONFIRM]'}`, `Schedule: ${a.schedule_impact || '[TO CONFIRM]'}`, '');
  const text = L.join('\n');
  return { rfi_no: no, text, open_markers: (text.match(MARKERS) || []).length, markers: [...new Set((text.match(MARKERS) || []).map((m) => m.split(':')[0].replace('[', '').replace(']', '')))] };
}

// ---------- 0.2.0: ball-in-court aging and chase list ----------
export const AGE_BUCKETS = [['0-7', 0, 7], ['8-14', 8, 14], ['15-30', 15, 30], ['31+', 31, Infinity]];
const bucketOf = (d) => (AGE_BUCKETS.find(([, lo, hi]) => d >= lo && d <= hi) || AGE_BUCKETS[0])[0];
const SUB_PARTY = { submitted: 'Reviewer', in_review: 'Reviewer', not_submitted: 'Contractor', revise_resubmit: 'Contractor', rejected: 'Contractor' };

/**
 * Who holds each open item and for how long. RFIs age from sent_date; submittals with the
 * reviewer from submitted_date, returned ones from returned_date, unsent ones from required_by
 * (only once that date has passed). Closed and approved items are left out.
 */
export function ballInCourt(r) {
  const now = parseDate(r.as_of); const open = [];
  for (const i of r.items) {
    if (!OPEN.has(i.status) || i.days_open === null) continue;
    open.push({ item: `RFI ${i.rfi_no}`, kind: 'rfi', party: i.ball_in_court || 'unknown', age_days: i.days_open, overdue: i.flags.includes('overdue'), days_overdue: i.days_overdue || 0, since: i.sent_date, due: i.due_date, subject: i.subject });
  }
  for (const s of r.submittal_items) {
    const party = s.ball_in_court || SUB_PARTY[s.status]; if (!party) continue;
    const from = ['submitted', 'in_review'].includes(s.status) ? s.submitted_date : ['revise_resubmit', 'rejected'].includes(s.status) ? s.returned_date : s.required_by;
    const t = parseDate(from); if (t === null || t > now) continue;
    const overdue = s.flags.includes('overdue_submission') || s.flags.includes('review_overdue');
    const reviewDays = r.review_days || 14;
    open.push({ item: `Submittal ${s.submittal_no}`, kind: 'submittal', party, age_days: days(now, t), overdue, days_overdue: s.flags.includes('review_overdue') ? days(now, t) - reviewDays : s.flags.includes('overdue_submission') ? days(now, t) : 0, since: from, due: s.required_by, subject: s.description });
  }
  const parties = new Map();
  for (const o of open) {
    const p = parties.get(o.party) || { party: o.party, open_items: 0, rfis: 0, submittals: 0, overdue: 0, ...Object.fromEntries(AGE_BUCKETS.map(([b]) => [b, 0])), oldest_days: 0, oldest_item: '' };
    p.open_items++; p[o.kind === 'rfi' ? 'rfis' : 'submittals']++; if (o.overdue) p.overdue++; p[bucketOf(o.age_days)]++;
    if (o.age_days > p.oldest_days || !p.oldest_item) { p.oldest_days = o.age_days; p.oldest_item = o.item; }
    parties.set(o.party, p);
  }
  const reason = (o) => o.overdue
    ? `${o.item} with ${o.party}: ${o.kind === 'rfi' ? 'response' : o.since === o.due ? 'submission' : 'review'} ${o.days_overdue} day(s) overdue${o.due ? ` (due ${o.due})` : ''}; ${o.age_days} day(s) in their court.`
    : `${o.item} with ${o.party}: ${o.age_days} day(s) in their court${o.due && o.kind === 'rfi' ? `, due ${o.due}` : ''}.`;
  const chase = open.slice().sort((a, b) => (b.overdue - a.overdue) || (b.days_overdue - a.days_overdue) || (b.age_days - a.age_days) || a.item.localeCompare(b.item)).map((o, n) => ({ rank: n + 1, ...o, reason: reason(o) }));
  return { as_of: r.as_of, buckets: AGE_BUCKETS.map(([b]) => b), parties: [...parties.values()].sort((a, b) => b.overdue - a.overdue || b.oldest_days - a.oldest_days || a.party.localeCompare(b.party)), chase_list: chase, open_items: open.length };
}
export const BIC_COLUMNS = ['party', 'open_items', 'rfis', 'submittals', 'overdue', ...AGE_BUCKETS.map(([b]) => b), 'oldest_days', 'oldest_item'];
export const bicCsv = (b) => toCsv(b.parties, BIC_COLUMNS);
export function bicMarkdown(b) {
  const L = ['## Ball in court', '', `| Party | Open | Overdue | ${b.buckets.join(' d | ')} d | Oldest |`, `|---|---|---|${b.buckets.map(() => '---|').join('')}---|`];
  for (const p of b.parties) L.push(`| ${p.party} | ${p.open_items} | ${p.overdue} | ${b.buckets.map((k) => p[k]).join(' | ')} | ${p.oldest_item} (${p.oldest_days} d) |`);
  if (!b.parties.length) L.push(`| none | 0 | 0 | ${b.buckets.map(() => '0').join(' | ')} | |`);
  L.push('', '## Chase list (most overdue first)', '', ...b.chase_list.map((c) => `${c.rank}. ${c.reason}`), '');
  return L.join('\n');
}

// ---------- 0.2.0: period-over-period log diff ----------
/** Compare an earlier RFI log export with the current one, keyed by RFI number. */
export function diffLogs(prevRows, curRows, { as_of, previous_as_of } = {}) {
  const now = asOfMs(as_of); const prevAt = previous_as_of ? asOfMs(previous_as_of) : now - 7 * DAY;
  const row = (r) => ({ rfi_no: pick(r, 'rfi_no', 'rfi', 'number', 'id'), subject: pick(r, 'subject', 'title'), status: (pick(r, 'status') || 'open').toLowerCase().replace(/\s+/g, '_'), due_date: pick(r, 'due_date', 'response_due', 'due'), ball_in_court: pick(r, 'ball_in_court', 'with', 'assigned_to'), answered_date: pick(r, 'answered_date', 'answered', 'response_date') });
  const prev = new Map(prevRows.map(row).filter((x) => x.rfi_no).map((x) => [x.rfi_no, x]));
  const cur = new Map(curRows.map(row).filter((x) => x.rfi_no).map((x) => [x.rfi_no, x]));
  const out = { as_of: iso(now), previous_as_of: iso(prevAt), added: [], removed: [], closed: [], reopened: [], status_changed: [], due_changed: [], ball_in_court_changed: [], newly_overdue: [] };
  for (const [no, c] of cur) {
    const p = prev.get(no);
    if (!p) out.added.push({ rfi_no: no, subject: c.subject, status: c.status });
    else {
      if (p.status !== c.status) {
        out.status_changed.push({ rfi_no: no, from: p.status, to: c.status });
        if (OPEN.has(p.status) && !OPEN.has(c.status) && c.status !== 'draft') out.closed.push({ rfi_no: no, subject: c.subject, to: c.status, answered_date: c.answered_date });
        if (!OPEN.has(p.status) && OPEN.has(c.status)) out.reopened.push({ rfi_no: no, subject: c.subject });
      }
      if (p.due_date !== c.due_date) out.due_changed.push({ rfi_no: no, from: p.due_date || '(none)', to: c.due_date || '(none)' });
      if (p.ball_in_court !== c.ball_in_court) out.ball_in_court_changed.push({ rfi_no: no, from: p.ball_in_court || '(none)', to: c.ball_in_court || '(none)' });
    }
    const due = parseDate(c.due_date);
    if (OPEN.has(c.status) && due !== null && due < now && due >= prevAt) out.newly_overdue.push({ rfi_no: no, subject: c.subject, due_date: c.due_date, ball_in_court: c.ball_in_court });
  }
  for (const [no, p] of prev) if (!cur.has(no)) out.removed.push({ rfi_no: no, subject: p.subject });
  out.changes = ['added', 'removed', 'closed', 'reopened', 'status_changed', 'due_changed', 'ball_in_court_changed', 'newly_overdue'].reduce((n, k) => n + out[k].length, 0);
  return out;
}
export function diffMarkdown(d) {
  const L = ['# RFI log changes', '', `From ${d.previous_as_of} to ${d.as_of}: ${d.changes} change(s).`, ''];
  const sec = (title, arr, f) => { L.push(`## ${title} (${arr.length})`, ''); for (const x of arr) L.push(`- ${f(x)}`); if (!arr.length) L.push('- none'); L.push(''); };
  sec('New', d.added, (x) => `RFI ${x.rfi_no} ${x.subject} (${x.status})`);
  sec('Closed', d.closed, (x) => `RFI ${x.rfi_no} ${x.subject}: ${x.to}${x.answered_date ? ` on ${x.answered_date}` : ''}`);
  sec('Reopened', d.reopened, (x) => `RFI ${x.rfi_no} ${x.subject}`);
  sec('Became overdue', d.newly_overdue, (x) => `RFI ${x.rfi_no} ${x.subject}: due ${x.due_date}, with ${x.ball_in_court || 'unknown'}`);
  sec('Due date changed', d.due_changed, (x) => `RFI ${x.rfi_no}: ${x.from} → ${x.to}`);
  sec('Ball in court changed', d.ball_in_court_changed, (x) => `RFI ${x.rfi_no}: ${x.from} → ${x.to}`);
  sec('Status changed', d.status_changed, (x) => `RFI ${x.rfi_no}: ${x.from} → ${x.to}`);
  sec('No longer in the log', d.removed, (x) => `RFI ${x.rfi_no} ${x.subject}`);
  return L.join('\n');
}

/** Calendar events for open RFI response dates and unsent submittals' required-by dates. */
export function dueEvents(r) {
  const ev = [];
  for (const i of r.items) if (OPEN.has(i.status) && parseDate(i.due_date) !== null) ev.push({ uid: `rfi-${i.rfi_no}@epeius.local`, date: i.due_date, summary: `RFI ${i.rfi_no} response due (${i.ball_in_court || 'ball in court unknown'})`, description: `${i.subject}${i.flags.length ? `\nFlags: ${i.flags.join(', ')}` : ''}`, reminders: [2], categories: ['RFI'] });
  for (const s of r.submittal_items) if (s.status === 'not_submitted' && parseDate(s.required_by) !== null) ev.push({ uid: `sub-${docKey(s.submittal_no)}@epeius.local`, date: s.required_by, summary: `Submittal ${s.submittal_no} required by`, description: `${s.spec_section} ${s.description}`, reminders: [7, 2], categories: ['Submittal'] });
  return ev;
}

// ---------- 0.2.0: drawing index from title-block text ----------
const cmpRev = (a, b) => { const x = String(a || ''); const y = String(b || ''); if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y); return x.localeCompare(y); };
/**
 * Read sheet number, title, revision and issue date from the text of a title block
 * (for example a PDF text export of the sheet's title block). Spec section headers
 * ("SECTION 08 71 00 - DOOR HARDWARE") are read as specs.
 */
export function parseTitleBlock(text, file = '') {
  const T = String(text || ''); const lines = T.split(/\r?\n/).map((l) => l.trim());
  const out = { file, doc_id: '', type: '', title: '', revision: '', issued: '', revisions: [], problems: [] };
  const spec = /SECTION\s+(\d{2})\s?(\d{2})\s?(\d{2})\s*[-–:]\s*([^\n(]+)/i.exec(T);
  const sheet = /\b(?:SHEET|DRAWING|DWG)\s*(?:NO\.?|NUMBER|#)?\s*[:#]?\s*([A-Z]{1,3})-?(\d{1,4}(?:\.\d+)?)\b/i.exec(T);
  if (sheet) { out.doc_id = `${sheet[1].toUpperCase()}-${sheet[2]}`; out.type = 'drawing'; }
  else if (spec) { out.doc_id = `${spec[1]} ${spec[2]} ${spec[3]}`; out.type = 'spec'; out.title = spec[4].trim().replace(/\s+/g, ' '); }
  const title = /^(?:SHEET\s+TITLE|DRAWING\s+TITLE|TITLE)\s*:\s*(.+)$/im.exec(T);
  if (title) out.title = title[1].trim();
  for (const l of lines) { const m = /^(?:REV\.?\s*)?([0-9]{1,2}|[A-Z])\s+(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(l); if (m) out.revisions.push({ revision: m[1], date: m[2], description: m[3].trim() }); }
  const explicit = /^(?:CURRENT\s+)?REV(?:ISION)?\.?\s*(?:NO\.?)?\s*[:#]\s*([0-9A-Z]{1,3})\b/im.exec(T);
  const latest = out.revisions.slice().sort((a, b) => cmpRev(a.revision, b.revision) || a.date.localeCompare(b.date)).at(-1);
  out.revision = (explicit ? explicit[1] : latest ? latest.revision : '').toUpperCase();
  if (explicit && latest && cmpRev(explicit[1], latest.revision) !== 0) out.problems.push(`revision field says ${explicit[1]} but the revision table goes to ${latest.revision}`);
  const date = /^(?:ISSUE\s+DATE|ISSUED|DATE)\s*:\s*(\d{4}-\d{2}-\d{2})/im.exec(T);
  const ofRev = out.revisions.find((r) => cmpRev(r.revision, out.revision) === 0);
  out.issued = ofRev ? ofRev.date : date ? date[1] : '';
  if (!out.doc_id) out.problems.push('no sheet number or spec section found');
  if (!out.revision) out.problems.push('no revision found');
  if (!out.title) out.problems.push('no title found');
  return out;
}

/** Compare parsed title blocks with the document index and propose index rows. */
export function indexFromTitleBlocks(parsed, docs = []) {
  const index = indexDocs(docs); const findings = []; const rows = []; const seen = new Set();
  for (const p of parsed) {
    if (!p.doc_id) { findings.push({ check: 'unreadable_title_block', file: p.file, detail: p.problems.join('; ') }); continue; }
    const k = docKey(p.doc_id); seen.add(k);
    const list = index.get(k) || []; const current = list.find((d) => d.status === 'current') || list.at(-1);
    if (!list.length) findings.push({ check: 'new_sheet', file: p.file, doc_id: p.doc_id, detail: `${p.doc_id} rev ${p.revision || '?'} (${p.title || 'untitled'}) is not in the document index.` });
    else if (p.revision && current.revision && cmpRev(p.revision, current.revision) > 0) findings.push({ check: 'index_behind', file: p.file, doc_id: p.doc_id, detail: `Title block shows rev ${p.revision}${p.issued ? ` (${p.issued})` : ''}; the index has rev ${current.revision} as current. RFIs citing rev ${current.revision} may now be on a superseded revision.` });
    else if (p.revision && current.revision && cmpRev(p.revision, current.revision) < 0) findings.push({ check: 'stale_sheet_file', file: p.file, doc_id: p.doc_id, detail: `Title block shows rev ${p.revision}; the index already has rev ${current.revision}. This file may be an old print.` });
    if (list.length && p.title && current.title && normTitle(p.title) !== normTitle(current.title)) findings.push({ check: 'title_differs', file: p.file, doc_id: p.doc_id, detail: `Title block says "${p.title}"; the index says "${current.title}".` });
    for (const pr of p.problems.filter((x) => /revision field/.test(x))) findings.push({ check: 'revision_conflict', file: p.file, doc_id: p.doc_id, detail: pr });
    if (!p.revision) findings.push({ check: 'no_revision', file: p.file, doc_id: p.doc_id, detail: 'No revision found in the title block.' });
    const prior = list.filter((d) => !p.revision || cmpRev(d.revision, p.revision) < 0);
    for (const d of prior) rows.push({ doc_id: d.doc_id, type: d.type, title: d.title, revision: d.revision, issued: d.issued, status: 'superseded', file: d.file, source: 'index' });
    rows.push({ doc_id: p.doc_id, type: p.type, title: p.title || current?.title || '', revision: p.revision, issued: p.issued, status: 'current', file: current && current.revision === p.revision ? current.file : '', source: `title block ${p.file}` });
  }
  for (const [k, list] of index) if (!seen.has(k)) for (const d of list) rows.push({ ...d, source: 'index (no title block given)' });
  for (const [k, list] of index) if (!seen.has(k) && list.some((d) => d.type === 'drawing' && d.status === 'current')) findings.push({ check: 'no_title_block', doc_id: list[0].doc_id, detail: `${list[0].doc_id} is a current drawing in the index but no title block text was given for it.` });
  const n = (c) => findings.filter((f) => f.check === c).length;
  return { sheets_read: parsed.length, new_sheet: n('new_sheet'), index_behind: n('index_behind'), unreadable: n('unreadable_title_block'), findings, rows };
}
const normTitle = (s) => (NON_ASCII.test(String(s)) ? foldText(s) : String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
export const INDEX_COLUMNS = ['doc_id', 'type', 'title', 'revision', 'issued', 'status', 'file', 'source'];

// ---------- 0.2.0: transmittal drafts ----------
export const PURPOSES = ['For construction', 'For review', 'For approval', 'For information', 'As requested', 'For bid'];
/** A transmittal that lists only documents in the index, each on its current revision unless one is asked for. */
export function draftTransmittal(a, docs, rootDir, sha) {
  if (!String(a.subject ?? '').trim()) throw new Error('subject is required');
  const index = indexDocs(docs); const refs = splitRefs(a.items); if (!refs.length) throw new Error('items is required: the drawing and spec references to transmit');
  const no = a.transmittal_no || 'TR-001'; const rows = []; const listed = [];
  refs.forEach((raw, i) => {
    const res = resolve(parseRef(raw), index);
    if (!res.found) { rows.push(`| ${i + 1} | [MISSING REFERENCE: "${raw}" is not in the document index] | | | | | |`); return; }
    const d = res.doc; const fp = d.file ? join(rootDir, d.file) : null; const h = fp && existsSync(fp) ? sha(readFileSync(fp, 'utf8')).slice(0, 12) : '';
    const rev = res.problem === 'superseded_reference' || res.problem === 'unknown_revision' ? `${d.revision || '—'} [CHECK REVISION: current is rev ${(res.current || d).revision}]` : (d.revision || '—');
    rows.push(`| ${i + 1} | ${d.doc_id} | ${rev} | ${d.title} | ${d.issued || ''} | ${a.copies || 1} | ${h} |`);
    listed.push({ doc_id: d.doc_id, revision: d.revision, title: d.title, issued: d.issued, extract_sha256_12: h, problem: res.problem || '' });
  });
  const L = ['DRAFT — not sent. A person reviews and sends it.', '', `Transmittal ${no}: ${a.subject}`, `Project: ${a.project || '[TO CONFIRM: project]'}`, `To: ${a.to || '[TO CONFIRM: recipient]'}`, `From: ${a.from || '[TO CONFIRM: your name and company]'}`, `Date: ${a.date || '[TO CONFIRM: date]'}`, `Purpose: ${a.purpose || '[TO CONFIRM: purpose]'}`, ...(a.action_by ? [`Action required by: ${a.action_by}`] : []), '', '## Documents', '', '| # | Document | Rev | Title | Issued | Copies | Extract sha256 (first 12) |', '|---|---|---|---|---|---|---|', ...rows, '', 'Only documents in the project document index are listed. The extract hash identifies the text extract held for that revision, if any.', ''];
  if (a.remarks) L.push('## Remarks', '', String(a.remarks).trim(), '');
  const text = L.join('\n'); const m = text.match(MARKERS) || [];
  return { transmittal_no: no, text, documents: listed, open_markers: m.length, markers: [...new Set(m.map((x) => x.split(':')[0].replace('[', '').replace(']', '')))] };
}
