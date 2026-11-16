// License text identification. Short permissive licenses (MIT, ISC, 0BSD, BSD-2/3-Clause,
// Unlicense) are compared word by word with the SPDX text (Sørensen-Dice on word pairs
// after normalising case, punctuation, titles and copyright notices). Apache-2.0 and
// MPL-2.0 are compared with a fingerprint of the official text (sampled 6-word shingles,
// see license-fingerprints.json). The GPL family and CC-BY-4.0 are recognised by title
// only and are always low confidence: the text alone cannot say "only" or "or later".
// A low-confidence or unidentified text is never treated as allowed.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const FINGERPRINTS = JSON.parse(readFileSync(new URL('./license-fingerprints.json', import.meta.url), 'utf8'));

const DISCLAIMER_MIT = 'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.';
const DISCLAIMER_ISC = 'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.';
const BSD_COND = 'Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met: 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer. 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.';
const BSD_DISC = 'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.';

export const TEMPLATES = {
  MIT: `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. ${DISCLAIMER_MIT}`,
  ISC: `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies. ${DISCLAIMER_ISC}`,
  '0BSD': `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted. ${DISCLAIMER_ISC}`,
  'BSD-2-Clause': `${BSD_COND} ${BSD_DISC}`,
  'BSD-3-Clause': `${BSD_COND} 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission. ${BSD_DISC}`,
  Unlicense: 'This is free and unencumbered software released into the public domain. Anyone is free to copy, modify, publish, use, compile, sell, or distribute this software, either in source code form or as a compiled binary, for any purpose, commercial or non-commercial, and by any means. In jurisdictions that recognize copyright laws, the author or authors of this software dedicate any and all copyright interest in the software to the public domain. We make this dedication for the benefit of the public at large and to the detriment of our heirs and successors. We intend this dedication to be an overt act of relinquishment in perpetuity of all present and future rights to this software under copyright law. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. For more information, please refer to <https://unlicense.org>',
};
// Recognised by title only. Order matters: AGPL/LGPL before GPL.
export const MARKERS = [
  ['Apache-2.0', /apache license version 2 0/],
  ['CC-BY-4.0', /creative commons attribution 4 0 international/],
  ['AGPL-3.0-only', /gnu affero general public license version 3/],
  ['LGPL-3.0-only', /gnu lesser general public license version 3/],
  ['LGPL-2.1-only', /gnu lesser general public license version 2 1/],
  ['GPL-3.0-only', /gnu general public license version 3/],
  ['GPL-2.0-only', /gnu general public license version 2/],
  ['MPL-2.0', /mozilla public license version 2 0/],
];
export const HIGH = 0.97; export const LOW = 0.8; const MARKER_CONFIDENCE = 0.85;

const NOTICE_LINE = /^\s*(copyright\s+(\(c\)|©|\d{4})|\(c\)\s*\d{4}|©|all rights reserved\.?\s*$)/i;
const TITLE_LINE = /^\s*(the\s+)?(mit|isc|bsd|0bsd|zero[- ]clause bsd)\b[^.]{0,40}licen[cs]e(\s*\(\w+\))?\s*$|^\s*bsd\s+\d-clause.*$/i;
/** Lowercase words only; copyright notices and (optionally) a short licence title are dropped. */
export function normalize(text, { keepTitle = false } = {}) {
  let lines = String(text || '').split(/\r?\n/).filter((l) => !NOTICE_LINE.test(l));
  if (!keepTitle) { const i = lines.findIndex((l) => l.trim()); if (i >= 0 && TITLE_LINE.test(lines[i])) lines = lines.slice(i + 1); }
  return lines.join(' ').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
const pairs = (s) => { const w = s.split(' ').filter(Boolean); const set = new Set(); for (let i = 0; i < w.length - 1; i++) set.add(`${w[i]} ${w[i + 1]}`); return set; };
/** Word-pair overlap: dice, plus how much of the candidate (precision) and of the template (recall) is shared. */
export function overlap(a, b) { const x = pairs(a); const y = pairs(b); if (!x.size || !y.size) return { dice: 0, precision: 0, recall: 0 }; let n = 0; for (const p of x) if (y.has(p)) n++; return { dice: (2 * n) / (x.size + y.size), precision: n / x.size, recall: n / y.size }; }
export const dice = (a, b) => overlap(a, b).dice;
const TPL = Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, normalize(v)]));

