import { toCsv, toNumber, round2, normalizeName, levenshtein, escapeHtml, htmlPage } from 'mythos-agent-core';

const s = (v) => String(v ?? '').trim();
const up = (v) => s(v).toUpperCase();
function col(row, names) {
  const keys = Object.keys(row);
  for (const want of names) { const k = keys.find((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '') === want); if (k !== undefined) return row[k]; }
  return '';
}
const line = (r) => s(col(r, ['line', 'poline', 'lineno', 'linenumber'])) || '1';
const item = (r) => up(col(r, ['item', 'sku', 'itemcode', 'partnumber']));

export const normPOs = (rows) => rows.map((r) => ({ po: up(col(r, ['po', 'ponumber', 'purchaseorder'])), line: line(r), item: item(r), vendor: s(col(r, ['vendor', 'supplier', 'vendorname'])), qty: toNumber(col(r, ['qty', 'quantity', 'orderedqty'])), unit_price: toNumber(col(r, ['unitprice', 'price', 'rate'])) }));
export const normReceipts = (rows) => rows.map((r) => ({ receipt: s(col(r, ['receipt', 'receiptid', 'grn', 'receiptnumber'])), po: up(col(r, ['po', 'ponumber', 'purchaseorder'])), line: line(r), qty: toNumber(col(r, ['qty', 'quantity', 'receivedqty', 'qtyreceived'])), date: s(col(r, ['date', 'receiptdate', 'receivedon', 'receiveddate'])) }));
export const normInvoices = (rows) => rows.map((r, i) => ({ row: i + 2, invoice: up(col(r, ['invoice', 'invoicenumber', 'invoiceno', 'invoiceid'])), vendor: s(col(r, ['vendor', 'supplier', 'vendorname'])), po: up(col(r, ['po', 'ponumber', 'purchaseorder'])), line: line(r), qty: toNumber(col(r, ['qty', 'quantity', 'billedqty'])), unit_price: toNumber(col(r, ['unitprice', 'price', 'rate'])), date: s(col(r, ['date', 'invoicedate'])) }));

const EXPLAIN = {
  no_po: ['No matching PO', 'The invoice cites a PO that is not in the PO file.', 'Ask the requester for the PO, or route for non-PO approval under your policy.'],
  po_line_missing: ['PO line not found', 'The PO exists but this line number is not on it.', 'Check the line number with the vendor; the invoice may need correcting.'],
  vendor_mismatch: ['Vendor differs from PO', 'The invoice vendor name does not match the PO vendor.', 'Confirm the legal entity and remit-to before anything is paid. Never change bank details from an email.'],
  not_received: ['Nothing received yet', 'No receipt is recorded for this PO line.', 'Confirm with the receiver; hold until goods or services are received.'],
  qty_over_received: ['Billed more than received', 'Invoice quantity (plus earlier invoices) exceeds the quantity received.', 'Hold the difference; ask the vendor for a credit or wait for the rest to be received.'],
  qty_over_ordered: ['Billed more than ordered', 'Invoice quantity exceeds the PO quantity.', 'Ask the buyer to amend the PO or the vendor to correct the invoice.'],
  price_variance: ['Price variance', 'Invoice unit price differs from the PO beyond tolerance.', 'Ask the buyer to confirm the agreed price; request a corrected invoice or a PO change.'],
  duplicate_invoice: ['Possible duplicate invoice', 'The same vendor, invoice number and line appear more than once.', 'Hold the duplicate. Check whether the first one was already paid.'],
  near_duplicate_invoice: ['Possible duplicate (near-identical number)', 'Same vendor, PO line and amount as an earlier line, with an invoice number that differs only in punctuation, leading zeros or one character.', 'Hold it and compare both invoice images with the vendor before anything is paid.'],
  invoice_before_receipt: ['Invoice dated before receipt', 'The invoice date is earlier than the first receipt on this line.', 'Usually fine for advance billing; confirm receipt before payment.'],
  partial_receipt: ['Partial receipt', 'Only part of the PO line has been received so far.', 'Pay only what was received, or wait for the rest.'],
  missing_data: ['Missing data', 'Quantity or unit price is missing on the invoice.', 'Ask AP to complete the invoice entry.'],
};

