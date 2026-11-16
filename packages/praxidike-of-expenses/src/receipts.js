import { sha256, round2, parseAnyDate } from 'mythos-agent-core';

// Receipt text normalisation for text you already have (from your scanner, card
// feed or OCR tool). Praxidike does no OCR itself and never returns receipt text:
// only the merchant line, totals, dates, currency and a content hash.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
// Amounts with two decimals (1,234.50 / 1.234,50 / 45,90). Receipts in yen or won have
// no decimals, so those receipts (and receipts with Japanese, Chinese or Korean labels)
// also accept whole amounts, unless a count word follows (3点, 2개 are item counts).
const AMT = String.raw`(\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d+[.,]\d{2})`;
const AMT_WHOLE = String.raw`(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?)(?!\d)(?!\s*(?:点|個|件|品|枚|개|건|項|项|pcs?\b|items?\b))`;
// Label → priority. Higher wins when picking "the" total. "(?<![a-z])" keeps "Subtotal" out.
const LABELS = [
  ['grand\\s+total', 4], ['total\\s+due', 3], ['amount\\s+due', 3], ['balance\\s+due', 3], ['total\\s+to\\s+pay', 3],
  ['amount\\s+paid', 1], ['total', 2], ['gesamt(?:betrag)?', 2], ['summe', 2], ['montant', 2], ['balance', 1], ['paid', 1], ['amount', 1],
  // German, French, Spanish, Portuguese, Italian.
  ['zu\\s+zahlen', 3], ['endbetrag', 3], ['total\\s+ttc', 4], ['montant\\s+ttc', 3], ['net\\s+[àa]\\s+payer', 3], ['total\\s+a\\s+pagar', 3], ['importe\\s+total', 3], ['importe', 1],
  ['valor\\s+total', 3], ['valor\\s+a\\s+pagar', 3], ['totale\\s+(?:complessivo|da\\s+pagare)', 3], ['totale', 2], ['importo\\s+pagato', 1], ['importo', 1],
  // Japanese, Chinese, Korean.
  ['総合計', 4], ['ご請求(?:金)?額', 3], ['お支払(?:い)?(?:金額|額)?', 3], ['お会計', 3], ['領収金額', 3], ['合計(?:金額)?', 2],
  ['总计', 4], ['应付(?:金额)?', 3], ['实付(?:金额)?', 3], ['應付(?:金額)?', 3], ['合计(?:金额)?', 2], ['總計', 4], ['合計', 2],
  ['총\\s*합계', 4], ['결제\\s*금액', 3], ['받을\\s*금액', 3], ['청구\\s*금액', 3], ['총액', 3], ['합계(?:\\s*금액)?', 2],
];
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// A label right after a letter or a dash is part of another word (Subtotal, Sous-total).
const totalRe = (amt) => new RegExp(`(?<![a-z\\u00C0-\\u024F-])(${LABELS.map(([l]) => l).join('|')})(?![a-z\\u00C0-\\u024F])[^\\d\\n]{0,20}?${amt}`, 'giu');
const TOTAL_RE = totalRe(AMT), TOTAL_RE_WHOLE = totalRe(AMT_WHOLE);
const PRIO = LABELS.map(([re, p]) => [new RegExp(`^${re}$`, 'u'), p]);
const prio = (label) => { const l = label.toLowerCase(); for (const [re, p] of PRIO) if (re.test(l)) return p; return 0; };
const labelled = (re, t, amt = AMT) => { const m = new RegExp(`(?<![a-z\\u00C0-\\u024F])(?:${re})(?![a-z\\u00C0-\\u024F])[^\\d\\n]{0,20}?${amt}`, 'iu').exec(t); return m ? parseAmount(m[1]) : null; };

