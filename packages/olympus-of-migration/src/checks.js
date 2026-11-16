import { round2, normHeader, namesFor, numberReader } from 'mythos-agent-core';
import { olympusText } from './text.js';

// Header names compare in any script ("金額", "Währung"), so two Japanese headers
// no longer both become "" and collide.
const norm = (s) => normHeader(s);
// English names first, then the same columns as German, French, Spanish, Portuguese,
// Italian, Japanese, Chinese and Korean exports name them.
const local = (...concepts) => concepts.flatMap((c) => namesFor(c)).map(norm);
const uniq = (a) => [...new Set(a)].filter(Boolean);
const KEY_CANDIDATES = uniq(['externalid', 'id', 'internalid', 'tranid', 'documentnumber', 'entityid', 'itemid', 'number', ...local('external_id', 'document_number', 'id')]);
const AMOUNT_CANDIDATES = uniq(['amount', 'total', 'amountremaining', 'balance', 'openbalance', 'grossamount', ...local('amount', 'balance')]);
const ACCOUNT_CANDIDATES = uniq(['account', 'accountnumber', 'acctnumber', 'accountname', 'number', ...local('account', 'account_name')]);
const BALANCE_CANDIDATES = uniq(['balance', 'amount', 'endingbalance', 'net', ...local('balance', 'amount')]);
export const DEFAULT_TOLERANCE = 0.005;

/**
 * Number readers per column: each column's decimal mark is worked out from its own
 * values, so "1.234" in a column of "1.234,56"-style amounts reads as 1234.
 */
function readers(rows) {
  const cache = new Map();
  return (col) => {
    if (!cache.has(col)) cache.set(col, numberReader(rows.slice(0, 5000).map((r) => r[col])));
    return cache.get(col);
  };
}

export function columnMap(rows) {
  const map = new Map();
  for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) if (!map.has(norm(k))) map.set(norm(k), k);
  return map;
}

function pick(map, wanted, candidates) {
  if (wanted) { const k = map.get(norm(wanted)); return k || null; }
  for (const c of candidates) if (map.has(c)) return map.get(c);
  return null;
}

/** A named optional column: absent when not asked for, an error when asked for but missing. */
function optionalColumn(map, wanted, label, side) {
  if (!wanted) return null;
  const k = map.get(norm(wanted));
  if (!k) throw new Error(`${label} "${wanted}" was not found in the ${side} file`);
  return k;
}

/** Differences up to and including the tolerance count as tied. */
export const withinTolerance = (diff, tol = DEFAULT_TOLERANCE) => Math.abs(diff) <= Number(tol) + 1e-9;

function sameValue(a, b, tol, ra, rb) {
  const na = ra(a), nb = rb(b);
  if (na !== null && nb !== null) return withinTolerance(na - nb, tol);
  return String(a ?? '').trim() === String(b ?? '').trim();
}

function index(rows, key) {
  const byKey = new Map(); const dups = new Set(); let blank = 0;
  for (const r of rows) {
    const k = String(r[key] ?? '').trim();
    if (!k) { blank++; continue; }
    if (byKey.has(k)) dups.add(k); else byKey.set(k, r);
  }
  return { byKey, dups: [...dups], blank };
}

function total(rows, col, read) {
  if (!col) return { column: null, total: null, unparseable: 0 };
  let t = 0, bad = 0;
  for (const r of rows) { const n = read(r[col]); if (n === null) bad++; else t += n; }
  return { column: col, total: round2(t), unparseable: bad };
}

function totalsBy(rows, groupCol, amtCol, read) {
  const m = new Map();
  for (const r of rows) {
    const g = String(r[groupCol] ?? '').trim() || '(blank)';
    const n = read(r[amtCol]);
    if (n !== null) m.set(g, round2((m.get(g) || 0) + n));
    else if (!m.has(g)) m.set(g, 0);
  }
  return m;
}