const BUILTIN = { price_pct: 2, price_abs: 0, qty: 0 };
const FIELDS = ['price_pct', 'price_abs', 'qty'];
/** Normalised invoice number for near-duplicate checks: upper case, letters and digits only, no leading zeros in digit runs. */
export const normInvoiceNo = (v) => up(v).replace(/[^A-Z0-9]/g, '').replace(/\d+/g, (d) => String(Number(d)));

/**
 * Tolerance for one vendor. Order: vendor entry in the profile, then the run's arguments,
 * then the profile's "default", then the built-in defaults (price 2%, abs 0, qty 0).
 */
export function toleranceFor(vendor, args = {}, profile = null) {
  const vmap = new Map(Object.entries((profile && profile.vendors) || {}).map(([k, v]) => [normalizeName(k), v]));
  const v = vmap.get(normalizeName(vendor)) || null; const d = (profile && profile.default) || {};
  const out = {}; let source = 'built-in';
  for (const f of FIELDS) {
    if (v && v[f] !== undefined) { out[f] = Number(v[f]); source = 'vendor profile'; }
    else if (args[f] !== undefined && args[f] !== null) { out[f] = Number(args[f]); if (source === 'built-in') source = 'arguments'; }
    else if (d[f] !== undefined) { out[f] = Number(d[f]); if (source === 'built-in') source = 'profile default'; }
    else out[f] = BUILTIN[f];
  }
  return { ...out, source };
}

/**
 * Three-way match. Tolerances: price_pct (default 2), price_abs, qty (default 0), optionally per vendor
 * from a tolerance profile. Several receipts and several invoices per PO line are allowed: billing is
 * cumulative and each invoice is allocated to receipts first-in, first-out. $ impact is an estimate.
 */
