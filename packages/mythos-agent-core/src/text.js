// Shared text matching helpers: Jaro-Winkler, Levenshtein, token-set similarity,
// name/address normalisation and Shannon entropy. Deterministic, no dependencies.

export function levenshtein(a, b) {
  a = String(a ?? ''); b = String(b ?? '');
  if (a === b) return 0;
  if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Jaro-Winkler similarity in [0, 1]. */
export function jaroWinkler(s1, s2, { prefixScale = 0.1 } = {}) {
  s1 = String(s1 ?? ''); s2 = String(s2 ?? '');
  if (s1 === s2) return s1.length ? 1 : 1;
  if (!s1.length || !s2.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const m1 = new Array(s1.length).fill(false), m2 = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(s2.length, i + range + 1); j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = m2[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  const jaro = (matches / s1.length + matches / s2.length + (matches - t / 2) / matches) / 3;
  let p = 0; while (p < 4 && p < s1.length && p < s2.length && s1[p] === s2[p]) p++;
  return jaro + p * prefixScale * (1 - jaro);
}

const STOP = new Set(['the', 'and', 'of', '&']);
// Legal forms: English, plus the common European ones (GmbH, AG, KG, SARL, SAS, SRL,
// S.p.A., Ltda, Oy, ApS...). Matched as whole words anywhere in the name.
const ENTITY = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|mbh|ag|kg|ohg|kgaa|sa|sarl|sas|sasu|srl|s\.r\.l|s\.p\.a|s\.a\.s|s\.a|ltda|eireli|bv|nv|bvba|sprl|oy|oyj|aps|pty|lp|llp|pc)\b\.?/g;
// Japanese, Chinese and Korean legal forms, written before or after the name and with
// no spaces around them: 株式会社 / (株), 有限公司, 주식회사 / (주) and the like.
const CJK_LEGAL = /(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|\((?:株|有|同|合|資|名)\)|股份有限公司|有限责任公司|有限責任公司|有限公司|股份公司|주식\s*회사|유한\s*회사|유한책임회사|\((?:주|유)\))/gu;
const CJK_TAIL = /(公司|会社|회사)$/u;
// Japanese bank-transfer names abbreviate the legal form in katakana: カ) or (カ for
// 株式会社, ユ) for 有限会社, ド) for 合同会社 (half-width in the file; NFKC makes them full-width).
const KANA_LEGAL_HEAD = /^\s*\(?(?:カ|ユ|ド)\)\s*/u;
const KANA_LEGAL_TAIL = /\s*\((?:カ|ユ|ド)\)?\s*$/u;
const KANA_LEGAL_WORDS = /(カブシキガイシヤ|カブシキガイシャ|カブシキカイシヤ|カブシキカイシャ|ユウゲンガイシヤ|ユウゲンガイシャ|ゴウドウガイシヤ|ゴウドウガイシャ)/gu;
const NON_ASCII = /[^\x00-\x7f]/;
// Legal forms that are only removed at the END of a name, because as words elsewhere they
// could be part of the name itself: Spanish S.L., S.L.U., S.A.U.; Italian S.n.c., S.a.p.a.;
// European SE; Brazilian ME, EPP and S/A; and the Mexican "S.A. de C.V." family.
const LSEP = '[.\\s]*';
const spelled = (w) => w.split('').join(LSEP);
const LATAM_CV = new RegExp(`\\s(?:${['sapi', 'sab', 'sderl', 'srl', 'sa', 'sc'].map(spelled).join('|')})${LSEP}de${LSEP}${spelled('cv')}[.\\s]*$`);
const LATIN_TAIL = new RegExp(`\\s(?:${['slu', 'sl', 'sau', 'snc', 'sapa', 'sa', 'se', 'me', 'epp'].map(spelled).join('|')})[.\\s]*$`);

/**
 * Remove legal forms that only count at the end of a lowercase name: S.L., S.L.U., S.A.U.,
 * S.n.c., SE, ME, EPP, S/A and "S.A. de C.V.". Dots and spaces between the letters are
 * allowed ("s.a. de c.v.", "s a de c v"). A name that is only the form is left alone.
 */
export function stripLegalTail(s) {
  let t = String(s ?? '');
  t = t.replace(LATAM_CV, ' ');
  for (let i = 0; i < 3; i++) { const n = t.replace(LATIN_TAIL, ' '); if (n === t) break; t = n; }
  return t;
}

/**
 * Remove Japanese, Chinese and Korean legal forms from a name (株式会社, (株), 有限公司,
 * 주식회사, (주)...). Half-width and full-width forms are unified first (NFKC).
 */
export function stripLegalForms(s) {
  let t = String(s ?? '').normalize('NFKC').replace(CJK_LEGAL, ' ').replace(KANA_LEGAL_WORDS, ' ').replace(KANA_LEGAL_HEAD, '').replace(KANA_LEGAL_TAIL, '').trim();
  const tail = CJK_TAIL.exec(t);
  if (tail && t.length - tail[0].length >= 2) t = t.slice(0, -tail[0].length);
  return t;
}

/**
 * Lowercase, strip accents, punctuation and legal suffixes (Inc, LLC, Ltd, GmbH, AG,
 * SARL, S.L., S.A. de C.V., Ltda, 株式会社, 有限公司, 주식회사…). Letters of every script are kept, so names in
 * Japanese, Chinese, Korean, Greek or Cyrillic compare too (they used to become empty).
 */
export function normalizeName(s, { stripEntity = true } = {}) {
  const raw = String(s ?? '');
  let t;
  if (!NON_ASCII.test(raw)) t = raw.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s.]/g, ' ');
  else {
    t = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC').toLowerCase().replace(/ß/g, 'ss').replace(/&/g, ' and ');
    if (stripEntity) t = stripLegalForms(t);
    t = t.replace(/[^\p{L}\p{N}\s.]/gu, ' ');
  }
  if (stripEntity) t = stripLegalTail(t).replace(ENTITY, ' ');
  return t.replace(/\./g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).join(' ');
}