/** Compare a source-system export with the target (e.g. NetSuite sandbox) export. */
export function compareExports(source, target, opts = {}) {
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE;
  const sMap = columnMap(source), tMap = columnMap(target);
  const sKey = pick(sMap, opts.key, KEY_CANDIDATES), tKey = pick(tMap, opts.target_key || opts.key, KEY_CANDIDATES);
  if (!sKey || !tKey) throw new Error(`could not find a key column (tried ${opts.key || KEY_CANDIDATES.join(', ')}); pass "key"`);
  const s = index(source, sKey), t = index(target, tKey);
  const missing = [...s.byKey.keys()].filter((k) => !t.byKey.has(k));
  const extra = [...t.byKey.keys()].filter((k) => !s.byKey.has(k));
  const shared = [...sMap.keys()].filter((c) => tMap.has(c) && c !== norm(sKey) && c !== norm(tKey));
  const cols = opts.compare_columns ? opts.compare_columns.map(norm).filter((c) => shared.includes(c)) : shared;
  const mismatches = [];
  let mismatchCount = 0;
  const sRead = readers(source), tRead = readers(target);
  for (const [k, sr] of s.byKey) {
    const tr = t.byKey.get(k); if (!tr) continue;
    for (const c of cols) {
      const sv = sr[sMap.get(c)], tv = tr[tMap.get(c)];
      if (!sameValue(sv, tv, tol, sRead(sMap.get(c)), tRead(tMap.get(c)))) { mismatchCount++; if (mismatches.length < 100) mismatches.push({ key: k, column: sMap.get(c), source: sv ?? '', target: tv ?? '' }); }
    }
  }
  const sAmtCol = pick(sMap, opts.amount_column, AMOUNT_CANDIDATES), tAmtCol = pick(tMap, opts.amount_column, AMOUNT_CANDIDATES);
  const sAmt = total(source, sAmtCol, sRead(sAmtCol));
  const tAmt = total(target, tAmtCol, tRead(tAmtCol));
  const findings = [];
  // The message is English; params let a report rebuild it in another language.
  const add = (severity, code, message, params = {}) => findings.push({ severity, code, message, params });
  const list = (a) => `${a.slice(0, 10).join(', ')}${a.length > 10 ? ', …' : ''}`;
  if (missing.length) add('blocking', 'missing_in_target', `${missing.length} source record(s) are not in the target: ${list(missing)}`, { n: missing.length, list: list(missing) });
  if (t.dups.length) add('blocking', 'duplicate_keys_target', `${t.dups.length} duplicate key(s) in the target: ${t.dups.slice(0, 10).join(', ')}`, { n: t.dups.length, list: t.dups.slice(0, 10).join(', ') });
  if (s.dups.length) add('warning', 'duplicate_keys_source', `${s.dups.length} duplicate key(s) in the source: ${s.dups.slice(0, 10).join(', ')}`, { n: s.dups.length, list: s.dups.slice(0, 10).join(', ') });
  if (s.blank || t.blank) add('warning', 'blank_keys', `${s.blank} source and ${t.blank} target row(s) have a blank key`, { s: s.blank, t: t.blank });
  if (extra.length) add('warning', 'extra_in_target', `${extra.length} target record(s) are not in the source: ${extra.slice(0, 10).join(', ')}`, { n: extra.length, list: extra.slice(0, 10).join(', ') });
  if (mismatchCount) add('warning', 'field_mismatch', `${mismatchCount} field value(s) differ between source and target`, { n: mismatchCount });
  let amountDifference = null;
  let bySubsidiary = null;
  if (sAmt.column && tAmt.column) {
    amountDifference = round2(sAmt.total - tAmt.total);
    if (!withinTolerance(amountDifference, tol)) add('blocking', 'totals_do_not_tie', `${sAmt.column} totals differ by ${amountDifference} (source ${sAmt.total}, target ${tAmt.total})`, { col: sAmt.column, diff: amountDifference, s: sAmt.total, t: tAmt.total });
    if (sAmt.unparseable || tAmt.unparseable) add('warning', 'unparseable_amounts', `${sAmt.unparseable} source and ${tAmt.unparseable} target amount(s) are blank or not numbers; totals exclude them`, { s: sAmt.unparseable, t: tAmt.unparseable });
    const sSub = opts.subsidiary_column ? sMap.get(norm(opts.subsidiary_column)) : null;
    const tSub = opts.subsidiary_column ? tMap.get(norm(opts.subsidiary_column)) : null;
    if (opts.subsidiary_column && (!sSub || !tSub)) add('info', 'no_subsidiary_column', `Column "${opts.subsidiary_column}" is not in both files, so totals were not tied per subsidiary.`, { col: opts.subsidiary_column });
    if (sSub && tSub) {
      const S = totalsBy(source, sSub, sAmtCol, sRead(sAmtCol)), T = totalsBy(target, tSub, tAmtCol, tRead(tAmtCol));
      bySubsidiary = [...new Set([...S.keys(), ...T.keys()])].sort().map((g) => {
        const sv = S.has(g) ? S.get(g) : null, tv = T.has(g) ? T.get(g) : null;
        const diff = sv !== null && tv !== null ? round2(sv - tv) : null;
        return { subsidiary: g, source: sv, target: tv, difference: diff, state: diff === null ? 'missing_or_unknown' : withinTolerance(diff, tol) ? 'ties' : 'differs' };
      });
      const off = bySubsidiary.filter((x) => x.state !== 'ties');
      if (off.length) add('blocking', 'subsidiary_totals_do_not_tie', `${off.length} subsidiar${off.length === 1 ? 'y does' : 'ies do'} not tie: ${off.map((x) => `${x.subsidiary} (${x.difference ?? 'missing'})`).join(', ')}`, { n: off.length, list: off.map((x) => `${x.subsidiary} (${x.difference ?? '—'})`).join(', ') });
    }
  } else {
    add('info', 'no_amount_column', 'No amount column found, so totals were not compared. Pass "amount_column" to compare them.');
  }
  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  return {
    status: blocking ? 'blocking' : findings.some((f) => f.severity === 'warning') ? 'warnings' : 'clean',
    go_live: 'not_approved',
    go_live_note: 'Go-live is a human decision. Olympus reports; it never approves go-live.',
    key: { source: sKey, target: tKey },
    tolerance: Number(tol),
    counts: { source: source.length, target: target.length, matched: s.byKey.size - missing.length, missing_in_target: missing.length, extra_in_target: extra.length, field_mismatches: mismatchCount },
    totals: { source: sAmt, target: tAmt, difference: amountDifference, ...(bySubsidiary ? { by_subsidiary: bySubsidiary } : {}) },
    missing_in_target: missing.slice(0, 200), extra_in_target: extra.slice(0, 200),
    mismatches, findings,
  };
}

