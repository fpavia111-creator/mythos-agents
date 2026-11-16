// Reading values the way exports from different countries write them: header
// names in any script, amounts with either decimal mark and local currency
// signs, and dates in English, European and East Asian forms.
//
// Every function here is pure and has an ASCII fast path, so files that were
// read correctly before read exactly the same way now.

const NON_ASCII = /[^\x00-\x7f]/;
const stripMarks = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');

// ---------------------------------------------------------------------------
// Header names
// ---------------------------------------------------------------------------

const headerCache = new Map();
/**
 * Header comparison key: lower case, letters and digits only, in any script.
 * Accents are dropped ("Währung" and "Wahrung" compare equal), full-width
 * letters become plain ones, "ß" becomes "ss". A header that is only a symbol
 * (such as "#") is kept.
 */
export function normHeader(h) {
  const t0 = String(h ?? '').trim();
  if (!NON_ASCII.test(t0)) { const t = t0.toLowerCase(); const k = t.replace(/[^a-z0-9]/g, ''); return k || (t.length <= 3 ? t : ''); }
  const hit = headerCache.get(t0);
  if (hit !== undefined) return hit;
  const t = t0.normalize('NFKC').toLowerCase();
  const k = stripMarks(t).replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}]/gu, '');
  const out = k || ([...t].length <= 3 ? t : '');
  if (headerCache.size > 4096) headerCache.clear();
  headerCache.set(t0, out);
  return out;
}

