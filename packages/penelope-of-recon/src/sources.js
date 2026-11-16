// Exports Penelope reads directly. A file already in Penelope's own columns is read as it is.
// OFX/QFX, CAMT.053 and BAI2 statements are parsed separately (bankformats.js).
import { exportProfile } from 'mythos-agent-core';

const BANK_FIELDS = {
  date: { type: 'date', aliases: ['Posting Date', 'Post Date', 'Posted Date', 'Transaction Date', 'Value Date', 'Booking Date', 'Date Posted', 'Trans Date'], required: true },
  description: { aliases: ['Details', 'Narrative', 'Payee', 'Transaction Description', 'Particulars', 'Transaction Details', 'Bank Description'] },
  reference: { aliases: ['Ref', 'Check Number', 'Cheque Number', 'Check or Slip #', 'Check #', 'Reference Number', 'Serial Number', 'Bank Reference'] },
  amount: { type: 'money', aliases: ['Transaction Amount', 'Amt', 'Net Amount'] },
  debit: { type: 'money', aliases: ['Withdrawal', 'Withdrawals', 'Debit Amount', 'Money Out', 'Paid Out', 'Debits'] },
  credit: { type: 'money', aliases: ['Deposit', 'Deposits', 'Credit Amount', 'Money In', 'Paid In', 'Credits'] },
};
const GL_FIELDS = {
  date: { type: 'date', aliases: ['Posting Date', 'Transaction Date', 'Tran Date', 'Trans Date', 'Journal Date', 'GL Date'], required: true },
  memo: { aliases: ['Description', 'Memo/Description', 'Line Description', 'Narration', 'Details'] },
  reference: { aliases: ['Ref', 'Document Number', 'Doc Number', 'Num', 'Check Number', 'Journal Number', 'Tran ID', 'Reference Number'] },
  amount: { type: 'money', aliases: ['Amt', 'Net Amount', 'Net'] },
  // Ledger debit/credit (Soll/Haben, 借方/貸方), not the bank's money out/in.
  debit: { type: 'money', translate: 'ledger_debit', aliases: ['Dr', 'Debit Amount', 'Amount (Debit)'] },
  credit: { type: 'money', translate: 'ledger_credit', aliases: ['Cr', 'Credit Amount', 'Amount (Credit)'] },
};

const blank = (v) => String(v ?? '').trim() === '';
const dated = (v) => /^\d/.test(String(v ?? '').trim());
const US = { dateOrder: 'mdy' };

const BANK_PROFILES = [
  exportProfile('chase_checking', { date: 'Posting Date', description: 'Description', amount: 'Amount', reference: 'Check or Slip #' }, US),
  exportProfile('chase_card', { date: 'Post Date', description: 'Description', amount: 'Amount' },
    { ...US, note: 'A card account: purchases are negative and payments positive, as Chase writes them. The GL side must use the same signs.' }),
  exportProfile('bofa_checking', { date: 'Date', description: 'Description', amount: 'Amount' },
    { ...US, skipRow: (_r, get) => blank(get('Amount')) || /^beginning balance/i.test(String(get('Description') ?? '')), note: 'The summary block above the transactions and the "Beginning balance" line are skipped. Pass bank_balance to tie the balances; the summary block is not read.' }),
  exportProfile('wells_fargo_csv', { date: 'Date', description: 'Description', amount: 'Amount', reference: 'Check Number' },
    { ...US, note: 'This download has no header row; the five columns are read as date, amount, a "*" flag, check number and description.' }),
  exportProfile('capital_one_360', {
    date: 'Transaction Date', description: 'Transaction Description',
    amount: { from: ['Transaction Amount', 'Transaction Type'], compute: (_r, get, h) => { const a = h.amount(get('Transaction Amount')); if (a === '') return ''; const n = Math.abs(Number(a)); return /debit/i.test(String(get('Transaction Type') ?? '')) ? String(-n) : String(n); } },
  }, { ...US, note: 'Amounts in this export are unsigned; the sign comes from the Transaction Type column (Debit is money out).' }),
  exportProfile('mercury', { date: 'Date (UTC)', description: 'Description', amount: 'Amount', reference: 'Reference' },
    { ...US, skipRow: (_r, get) => /^(failed|cancell?ed)$/i.test(String(get('Status') ?? '').trim()), note: 'Dates are in UTC, so a late-evening transaction can fall on the next day. Rows with status failed or cancelled are skipped.' }),
  exportProfile('xero_statement_csv', { date: 'Date', description: { from: ['Payee', 'Description'], compute: (_r, get) => [get('Payee'), get('Description')].map((x) => String(x ?? '').trim()).filter(Boolean).join(' - ') }, amount: 'Amount', reference: { from: ['Reference', 'Cheque Number'], compute: (_r, get) => String(get('Cheque Number') ?? '').trim() || String(get('Reference') ?? '').trim() } }),
];

const GL_PROFILES = [
  exportProfile('netsuite_transactions', {
    date: 'Date',
    memo: { from: ['Memo', 'Name'], compute: (_r, get) => [get('Name'), get('Memo')].map((x) => String(x ?? '').trim()).filter(Boolean).join(' - ') },
    reference: 'Document Number',
    amount: 'Amount', debit: 'Amount (Debit)', credit: 'Amount (Credit)',
  }, { ...US, dropTotals: true, skipRow: (_r, get) => !dated(get('Date')), note: 'Filter the saved search to the cash account. If the search has "Amount (Debit)" and "Amount (Credit)" columns they are used; otherwise check that money out of the account is negative in "Amount".' }),
  exportProfile('qbo_transaction_detail', {
    date: 'Date',
    memo: { from: ['Memo/Description', 'Name'], compute: (_r, get) => [get('Name'), get('Memo/Description')].map((x) => String(x ?? '').trim()).filter(Boolean).join(' - ') },
    reference: 'Num', amount: 'Amount',
  }, { dropTotals: true, skipRow: (_r, get) => !dated(get('Date')), note: 'Run the report for the cash account only. Account heading rows, "Beginning Balance" and "Total for" rows are skipped.' }),
  exportProfile('xero_account_transactions', { date: 'Date', memo: 'Description', reference: 'Reference', debit: 'Debit', credit: 'Credit' },
    { dropTotals: true, skipRow: (_r, get) => !dated(get('Date')), note: 'Run the report for the bank account only. Account heading, opening balance, closing balance and total rows are skipped.' }),
];

export const SOURCES = {
  bank: { label: 'Bank statement (table files)', args: ['bank'], fields: BANK_FIELDS, profiles: BANK_PROFILES },
  gl: { label: 'GL cash-account detail', args: ['gl'], fields: GL_FIELDS, profiles: GL_PROFILES },
};
