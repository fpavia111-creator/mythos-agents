import { toNumber, round2 } from 'mythos-agent-core';

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const KEY_CANDIDATES = ['externalid', 'id', 'internalid', 'tranid', 'documentnumber', 'entityid', 'itemid', 'number'];
const AMOUNT_CANDIDATES = ['amount', 'total', 'amountremaining', 'balance', 'openbalance', 'grossamount'];

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

function sameValue(a, b) {
  const na = toNumber(a), nb = toNumber(b);
  if (na !== null && nb !== null) return Math.abs(na - nb) < 0.005;
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

function total(rows, col) {
  if (!col) return { column: null, total: null, unparseable: 0 };
  let t = 0, bad = 0;
  for (const r of rows) { const n = toNumber(r[col]); if (n === null) bad++; else t += n; }
  return { column: col, total: round2(t), unparseable: bad };
}

/** Compare a source-system export with the target (e.g. NetSuite sandbox) export. */
export function compareExports(source, target, opts = {}) {
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
  for (const [k, sr] of s.byKey) {
    const tr = t.byKey.get(k); if (!tr) continue;
    for (const c of cols) {
      const sv = sr[sMap.get(c)], tv = tr[tMap.get(c)];
      if (!sameValue(sv, tv)) { mismatchCount++; if (mismatches.length < 100) mismatches.push({ key: k, column: sMap.get(c), source: sv ?? '', target: tv ?? '' }); }
    }
  }
  const sAmt = total(source, pick(sMap, opts.amount_column, AMOUNT_CANDIDATES));
  const tAmt = total(target, pick(tMap, opts.amount_column, AMOUNT_CANDIDATES));
  const findings = [];
  const add = (severity, code, message) => findings.push({ severity, code, message });
  if (missing.length) add('blocking', 'missing_in_target', `${missing.length} source record(s) are not in the target: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`);
  if (t.dups.length) add('blocking', 'duplicate_keys_target', `${t.dups.length} duplicate key(s) in the target: ${t.dups.slice(0, 10).join(', ')}`);
  if (s.dups.length) add('warning', 'duplicate_keys_source', `${s.dups.length} duplicate key(s) in the source: ${s.dups.slice(0, 10).join(', ')}`);
  if (s.blank || t.blank) add('warning', 'blank_keys', `${s.blank} source and ${t.blank} target row(s) have a blank key`);
  if (extra.length) add('warning', 'extra_in_target', `${extra.length} target record(s) are not in the source: ${extra.slice(0, 10).join(', ')}`);
  if (mismatchCount) add('warning', 'field_mismatch', `${mismatchCount} field value(s) differ between source and target`);
  let amountDifference = null;
  if (sAmt.column && tAmt.column) {
    amountDifference = round2(sAmt.total - tAmt.total);
    if (Math.abs(amountDifference) >= 0.005) add('blocking', 'totals_do_not_tie', `${sAmt.column} totals differ by ${amountDifference} (source ${sAmt.total}, target ${tAmt.total})`);
    if (sAmt.unparseable || tAmt.unparseable) add('warning', 'unparseable_amounts', `${sAmt.unparseable} source and ${tAmt.unparseable} target amount(s) are blank or not numbers; totals exclude them`);
  } else {
    add('info', 'no_amount_column', 'No amount column found, so totals were not compared. Pass "amount_column" to compare them.');
  }
  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  return {
    status: blocking ? 'blocking' : findings.some((f) => f.severity === 'warning') ? 'warnings' : 'clean',
    go_live: 'not_approved',
    go_live_note: 'Go-live is a human decision. Olympus reports; it never approves go-live.',
    key: { source: sKey, target: tKey },
    counts: { source: source.length, target: target.length, matched: s.byKey.size - missing.length, missing_in_target: missing.length, extra_in_target: extra.length, field_mismatches: mismatchCount },
    totals: { source: sAmt, target: tAmt, difference: amountDifference },
    missing_in_target: missing.slice(0, 200), extra_in_target: extra.slice(0, 200),
    mismatches, findings,
  };
}

/** Trial balance tie-out by account. Never fills in a missing balance. */
export function tieOutBalances(source, target, opts = {}) {
  const sMap = columnMap(source), tMap = columnMap(target);
  const acctC = ['account', 'accountnumber', 'acctnumber', 'accountname', 'number'];
  const balC = ['balance', 'amount', 'endingbalance', 'net'];
  const sA = pick(sMap, opts.account_column, acctC), tA = pick(tMap, opts.account_column, acctC);
  const sB = pick(sMap, opts.balance_column, balC), tB = pick(tMap, opts.balance_column, balC);
  if (!sA || !tA || !sB || !tB) throw new Error('could not find account and balance columns; pass "account_column" and "balance_column"');
  const tol = Number(opts.tolerance ?? 0.005);
  const agg = (rows, a, b) => {
    const m = new Map(); const unknown = [];
    for (const r of rows) {
      const k = String(r[a] ?? '').trim(); const n = toNumber(r[b]);
      if (n === null) { unknown.push(k || '(blank account)'); continue; }
      m.set(k, round2((m.get(k) || 0) + n));
    }
    return { m, unknown };
  };
  const S = agg(source, sA, sB), T = agg(target, tA, tB);
  const accounts = [...new Set([...S.m.keys(), ...T.m.keys(), ...S.unknown, ...T.unknown])].sort();
  const lines = accounts.map((a) => {
    const sv = S.m.has(a) ? S.m.get(a) : null, tv = T.m.has(a) ? T.m.get(a) : null;
    const diff = sv !== null && tv !== null ? round2(sv - tv) : null;
    const state = sv === null || tv === null ? 'missing_or_unknown' : Math.abs(diff) > tol ? 'differs' : 'ties';
    return { account: a, source: sv, target: tv, difference: diff, state };
  });
  const sum = (m) => round2([...m.values()].reduce((x, y) => x + y, 0));
  const bad = lines.filter((l) => l.state !== 'ties');
  return {
    status: bad.length ? 'blocking' : 'ties',
    go_live: 'not_approved',
    accounts: lines.length, tied: lines.length - bad.length,
    not_tied: bad,
    unknown_balances: { source: S.unknown, target: T.unknown },
    net: { source: sum(S.m), target: sum(T.m), note: 'A signed trial balance should net to 0. A non-zero net can also mean the export uses unsigned debit/credit columns.' },
    note: 'Balances that are blank or not numbers are reported as unknown, never guessed.',
  };
}

export function reportMarkdown({ title, cmp, tb, generatedAt }) {
  const L = [];
  L.push(`# ${title || 'Migration readiness report'}`, '', `Generated ${generatedAt} by olympus-of-migration. Fictional or customer-provided export files only; no live system was queried.`, '');
  L.push('## Verdict', '', `- Data status: **${cmp.status.toUpperCase()}**${tb ? ` · Trial balance: **${tb.status.toUpperCase()}**` : ''}`, '- Go-live: **not approved.** Go-live is a decision for a named human after reviewing this report. Olympus never approves it.', '');
  L.push('## Findings', '');
  if (!cmp.findings.length) L.push('- No findings.');
  for (const f of cmp.findings) L.push(`- **${f.severity}** \`${f.code}\`: ${f.message}`);
  L.push('', '## Counts', '', '| Measure | Value |', '|---|---:|');
  for (const [k, v] of Object.entries(cmp.counts)) L.push(`| ${k.replace(/_/g, ' ')} | ${v} |`);
  L.push('', `Key column: \`${cmp.key.source}\` (source) / \`${cmp.key.target}\` (target).`);
  if (cmp.totals.difference !== null) L.push(`Totals on \`${cmp.totals.source.column}\`: source ${cmp.totals.source.total}, target ${cmp.totals.target.total}, difference ${cmp.totals.difference}.`);
  if (cmp.mismatches.length) {
    L.push('', '## Field differences (first 100)', '', '| Key | Column | Source | Target |', '|---|---|---|---|');
    for (const m of cmp.mismatches) L.push(`| ${m.key} | ${m.column} | ${String(m.source).replace(/\|/g, '/')} | ${String(m.target).replace(/\|/g, '/')} |`);
  }
  if (tb) {
    L.push('', '## Trial balance tie-out', '', `${tb.tied} of ${tb.accounts} account(s) tie.`);
    if (tb.not_tied.length) {
      L.push('', '| Account | Source | Target | Difference | State |', '|---|---:|---:|---:|---|');
      for (const l of tb.not_tied) L.push(`| ${l.account} | ${l.source ?? 'unknown'} | ${l.target ?? 'unknown'} | ${l.difference ?? 'n/a'} | ${l.state} |`);
    }
  }
  L.push('', '## Limits', '', '- This checks the export files you supplied. It does not prove the books are correct, and it is not accounting, tax or audit advice.', '- Rerun after every trial load. Keep this report with the go-live sign-off.', '');
  return L.join('\n');
}