/** Lower case, no accents, letters, digits and single spaces only (any script). For comparing names and words. */
export function foldText(s) {
  let t = String(s ?? '');
  if (NON_ASCII.test(t)) t = stripMarks(t.normalize('NFKC')).replace(/ß/g, 'ss');
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

// Active ISO 4217 codes (plus RMB and NTD, which exports use).
const ISO = new Set(('AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNH CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL RMB NTD').split(' '));
// Codes also accepted in lower case (payment exports such as Stripe write "usd").
const ISO_LOWER = new Set('usd eur gbp jpy cny krw brl inr chf cad aud mxn sek nok dkk pln czk huf nzd sgd hkd twd'.split(' '));
// Local words and signs written next to an amount, compared without accents and dots.
const LOCAL_WORDS = new Set(['kr', 'zl', 'zł', 'kc', 'fr', 'sfr', 'rs', 'ft', 'lei', 'dh', '円', '元', '圆', '圓', '块', '원']);
const SIGNS = /[$€£¥₹₩₽₺₪₫฿₱₦₴₸₡₲₵₭₮₼₾¢]/g;
const LEAD_SIGN = new RegExp(`^(?:${SIGNS.source})+`);
const TRAIL_SIGN = new RegExp(`(?:${SIGNS.source})+$`);
const LEAD = /^((?:[A-Za-z]{1,3})\$|[Ss]\/\.?|\p{L}{1,4}\.?)(?=[-+−(△▲]?[\d.,])/u;
const TRAIL = /(?<=[\d.,)])(\p{L}{1,4}\.?)$/u;

function isCurrencyWord(tok) {
  if (/^[A-Za-z]{1,3}\$$/.test(tok) || /^[Ss]\/\.?$/.test(tok)) return true;
  const t = tok.replace(/\.$/, '');
  if (ISO.has(t) || ISO_LOWER.has(t)) return true;
  return LOCAL_WORDS.has(stripMarks(t.toLowerCase()));
}

/**
 * Turn an amount as exports write it into a plain decimal string:
 * "$1,200.00", "(45.10)", "12-", "1.234,56 €", "USD 12", "R$ 1.234,56",
 * "1,200円", "₩12,000", "12,000원", "CHF 1'234.50", "1 234,56 zł",
 * "₹1,00,000", "△1,200" (Japanese negative), full-width digits.
 * decimal: '.' or ',' for the decimal mark when one value alone cannot tell
 * (default '.'). Returns null when it is not an amount.
 */
export function cleanAmount(value, { decimal = '.' } = {}) {
  let s = String(value ?? '').trim();
  if (!s) return null;
  if (NON_ASCII.test(s)) s = s.normalize('NFKC');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  s = s.replace(/[\s'’]/g, '');
  // Peel currency words and signs from both ends, in any order: "-R$ 12", "R$ -12", "¥△1,200", "12,50 €-".
  for (let i = 0; i < 4; i++) {
    const before = s;
    const lead = LEAD.exec(s); if (lead && isCurrencyWord(lead[1])) s = s.slice(lead[1].length);
    const trail = TRAIL.exec(s); if (trail && isCurrencyWord(trail[1])) s = s.slice(0, -trail[1].length);
    s = s.replace(LEAD_SIGN, '').replace(TRAIL_SIGN, '');
    while (/^[-+\u2212\u25b3\u25b2]/.test(s)) { if (s[0] !== '+') neg = !neg; s = s.slice(1); }
    if (/[-\u2212]$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
    if (s === before) break;
  }
  s = s.replace(SIGNS, '');
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  let dec = null;
  if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
  // Indian grouping (1,00,000) and three-digit groups (1,000,000) are thousands.
  else if (lastComma >= 0) dec = decimal === ',' ? ',' : /^\d{1,3}(,\d{3})+$/.test(s) || /^\d{1,2}(,\d{2})+,\d{3}$/.test(s) ? null : ',';
  else if (lastDot >= 0) dec = (decimal === ',' && /^\d{1,3}(\.\d{3})+$/.test(s)) || /^\d{1,3}(\.\d{3}){2,}$/.test(s) ? null : '.';
  const thousands = dec === '.' ? ',' : dec === ',' ? '.' : lastComma >= 0 ? ',' : '.';
  let body = s.split(thousands).join('');
  if (dec === ',') body = body.replace(',', '.');
  if (!/^\d*\.?\d+$/.test(body) && !/^\d+\.$/.test(body)) return null;
  if (body.startsWith('.')) body = '0' + body;
  if (body.endsWith('.')) body = body.slice(0, -1);
  return (neg && Number(body) !== 0 ? '-' : '') + body;
}

/** '.' or ',' : the decimal mark a column of amounts uses. */
export function inferDecimal(values) {
  let comma = 0, dot = 0;
  for (const v of values) {
    let s = String(v ?? '');
    if (NON_ASCII.test(s)) s = s.normalize('NFKC');
    s = s.replace(/[^\d.,]/g, '');
    const d = s.lastIndexOf('.'), c = s.lastIndexOf(',');
    if (d >= 0 && c >= 0) { if (d > c) dot += 2; else comma += 2; }
    else if (c >= 0 && /,\d{1,2}$/.test(s)) comma += 1;
    else if (d >= 0 && /\.\d{1,2}$/.test(s)) dot += 1;
  }
  return comma > dot ? ',' : '.';
}

/**
 * A number from a cell: plain numbers as they are, anything else through
 * cleanAmount. decimal: the column's decimal mark when known (see inferDecimal).
 */
export function readNumber(v, { decimal = '.' } = {}) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s) && !(decimal === ',' && /^[-+]?\d{1,3}\.\d{3}$/.test(s))) return Number(s);
  const a = cleanAmount(s, { decimal });
  return a === null ? null : Number(a);
}

/** A number reader for one column: works out the decimal mark from the column's values first. */
export function numberReader(values) {
  const decimal = inferDecimal(values);
  return (v) => readNumber(v, { decimal });
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  ['january', 'januar', 'janvier', 'enero', 'janeiro', 'gennaio', 'januari'],
  ['february', 'februar', 'fevrier', 'febrero', 'fevereiro', 'febbraio', 'februari'],
  ['march', 'marz', 'maerz', 'mars', 'marzo', 'marco', 'maart'],
  ['april', 'avril', 'abril', 'aprile'],
  ['may', 'mai', 'mayo', 'maio', 'maggio', 'mei'],
  ['june', 'juni', 'juin', 'junio', 'junho', 'giugno'],
  ['july', 'juli', 'juillet', 'julio', 'julho', 'luglio'],
  ['august', 'aout', 'agosto', 'augustus'],
  ['september', 'septembre', 'septiembre', 'setiembre', 'setembro', 'settembre'],
  ['october', 'oktober', 'octobre', 'octubre', 'outubro', 'ottobre'],
  ['november', 'novembre', 'noviembre', 'novembro'],
  ['december', 'dezember', 'decembre', 'diciembre', 'dezembro', 'dicembre'],
];
// Every full name and every prefix of three letters or more that belongs to one month only.
const MONTHS = new Map();
for (const [i, names] of MONTH_NAMES.entries()) for (const n of names) {
  MONTHS.set(n, i + 1);
  for (let k = 3; k < n.length; k++) { const p = n.slice(0, k); const was = MONTHS.get(p); MONTHS.set(p, was === undefined || was === i + 1 ? i + 1 : -1); }
}
const monthOf = (w) => { const m = MONTHS.get(stripMarks(String(w).toLowerCase()).replace(/\.$/, '')); return m > 0 ? m : null; };

const WEEKDAYS = new Set(('monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun ' +
  'montag dienstag mittwoch donnerstag freitag samstag sonnabend sonntag mo di mi do fr sa so ' +
  'lundi mardi mercredi jeudi vendredi samedi dimanche lun mar mer jeu ven sam dim ' +
  'lunes martes miercoles jueves viernes sabado domingo mie jue vie sab dom ' +
  'segunda terca quarta quinta sexta seg ter qua qui sex ' +
  'lunedi martedi mercoledi giovedi venerdi sabato domenica gio').split(' '));

const DIM = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const p2 = (n) => String(n).padStart(2, '0');
const year2 = (y) => { const n = Number(y); return String(y).length <= 2 ? (n < 70 ? 2000 + n : 1900 + n) : n; };
const okDate = (y, m, d) => y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= DIM[m - 1] && (m !== 2 || d < 29 || (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)));