const ADDR = [[/\bstreet\b/g, 'st'], [/\bavenue\b/g, 'ave'], [/\broad\b/g, 'rd'], [/\bboulevard\b/g, 'blvd'], [/\bdrive\b/g, 'dr'], [/\blane\b/g, 'ln'], [/\bsuite\b/g, 'ste'], [/\bapartment\b/g, 'apt'], [/\bnorth\b/g, 'n'], [/\bsouth\b/g, 's'], [/\beast\b/g, 'e'], [/\bwest\b/g, 'w'], [/\bplace\b/g, 'pl'], [/\bcourt\b/g, 'ct'], [/\bhighway\b/g, 'hwy'], [/\bparkway\b/g, 'pkwy'], [/#/g, ' ste ']];

/** Normalise a postal address (USPS-style abbreviations, punctuation removed). */
export function normalizeAddress(s) {
  const raw = String(s ?? '');
  let t = NON_ASCII.test(raw) ? raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase().replace(/ß/g, 'ss') : raw.toLowerCase();
  for (const [re, rep] of ADDR) t = t.replace(re, rep);
  // Letters of every script are kept (a Japanese or Korean address used to become just its digits).
  return t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Token-set similarity (Jaccard on words) in [0, 1]. */
export function tokenSetSimilarity(a, b) {
  const A = new Set(String(a ?? '').split(/\s+/).filter(Boolean)), B = new Set(String(b ?? '').split(/\s+/).filter(Boolean));
  if (!A.size && !B.size) return 1;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Best-of similarity for business names: Jaro-Winkler on normalised strings and on sorted tokens. */
export function nameSimilarity(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return 0;
  const sorted = (s) => s.split(' ').sort().join(' ');
  return Math.max(jaroWinkler(na, nb), jaroWinkler(sorted(na), sorted(nb)), tokenSetSimilarity(na, nb));
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s) {
  s = String(s ?? ''); if (!s) return 0;
  const f = new Map(); for (const c of s) f.set(c, (f.get(c) || 0) + 1);
  let h = 0; for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

/** Mask all but the last `keep` characters of a secret-ish value. */
export function maskValue(v, keep = 4) {
  const s = String(v ?? '');
  if (s.length <= keep) return '•'.repeat(s.length);
  return '•'.repeat(Math.min(8, s.length - keep)) + s.slice(-keep);
}

// ---------------------------------------------------------------------------
// Text in data that reads like instructions to an AI
// ---------------------------------------------------------------------------

const INJECTION_SIGNALS = [
  ['override_instructions', /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|guidelines|directions)\b/i],
  ['role_change', /\byou are now\b|\bact as (an? |the )?(system|admin|administrator|developer)\b|\bnew instructions?\s*:/i],
  ['system_prompt', /\b(system prompt|developer message)\b/i],
  ['hide_from_person', /\b(do not|don't|never) (tell|inform|alert|notify|show|mention (this |it )?to) the (user|human|operator|reviewer|person)\b/i],
  ['chat_markup', /<\/?(system|assistant|tool_result|function_calls|antml:[a-z_]+)\b|<\|im_(start|end)\|>|\[\/?INST\]/i],
  ['tool_steering', /\b(call|invoke|run|use) (the )?(tool|function) [a-z_]{3,}|\bapprove (this|the) (request|payment|refund|transfer|change)\b[^.\n]{0,20}\b(automatically|without (asking|review|approval))/i],
  ['hidden_characters', /[‪-‮⁦-⁩​]|[\u{E0000}-\u{E007F}]/u],
];

/**
 * Names of the signals found in a string: phrases that try to redirect an AI
 * model ("ignore previous instructions", fake chat markup, "do not tell the
 * user"), and invisible or direction-flipping characters used to hide them.
 * A heuristic with a short, high-precision list: it catches the common shapes
 * and misses others, so it is a warning light, not a filter.
 */
export function injectionSignals(text) {
  const s = String(text ?? '');
  return INJECTION_SIGNALS.filter(([, re]) => re.test(s)).map(([name]) => name);
}
