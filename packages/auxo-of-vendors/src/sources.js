// Exports Auxo reads directly. A file already in Auxo's own columns is read as it is.
import { exportProfile, carryGroup } from 'mythos-agent-core';

const NO_W9 = 'This export has no W-9 or W-8 tracking columns (w9_received, w9_signed, w8_received). Until you add them, every vendor shows as form missing; the TIN and payment-total checks still apply.';
const abs = (v, _r, _get, h) => { const a = h.amount(v); return a === '' ? v : a.replace(/^-/, ''); };
const METHOD = { 'Bill Payment (Check)': 'check', 'Bill Payment (Credit Card)': 'credit_card', 'Bill Payment': 'ach', Check: 'check', Expense: 'ach', 'Credit Card Expense': 'credit_card', 'Credit Card Credit': 'credit_card', 'Cash Expense': 'cash' };

const VENDOR_FIELDS = {
  vendor_id: { aliases: ['Vendor ID', 'Vendor Number', 'Vendor No', 'Supplier ID', 'Supplier Number', 'Vendor Code'], required: true },
  name: { aliases: ['Vendor', 'Vendor Name', 'Supplier', 'Supplier Name', 'Company Name', 'Display Name'] },
  legal_name: { aliases: ['Legal Name', 'Legal Business Name', 'Name on W-9', 'Name on Check'] },
  entity_type: { aliases: ['Entity Type', 'Tax Classification', 'Business Type', 'Federal Tax Classification'] },
  country: { aliases: ['Country', 'Billing Country', 'Country/Region'] },
  tin: { aliases: ['Tax ID', 'Tax ID Number', 'Tax Number', 'TIN', 'EIN', 'Taxpayer ID', 'Business ID No. / Social Security No.'] },
  w9_received: { type: 'date', aliases: ['W-9 Received', 'W9 Received', 'W-9 Date', 'W9 Date', 'W-9 On File Date'] },
  w9_signed: { type: 'bool', aliases: ['W-9 Signed', 'W9 Signed'] },
  address: { aliases: ['Billing Address', 'Mailing Address', 'Street Address', 'Address 1'] },
  email: { type: 'email', aliases: ['Email Address', 'E-mail', 'AP Email', 'Contact Email', 'Main Email'] },
  requested_date: { type: 'date', aliases: ['Requested Date', 'W-9 Requested', 'Last Requested'] },
  w8_received: { type: 'date', aliases: ['W-8 Received', 'W8 Received', 'W-8 Date'] },
  w8_type: { aliases: ['W-8 Type', 'W8 Type', 'W-8 Form'] },
  w8_signed: { type: 'bool', aliases: ['W-8 Signed', 'W8 Signed'] },
};

const VENDOR_PROFILES = [
  exportProfile('netsuite_vendors', {
    vendor_id: ['Name', 'ID'],
    name: ['Company Name', 'Name'],
    legal_name: 'Legal Name',
    entity_type: { from: 'Is Individual', values: { Yes: 'individual', T: 'individual', true: 'individual', No: '', F: '', false: '' } },
    country: ['Country', 'Billing Country'],
    tin: ['Tax ID', 'Tax Number'],
    address: ['Billing Address', 'Address'],
    email: 'Email',
  }, { note: `Vendors are keyed by the NetSuite "Name" column so that payments from a transaction search (which carry the name, not the internal id) line up. ${NO_W9}`, skipRow: (_r, get) => /^(yes|t|true)$/i.test(String(get('Inactive') || '')) }),
  exportProfile('qbo_vendor_contact_list', {
    vendor_id: 'Vendor',
    name: 'Vendor',
    legal_name: ['Company name', 'Full Name'],
    tin: ['Tax ID', 'Business ID No. / Social Security No.'],
    address: 'Billing Address',
    email: 'Email',
  }, { dropTotals: true, note: `Vendors are keyed by the QuickBooks vendor name, as in the Transaction List by Vendor report. ${NO_W9}` }),
  exportProfile('xero_contacts', {
    vendor_id: 'ContactName',
    name: 'ContactName',
    legal_name: ['LegalName', 'CompanyName'],
    tin: 'TaxNumber',
    country: 'POCountry',
    address: { from: ['POAddressLine1', 'POCity', 'PORegion', 'POPostalCode'], compute: (_r, get) => ['POAddressLine1', 'POAddressLine2', 'POCity', 'PORegion', 'POPostalCode'].map((k) => String(get(k) ?? '').trim()).filter(Boolean).join(', ') },
    email: 'EmailAddress',
  }, { note: `Vendors are keyed by the Xero contact name. ${NO_W9}` }),
];

const PAYMENT_FIELDS = {
  vendor_id: { aliases: ['Vendor ID', 'Vendor', 'Vendor Name', 'Supplier', 'Payee', 'Name'], required: true },
  date: { type: 'date', aliases: ['Payment Date', 'Paid On', 'Paid Date', 'Transaction Date', 'Process Date'], required: true },
  amount: { type: 'money', aliases: ['Paid', 'Paid Amount', 'Payment Amount', 'Total', 'Amount Paid'], required: true },
  method: { aliases: ['Payment Method', 'Method', 'Payment Type', 'Type'] },
};
const PAYMENT_PROFILES = [
  exportProfile('netsuite_transactions', {
    vendor_id: 'Name',
    date: 'Date',
    amount: { from: 'Amount', transform: abs },
    method: { from: ['Payment Method', 'Type'], compute: (_r, get) => String(get('Payment Method') || '').trim() || (/card/i.test(String(get('Type') || '')) ? 'credit_card' : 'ach') },
  }, { skipRow: (_r, get) => !/payment|check|credit card|expense/i.test(String(get('Type') || 'payment')), note: 'Only payment, check, card and expense rows are counted; bills and purchase orders in the same search are skipped. A row with no payment method is counted as a reportable (non-card) payment.' }),
  exportProfile('qbo_transaction_list_by_vendor', {
    date: 'Date',
    amount: { from: 'Amount', transform: abs },
    method: { from: 'Transaction Type', values: METHOD },
  }, {
    provides: ['vendor_id'],
    rows: (rows) => carryGroup('vendor_id')(rows).filter((r) => /check|card|cash|ach|payment|expense/i.test(String(r.method || ''))),
    note: 'Only payment, check, card and expense rows are counted; bills and vendor credits in the report are skipped. Plain bill payments and expenses are counted as reportable (non-card) payments.',
  }),
];

export const SOURCES = {
  vendors: { label: 'Vendor master', args: ['vendors'], fields: VENDOR_FIELDS, profiles: VENDOR_PROFILES },
  payments: { label: 'Payments to vendors', args: ['payments'], fields: PAYMENT_FIELDS, profiles: PAYMENT_PROFILES },
};
