// Solon of Clauses: check a contract's text against the user's own clause playbook.
// It finds words and numbers the playbook names and cites where they are. It does not
// interpret the contract, weigh risk, or give legal advice.
import { readFileSync } from 'node:fs';

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

export function checkContract(text, playbookIn, { file = 'contract' } = {}) {
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
  const seen = new Map(); for (const s of secs) if (s.number) { if (seen.has(s.number)) doc.push({ check: 'duplicate_section_number', line: s.start, detail: `Section number ${s.number} is used twice (also line ${seen.get(s.number)}).`, quote: s.heading }); else seen.set(s.number, s.start); }
  results.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9));
  doc.sort((a, b) => a.line - b.line);
  const counts = {}; for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return { file, playbook_source: pb.source, contract_type: pb.contract_type || null, sections: secs.filter((s) => s.number).length, clauses: results, counts, gaps: results.filter((r) => ['missing', 'prohibited_present', 'needs_attention'].includes(r.status)).length, document_findings: doc, disclaimer: DISCLAIMER };
}

export function readContract(path) {
  if (!/\.(txt|md|markdown|text)$/i.test(path)) throw new Error('contract must be a .txt or .md file; export the document as plain text first (Solon does not read .docx or .pdf)');
  return readFileSync(path, 'utf8');
}

export const MARK = /\[COUNSEL REVIEW\]/;
export function issuesMemo(r) {
  const L = [`# Issues list for counsel: ${r.file}`, '', `[COUNSEL REVIEW] ${DISCLAIMER}`, '', `Checked against: ${r.playbook_source}${r.contract_type ? ` (${r.contract_type})` : ''}. Every suggested wording below is copied from your playbook; Solon writes none of its own.`, ''];
  for (const c of r.clauses.filter((x) => ['missing', 'prohibited_present', 'needs_attention'].includes(x.status))) {
    L.push(`## ${c.title} (${c.status.replace('_', ' ')}) [COUNSEL REVIEW]`, '');
    for (const i of c.issues) L.push(`- ${i}`);
    for (const x of c.citations) L.push(`- Contract ${x.section}, line ${x.line}: "${x.quote}"`);
    L.push('', `Playbook position: ${c.playbook_note || '(none written)'}`, '', `Playbook fallback language: ${c.fallback ? `"${c.fallback}"` : '[PLAYBOOK HAS NO FALLBACK]'}`, '');
  }
  if (r.document_findings.length) { L.push('## Document checks [COUNSEL REVIEW]', ''); for (const d of r.document_findings) L.push(`- Line ${d.line} ${d.check}: ${d.detail} "${d.quote}"`); L.push(''); }
  L.push('## Present as the playbook expects', '', ...r.clauses.filter((x) => x.status === 'present' || x.status === 'absent_ok').map((c) => `- ${c.title}${c.citations[0] ? ` (${c.citations[0].section}, line ${c.citations[0].line})` : ' (not in the contract, as the playbook wants)'}`), '');
  return L.join('\n');
}
