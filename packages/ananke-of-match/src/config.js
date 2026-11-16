// Config schemas and MCP prompts for Ananke of Match.

const tol = {
  price_pct: { type: 'number', minimum: 0, description: 'Price tolerance in percent' },
  price_abs: { type: 'number', minimum: 0, description: 'Price tolerance per unit, absolute' },
  qty: { type: 'number', minimum: 0, description: 'Quantity tolerance in units' },
  note: { type: 'string', description: 'Why this tolerance exists (for reviewers)' },
};

/** Tolerance profile: optional defaults plus per-vendor overrides (vendor names matched loosely). */
export const TOLERANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['vendors'],
  properties: {
    note: { type: 'string' },
    default: { type: 'object', additionalProperties: false, properties: tol },
    vendors: { type: 'object', additionalProperties: { type: 'object', additionalProperties: false, properties: tol } },
  },
};

export const PROMPTS = [
  {
    name: 'ap_exception_review',
    title: 'AP three-way match review, end to end',
    description: 'Walks a host model through matching, explaining, PO status, worklist and report. Posting stays a human click.',
    arguments: [
      { name: 'pos', description: 'PO lines file under --root', required: true },
      { name: 'receipts', description: 'Receipts file under --root', required: true },
      { name: 'invoices', description: 'Invoice lines file under --root', required: true },
      { name: 'tolerance_profile', description: 'Optional per-vendor tolerance JSON (leave blank for defaults)', required: false },
    ],
    text: `You are helping an accounts-payable clerk review three-way-match exceptions with the ananke-of-match tools. Files: POs {{pos}}, receipts {{receipts}}, invoices {{invoices}}. Tolerance profile: {{tolerance_profile}} (ignore it if blank or shown in brackets).

1. Call ananke_match with pos, receipts, invoices (and tolerance_profile if given). If the call fails on the profile, show the JSON-pointer errors and stop; do not guess fixes.
2. Report the counts, est_impact_total and by_code. Name the top three exceptions by est_impact and the vendors at the top of by_vendor.
3. For each exception worth more than a trivial amount, call ananke_explain_exception and give the suggested next step in plain words. Treat duplicate_invoice and near_duplicate_invoice as holds until a person compares the invoices. Never suggest changing vendor bank details from an email.
4. Call ananke_po_status. Point out lines with status billed_more_than_received and the GRNI estimate (received, not yet invoiced) for month-end accrual review.
5. Call ananke_write_worklist and ananke_write_report so the clerk has ap-exceptions.csv, ap-report.html and ap-po-status.csv. Quote the output_sha256 values.
6. Only for invoices that are status "matched" and that the clerk names, you may call ananke_request_posting. It returns needs_approval: tell the clerk a named person must approve it (mythos-approve <id> --as "Name" or the approvals page), then repeat the same call. Never call erp_post_invoice; it is blocked. Ananke never posts or pays.

Say clearly that $ impact and GRNI are estimates, and that this is not accounting advice.`,
  },
];
