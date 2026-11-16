// Exports Ananke reads directly. A file already in Ananke's own columns is read as it is.
import { exportProfile } from 'mythos-agent-core';

const BY_ITEM = 'Lines are matched by PO number and item code, because line ids in this export differ between a PO, its receipt and its bill. A PO that lists the same item twice needs a line column.';
const poRef = (v) => String(v).replace(/^\s*purchase order\s*#?\s*/i, '').trim();
const absQty = (v, _r, _get, h) => { const a = h.amount(v); return a === '' ? v : a.replace(/^-/, ''); };

const PO_FIELDS = {
  po: { aliases: ['PO Number', 'PO No', 'PO #', 'Purchase Order', 'Purchase Order Number', 'Order Number'], required: true },
  line: { aliases: ['Line', 'PO Line', 'Line No', 'Line Number', 'Line #'] },
  item: { aliases: ['Item Code', 'SKU', 'Part Number', 'Product/Service', 'Product', 'Item Number'] },
  vendor: { aliases: ['Supplier', 'Vendor Name', 'Supplier Name'] },
  qty: { type: 'number', aliases: ['Quantity', 'Ordered Qty', 'Qty Ordered', 'Order Qty'], required: true },
  unit_price: { type: 'money', aliases: ['Unit Price', 'Price', 'Rate', 'Unit Cost', 'Item Rate'], required: true },
};
const RECEIPT_FIELDS = {
  receipt: { aliases: ['Receipt Number', 'Receipt No', 'Receipt ID', 'GRN', 'Goods Receipt', 'Item Receipt'] },
  po: { aliases: ['PO Number', 'PO No', 'PO #', 'Purchase Order', 'Purchase Order Number'], required: true },
  line: { aliases: ['Line', 'PO Line', 'Line No', 'Line Number', 'Line #'] },
  qty: { type: 'number', aliases: ['Quantity', 'Received Qty', 'Qty Received', 'Quantity Received'], required: true },
  date: { type: 'date', aliases: ['Receipt Date', 'Received On', 'Received Date', 'Date Received'] },
};
const INVOICE_FIELDS = {
  invoice: { aliases: ['Invoice Number', 'Invoice No', 'Invoice #', 'Invoice ID', 'Bill Number', 'Bill No', 'Reference No'], required: true },
  vendor: { aliases: ['Supplier', 'Vendor Name', 'Supplier Name'] },
  po: { aliases: ['PO Number', 'PO No', 'PO #', 'Purchase Order', 'Purchase Order Number'], required: true },
  line: { aliases: ['Line', 'PO Line', 'Line No', 'Line Number', 'Line #'] },
  qty: { type: 'number', aliases: ['Quantity', 'Billed Qty', 'Qty Billed', 'Invoiced Qty'], required: true },
  unit_price: { type: 'money', aliases: ['Unit Price', 'Price', 'Rate', 'Unit Cost', 'Item Rate'], required: true },
  date: { type: 'date', aliases: ['Invoice Date', 'Bill Date'] },
};

const nsLine = { from: ['Item'], consume: false, compute: (_r, get) => String(get('Item') ?? '').trim().toUpperCase() };
const noItem = (_r, get) => !String(get('Item') ?? '').trim();

export const SOURCES = {
  pos: {
    label: 'Purchase order lines', fields: PO_FIELDS,
    profiles: [exportProfile('netsuite_transactions', { po: 'Document Number', line: nsLine, item: 'Item', vendor: 'Name', qty: { from: 'Quantity', transform: absQty }, unit_price: ['Item Rate', 'Rate'] }, { skipRow: noItem, note: BY_ITEM })],
  },
  receipts: {
    label: 'Goods receipt lines', fields: RECEIPT_FIELDS,
    profiles: [exportProfile('netsuite_transactions', { receipt: 'Document Number', po: { from: 'Created From', transform: poRef }, line: nsLine, qty: { from: 'Quantity', transform: absQty }, date: 'Date' }, { skipRow: noItem, note: BY_ITEM })],
  },
  invoices: {
    label: 'Vendor invoice (bill) lines', fields: INVOICE_FIELDS,
    profiles: [
      exportProfile('netsuite_transactions', { invoice: 'Document Number', vendor: 'Name', po: { from: 'Created From', transform: poRef }, line: nsLine, qty: { from: 'Quantity', transform: absQty }, unit_price: ['Item Rate', 'Rate'], date: 'Date' }, { skipRow: noItem, note: BY_ITEM }),
      exportProfile('xero_bills', { invoice: 'InvoiceNumber', vendor: 'ContactName', po: 'Reference', line: { from: ['InventoryItemCode'], consume: false, compute: (_r, get) => String(get('InventoryItemCode') ?? '').trim().toUpperCase() }, qty: 'Quantity', unit_price: 'UnitAmount', date: 'InvoiceDate' }, { note: `The PO number is read from the Xero "Reference" column. ${BY_ITEM}` }),
    ],
  },
};