export function match(pos, receipts, invoices, tol = {}, profile = null) {
  const global = toleranceFor('', tol, profile);
  const poMap = new Map(pos.map((p) => [`${p.po}|${p.line}`, p])); const poIds = new Set(pos.map((p) => p.po));
  const rec = new Map();
  for (const r of [...receipts].sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.receipt.localeCompare(b.receipt))) {
    const k = `${r.po}|${r.line}`; const e = rec.get(k) || { qty: 0, first: null, list: [], used: 0 };
    e.qty += r.qty || 0; if (r.date && (!e.first || r.date < e.first)) e.first = r.date; e.list.push({ id: r.receipt, qty: r.qty || 0, date: r.date }); rec.set(k, e);
  }
  const seen = new Map(); const near = new Map(); const billed = new Map(); const items = [];
  for (const inv of invoices) {
    const ex = []; let impact = 0; const k = `${inv.po}|${inv.line}`; const p = poMap.get(k); const r = rec.get(k);
    const t = toleranceFor(p && p.vendor ? p.vendor : inv.vendor, tol, profile);
    const dkey = `${inv.vendor.toLowerCase()}|${inv.invoice}|${inv.line}`;
    const amount = inv.qty !== null && inv.unit_price !== null ? round2(inv.qty * inv.unit_price) : null;
    if (seen.has(dkey)) { ex.push({ code: 'duplicate_invoice', detail: `same as row ${seen.get(dkey)}` }); impact = Math.max(impact, amount ?? 0); }
    else {
      seen.set(dkey, inv.row);
      const nkey = `${normalizeName(inv.vendor)}|${inv.po}|${inv.line}`; const prior = near.get(nkey) || []; const n = normInvoiceNo(inv.invoice);
      const hit = prior.find((x) => x.invoice !== inv.invoice && x.amount === amount && amount !== null && (x.norm === n || (n.length >= 4 && x.norm.length >= 4 && inv.date && x.date === inv.date && levenshtein(x.norm, n) === 1)));
      if (hit) { ex.push({ code: 'near_duplicate_invoice', detail: `${inv.invoice} looks like ${hit.invoice} (row ${hit.row})` }); impact = Math.max(impact, amount ?? 0); }
      prior.push({ invoice: inv.invoice, norm: n, amount, date: inv.date, row: inv.row }); near.set(nkey, prior);
    }
    if (inv.qty === null || inv.unit_price === null) ex.push({ code: 'missing_data', detail: 'qty or unit_price blank' });
    if (!poIds.has(inv.po)) { ex.push({ code: 'no_po', detail: inv.po || '(blank)' }); impact = Math.max(impact, amount ?? 0); }
    else if (!p) ex.push({ code: 'po_line_missing', detail: `${inv.po} line ${inv.line}` });
    const matchedReceipts = [];
    if (p && !ex.some((e) => e.code === 'duplicate_invoice' || e.code === 'near_duplicate_invoice')) {
      if (p.vendor && inv.vendor && p.vendor.toLowerCase() !== inv.vendor.toLowerCase() && (normalizeName(p.vendor) || p.vendor.toLowerCase()) !== (normalizeName(inv.vendor) || inv.vendor.toLowerCase())) ex.push({ code: 'vendor_mismatch', detail: `PO ${p.vendor} vs invoice ${inv.vendor}` });
      const prior = billed.get(k) || 0; const total = prior + (inv.qty || 0); billed.set(k, total);
      const got = r ? r.qty : 0;
      if (r) { // FIFO allocation of this invoice's quantity to receipts
        let need = inv.qty || 0; let off = r.used;
        for (const g of r.list) { if (need <= 0) break; if (off >= g.qty) { off -= g.qty; continue; } const take = Math.min(g.qty - off, need); matchedReceipts.push(g.id); need -= take; off = 0; r.used += take; }
      }
      if (!r || got === 0) { ex.push({ code: 'not_received', detail: 'no receipt' }); impact = Math.max(impact, amount ?? 0); }
      else {
        if (total > got + t.qty) { const over = total - got; ex.push({ code: 'qty_over_received', detail: `billed ${total} (incl. earlier ${prior}) vs received ${got}` }); impact = Math.max(impact, round2(Math.min(over, inv.qty || 0) * (inv.unit_price || 0))); }
        if (p.qty !== null && got < p.qty) ex.push({ code: 'partial_receipt', detail: `received ${got} of ${p.qty}` });
        if (r.first && inv.date && inv.date < r.first) ex.push({ code: 'invoice_before_receipt', detail: `${inv.date} < ${r.first}` });
      }
      if (p.qty !== null && total > p.qty + t.qty) ex.push({ code: 'qty_over_ordered', detail: `billed ${total} vs ordered ${p.qty}` });
      if (p.unit_price !== null && inv.unit_price !== null) {
        const diff = inv.unit_price - p.unit_price; const pct = p.unit_price ? Math.abs(diff) / p.unit_price * 100 : 100;
        if (Math.abs(diff) > t.price_abs && pct > t.price_pct) { ex.push({ code: 'price_variance', detail: `${inv.unit_price} vs PO ${p.unit_price} (${round2(pct)}%, tolerance ${t.price_pct}% from ${t.source})` }); impact = Math.max(impact, round2(Math.abs(diff) * (inv.qty || 0))); }
      }
    }
    const hard = ex.filter((e) => !['partial_receipt', 'invoice_before_receipt'].includes(e.code));
    items.push({ ...inv, amount, status: hard.length ? 'exception' : ex.length ? 'matched_with_notes' : 'matched', exceptions: ex, est_impact: round2(impact), receipts: matchedReceipts, tolerance: t });
  }
  const counts = {}; for (const i of items) for (const e of i.exceptions) counts[e.code] = (counts[e.code] || 0) + 1;
  const exc = items.filter((i) => i.status === 'exception');
  return { invoices: items.length, matched: items.filter((i) => i.status === 'matched').length, matched_with_notes: items.filter((i) => i.status === 'matched_with_notes').length, exceptions: exc.length,
    est_impact_total: round2(exc.reduce((t, i) => t + i.est_impact, 0)), by_code: counts, tolerances: { price_pct: global.price_pct, price_abs: global.price_abs, qty: global.qty }, vendor_profiles: profile ? Object.keys(profile.vendors || {}).length : 0, items,
    by_vendor: vendorScorecard(items),
    note: 'Finds and explains exceptions. Ananke never approves, posts or pays an invoice; $ impact is an estimate of the amount at issue.' };
}

