// Exports Praxidike reads directly. A file already in Praxidike's own columns is read as it is.
import { exportProfile } from 'mythos-agent-core';

const FIELDS = {
  report_id: { aliases: ['Report ID', 'Report', 'Report Number', 'Report Name', 'Expense Report'] },
  line_id: { aliases: ['Line ID', 'Line', 'Expense ID', 'Transaction ID'] },
  employee: { aliases: ['Employee', 'Employee Name', 'Submitter', 'Submitted By', 'Cardholder', 'Spender'] },
  date: { type: 'date', aliases: ['Expense Date', 'Transaction Date', 'Spent On', 'Date of Expense', 'Purchase Date'], required: true },
  submitted_on: { type: 'date', aliases: ['Submitted On', 'Submitted', 'Submitted Date', 'Report Date', 'Date Submitted'] },
  category: { aliases: ['Expense Category', 'Expense Type', 'Type'] },
  merchant: { aliases: ['Merchant Name', 'Vendor', 'Payee', 'Supplier'] },
  amount: { type: 'money', aliases: ['Total', 'Expense Amount', 'Claimed Amount', 'Amount Claimed'], required: true },
  currency: { aliases: ['Currency Code', 'Curr'] },
  receipt: { aliases: ['Receipt File', 'Receipt Name', 'Attachment'] },
  purpose: { aliases: ['Business Purpose', 'Description', 'Memo', 'Comment', 'Notes', 'Reason'] },
  attendees: { aliases: ['Attendee Count', 'Number of Attendees', 'Guests'] },
  nights: { type: 'number', aliases: ['Nights', 'Number of Nights'] },
  miles: { type: 'number', aliases: ['Miles', 'Distance', 'Mileage'] },
  days: { type: 'number', aliases: ['Days', 'Number of Days'] },
  location: { aliases: ['City', 'Destination', 'Travel Location'] },
  preapproved_by: { aliases: ['Preapproved By', 'Pre-approved By', 'Pre Approval', 'Approved By'] },
};

// "Ana Ortiz, Ben Cho" is two attendees; a plain number is kept.
const headcount = (v) => { const s = String(v ?? '').trim(); if (!s) return ''; if (/^\d+$/.test(s)) return s; return String(s.split(/[,;|\n]+/).map((x) => x.trim()).filter(Boolean).length); };
const yes = (v) => /^(true|yes|y|1)$/i.test(String(v ?? '').trim());

export const SOURCES = {
  expenses: {
    label: 'Expense lines', args: ['expenses', 'history'], fields: FIELDS,
    profiles: [
      exportProfile('ramp_transactions', {
        report_id: { from: 'User', consume: false, compute: (_r, get) => (get('User') ? `Card: ${get('User')}` : 'Card transactions') },
        employee: 'User',
        date: 'Transaction Date',
        category: 'Ramp Category',
        merchant: 'Merchant Name',
        amount: 'Amount',
        purpose: 'Memo',
        receipt: { from: ['Receipts Link', 'Has Receipt'], compute: (_r, get) => String(get('Receipts Link') ?? '').trim() || (yes(get('Has Receipt')) ? 'on file in Ramp' : '') },
        attendees: { from: 'Attendees', transform: (v) => headcount(v) },
      }, { dateOrder: 'mdy', note: 'Ramp lists company card transactions: lines are grouped per cardholder, there is no submission date, and staging a reimbursement from this file is refused because the company already paid. Ramp category names are looked up in the policy\'s category_aliases. The receipt column says whether Ramp holds a receipt; the receipt files themselves are not read.' }),
      exportProfile('expensify_default_csv', {
        report_id: { value: 'Expensify export' },
        date: 'Timestamp',
        category: 'Category',
        merchant: 'Merchant',
        amount: 'Amount',
        purpose: 'Comment',
        receipt: 'Receipt',
      }, { skipRow: (_r, get) => /^(no|false|n|0)$/i.test(String(get('Reimbursable') ?? '').trim()), note: 'The Expensify default CSV has no employee and no report column: export one report at a time, or set employee and report_id for the file in mythos-sources.json. Lines marked not reimbursable are skipped. Expensify category names are looked up in the policy\'s category_aliases.' }),
    ],
  },
};
