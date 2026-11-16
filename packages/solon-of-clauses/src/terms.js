// Defined-terms check: capitalised terms used but never defined, terms defined but never used,
// and terms defined twice, each with line numbers. Pattern matching on the text only; it does not
// decide whether a term needs a definition, so every result is for a person to read.

const Q = '["“”]';
const TERM = "([A-Z][\\w'’-]*(?:\\s+(?:of|and|for|the|to|in|[A-Z][\\w'’-]*)){0,5})";
const DEF_PATTERNS = [
  new RegExp(`${Q}${TERM}${Q}\\s+(?:means|shall mean|will mean|has the meaning|refers to|includes)`, 'g'),
  new RegExp(`\\((?:the|each|each a|an?|together,? the|collectively,? the|hereinafter|hereinafter the)?\\s*${Q}${TERM}${Q}\\s*\\)`, 'g'),
];
const ENTITY = /^(?:Ltd|LLC|Inc|Limited|GmbH|plc|PLC|Corp|Corporation|Company|LLP|LP|SA|AG|BV|Pty)\b/;
const STOP = new Set(['I', 'Section', 'Sections', 'Clause', 'Clauses', 'Article', 'Articles', 'Schedule', 'Exhibit', 'Annex', 'Appendix', 'Part', 'State', 'States', 'United', 'Kingdom', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'Mr', 'Ms', 'Mrs', 'Dr', 'Note', 'Notes']);

/**
 * text: contract text. Returns { defined: [{term, line}], undefined: [{term, lines}], unused: [{term, line}], duplicates: [{term, lines}] }.
 * A capitalised word used once mid-sentence is not reported (it is usually a name); a capitalised
 * phrase of two or more words is reported on first use.
 */
export function definedTerms(text, { ignore = [] } = {}) {
  const lines = String(text).split(/\r?\n/);
  const defs = new Map(); const dupes = new Map();
  lines.forEach((l, i) => {
    for (const re of DEF_PATTERNS) for (const m of l.matchAll(re)) {
      const term = m[1].trim(); const at = i + 1;
      if (defs.has(term)) dupes.set(term, [...(dupes.get(term) || [defs.get(term)]), at]);
      else defs.set(term, at);
    }
  });
  const title = (lines.find((l) => /^#\s/.test(l)) || '').replace(/^#\s+/, '');
  const known = new Set([...STOP, ...ignore.flatMap((x) => String(x).split(/\s+/))]);
  // The document's own title ("this Agreement") is not reported: single title words, or a phrase inside the title.
  const titleWords = new Set(title.split(/[^A-Za-z]+/).filter(Boolean));
  const defined = [...defs.keys()].sort((a, b) => b.length - a.length);
  const uses = new Map(defined.map((t) => [t, 0])); const cand = new Map();
  lines.forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return;
    // Remove the quoted term in each definition so it does not count as a use.
    let l = raw.replace(new RegExp(`${Q}[^"“”]{1,80}${Q}`, 'g'), (q) => ' '.repeat(q.length)).replace(/[*_`]/g, ' ');
    for (const t of defined) { const re = new RegExp(`(?<![\\w-])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'); l = l.replace(re, (m) => { uses.set(t, uses.get(t) + 1); return ' '.repeat(m.length); }); }
    for (const m of l.matchAll(/(?<![\w'-])[A-Z][a-z][\w'’-]*(?:\s+[A-Z][a-z][\w'’-]*){0,3}/g)) {
      const before = l.slice(0, m.index); const after = l.slice(m.index + m[0].length).trimStart();
      if (/^\s*(?:[-*+]|\d+[.)])?\s*$/.test(before) || /[.!?:;(]\s*$/.test(before)) continue; // sentence start
      if (ENTITY.test(after) || ENTITY.test(m[0].split(/\s+/).pop())) continue; // a company name
      const words = m[0].split(/\s+/).filter((w) => !known.has(w));
      if (!words.length) continue;
      const term = words.join(' ');
      if (words.length === 1 ? titleWords.has(term) : title.includes(term)) continue;
      const c = cand.get(term) || { term, lines: [], multi: words.length > 1 }; if (!c.lines.includes(i + 1)) c.lines.push(i + 1); c.count = (c.count || 0) + 1; cand.set(term, c);
    }
  });
  const undefinedTerms = [...cand.values()].filter((c) => c.multi || c.count >= 2).map(({ term, lines: ls }) => ({ term, lines: ls })).sort((a, b) => a.lines[0] - b.lines[0] || a.term.localeCompare(b.term));
  return {
    defined: [...defs].map(([term, line]) => ({ term, line })).sort((a, b) => a.line - b.line || a.term.localeCompare(b.term)),
    undefined: undefinedTerms,
    unused: [...defs].filter(([t]) => !uses.get(t)).map(([term, line]) => ({ term, line })).sort((a, b) => a.line - b.line),
    duplicates: [...dupes].map(([term, ls]) => ({ term, lines: ls.sort((a, b) => a - b) })),
  };
}
