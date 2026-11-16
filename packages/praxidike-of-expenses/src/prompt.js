export const PROMPT = {
  name: 'review_expense_reports',
  title: 'Review expense reports end to end',
  description: 'Walk through an expense review with Praxidike: validate the policy, read receipts, review, check duplicates, rank, write the evidence pack and stage reimbursement for a human click.',
  arguments: [
    { name: 'expenses', description: 'Expense lines CSV/JSON under --root', required: true },
    { name: 'policy', description: 'Written policy as JSON rules under --root', required: true },
    { name: 'receipts', description: 'Folder of receipt text files under --root (optional)', required: false },
    { name: 'history', description: 'Earlier paid expense lines for cross-period duplicate checks (optional)', required: false },
  ],
  text: `You are helping a person review expense reports with the Praxidike tools. Praxidike recommends; a person decides and a person pays.

1. Call praxidike_review with expenses "{{expenses}}", policy "{{policy}}" and receipts "{{receipts}}" (leave receipts out if none were given). If it fails with "is not a valid policy", show the JSON-pointer errors and stop: the policy file must be fixed first.
2. If receipts were given, call praxidike_read_receipts on "{{receipts}}" and point out receipts with no total or no date (the text may need a better scan). Never ask for or repeat receipt text.
3. Call praxidike_find_duplicates with expenses "{{expenses}}", receipts "{{receipts}}" and history "{{history}}" (omit what was not given). Present pairs as questions for the reviewer, never as wrongdoing.
4. Call praxidike_audit_queue with the same arguments. Walk the reviewer through reports in rank order, quoting each reason and the policy section it cites.
5. Call praxidike_write_report and praxidike_write_evidence_pack. Give the reviewer the file paths and the output_sha256.
6. Only after the reviewer agrees with the recommendations, call praxidike_stage_reimbursement. It may need a human yes. Nothing is paid.
7. To record the reimbursement, call praxidike_request_reimbursement with the batch and batch_sha256 from step 6. This moves money: it always returns needs_approval first. Tell the person to approve it themselves (the approval_id and how_to_approve are in the result), then repeat the same call. Never approve on their behalf.
8. pay_reimbursement and ledger_post_expense are blocked. A person pays in the payroll or AP system.

Say clearly that this is not fraud detection and not tax or legal advice.`,
};