/** Parse 1,234.50 / 1.234,50 / 45,90 / 45.90 / ¥1,200 into a number (2 decimals). */
export function parseAmount(s) {
  let t = String(s ?? '').normalize('NFKC').replace(/[^\d.,-]/g, '');
  if (/^\d{1,3}(?:\.\d{3})+,\d{2}$/.test(t) || /^\d+,\d{2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return t && Number.isFinite(n) ? round2(n) : null;
}

const utc = (y, m, d) => { const t = Date.UTC(y, m - 1, d); const x = new Date(t); return x.getUTCMonth() === m - 1 && x.getUTCDate() === d ? t : null; };
// "14. November 2026", "14 novembre 2026", "14 de noviembre de 2026": read by the core date reader.
const WORD_DATE = /\b\d{1,2}\.?\s+(?:de\s+)?[\p{L}]{3,12}\.?\s+(?:de\s+)?\d{4}\b/gu;
/**
 * All dates in the text, in order of appearance: ISO, m/d/yyyy (d/m/yyyy when dayFirst),
 * d.m.yyyy, "Nov 3, 2026", "3 Nov 2026", month names in German, French, Spanish,
 * Portuguese and Italian, 2026/11/14, 2026年11月14日, 令和8年11月14日 and 2026년 11월 14일.
 */
export function findDates(text, { dayFirst = false } = {}) {
  const t = String(text).normalize('NFKC'); const out = [];
  const add = (idx, ms) => { if (ms !== null) out.push({ idx, ms }); };
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(m.index, utc(+m[1], +m[2], +m[3]));
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) add(m.index, dayFirst ? utc(+m[3], +m[2], +m[1]) : utc(+m[3], +m[1], +m[2]));
  for (const m of t.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g)) add(m.index, utc(+m[3], +m[2], +m[1]));
  for (const m of t.matchAll(new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'gi'))) add(m.index, utc(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]));
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})\\s+${MON}\\.?,?\\s+(\\d{4})\\b`, 'gi'))) add(m.index, utc(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]));
  // Year first: 2026/11/14, 2026.11.14, 2026年11月14日, 2026년 11월 14일.
  for (const m of t.matchAll(/(?<!\d)(\d{4})\s*(?:[/.]|年|년)\s*(\d{1,2})\s*(?:[/.]|月|월)\s*(\d{1,2})(?!\d)/g)) add(m.index, utc(+m[1], +m[2], +m[3]));
  // Japanese era years: 令和8年11月14日, R8.11.14, 平成31年4月30日.
  for (const m of t.matchAll(/(令和|平成|(?<![A-Za-z])[RH])\s*(\d{1,2}|元)\s*[年.]\s*(\d{1,2})\s*[月.]\s*(\d{1,2})/g)) {
    const n = m[2] === '元' ? 1 : +m[2]; add(m.index, utc((m[1] === '令和' || m[1] === 'R' ? 2018 : 1988) + n, +m[3], +m[4]));
  }
  for (const m of t.matchAll(WORD_DATE)) { const d = parseAnyDate(m[0]); if (d && d.date) add(m.index, Date.parse(d.date + 'T00:00:00Z')); }
  const seen = new Set();
  return out.sort((a, b) => a.idx - b.idx).filter((x) => (seen.has(x.idx) ? false : seen.add(x.idx))).map((x) => x.ms);
}

function currencyOf(t) {
  if (/\bEUR\b|€/.test(t)) return 'EUR';
  if (/\bGBP\b|£/.test(t)) return 'GBP';
  if (/\bBRL\b|R\$/.test(t)) return 'BRL';
  if (/\bKRW\b|₩|￦|\d\s*원/u.test(t)) return 'KRW';
  if (/\bJPY\b|\d\s*円|円\s*\d|税込|税抜/u.test(t)) return 'JPY';
  if (/\bCNY\b|\bRMB\b|人民币|\d\s*元/u.test(t)) return 'CNY';
  if (/[¥￥]/u.test(t)) return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t) ? 'JPY' : CJK.test(t) ? 'CNY' : 'JPY';
  if (/\bCHF\b/.test(t)) return 'CHF';
  if (/\bINR\b|₹/.test(t)) return 'INR';
  if (/\bMXN\b|MX\$/.test(t)) return 'MXN';
  if (/\bAUD\b|A\$/.test(t)) return 'AUD';
  if (/\bCAD\b|C\$/.test(t)) return 'CAD';
  if (/\bUSD\b|US\$|\$/.test(t)) return 'USD';
  return null;
}
// Currencies whose receipts carry no decimals.
const WHOLE = new Set(['JPY', 'KRW']);
// Where the day comes first in 03/11/2026.
const DAY_FIRST = new Set(['EUR', 'GBP', 'BRL', 'CHF', 'INR', 'MXN', 'AUD']);

/** Mask anything that looks like a card or account number (12–19 digits). */
const mask = (s) => String(s || '').replace(/\b\d(?:[ -]?\d){11,18}\b/g, (m) => `•••• ${m.replace(/\D/g, '').slice(-4)}`);

// Header words that are not the merchant: receipt, invoice, date, phone, in nine languages.
const NOT_MERCHANT = /^(date|receipt|invoice|order|tel|phone|datum|quittung|beleg|rechnung|re[çc]u|facture|ticket|fecha|recibo|factura|nota\s+fiscal|cupom|data|scontrino|ricevuta|fattura|領収書|領収証|レシート|請求書|日付|電話|发票|發票|收据|收據|小票|日期|电话|영수증|계산서|날짜|전화)/iu;
function merchantOf(t) {
  for (const raw of String(t).split(/\r?\n/)) {
    const line = raw.normalize('NFKC').trim();
    if ((line.match(/\p{L}/gu) || []).length < 2) continue;
    if (NOT_MERCHANT.test(line)) continue;
    const m = line.split(/\s[(\-–|]\s?|\(/)[0].replace(/\b(tax\s+invoice|invoice|receipt|e-ticket)\b.*$/i, '').trim();
    if (m) return mask(m).slice(0, 60);
  }
  return '';
}

const iso = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * Normalise receipt text into { merchant, total, date, currency, tax, tip, subtotal,
 * amounts (every total-like amount), dates (ms), content_sha256 }. The text is not returned.
 */
export function normalizeReceipt(text) {
  const t0 = String(text ?? '');
  const t = t0.normalize('NFKC');
  const currency = currencyOf(t);
  const whole = WHOLE.has(currency) || (CJK.test(t) && !/\d[.,]\d{2}(?!\d)/.test(t));
  const amt = whole ? AMT_WHOLE : AMT;
  const hits = [...t.matchAll(whole ? TOTAL_RE_WHOLE : TOTAL_RE)].map((m) => ({ p: prio(m[1]), n: parseAmount(m[2]) })).filter((x) => x.n !== null);
  const best = hits.reduce((b, x) => (!b || x.p >= b.p ? x : b), null);
  const dates = findDates(t, { dayFirst: DAY_FIRST.has(currency) });
  const dl = /(?:^|\n)\s*(?:date|datum|fecha|data|日付|日期|날짜)\s*[:：]?\s*([^\n]+)/iu.exec(t);
  const labelledDate = dl ? findDates(dl[1], { dayFirst: DAY_FIRST.has(currency) })[0] : undefined;
  const date = labelledDate ?? dates[0] ?? null;
  return {
    merchant: merchantOf(t), total: best ? best.n : null, date: date === null ? null : iso(date), currency,
    subtotal: labelled('sub\\s*-?total|zwischensumme|sous-total|subtotale|小計|小计|소계', t, amt),
    tax: labelled('tax|vat|gst|hst|mwst|ust|tva|iva|icms|消費税|内消費税|税額|税额|增值税|부가세|부가가치세|세액', t, amt),
    tip: labelled('tip|gratuity|trinkgeld|pourboire|propina|gorjeta|mancia|チップ|小费|팁', t, amt),
    amounts: hits.map((x) => x.n), dates, content_sha256: sha256(t0.toLowerCase().replace(/\s+/g, ' ').trim()),
  };
}

/** Back-compatible reader used by the review: total-like amounts and dates only. */
export function readReceipt(text) { const r = normalizeReceipt(text); return { amounts: r.amounts, dates: r.dates }; }

/** Public view of a normalised receipt (no raw text, dates as YYYY-MM-DD). */
export function receiptView(file, r) {
  return { file, merchant: r.merchant, total: r.total, date: r.date, currency: r.currency, subtotal: r.subtotal, tax: r.tax, tip: r.tip, candidate_totals: r.amounts, dates: r.dates.map(iso), content_sha256: r.content_sha256 };
}