/** Per-vendor scorecard: lines, exception rate, $ at issue and the most common codes. */
export function vendorScorecard(items) {
  const m = new Map();
  for (const i of items) {
    const k = i.vendor || '(blank)'; const v = m.get(k) || { vendor: k, invoice_lines: 0, exceptions: 0, est_impact: 0, codes: {} };
    v.invoice_lines++; if (i.status === 'exception') { v.exceptions++; v.est_impact = round2(v.est_impact + i.est_impact); }
    for (const e of i.exceptions) v.codes[e.code] = (v.codes[e.code] || 0) + 1; m.set(k, v);
  }
  return [...m.values()].map((v) => ({ vendor: v.vendor, invoice_lines: v.invoice_lines, exceptions: v.exceptions, exception_rate_pct: round2(v.exceptions / v.invoice_lines * 100), est_impact: v.est_impact, top_codes: Object.entries(v.codes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([c]) => c) }))
    .sort((a, b) => b.est_impact - a.est_impact || b.exception_rate_pct - a.exception_rate_pct || a.vendor.localeCompare(b.vendor));
}

const NOT_BILLABLE = new Set(['duplicate_invoice', 'near_duplicate_invoice', 'no_po', 'po_line_missing']);
/**
 * PO line status after matching: ordered, received, billed (duplicates excluded), left to receive,
 * received-not-billed quantity and its value at PO price (a GRNI accrual estimate), billed-not-received.
 */
export function poStatus(pos, receipts, r, { po = null } = {}) {
  const rec = new Map(); for (const x of receipts) { const k = `${x.po}|${x.line}`; const e = rec.get(k) || { qty: 0, ids: [] }; e.qty += x.qty || 0; e.ids.push(x.receipt); rec.set(k, e); }
  const bill = new Map(); for (const i of r.items) { if (i.exceptions.some((e) => NOT_BILLABLE.has(e.code))) continue; const k = `${i.po}|${i.line}`; const e = bill.get(k) || { qty: 0, inv: [] }; e.qty += i.qty || 0; e.inv.push(i.invoice); bill.set(k, e); }
  const want = po ? String(po).trim().toUpperCase() : null;
  const lines = pos.filter((p) => !want || p.po === want).map((p) => {
    const k = `${p.po}|${p.line}`; const g = rec.get(k) || { qty: 0, ids: [] }; const b = bill.get(k) || { qty: 0, inv: [] };
    const ordered = p.qty ?? 0; const price = p.unit_price ?? 0;
    const rnb = Math.max(0, g.qty - b.qty), bnr = Math.max(0, b.qty - g.qty), toRecv = Math.max(0, ordered - g.qty);
    const status = bnr > 0 ? 'billed_more_than_received' : g.qty === 0 && b.qty === 0 ? 'open_nothing_received' : g.qty >= ordered && b.qty >= ordered ? 'closed' : rnb > 0 ? 'received_not_billed' : 'partially_received';
    return { po: p.po, line: p.line, item: p.item, vendor: p.vendor, ordered, received: g.qty, billed: b.qty, unit_price: p.unit_price, receipts: g.ids, invoices: b.inv,
      left_to_receive: toRecv, received_not_billed_qty: rnb, grni_value: round2(rnb * price), billed_not_received_qty: bnr, billed_not_received_value: round2(bnr * price), open_po_value: round2(toRecv * price), status };
  });
  const sum = (f) => round2(lines.reduce((t, l) => t + l[f], 0));
  return { po_lines: lines.length, grni_value_total: sum('grni_value'), billed_not_received_total: sum('billed_not_received_value'), open_po_value_total: sum('open_po_value'),
    by_status: lines.reduce((o, l) => ({ ...o, [l.status]: (o[l.status] || 0) + 1 }), {}), lines,
    note: 'GRNI (received, not yet invoiced) is valued at PO price as an accrual estimate for your review. Ananke posts nothing.' };
}
export const PO_STATUS_COLUMNS = ['po', 'line', 'item', 'vendor', 'ordered', 'received', 'billed', 'unit_price', 'left_to_receive', 'received_not_billed_qty', 'grni_value', 'billed_not_received_qty', 'billed_not_received_value', 'open_po_value', 'status'];
export const poStatusCsv = (s) => toCsv(s.lines, PO_STATUS_COLUMNS);

