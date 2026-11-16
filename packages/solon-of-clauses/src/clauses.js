// Solon of Clauses: check a contract's text against the user's own clause playbook.
// It finds words and numbers the playbook names and cites where they are. It does not
// interpret the contract, weigh risk, or give legal advice.
import { readFileSync } from 'node:fs';
import { readZip } from 'mythos-agent-core';
import { definedTerms } from './terms.js';

export const DISCLAIMER = 'Not legal advice. Solon checks the contract text against the checklist in your own playbook: it finds the words and numbers your playbook names and cites where they are. It does not interpret what a clause means, does not review the other side\'s interests, and is not a substitute for a lawyer.';
export const STATUSES = ['missing', 'prohibited_present', 'needs_attention', 'present', 'absent_ok', 'absent_optional'];
const RANK = { missing: 0, prohibited_present: 1, needs_attention: 2, present: 3, absent_ok: 4, absent_optional: 5 };
const norm = (s) => String(s).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();

export function validatePlaybook(p) {
  if (!p || typeof p !== 'object') throw new Error('playbook must be a JSON object');
  if (!String(p.source || '').trim()) throw new Error('playbook.source is required (whose playbook, which version)');
  if (!Array.isArray(p.clauses) || !p.clauses.length) throw new Error('playbook.clauses must list at least one clause');
  const ids = new Set();
  for (const c of p.clauses) {
    if (!c.id || !c.title) throw new Error('every clause needs an id and a title');
    if (ids.has(c.id)) throw new Error(`duplicate clause id ${c.id}`); ids.add(c.id);
    if (!Array.isArray(c.find) || !c.find.length) throw new Error(`clause ${c.id}: find must list words or phrases that show the clause is there`);
    if (c.value) { if (!c.value.pattern || String(c.value.pattern).length > 200) throw new Error(`clause ${c.id}: value.pattern is required and at most 200 characters`); try { new RegExp(c.value.pattern, 'i'); } catch (e) { throw new Error(`clause ${c.id}: value.pattern is not a valid regular expression (${e.message})`); } }
  }
  return p;
}