function timeOf(rest) {
  const r = String(rest || '');
  let m = /^[T ,@]*\s*(?:(?:at|à|a las|às|alle|um)\s+)?(午前|午後|오전|오후)?\s*(\d{1,2})(?::|h(?=\d{2})|時|시\s*)(\d{2})(?:分|분)?(?::(\d{2})(?:[.,]\d+)?|(\d{2})(?:秒|초))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(z|utc|gmt|[+-]\d{2}:?\d{2})?/i.exec(r);
  if (!m) return null;
  let h = Number(m[2]); const ap = (m[6] || '').toLowerCase().replace(/\./g, '');
  const pm = ap === 'pm' || m[1] === '午後' || m[1] === '오후', am = ap === 'am' || m[1] === '午前' || m[1] === '오전';
  if (pm && h < 12) h += 12; if (am && h === 12) h = 0;
  const sec = m[4] || m[5] || '00';
  if (h > 23 || Number(m[3]) > 59 || Number(sec) > 59) return null;
  let zone = (m[7] || '').toUpperCase();
  if (zone === 'UTC' || zone === 'GMT') zone = 'Z';
  else if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return `${p2(h)}:${m[3]}:${sec}${zone}`;
}

// Japanese era names: first day of each era and the Gregorian year before its year 1.
const ERAS = { 令和: [2018, '2019-05-01', null], R: [2018, '2019-05-01', null], 平成: [1988, '1989-01-08', '2019-04-30'], H: [1988, '1989-01-08', '2019-04-30'], 昭和: [1925, '1926-12-25', '1989-01-07'], S: [1925, '1926-12-25', '1989-01-07'] };

/**
 * Parse one date in the shapes exports use. order: 'mdy' or 'dmy' for
 * all-number dates such as 03/04/2026 (default 'mdy').
 * Reads ISO dates, 03/04/2026, 03.04.2026, 2026/04/03, "3 Nov 2026",
 * "Nov 3, 2026", "14. November 2026", "14 de noviembre de 2026", "14/NOV/2026",
 * "2026年11月14日", "2026년 11월 14일", "2026. 11. 14.", Japanese era dates
 * (令和8年11月14日, R8.11.14) and Taiwan's 民國 years, with an optional time.
 * Returns { iso, date, time, ambiguous, already } or null.
 * `already` is true when the text was an ISO date to begin with.
 */