/**
 * Trial balance tie-out by account, optionally by subsidiary and currency.
 * - tolerance: differences up to and including it tie (default 0.005).
 * - subsidiary_column: tie out per subsidiary + account, with a per-subsidiary summary.
 * - currency_column without fx_rates: currency becomes part of the key (tie out in each currency).
 * - currency_column with fx_rates ({ EUR: 1.08 } = 1 EUR in base_currency): every row is
 *   converted to base_currency first. A currency with no rate is reported as unknown, never guessed.
 * Never fills in a missing balance.
 */
export function tieOutBalances(source, target, opts = {}) {
  const sMap = columnMap(source), tMap = columnMap(target);
  const sA = pick(sMap, opts.account_column, ACCOUNT_CANDIDATES), tA = pick(tMap, opts.account_column, ACCOUNT_CANDIDATES);
  const sB = pick(sMap, opts.balance_column, BALANCE_CANDIDATES), tB = pick(tMap, opts.balance_column, BALANCE_CANDIDATES);
  if (!sA || !tA || !sB || !tB) throw new Error('could not find account and balance columns; pass "account_column" and "balance_column"');
  const tol = Number(opts.tolerance ?? DEFAULT_TOLERANCE);
  const sS = optionalColumn(sMap, opts.subsidiary_column, 'subsidiary_column', 'source'), tS = optionalColumn(tMap, opts.subsidiary_column, 'subsidiary_column', 'target');
  const sC = optionalColumn(sMap, opts.currency_column, 'currency_column', 'source'), tC = optionalColumn(tMap, opts.currency_column, 'currency_column', 'target');
  const fx = opts.fx_rates && Object.keys(opts.fx_rates).length ? Object.fromEntries(Object.entries(opts.fx_rates).map(([k, v]) => [k.toUpperCase(), Number(v)])) : null;
  const base = String(opts.base_currency || 'USD').toUpperCase();
  if (fx && !sC) throw new Error('fx_rates needs "currency_column" so each row\'s currency is known');
  const convert = !!(fx && sC && tC);
  const currencyIsKey = !!(sC && tC && !convert);
  const missingRates = new Set();
  const agg = (rows, a, b, sub, cur) => {
    const m = new Map(); const unknown = []; const meta = new Map(); const read = readers(rows)(b);
    for (const r of rows) {
      const acct = String(r[a] ?? '').trim() || '(blank account)';
      const subsidiary = sub ? String(r[sub] ?? '').trim() || '(blank)' : null;
      const currency = cur ? String(r[cur] ?? '').trim().toUpperCase() || base : null;
      const parts = [subsidiary, acct, currencyIsKey ? currency : null].filter((x) => x !== null);
      const k = parts.join(' · ');
      meta.set(k, { account: acct, ...(sub ? { subsidiary } : {}), ...(currencyIsKey ? { currency } : {}) });
      let n = read(r[b]);
      if (n !== null && convert) {
        const rate = currency === base ? 1 : fx[currency];
        if (!(rate > 0)) { missingRates.add(currency); n = null; } else n = round2(n * rate);
      }
      if (n === null) { unknown.push(k); continue; }
      m.set(k, round2((m.get(k) || 0) + n));
    }
    return { m, unknown, meta };
  };
  const S = agg(source, sA, sB, sS, sC), T = agg(target, tA, tB, tS, tC);
  const meta = new Map([...S.meta, ...T.meta]);
  const sUnknown = new Set(S.unknown), tUnknown = new Set(T.unknown);
  const unknownSet = new Set([...sUnknown, ...tUnknown]);
  const keys = [...new Set([...S.m.keys(), ...T.m.keys(), ...unknownSet])].sort();
  const lines = keys.map((k) => {
    const sv = S.m.has(k) && !sUnknown.has(k) ? S.m.get(k) : null, tv = T.m.has(k) && !tUnknown.has(k) ? T.m.get(k) : null;
    const diff = sv !== null && tv !== null ? round2(sv - tv) : null;
    const state = sv === null || tv === null ? 'missing_or_unknown' : withinTolerance(diff, tol) ? 'ties' : 'differs';
    const md = meta.get(k) || { account: k };
    return { account: sS || currencyIsKey ? md.account : k, ...(sS ? { subsidiary: md.subsidiary } : {}), ...(currencyIsKey ? { currency: md.currency } : {}), source: sv, target: tv, difference: diff, state };
  });
  const sum = (m, skip) => round2([...m.entries()].filter(([k]) => !skip.has(k)).reduce((x, [, y]) => x + y, 0));
  const bad = lines.filter((l) => l.state !== 'ties');
  let bySubsidiary = null;
  if (sS) {
    const groups = new Map();
    for (const l of lines) {
      const g = groups.get(l.subsidiary) || { subsidiary: l.subsidiary, accounts: 0, tied: 0, not_tied: 0, unknown: 0, difference: 0 };
      g.accounts++; if (l.state === 'ties') g.tied++; else g.not_tied++;
      if (l.difference === null) g.unknown++; else g.difference = round2(g.difference + l.difference);
      groups.set(l.subsidiary, g);
    }
    bySubsidiary = [...groups.values()].sort((a, b) => a.subsidiary.localeCompare(b.subsidiary)).map((g) => ({ ...g, ...(convert ? { currency: base } : {}), state: g.not_tied ? 'blocking' : 'ties' }));
  }
  return {
    status: bad.length ? 'blocking' : 'ties',
    go_live: 'not_approved',
    tolerance: tol,
    ...(convert ? { base_currency: base, fx_rates: fx, missing_fx_rates: [...missingRates].sort() } : {}),
    accounts: lines.length, tied: lines.length - bad.length,
    not_tied: bad,
    ...(bySubsidiary ? { by_subsidiary: bySubsidiary } : {}),
    unknown_balances: { source: S.unknown, target: T.unknown },
    net: { source: sum(S.m, sUnknown), target: sum(T.m, tUnknown), ...(convert ? { currency: base } : {}), note: 'A signed trial balance should net to 0. A non-zero net can also mean the export uses unsigned debit/credit columns.' },
    note: `Balances that are blank or not numbers${convert ? ', or in a currency with no FX rate,' : ''} are reported as unknown, never guessed.`,
  };
}

