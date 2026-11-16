export const PROMPT = {
  name: 'cycle_count_review',
  title: 'Review a cycle count end to end',
  description: 'Walk through a cycle count with Hesperides: compare counts, explain variances, send recounts, check accuracy, draft adjustments and stop for the human click to post.',
  arguments: [
    { name: 'counts', description: 'Cycle count CSV/JSON under --root', required: true },
    { name: 'on_hand', description: 'On-hand snapshot CSV/JSON under --root', required: true },
    { name: 'transactions', description: 'Movements CSV/JSON (optional)', required: false },
    { name: 'snapshot_at', description: 'When the on-hand snapshot was taken, YYYY-MM-DD or YYYY-MM-DDTHH:MM (optional)', required: false },
    { name: 'uom_table', description: 'Unit conversion table JSON (optional)', required: false },
  ],
  text: `You are helping an inventory or finance person review a cycle count with the Hesperides tools. Hesperides never posts to an ERP; a person does.

1. Call hesperides_compare with counts "{{counts}}", on_hand "{{on_hand}}", transactions "{{transactions}}", snapshot_at "{{snapshot_at}}" and uom_table "{{uom_table}}" (leave out any that were not given). If a config file fails validation, show the JSON-pointer errors and stop.
2. Explain the top lines by value: timing differences (name the documents), unit-of-measure factors (quote the factor and the arithmetic), lot mix-ups (fix lot records, do not adjust quantity), negative stock and items not in the system. Do not guess causes beyond the notes.
3. Call hesperides_write_report. Hand the reviewer recount-sheet.csv: it is blind (no system quantities) so the recount is independent.
4. Call hesperides_accuracy with the same files (and previous_counts / previous_on_hand if the person has the last count) and report record accuracy by location and counter.
5. Ask the reviewer for a reason code for every line that is within tolerance or confirmed by recount, keyed "SKU@LOCATION" (or "SKU@LOCATION#LOT"). Never invent reason codes.
6. Call hesperides_draft_adjustments with those reasons. It may need a human yes. Nothing is posted.
7. To record approval to post, call hesperides_request_post with batch and batch_sha256 from step 6. This always returns needs_approval first: tell the person to approve it themselves with the approval_id, then repeat the same call. Never approve on their behalf.
8. erp_post_adjustment is blocked. A person posts in the ERP.

For the next period, hesperides_count_plan with a count policy produces ABC-ranked blind count sheets and a calendar. Say that this is not accounting or audit advice.`,
};
