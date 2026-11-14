import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { toCsv } from 'mythos-agent-core';

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
const tokens = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'are', 'what', 'which', 'this', 'that', 'shall', 'should', 'per', 'please', 'confirm', 'clarify', 'detail', 'at', 'of', 'on', 'in', 'to', 'is']);
const jaccard = (a, b) => { const x = tokens(a); const y = tokens(b); const i = [...x].filter((w) => y.has(w)).length; return x.size + y.size - i ? i / (x.size + y.size - i) : 0; };

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
  for (let i = 0; i < items.length; i++) for (let j = 0; j < i; j++) {
    const x = items[i]; const y = items[j];
    if (OPEN.has(x.status) || x.status === 'draft') if (jaccard(`${x.subject} ${x.question}`, `${y.subject} ${y.question}`) >= dupAt) { x.flags.push('possible_duplicate'); x.notes.push(`Similar to RFI ${y.rfi_no} (${y.status}).`); }
  }
  for (const it of items) it.flags = [...new Set(it.flags)];
  const specIds = new Set([...index.values()].flat().filter((d) => d.type === 'spec').map((d) => docKey(d.doc_id)));
  const subs = submittals.map((s) => {
    const it = { submittal_no: pick(s, 'submittal_no', 'submittal', 'number', 'id'), spec_section: pick(s, 'spec_section', 'section'), description: pick(s, 'description', 'title'), status: (pick(s, 'status') || 'not_submitted').toLowerCase().replace(/\s+/g, '_'), required_by: pick(s, 'required_by', 'due'), submitted_date: pick(s, 'submitted_date', 'submitted'), returned_date: pick(s, 'returned_date', 'returned'), revision: pick(s, 'revision', 'rev'), flags: [], notes: [] };
    const req = parseDate(it.required_by); const sub = parseDate(it.submitted_date); const ret = parseDate(it.returned_date);
    if (it.status === 'not_submitted' && req !== null && req < now) { it.flags.push('overdue_submission'); it.notes.push(`Required by ${it.required_by}.`); }
    if (['submitted', 'in_review'].includes(it.status) && sub !== null && ret === null && days(now, sub) > reviewDays) { it.flags.push('review_overdue'); it.notes.push(`With the reviewer for ${days(now, sub)} days (review period ${reviewDays}).`); }
    if (['revise_resubmit', 'rejected'].includes(it.status)) { it.flags.push('resubmit_pending'); it.notes.push(`Returned ${it.returned_date || ''} as ${it.status.replace(/_/g, ' ')}; resubmit.`); }
    if (it.spec_section && specIds.size && !specIds.has(docKey(it.spec_section))) it.flags.push('unknown_spec_section');
    return it;
  });
  const n = (arr, f) => arr.filter((x) => x.flags.includes(f)).length;
  return {
    as_of: iso(now), rfis: items.length, open: items.filter((x) => OPEN.has(x.status)).length, overdue: n(items, 'overdue'), superseded_reference: n(items, 'superseded_reference'), unknown_reference: n(items, 'unknown_reference'), missing_references: n(items, 'missing_references'), possible_duplicate: n(items, 'possible_duplicate'),
    submittals: subs.length, submittal_issues: subs.filter((x) => x.flags.length).length,
    items, submittal_items: subs,
    note: 'A log check against the index you provide. Epeius does not interpret drawings, give design or engineering advice, or decide responsibility.',
  };
}
export const RFI_COLUMNS = ['rfi_no', 'subject', 'status', 'sent_date', 'due_date', 'days_open', 'ball_in_court', 'references', 'flags', 'notes', 'next_action', 'owner'];
export const SUB_COLUMNS = ['submittal_no', 'spec_section', 'description', 'status', 'required_by', 'submitted_date', 'returned_date', 'flags', 'notes', 'owner'];
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