export const SHINGLE = 6; export const SAMPLE_MOD = 8;
/** Hashes of every 6-word run in a normalised text. */
export function shingleHashes(norm) {
  const w = norm.split(' ').filter(Boolean); const out = new Set();
  for (let i = 0; i + SHINGLE <= w.length; i++) out.add(createHash('sha256').update(w.slice(i, i + SHINGLE).join(' ')).digest('hex').slice(0, 8));
  return out;
}
export const sampleHashes = (set) => [...set].filter((h) => parseInt(h, 16) % SAMPLE_MOD === 0).sort();
const rounded = (x) => Math.round(x * 1000) / 1000;

/**
 * Identify a license text. Returns { id, confidence, method, level: 'high'|'low'|'none', runner_up, note? }.
 * level 'low' means a person should confirm it; 'none' means it was not identified.
 */
export function identifyLicense(text) {
  const n = normalize(text); const words = n ? n.split(' ').length : 0;
  if (words < 8) return { id: null, confidence: 0, method: 'too short', level: 'none', runner_up: null };
  const scores = Object.entries(TPL).map(([id, t]) => { const o = overlap(n, t); return { id, s: o.dice, o }; }).sort((a, b) => b.s - a.s);
  const [best, second] = scores;
  if (best.s >= LOW) {
    // High needs both: nearly all of the standard text is there, and almost nothing else is.
    const level = best.o.recall >= HIGH && best.o.precision >= HIGH ? 'high' : 'low';
    return { id: best.id, confidence: rounded(best.s), method: 'text comparison', level, runner_up: second ? { id: second.id, confidence: rounded(second.s) } : null, ...(level === 'low' ? { note: 'The text differs from the standard wording (extra, missing or changed words); a person should read it.' } : {}) };
  }
  if (words > 400) {
    const full = normalize(text, { keepTitle: true }); const fullWords = full.split(' ').length; const have = shingleHashes(full);
    const fp = Object.entries(FINGERPRINTS.licenses).map(([id, f]) => ({ id, f, c: f.sample.filter((h) => have.has(h)).length / f.sample.length })).sort((a, b) => b.c - a.c)[0];
    if (fp && fp.c >= LOW) {
      const extra = fullWords > fp.f.words_full * 1.05;
      const level = fp.c >= 0.98 && !extra ? 'high' : 'low';
      return { id: fp.id, confidence: rounded(fp.c), method: `fingerprint of the official text (${FINGERPRINTS.version})`, level, runner_up: null, ...(extra ? { note: `The file is about ${fullWords - fp.f.words_full} words longer than the official text; read the extra terms.` } : level === 'low' ? { note: 'Parts of the official text are missing or changed.' } : {}) };
    }
  }
  const titled = normalize(text, { keepTitle: true });
  for (const [id, re] of MARKERS) if (re.test(titled)) return { id, confidence: MARKER_CONFIDENCE, method: 'title match (not compared word by word)', level: 'low', runner_up: null, note: /GPL/.test(id) ? 'Recognised by its title. The license text alone does not say "only" or "or later"; check the package\'s notices.' : 'Recognised by its title only; the body was not compared.' };
  return { id: null, confidence: rounded(best.s), method: 'text comparison', level: 'none', runner_up: { id: best.id, confidence: rounded(best.s) } };
}

/** Copyright notice lines in a license or notice file (at most `max`). */
export function copyrightLines(text, max = 5) {
  return [...new Set(String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(copyright\s+(\(c\)|©|\d{4})|\(c\)\s*\d{4}|©)/i.test(l)))].slice(0, max);
}

const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)([-._].*)?$/i;
/** License files in a package directory (and a Python dist-info's licenses/ folder). */
export function licenseFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile()).sort().map((f) => join(dir, f));
  if (existsSync(join(dir, 'licenses')) && statSync(join(dir, 'licenses')).isDirectory()) for (const f of readdirSync(join(dir, 'licenses')).sort()) out.push(join(dir, 'licenses', f));
  return out;
}
export const readText = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
