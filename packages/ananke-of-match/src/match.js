import { toCsv, toNumber, round2 } from 'mythos-agent-core';

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
  invoice_before_receipt: ['Invoice dated before receipt', 'The invoice date is earlier than the first receipt on this line.', 'Usually fine for advance billing; confirm receipt before payment.'],
  partial_receipt: ['Partial receipt', 'Only part of the PO line has been received so far.', 'Pay only what was received, or wait for the rest.'],
  missing_data: ['Missing data', 'Quantity or unit price is missing on the invoice.', 'Ask AP to complete the invoice entry.'],
};

/** Three-way match. Tolerances: price_pct (default 2), price_abs, qty (default 0). $ impact is an estimate of the amount at issue. */
export function match(pos, receipts, invoices, tol = {}) {
  const pricePct = Number(tol.price_pct ?? 2), priceAbs = Number(tol.price_abs ?? 0), qtyTol = Number(tol.qty ?? 0);
  const poMap = new Map(pos.map((p) => [`${p.po}|${p.line}`, p])); const poIds = new Set(pos.map((p) => p.po));
  const rec = new Map(); for (const r of receipts) { const k = `${r.po}|${r.line}`; const e = rec.get(k) || { qty: 0, first: null }; e.qty += r.qty || 0; if (r.date && (!e.first || r.date < e.first)) e.first = r.date; rec.set(k, e); }
  const seen = new Map(); const billed = new Map(); const items = [];
  for (const inv of invoices) {
    const ex = []; let impact = 0; const k = `${inv.po}|${inv.line}`; const p = poMap.get(k); const r = rec.get(k);
    const dkey = `${inv.vendor.toLowerCase()}|${inv.invoice}|${inv.line}`;
    const amount = inv.qty !== null && inv.unit_price !== null ? round2(inv.qty * inv.unit_price) : null;
    if (seen.has(dkey)) { ex.push({ code: 'duplicate_invoice', detail: `same as row ${seen.get(dkey)}` }); impact = Math.max(impact, amount ?? 0); }
    else seen.set(dkey, inv.row);
    if (inv.qty === null || inv.unit_price === null) ex.push({ code: 'missing_data', detail: 'qty or unit_price blank' });
    if (!poIds.has(inv.po)) { ex.push({ code: 'no_po', detail: inv.po || '(blank)' }); impact = Math.max(impact, amount ?? 0); }
    else if (!p) ex.push({ code: 'po_line_missing', detail: `${inv.po} line ${inv.line}` });
    if (p && !ex.some((e) => e.code === 'duplicate_invoice')) {
      if (p.vendor && inv.vendor && p.vendor.toLowerCase() !== inv.vendor.toLowerCase()) ex.push({ code: 'vendor_mismatch', detail: `PO ${p.vendor} vs invoice ${inv.vendor}` });
      const prior = billed.get(k) || 0; const total = prior + (inv.qty || 0); billed.set(k, total);
      const got = r ? r.qty : 0;
      if (!r || got === 0) { ex.push({ code: 'not_received', detail: 'no receipt' }); impact = Math.max(impact, amount ?? 0); }
      else {
        if (total > got + qtyTol) { const over = total - got; ex.push({ code: 'qty_over_received', detail: `billed ${total} (incl. earlier ${prior}) vs received ${got}` }); impact = Math.max(impact, round2(Math.min(over, inv.qty || 0) * (inv.unit_price || 0))); }
        if (p.qty !== null && got < p.qty) ex.push({ code: 'partial_receipt', detail: `received ${got} of ${p.qty}` });
        if (r.first && inv.date && inv.date < r.first) ex.push({ code: 'invoice_before_receipt', detail: `${inv.date} < ${r.first}` });
      }
      if (p.qty !== null && total > p.qty + qtyTol) ex.push({ code: 'qty_over_ordered', detail: `billed ${total} vs ordered ${p.qty}` });
      if (p.unit_price !== null && inv.unit_price !== null) {
        const diff = inv.unit_price - p.unit_price; const pct = p.unit_price ? Math.abs(diff) / p.unit_price * 100 : 100;
        if (Math.abs(diff) > priceAbs && pct > pricePct) { ex.push({ code: 'price_variance', detail: `${inv.unit_price} vs PO ${p.unit_price} (${round2(pct)}%)` }); impact = Math.max(impact, round2(Math.abs(diff) * (inv.qty || 0))); }
      }
    }
    const hard = ex.filter((e) => !['partial_receipt', 'invoice_before_receipt'].includes(e.code));
    items.push({ ...inv, amount, status: hard.length ? 'exception' : ex.length ? 'matched_with_notes' : 'matched', exceptions: ex, est_impact: round2(impact) });
  }
  const counts = {}; for (const i of items) for (const e of i.exceptions) counts[e.code] = (counts[e.code] || 0) + 1;
  const exc = items.filter((i) => i.status === 'exception');
  return { invoices: items.length, matched: items.filter((i) => i.status === 'matched').length, matched_with_notes: items.filter((i) => i.status === 'matched_with_notes').length, exceptions: exc.length,
    est_impact_total: round2(exc.reduce((t, i) => t + i.est_impact, 0)), by_code: counts, tolerances: { price_pct: pricePct, price_abs: priceAbs, qty: qtyTol }, items,
    note: 'Finds and explains exceptions. Ananke never approves, posts or pays an invoice; $ impact is an estimate of the amount at issue.' };
}

export function explain(item) {
  return item.exceptions.map((e) => { const [title, why, next] = EXPLAIN[e.code]; return { code: e.code, title, detail: e.detail, why, suggested_next_step: next }; });
}
export const CODES = Object.keys(EXPLAIN);
export const WORKLIST_COLUMNS = ['invoice', 'vendor', 'po', 'line', 'qty', 'unit_price', 'amount', 'status', 'exception_codes', 'details', 'est_impact', 'suggested_next_step', 'owner', 'resolution', 'resolved_date'];
export function worklistCsv(r) {
  return toCsv(r.items.filter((i) => i.status !== 'matched').sort((a, b) => b.est_impact - a.est_impact).map((i) => ({ ...i, exception_codes: i.exceptions.map((e) => e.code).join('; '), details: i.exceptions.map((e) => e.detail).join('; '), suggested_next_step: explain(i).map((e) => e.suggested_next_step).join(' '), owner: '', resolution: '', resolved_date: '' })), WORKLIST_COLUMNS);
}