const HEAD = /^\s*(?:#{1,6}\s*)?(?:(?:section|article|clause)\s+)?(\d+(?:\.\d+)*)[.)]?\s+(?!\d)([^\n]{2,120}?)\s*$/i;
export function sections(text) {
  const lines = String(text).split(/\r?\n/); const out = []; let cur = { number: null, heading: '(preamble)', start: 1, lines: [] };
  lines.forEach((l, i) => {
    const m = HEAD.exec(l);
    const looksHead = m && (m[2].length <= 80) && !/[.;:,]$/.test(m[2].trim()) || (m && /^#/.test(l.trim()));
    if (looksHead) { out.push(cur); cur = { number: m[1], heading: m[2].replace(/[*_#]+/g, '').trim(), start: i + 1, lines: [] }; }
    cur.lines.push({ ln: i + 1, text: l });
  });
  out.push(cur);
  return out.filter((s) => s.lines.some((x) => x.text.trim()));
}
const cite = (s, ln, text) => ({ section: s.number ? `${s.number} ${s.heading}` : s.heading, line: ln, quote: text.trim().length > 220 ? text.trim().slice(0, 217) + '...' : text.trim() });
function findIn(s, phrase) { const p = norm(phrase); if (norm(s.heading).includes(p)) return s.lines[0]; return s.lines.find((x) => norm(x.text).includes(p)) || (norm(s.lines.map((x) => x.text).join(' ')).includes(p) ? s.lines[0] : null); }

export function checkContract(text, playbookIn, { file = 'contract', source = null, playbookSha256 = null } = {}) {
  const pb = validatePlaybook(playbookIn); const secs = sections(text); const lines = String(text).split(/\r?\n/);
  const results = [];
  for (const c of pb.clauses) {
    let hits = [];
    for (const s of secs) for (const ph of c.find) { const l = findIn(s, ph); if (l) { hits.push({ s, l, ph }); break; } }
    const byHeading = hits.filter((h) => c.find.some((ph) => norm(h.s.heading).includes(norm(ph))));
    if (byHeading.length) hits = byHeading;
    const r = { id: c.id, title: c.title, required: !!c.required, prohibited: !!c.prohibited, status: null, citations: hits.slice(0, 3).map((h) => cite(h.s, h.l.ln, h.l.text)), issues: [], playbook_note: c.note || null, fallback: c.fallback || null };
    if (c.prohibited) { r.status = hits.length ? 'prohibited_present' : 'absent_ok'; if (hits.length) r.issues.push(`Your playbook marks "${c.title}" as not acceptable, and the contract has it ("${hits[0].ph}").`); results.push(r); continue; }
    if (!hits.length) { r.status = c.required ? 'missing' : 'absent_optional'; if (c.required) r.issues.push(`None of the playbook's phrases for "${c.title}" (${c.find.map((x) => `"${x}"`).join(', ')}) appear in the contract.`); results.push(r); continue; }
    const body = hits.map((h) => h.s.lines.map((x) => x.text).join('\n')).join('\n'); const nb = norm(body);
    for (const m of c.must_include || []) if (!nb.includes(norm(m))) r.issues.push(`Your playbook expects "${m}" in this clause; it is not there.`);
    for (const m of c.must_not_include || []) if (nb.includes(norm(m))) { const s = hits.find((h) => norm(h.s.lines.map((x) => x.text).join(' ')).includes(norm(m))).s; const l = s.lines.find((x) => norm(x.text).includes(norm(m))) || s.lines[0]; r.issues.push(`Your playbook says this clause should not contain "${m}" (line ${l.ln}).`); }
    if (c.value) {
      const re = new RegExp(c.value.pattern, 'i'); let found = null;
      for (const h of hits) for (const x of h.s.lines) { const m = re.exec(x.text.replace(/\s+/g, ' ')); if (m) { found = { n: Number(String(m[1] ?? m[0]).replace(/,/g, '')), ln: x.ln, s: h.s, text: x.text }; break; } if (found) break; }
      const unit = c.value.unit ? ` ${c.value.unit}` : '';
      if (!found || Number.isNaN(found.n)) r.issues.push(`Could not find the ${c.value.label || 'number'} your playbook checks (pattern ${c.value.pattern}); a person should read the clause.`);
      else {
        r.value = { found: found.n, unit: c.value.unit || null, line: found.ln, min: c.value.min ?? null, max: c.value.max ?? null };
        if (!r.citations.some((x) => x.line === found.ln)) r.citations.push(cite(found.s, found.ln, found.text));
        if (c.value.max !== undefined && found.n > c.value.max) r.issues.push(`${c.value.label || 'Value'} is ${found.n}${unit} (line ${found.ln}); your playbook's limit is ${c.value.max}${unit}.`);
        if (c.value.min !== undefined && found.n < c.value.min) r.issues.push(`${c.value.label || 'Value'} is ${found.n}${unit} (line ${found.ln}); your playbook's minimum is ${c.value.min}${unit}.`);
      }
    }
    r.status = r.issues.length ? 'needs_attention' : 'present';
    results.push(r);
  }
  // document checks
  const doc = [];
  lines.forEach((l, i) => { const m = /\[(?:\s*|[●•]+|_+|\.{3,}|TBD|TBC|insert[^\]]*|to be (?:agreed|confirmed)[^\]]*)\]|_{4,}|\bTBD\b|\bTBC\b/i.exec(l); if (m) doc.push({ check: 'open_placeholder', line: i + 1, detail: `Unfilled placeholder "${m[0]}".`, quote: l.trim().slice(0, 200) }); });
  const nums = new Set(secs.map((s) => s.number).filter(Boolean));
  lines.forEach((l, i) => { for (const m of l.matchAll(/\b(?:Section|Clause|§)\s*(\d+(?:\.\d+)*)/gi)) { if (HEAD.test(l) && HEAD.exec(l)[1] === m[1]) continue; if (!nums.has(m[1]) && ![...nums].some((n) => n.startsWith(m[1] + '.'))) doc.push({ check: 'broken_cross_reference', line: i + 1, detail: `Refers to section ${m[1]}, which this document does not have.`, quote: l.trim().slice(0, 200) }); } });
  if (source && source.format === 'docx') {
    if (source.tracked_insertions || source.tracked_deletions) doc.push({ check: 'docx_tracked_changes', line: source.first_tracked_paragraph || 1, detail: `The DOCX has ${source.tracked_insertions} tracked insertion(s) and ${source.tracked_deletions} tracked deletion(s). Solon read it as if every change were accepted; check the changes themselves in Word.`, quote: '' });
    if (source.comments) doc.push({ check: 'docx_comments', line: 1, detail: `The DOCX has ${source.comments} comment(s). Solon does not read comments; read them in Word.`, quote: '' });
    if (source.auto_numbered) doc.push({ check: 'docx_auto_numbering', line: 1, detail: `${source.auto_numbered} paragraph(s) use Word automatic numbering, which Solon cannot see; section numbers and cross-reference checks may be incomplete. Line numbers are paragraph numbers.`, quote: '' });
  }
  const seen = new Map(); for (const s of secs) if (s.number) { if (seen.has(s.number)) doc.push({ check: 'duplicate_section_number', line: s.start, detail: `Section number ${s.number} is used twice (also line ${seen.get(s.number)}).`, quote: s.heading }); else seen.set(s.number, s.start); }
  results.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9));
  doc.sort((a, b) => a.line - b.line);
  const counts = {}; for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const terms = definedTerms(text, { ignore: pb.ignore_terms || [] });
  return { file, ...(source ? { source } : {}), playbook_source: pb.source, playbook_version: pb.version || null, playbook_sha256: playbookSha256, contract_type: pb.contract_type || null, defined_terms: terms, sections: secs.filter((s) => s.number).length, clauses: results, counts, gaps: results.filter((r) => ['missing', 'prohibited_present', 'needs_attention'].includes(r.status)).length, document_findings: doc, disclaimer: DISCLAIMER };
}

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');

/**
 * Read a .docx with zero dependencies (unzip through node:zlib via mythos-agent-core's readZip).
 * One paragraph becomes one line, so citation line numbers are paragraph numbers. Tracked changes
 * are read as accepted (insertions kept, deletions dropped) and counted; comments are counted, not read.
 */
export function docxContract(buf) {
  let z; try { z = readZip(buf, { only: (n) => n === 'word/document.xml' || n === 'word/comments.xml', maxBytes: 50 * 1024 * 1024 }); } catch (e) { throw new Error(`not a readable .docx: ${e.message}`); }
  const xml = z.get('word/document.xml'); if (!xml) throw new Error('not a .docx (word/document.xml missing)');
  const body = xml.toString('utf8');
  const paras = body.match(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
  let ins = 0; let del = 0; let auto = 0; let firstTracked = null;
  const lines = paras.map((p, i) => {
    const pi = (p.match(/<w:ins\b/g) || []).length; const pd = (p.match(/<w:del\b/g) || []).length;
    ins += pi; del += pd; if ((pi || pd) && firstTracked === null) firstTracked = i + 1;
    if (/<w:numPr>/.test(p)) auto++;
    const txt = [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((m) => (m[1] !== undefined ? unesc(m[1]) : m[0] === '<w:tab/>' ? '\t' : ' ')).join('');
    const h = /<w:pStyle w:val="[Hh]eading(\d)"/.exec(p);
    return h && txt.trim() ? `${'#'.repeat(Math.min(6, Number(h[1])))} ${txt}` : txt;
  });
  const cx = z.get('word/comments.xml'); const comments = cx ? (cx.toString('utf8').match(/<w:comment\b/g) || []).length : 0;
  return { text: lines.join('\n') + '\n', source: { format: 'docx', paragraphs: lines.length, tracked_insertions: ins, tracked_deletions: del, first_tracked_paragraph: firstTracked, comments, auto_numbered: auto } };
}

/** Contract text from .txt, .md or .docx. */
export function readContractFile(path) {
  if (/\.docx$/i.test(path)) return docxContract(readFileSync(path));
  if (!/\.(txt|md|markdown|text)$/i.test(path)) throw new Error('contract must be a .txt, .md or .docx file; export the document as plain text first (Solon does not read .pdf or .doc)');
  return { text: readFileSync(path, 'utf8'), source: null };
}
export function readContract(path) { return readContractFile(path).text; }

export const MARK = /\[COUNSEL REVIEW\]/;
export function issuesMemo(r, { compare = null } = {}) {
  const L = [`# Issues list for counsel: ${r.file}`, '', `[COUNSEL REVIEW] ${DISCLAIMER}`, '', `Checked against: ${r.playbook_source}${r.contract_type ? ` (${r.contract_type})` : ''}, playbook version ${r.playbook_version || 'not stated'}${r.playbook_sha256 ? ` (playbook file sha256 ${r.playbook_sha256.slice(0, 12)})` : ''}. Every suggested wording below is copied from your playbook; Solon writes none of its own.`, ''];
  for (const c of r.clauses.filter((x) => ['missing', 'prohibited_present', 'needs_attention'].includes(x.status))) {
    L.push(`## ${c.title} (${c.status.replace('_', ' ')}) [COUNSEL REVIEW]`, '');
    for (const i of c.issues) L.push(`- ${i}`);
    for (const x of c.citations) L.push(`- Contract ${x.section}, line ${x.line}: "${x.quote}"`);
    L.push('', `Playbook position: ${c.playbook_note || '(none written)'}`, '', `Playbook fallback language: ${c.fallback ? `"${c.fallback}"` : '[PLAYBOOK HAS NO FALLBACK]'}`, '');
  }
  const t = r.defined_terms || { undefined: [], unused: [], duplicates: [] };
  const termLines = [...t.undefined.map((x) => `- Capitalised term "${x.term}" is used (line ${x.lines.join(', ')}) but not defined.`), ...t.unused.map((x) => `- "${x.term}" is defined (line ${x.line}) but not used elsewhere.`), ...t.duplicates.map((x) => `- "${x.term}" is defined more than once (lines ${x.lines.join(', ')}).`)];
  if (r.document_findings.length || termLines.length) { L.push('## Document checks [COUNSEL REVIEW]', ''); for (const d of r.document_findings) L.push(`- Line ${d.line} ${d.check}: ${d.detail}${d.quote ? ` "${d.quote}"` : ''}`); L.push(...termLines); L.push(''); }
  if (compare) {
    const moved = compare.clauses.filter((c) => c.change !== 'unchanged');
    L.push(`## Changes since ${compare.before_file} [COUNSEL REVIEW]`, '', ...(moved.length ? moved.map((c) => `- ${c.title}: ${c.before ?? 'not checked'} → ${c.after} (${c.change})${c.value_before != null || c.value_after != null ? `, value ${c.value_before ?? 'n/a'} → ${c.value_after ?? 'n/a'}` : ''}`) : ['- No clause status changed.']), `- Sections changed: ${compare.sections.changed.join('; ') || 'none'}`, '');
  }
  L.push('## Present as the playbook expects', '', ...r.clauses.filter((x) => x.status === 'present' || x.status === 'absent_ok').map((c) => `- ${c.title}${c.citations[0] ? ` (${c.citations[0].section}, line ${c.citations[0].line})` : ' (not in the contract, as the playbook wants)'}`), '');
  return L.join('\n');
}

const GOOD = { missing: 0, prohibited_present: 0, needs_attention: 1, present: 2, absent_ok: 2, absent_optional: 2 };
/**
 * Compare two checks of the same playbook (an earlier and a later contract draft): per clause,
 * did its status get better, worse or stay the same; which document findings and defined-term
 * problems are new or resolved; which sections changed.
 */
export function compareDrafts(before, after, beforeText, afterText) {
  const old = new Map(before.clauses.map((c) => [c.id, c]));
  const clauses = after.clauses.map((c) => {
    const o = old.get(c.id) || null;
    const change = !o ? 'new_in_playbook' : GOOD[c.status] > GOOD[o.status] ? 'better' : GOOD[c.status] < GOOD[o.status] ? 'worse' : (o.value?.found !== c.value?.found || o.issues.join('|') !== c.issues.join('|')) ? 'changed' : 'unchanged';
    return { id: c.id, title: c.title, before: o ? o.status : null, after: c.status, change, ...(o?.value || c.value ? { value_before: o?.value?.found ?? null, value_after: c.value?.found ?? null } : {}), issues_after: c.issues };
  }).sort((a, b) => ['worse', 'better', 'changed', 'new_in_playbook', 'unchanged'].indexOf(a.change) - ['worse', 'better', 'changed', 'new_in_playbook', 'unchanged'].indexOf(b.change));
  const key = (d) => `${d.check}|${d.detail}`;
  const ob = new Set(before.document_findings.map(key)); const nb = new Set(after.document_findings.map(key));
  const termKey = (t) => [...t.undefined.map((x) => `undefined: ${x.term}`), ...t.unused.map((x) => `unused: ${x.term}`), ...t.duplicates.map((x) => `defined twice: ${x.term}`)];
  const tb = new Set(termKey(before.defined_terms)); const ta = new Set(termKey(after.defined_terms));
  const body = (text) => { const m = new Map(); for (const s of sections(text)) m.set(s.number ? `${s.number} ${s.heading}` : s.heading, s.lines.slice(1).map((x) => x.text.trim()).join(' ').replace(/\s+/g, ' ').trim()); return m; };
  const sb = body(beforeText); const sa = body(afterText);
  const sectionsChanged = { added: [...sa.keys()].filter((k) => !sb.has(k)), removed: [...sb.keys()].filter((k) => !sa.has(k)), changed: [...sa.keys()].filter((k) => sb.has(k) && sb.get(k) !== sa.get(k)) };
  const counts = {}; for (const c of clauses) counts[c.change] = (counts[c.change] || 0) + 1;
  return {
    before_file: before.file, after_file: after.file, playbook_source: after.playbook_source, playbook_version: after.playbook_version,
    counts, clauses, gaps_before: before.gaps, gaps_after: after.gaps,
    document_findings_new: after.document_findings.filter((d) => !ob.has(key(d))), document_findings_resolved: before.document_findings.filter((d) => !nb.has(key(d))),
    defined_terms_new: [...ta].filter((x) => !tb.has(x)), defined_terms_resolved: [...tb].filter((x) => !ta.has(x)),
    sections: sectionsChanged, disclaimer: DISCLAIMER,
  };
}

export function compareMarkdown(c) {
  const L = [`# Changes between drafts: ${c.before_file} → ${c.after_file}`, '', DISCLAIMER, '', `Checked against: ${c.playbook_source}, playbook version ${c.playbook_version || 'not stated'}. Gaps: ${c.gaps_before} before, ${c.gaps_after} after.`, '', '| Clause | Before | After | Change |', '|---|---|---|---|'];
  for (const x of c.clauses) L.push(`| ${x.title} | ${x.before ?? '-'}${x.value_before != null ? ` (${x.value_before})` : ''} | ${x.after}${x.value_after != null ? ` (${x.value_after})` : ''} | ${x.change} |`);
  L.push('', '## Sections', '', `- Changed: ${c.sections.changed.join('; ') || 'none'}`, `- Added: ${c.sections.added.join('; ') || 'none'}`, `- Removed: ${c.sections.removed.join('; ') || 'none'}`, '');
  L.push('## Document checks', '', ...c.document_findings_new.map((d) => `- New: line ${d.line} ${d.check}: ${d.detail}`), ...c.document_findings_resolved.map((d) => `- Resolved: ${d.check}: ${d.detail}`), ...c.defined_terms_new.map((x) => `- New defined-term finding: ${x}`), ...c.defined_terms_resolved.map((x) => `- Resolved defined-term finding: ${x}`));
  if (!c.document_findings_new.length && !c.document_findings_resolved.length && !c.defined_terms_new.length && !c.defined_terms_resolved.length) L.push('- No change.');
  L.push('');
  return L.join('\n');
}