// ---- Field rules ----------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const short = (v) => { const s = String(v ?? ''); return s.length > 40 ? s.slice(0, 37) + '…' : s; };

/**
 * Check rows against field rules: [{ column, required?, unique?, type?: number|integer|date,
 * enum?: [..], pattern?: regex, min?, max?, max_length?, severity?: blocking|warning }].
 * Row numbers are file line numbers for CSV (header = line 1), so they match a spreadsheet.
 */
export function checkFields(rows, rules) {
  const map = columnMap(rows);
  const violations = []; const perRule = [];
  let count = 0;
  rules.forEach((rule, i) => {
    const id = rule.id || `${rule.column}#${i + 1}`;
    const severity = rule.severity || 'blocking';
    const col = map.get(norm(rule.column));
    let n = 0;
    const flag = (row, value, problem) => { n++; count++; if (violations.length < 500) violations.push({ rule: id, column: rule.column, row, value: short(value), problem, severity }); };
    if (!col) { flag(null, '', `column "${rule.column}" is not in the file`); perRule.push({ rule: id, column: rule.column, severity, violations: n }); return; }
    const seen = new Map();
    const re = rule.pattern ? new RegExp(rule.pattern) : null;
    const read = rule.type === 'number' || rule.type === 'integer' ? numberReader(rows.slice(0, 5000).map((r) => r[col])) : null;
    rows.forEach((r, j) => {
      const row = j + 2;
      const raw = r[col]; const v = String(raw ?? '').trim();
      if (!v) { if (rule.required) flag(row, raw, 'required value is blank'); return; }
      if (rule.unique) { if (seen.has(v)) flag(row, v, `duplicate of row ${seen.get(v)}`); else seen.set(v, row); }
      if (rule.type === 'number' || rule.type === 'integer') {
        const x = read(v);
        if (x === null) flag(row, v, 'not a number');
        else {
          if (rule.type === 'integer' && !Number.isInteger(x)) flag(row, v, 'not a whole number');
          if (rule.min !== undefined && x < rule.min) flag(row, v, `below minimum ${rule.min}`);
          if (rule.max !== undefined && x > rule.max) flag(row, v, `above maximum ${rule.max}`);
        }
      }
      if (rule.type === 'date' && (!DATE_RE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z')))) flag(row, v, 'not a YYYY-MM-DD date');
      if (rule.enum && !rule.enum.map(String).includes(v)) flag(row, v, `not one of ${rule.enum.join(', ')}`);
      if (re && !re.test(v)) flag(row, v, `does not match ${rule.pattern}`);
      if (rule.max_length !== undefined && [...v].length > rule.max_length) flag(row, v, `longer than ${rule.max_length} characters`);
    });
    perRule.push({ rule: id, column: rule.column, severity, violations: n });
  });
  const blocking = violations.some((v) => v.severity === 'blocking') || perRule.some((p) => p.severity === 'blocking' && p.violations);
  return { status: count ? (blocking ? 'blocking' : 'warnings') : 'clean', rows: rows.length, rules: perRule, violation_count: count, violations };
}

// ---- Run-over-run comparison ------------------------------------------------------

const keyedTb = (tb) => new Map(((tb && tb.not_tied) || []).map((l) => [[l.subsidiary, l.account, l.currency].filter(Boolean).join(' · '), l]));

/** Compare two findings.json files (an earlier and a later trial load). */
export function compareRuns(prev, cur) {
  const pc = prev.compare || {}, cc = cur.compare || {};
  const codes = (c) => new Map((c.findings || []).map((f) => [f.code, f]));
  const P = codes(pc), C = codes(cc);
  const resolved = [...P.keys()].filter((k) => !C.has(k)).map((k) => P.get(k));
  const added = [...C.keys()].filter((k) => !P.has(k)).map((k) => C.get(k));
  const persisting = [...C.keys()].filter((k) => P.has(k)).map((k) => C.get(k));
  const setDiff = (a = [], b = []) => { const B = new Set(b); return a.filter((x) => !B.has(x)); };
  const mmKeys = (c) => [...new Set((c.mismatches || []).map((m) => `${m.key} · ${m.column}`))];
  const pTb = keyedTb(prev.trial_balance), cTb = keyedTb(cur.trial_balance);
  const countDelta = {};
  for (const k of new Set([...Object.keys(pc.counts || {}), ...Object.keys(cc.counts || {})])) {
    const a = (pc.counts || {})[k], b = (cc.counts || {})[k];
    countDelta[k] = { previous: a ?? null, current: b ?? null, change: typeof a === 'number' && typeof b === 'number' ? b - a : null };
  }
  const rank = { clean: 0, ties: 0, warnings: 1, blocking: 2 };
  const trend = (a, b) => (a === undefined || b === undefined ? 'unknown' : rank[b] < rank[a] ? 'better' : rank[b] > rank[a] ? 'worse' : 'same');
  return {
    previous: { generatedAt: prev.generatedAt || null, status: pc.status || null, trial_balance: prev.trial_balance ? prev.trial_balance.status : null },
    current: { generatedAt: cur.generatedAt || null, status: cc.status || null, trial_balance: cur.trial_balance ? cur.trial_balance.status : null },
    trend: trend(pc.status, cc.status),
    findings: { resolved, new: added, persisting },
    counts: countDelta,
    missing_in_target: { fixed: setDiff(pc.missing_in_target, cc.missing_in_target), new: setDiff(cc.missing_in_target, pc.missing_in_target), still_missing: (cc.missing_in_target || []).filter((x) => (pc.missing_in_target || []).includes(x)) },
    field_differences: { fixed: setDiff(mmKeys(pc), mmKeys(cc)), new: setDiff(mmKeys(cc), mmKeys(pc)) },
    trial_balance: { fixed: [...pTb.keys()].filter((k) => !cTb.has(k)), new: [...cTb.keys()].filter((k) => !pTb.has(k)), still_not_tied: [...cTb.keys()].filter((k) => pTb.has(k)) },
    go_live: 'not_approved',
  };
}

// ---- Action list and report ----------------------------------------------------

const ACTION = {
  missing_in_target: ['Load the missing records (or document why they are excluded) and rerun.', 1],
  duplicate_keys_target: ['Remove or merge duplicate target records before go-live; duplicates double-count balances.', 1],
  totals_do_not_tie: ['Find the records that make up the total difference (missing records and amount differences first).', 1],
  subsidiary_totals_do_not_tie: ['Tie out the listed subsidiaries one by one; check subsidiary mapping in the import.', 1],
  tb_not_tied: ['Explain or fix every trial-balance account that does not tie; blank balances must be filled from the source, not guessed.', 1],
  field_rules: ['Fix the rows that break your field rules (row numbers are in exceptions.csv).', 2],
  field_mismatch: ['Review field differences; decide per column whether the target or the source is right.', 2],
  duplicate_keys_source: ['Confirm duplicates in the source export are intended (they may hide a bad extract).', 3],
  extra_in_target: ['Confirm extra target records are intended (test data or opening entries) or delete them in the sandbox.', 3],
  blank_keys: ['Give every row a key so it can be matched.', 3],
  unparseable_amounts: ['Fix blank or non-numeric amounts; totals exclude them.', 3],
  missing_fx_rates: ['Add an FX rate for every currency in the trial balance.', 1],
};

/** Prioritised action list: blocking items first, each with the reason and a suggested next step. */
export function actionList({ cmp, tb, fields }) {
  const items = [];
  for (const f of cmp.findings) if (ACTION[f.code]) items.push({ priority: f.severity === 'blocking' ? 1 : ACTION[f.code][1], code: f.code, why: f.message, action: ACTION[f.code][0], params: f.params || {} });
  if (tb && tb.not_tied.length) items.push({ priority: 1, code: 'tb_not_tied', why: `${tb.not_tied.length} trial-balance line(s) do not tie`, action: ACTION.tb_not_tied[0], params: { n: tb.not_tied.length } });
  if (tb && tb.missing_fx_rates && tb.missing_fx_rates.length) items.push({ priority: 1, code: 'missing_fx_rates', why: `No FX rate for ${tb.missing_fx_rates.join(', ')}`, action: ACTION.missing_fx_rates[0], params: { list: tb.missing_fx_rates.join(', ') } });
  if (fields && fields.violation_count) items.push({ priority: fields.status === 'blocking' ? 1 : 2, code: 'field_rules', why: `${fields.violation_count} field-rule violation(s)`, action: ACTION.field_rules[0], params: { n: fields.violation_count } });
  items.sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
  return items.map((x, i) => ({ n: i + 1, ...x }));
}

/** One row per exception, for a spreadsheet owner to work through. */
export function exceptionRows({ cmp, tb, fields }) {
  const rows = [];
  for (const k of cmp.missing_in_target) rows.push({ type: 'missing_in_target', key: k, column: '', source: '', target: '', detail: 'in source, not in target' });
  for (const k of cmp.extra_in_target) rows.push({ type: 'extra_in_target', key: k, column: '', source: '', target: '', detail: 'in target, not in source' });
  for (const m of cmp.mismatches) rows.push({ type: 'field_mismatch', key: m.key, column: m.column, source: m.source, target: m.target, detail: '' });
  for (const s of (cmp.totals.by_subsidiary || []).filter((x) => x.state !== 'ties')) rows.push({ type: 'subsidiary_total', key: s.subsidiary, column: cmp.totals.source.column, source: s.source ?? '', target: s.target ?? '', detail: `difference ${s.difference ?? 'n/a'}` });
  if (tb) for (const l of tb.not_tied) rows.push({ type: 'trial_balance', key: [l.subsidiary, l.account, l.currency].filter(Boolean).join(' · '), column: 'balance', source: l.source ?? 'unknown', target: l.target ?? 'unknown', detail: `${l.state}${l.difference !== null ? `, difference ${l.difference}` : ''}` });
  if (fields) for (const v of fields.violations) rows.push({ type: 'field_rule', key: v.row === null ? '' : `row ${v.row}`, column: v.column, source: '', target: v.value, detail: `${v.rule}: ${v.problem}` });
  return rows.map((r, i) => ({ n: i + 1, owner: '', resolution: '', ...r }));
}

/**
 * Words for one report language. English keeps the exact text of earlier reports
 * (status codes as written); other languages rebuild each finding from its params.
 */
export function reportWords(lang = 'en', memoryText = (f) => JSON.stringify(f.value)) {
  const t = olympusText(lang); const en = !lang || lang === 'en';
  const has = (k) => t(k) !== k;
  const word = (x) => (en ? x : has(`s_${x}`) ? t(`s_${x}`) : x);
  const loud = (x) => (en ? String(x).toUpperCase() : word(x).toLocaleUpperCase(lang));
  const finding = (f) => (en || !f.params || !has(`f_${f.code}`) ? f.message : t(`f_${f.code}`, f.params));
  const why = (a) => (en || !a.params ? a.why : has(`f_${a.code}`) ? t(`f_${a.code}`, a.params) : has(`w_${a.code}`) ? t(`w_${a.code}`, a.params) : a.why);
  const action = (a) => (en || !has(`a_${a.code}`) ? a.action : t(`a_${a.code}`));
  const fact = (f) => memoryText(f, en ? null : t);
  const notUsed = (f) => t('not_used', { why: en || !f.why_code ? f.why : t(`why_${f.why_code}`, f.why_params || {}) });
  return { t, en, word, loud, finding, why, action, fact, notUsed };
}

export function reportMarkdown({ title, cmp, tb, fields, actions, runs, generatedAt, rulesName, memory = null, memoryText, lang = 'en' }) {
  const w = reportWords(lang, memoryText); const { t } = w;
  const cell = (v) => String(v).replace(/\|/g, '/');
  const L = [];
  L.push(`# ${title || t('report_title')}`, '', `${t('generated_md', { at: generatedAt })}${rulesName ? t('rules_used', { name: rulesName }) : ''}`, '');
  L.push(`## ${t('verdict')}`, '', `- ${t('data_status')}: **${w.loud(cmp.status)}**${tb ? ` · ${t('tb_status')}: **${w.loud(tb.status)}**` : ''}${fields ? ` · ${t('fr_status')}: **${w.loud(fields.status)}**` : ''}`, `- ${t('go_live')}: **${t('not_approved')}.** ${t('go_live_note')}`, '');
  if (actions && actions.length) {
    L.push(`## ${t('next_actions')}`, '', `| ${t('col_n')} | ${t('col_priority')} | ${t('col_why')} | ${t('col_action')} |`, '|---:|---:|---|---|');
    for (const a of actions) L.push(`| ${a.n} | P${a.priority} | ${cell(w.why(a))} | ${w.action(a)} |`);
    L.push('');
  }
  if (runs) {
    const codes = (list) => list.map((f) => `\`${f.code}\``).join(', ') || t('none');
    L.push(`## ${t('change_since')}`, '', `- ${t('previous_now', { prev: runs.previous.status ? w.word(runs.previous.status) : t('na'), at: runs.previous.generatedAt || t('unknown_date'), now: w.word(runs.current.status), trend: w.word(runs.trend) })}`);
    L.push(`- ${t('findings_change', { resolved: codes(runs.findings.resolved), new: codes(runs.findings.new) })}`);
    L.push(`- ${t('missing_change', { fixed: runs.missing_in_target.fixed.length, new: runs.missing_in_target.new.length, still: runs.missing_in_target.still_missing.length })}`, '');
  }
  L.push(`## ${t('findings')}`, '');
  if (!cmp.findings.length) L.push(`- ${t('no_findings')}`);
  for (const f of cmp.findings) L.push(`- **${w.word(f.severity)}** \`${f.code}\`: ${w.finding(f)}`);
  L.push('', `## ${t('counts')}`, '', `| ${t('measure')} | ${t('value')} |`, '|---|---:|');
  for (const [k, v] of Object.entries(cmp.counts)) L.push(`| ${w.en ? k.replace(/_/g, ' ') : t(`count_${k}`)} | ${v} |`);
  L.push('', t('key_line', { s: cmp.key.source, t: cmp.key.target, tol: cmp.tolerance }));
  if (cmp.totals.difference !== null) L.push(t('totals_line', { col: cmp.totals.source.column, s: cmp.totals.source.total, t: cmp.totals.target.total, d: cmp.totals.difference }));
  if (cmp.totals.by_subsidiary) {
    L.push('', `| ${t('subsidiary')} | ${t('source')} | ${t('target')} | ${t('difference')} | ${t('state')} |`, '|---|---:|---:|---:|---|');
    for (const x of cmp.totals.by_subsidiary) L.push(`| ${x.subsidiary} | ${x.source ?? t('missing')} | ${x.target ?? t('missing')} | ${x.difference ?? t('na')} | ${w.word(x.state)} |`);
  }
  if (cmp.mismatches.length) {
    L.push('', `## ${t('field_diffs')}`, '', `| ${t('key')} | ${t('column')} | ${t('source')} | ${t('target')} |`, '|---|---|---|---|');
    for (const m of cmp.mismatches) L.push(`| ${m.key} | ${m.column} | ${cell(m.source)} | ${cell(m.target)} |`);
  }
  if (tb) {
    L.push('', `## ${t('tb_heading')}`, '', t('tb_line', { tied: tb.tied, n: tb.accounts, tol: tb.tolerance, cur: tb.base_currency ? t('amounts_in', { cur: tb.base_currency }) : '' }));
    if (tb.by_subsidiary) {
      L.push('', `| ${t('subsidiary')} | ${t('accounts')} | ${t('tied')} | ${t('not_tied')} | ${t('difference')} | ${t('state')} |`, '|---|---:|---:|---:|---:|---|');
      for (const g of tb.by_subsidiary) L.push(`| ${g.subsidiary} | ${g.accounts} | ${g.tied} | ${g.not_tied} | ${g.difference}${g.unknown ? ` (+${g.unknown} ${t('unknown')})` : ''} | ${w.word(g.state)} |`);
    }
    if (tb.not_tied.length) {
      L.push('', `| ${t('account')} | ${t('source')} | ${t('target')} | ${t('difference')} | ${t('state')} |`, '|---|---:|---:|---:|---|');
      for (const l of tb.not_tied) L.push(`| ${[l.subsidiary, l.account, l.currency].filter(Boolean).join(' · ')} | ${l.source ?? t('unknown')} | ${l.target ?? t('unknown')} | ${l.difference ?? t('na')} | ${w.word(l.state)} |`);
    }
  }
  if (fields) {
    L.push('', `## ${t('fr_heading')}`, '', t('fr_line', { n: fields.violation_count, rows: fields.rows }), '', `| ${t('rule')} | ${t('column')} | ${t('severity')} | ${t('violations')} |`, '|---|---|---|---:|');
    for (const r of fields.rules) L.push(`| ${r.rule} | ${r.column} | ${w.word(r.severity)} | ${r.violations} |`);
  }
  if (memory && (memory.used.length || memory.skipped.length)) {
    L.push('', `## ${t('learned_heading')}`, '', t('learned_intro'), '');
    for (const f of memory.used) L.push(`- \`${f.id}\` ${w.fact(f)} (${t('accepted_by', { name: f.accepted_by })})`);
    for (const f of memory.skipped) L.push(`- \`${f.id}\` ${w.fact(f)}: ${w.notUsed(f)}`);
  }
  L.push('', `## ${t('limits')}`, '', `- ${t('limit_1')}`, `- ${t('limit_2')}`, `- ${t('limit_3')}`, '');
  if (!w.en) L.push(`_${t('translation_note')}_`, '');
  return L.join('\n');
}