export function parseAnyDate(value, { order = 'mdy', compact = false } = {}) {
  let s = String(value ?? '').trim();
  if (!s || s.length > 60) return null;
  if (NON_ASCII.test(s)) s = s.normalize('NFKC');
  let m;
  const done = (y, mo, d, rest, extra = {}) => {
    if (!okDate(y, mo, d)) return null;
    const date = `${y}-${p2(mo)}-${p2(d)}`; const time = timeOf(rest);
    return { iso: time ? `${date}T${time}` : date, date, time, ambiguous: false, already: false, ...extra };
  };
  if ((m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(s))) {
    const r = done(+m[1], +m[2], +m[3], m[4]);
    // A clean ISO date or date-time is left exactly as written.
    return r && /^(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(m[4]) ? { ...r, iso: s, already: true } : r;
  }
  if ((m = /^(\d{4})\s*[年년]\s*(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日号일](.*)$/.exec(s))) return done(+m[1], +m[2], +m[3], m[4]);
  if ((m = /^(\d{4})\s*([/.])\s*(\d{1,2})\s*\2\s*(\d{1,2})\.?(?!\d)(.*)$/.exec(s))) return done(+m[1], +m[3], +m[4], m[5]);
  if ((m = /^(令和|平成|昭和|[RHS])\s*(元|\d{1,2})\s*(?:年|[./])\s*(\d{1,2})\s*(?:月|[./])\s*(\d{1,2})\s*日?(?!\d)(.*)$/.exec(s))) {
    const [base, from, to] = ERAS[m[1]]; const r = done(base + (m[2] === '元' ? 1 : +m[2]), +m[3], +m[4], m[5]);
    return r && r.date >= from && (!to || r.date <= to) ? r : null;
  }
  if ((m = /^民[國国]\s*(\d{1,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(.*)$/.exec(s))) return done(1911 + +m[1], +m[2], +m[3], m[4]);
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)(.*)$/.exec(s))) {
    const a = +m[1], b = +m[2], y = year2(m[3]);
    const dmy = a > 12 ? true : b > 12 ? false : order === 'dmy';
    return done(y, dmy ? b : a, dmy ? a : b, m[4], { ambiguous: a <= 12 && b <= 12 && a !== b, numeric: true });
  }
  const words = (t) => {
    let w;
    if ((w = /^(\d{1,2})(?:st|nd|rd|th|er|º|°|\.)?(?:\s+de)?[\s/-]+(\p{L}{3,12})\.?,?(?:\s+de)?[\s/-]+(\d{4}|\d{2})(?!\d)(.*)$/u.exec(t))) { const mo = monthOf(w[2]); return mo ? done(year2(w[3]), mo, +w[1], w[4]) : null; }
    if ((w = /^(\p{L}{3,12})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)(.*)$/u.exec(t))) { const mo = monthOf(w[1]); return mo ? done(+w[3], mo, +w[2], w[4]) : null; }
    return null;
  };
  const r = words(s);
  if (r) return r;
  // A weekday in front: "Tue, 3 Nov 2026", "Montag, 14. November 2026", "lunes 14 de noviembre de 2026".
  if ((m = /^(\p{L}+)(?:-feira)?\.?,?\s+(.*)$/u.exec(s)) && WEEKDAYS.has(stripMarks(m[1].toLowerCase()))) { const r2 = words(m[2]); if (r2) return r2; }
  if (compact && (m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return done(+m[1], +m[2], +m[3], '');
  return null;
}

/** Work out whether all-number dates in a column are month-first or day-first. Returns 'mdy', 'dmy', 'mixed' or null (cannot tell). */
export function inferDateOrder(values) {
  let mdy = false, dmy = false;
  for (const v of values) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/.exec(String(v ?? '').trim());
    if (!m) continue;
    if (+m[1] > 12 && +m[2] <= 12) dmy = true; else if (+m[2] > 12 && +m[1] <= 12) mdy = true;
  }
  return mdy && dmy ? 'mixed' : mdy ? 'mdy' : dmy ? 'dmy' : null;
}
