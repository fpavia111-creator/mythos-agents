// Best-effort extraction of COI fields from text copied or exported from an
// ACORD 25-style certificate (for example with `pdftotext -layout`). No PDF
// parsing, no OCR, no network. Every extracted value is marked for review.

const COVERAGES = [
  { key: 'general_liability', re: /\b(commercial\s+general\s+liability|general\s+liability)\b/i, limit: [/each\s+occurrence/i] },
  { key: 'auto_liability', re: /\b(automobile\s+liability|auto\s+liability|business\s+auto)\b/i, limit: [/combined\s+single\s+limit/i, /each\s+accident/i] },
  { key: 'umbrella', re: /\b(umbrella|excess)\s+liab/i, limit: [/each\s+occurrence/i, /aggregate/i] },
  { key: 'workers_comp', re: /\bworkers['’]?\s+comp/i, limit: [/e\.?\s*l\.?\s+each\s+accident/i, /each\s+accident/i] },
  { key: 'professional_liability', re: /\b(professional\s+liability|errors\s+(and|&)\s+omissions)\b/i, limit: [/each\s+claim/i, /per\s+claim/i, /aggregate/i] },
];
const DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g;
const MONEY = /\$\s*([\d,]{3,}(?:\.\d{2})?)/;

function isoDate(m, d, y) {
  const yy = y.length === 2 ? 2000 + Number(y) : Number(y);
  const mm = Number(m), dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
const money = (s) => Number(String(s).replace(/,/g, ''));
const flag = (block, re) => { const m = re.exec(block); return m ? /^y/i.test(m[1]) : null; };

/** Value on the same line after a label ("INSURED: X"), or the first non-empty line after it. */
function labelled(lines, re) {
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const rest = lines[i].slice(m.index + m[0].length).replace(/^[\s:–-]+/, '').trim();
    if (rest) return { value: rest, line: i + 1 };
    for (let j = i + 1; j < lines.length && j < i + 4; j++) if (lines[j].trim()) return { value: lines[j].trim(), line: j + 1 };
  }
  return { value: '', line: null };
}

/**
 * Returns { insured, certificate_holder, rows: [{ vendor, coverage, policy_number, limit, effective,
 * expires, additional_insured, waiver_of_subrogation, needs_review: 'yes', source_line, warnings }], warnings }.
 */
export function extractCoiText(text, { source = '' } = {}) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const insured = labelled(lines, /^\s*insured\b(?=\s*:|\s*$)/i);
  const holder = labelled(lines, /^\s*certificate\s+holder\b(?=\s*:|\s*$)/i);
  const starts = [];
  // Coverage lines sit before the description, holder and cancellation sections.
  const stop = lines.findIndex((l) => /^\s*(description\s+of\s+operations|certificate\s+holder|cancellation)\b/i.test(l));
  const last = stop === -1 ? lines.length : stop;
  lines.slice(0, last).forEach((l, i) => { for (const c of COVERAGES) if (c.re.test(l)) { starts.push({ i, c }); break; } });
  const rows = []; const warnings = [];
  starts.forEach((s, n) => {
    const end = n + 1 < starts.length ? starts[n + 1].i : Math.min(last, s.i + 12);
    const blockLines = lines.slice(s.i, end); const block = blockLines.join('\n');
    const dates = [...block.matchAll(DATE)].map((m) => isoDate(m[1], m[2], m[3])).filter(Boolean);
    let limit = null;
    for (const re of s.c.limit) {
      for (const l of blockLines) if (re.test(l)) { const m = MONEY.exec(l.slice(l.search(re))); if (m) { limit = money(m[1]); break; } }
      if (limit !== null) break;
    }
    if (limit === null) { const m = MONEY.exec(block); if (m) limit = money(m[1]); }
    const pol = /\b(?:policy\s*(?:number|no\.?|#)\s*:?\s*)?([A-Z]{2,5}[-\s]?\d{4,}[A-Z0-9-]*)\b/.exec(block);
    const w = [];
    if (dates.length < 2) w.push('policy dates not found (need effective and expiry)');
    if (limit === null) w.push('limit not found');
    const ai = flag(block, /addl\.?\s*insd\.?\s*:?\s*([YN])\b/i) ?? flag(block, /additional\s+insured\s*:?\s*(yes|no|y|n)\b/i);
    const wos = flag(block, /subr\.?\s*wvd\.?\s*:?\s*([YN])\b/i) ?? flag(block, /waiver\s+of\s+subrogation\s*:?\s*(yes|no|y|n)\b/i);
    rows.push({
      vendor: insured.value, coverage: s.c.key, policy_number: pol ? pol[1] : '', limit: limit ?? '', effective: dates[0] || '', expires: dates[1] || '',
      additional_insured: ai === null ? '' : ai ? 'yes' : 'no', waiver_of_subrogation: wos === null ? '' : wos ? 'yes' : 'no',
      certificate_id: source, needs_review: 'yes', source_line: s.i + 1, warnings: w,
    });
    for (const x of w) warnings.push(`${s.c.key} (line ${s.i + 1}): ${x}`);
  });
  if (!insured.value) warnings.push('insured name not found');
  if (!rows.length) warnings.push('no coverage lines recognised');
  return { source, insured: insured.value, certificate_holder: holder.value, rows, warnings };
}

export const EXTRACT_COLUMNS = ['vendor', 'coverage', 'limit', 'effective', 'expires', 'additional_insured', 'waiver_of_subrogation', 'policy_number', 'certificate_id', 'needs_review', 'source_line', 'warnings', 'reviewed_by'];