/** Self-contained HTML exception report (no scripts, no network). */
export function reportHtml(r, s, { title = 'AP three-way match report', at = '' } = {}) {
  const e = escapeHtml; const money = (n) => (n === null || n === undefined ? '' : Number(n).toFixed(2));
  const tile = (label, v, cls = '') => `<div class="tile"><span class="mut">${e(label)}</span><b class="${cls}">${e(v)}</b></div>`;
  const exc = r.items.filter((i) => i.status !== 'matched').sort((a, b) => b.est_impact - a.est_impact || a.row - b.row);
  const body = [`<h1>${e(title)}</h1><p class="mut">Generated ${e(at)} by ananke-of-match. Findings for a person to review; nothing was approved, posted or paid.</p>`,
    `<div class="tiles">${tile('Invoice lines', r.invoices)}${tile('Matched', r.matched, 'ok')}${tile('With notes', r.matched_with_notes, 'warn')}${tile('Exceptions', r.exceptions, r.exceptions ? 'bad' : 'ok')}${tile('Est. $ at issue', money(r.est_impact_total))}${tile('GRNI estimate', money(s.grni_value_total))}</div>`,
    '<h2>Exceptions and notes, largest $ first</h2><div class="wrap"><table><tr><th>Invoice</th><th>Line</th><th>Vendor</th><th>PO</th><th>Status</th><th>Codes</th><th class="num">Est. $</th><th>Next step</th></tr>',
    ...exc.map((i) => `<tr><td>${e(i.invoice)}</td><td>${e(i.line)}</td><td>${e(i.vendor)}</td><td>${e(i.po)}</td><td class="${i.status === 'exception' ? 'bad' : 'warn'}">${e(i.status)}</td><td>${e(i.exceptions.map((x) => x.code).join(', '))}</td><td class="num">${money(i.est_impact)}</td><td>${e(explain(i).map((x) => x.suggested_next_step).join(' '))}</td></tr>`),
    '</table></div><h2>Vendor scorecard</h2><div class="wrap"><table><tr><th>Vendor</th><th class="num">Lines</th><th class="num">Exceptions</th><th class="num">Rate %</th><th class="num">Est. $</th><th>Top codes</th></tr>',
    ...r.by_vendor.map((v) => `<tr><td>${e(v.vendor)}</td><td class="num">${v.invoice_lines}</td><td class="num">${v.exceptions}</td><td class="num">${v.exception_rate_pct}</td><td class="num">${money(v.est_impact)}</td><td>${e(v.top_codes.join(', '))}</td></tr>`),
    '</table></div><h2>PO line status</h2><div class="wrap"><table><tr><th>PO</th><th>Line</th><th>Vendor</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Billed</th><th class="num">GRNI $</th><th>Status</th></tr>',
    ...s.lines.map((l) => `<tr><td>${e(l.po)}</td><td>${e(l.line)}</td><td>${e(l.vendor)}</td><td class="num">${l.ordered}</td><td class="num">${l.received}</td><td class="num">${l.billed}</td><td class="num">${money(l.grni_value)}</td><td>${e(l.status)}</td></tr>`),
    `</table></div><p class="mut">Tolerances: price ${e(r.tolerances.price_pct)}%, abs ${e(r.tolerances.price_abs)}, qty ${e(r.tolerances.qty)}${r.vendor_profiles ? `; ${r.vendor_profiles} vendor profile(s) applied where they match` : ''}. $ impact and GRNI are estimates.</p>`];
  return htmlPage({ title, bodyHtml: body.join('\n'), footer: 'ananke-of-match: finds and explains exceptions. Not accounting advice. It does not approve, post or pay invoices.' });
}

export function explain(item) {
  return item.exceptions.map((e) => { const [title, why, next] = EXPLAIN[e.code]; return { code: e.code, title, detail: e.detail, why, suggested_next_step: next }; });
}
export const CODES = Object.keys(EXPLAIN);
export const WORKLIST_COLUMNS = ['invoice', 'vendor', 'po', 'line', 'qty', 'unit_price', 'amount', 'status', 'exception_codes', 'details', 'est_impact', 'suggested_next_step', 'owner', 'resolution', 'resolved_date'];
export function worklistCsv(r) {
  return toCsv(r.items.filter((i) => i.status !== 'matched').sort((a, b) => b.est_impact - a.est_impact).map((i) => ({ ...i, exception_codes: i.exceptions.map((e) => e.code).join('; '), details: i.exceptions.map((e) => e.detail).join('; '), suggested_next_step: explain(i).map((e) => e.suggested_next_step).join(' '), owner: '', resolution: '', resolved_date: '' })), WORKLIST_COLUMNS);
}
