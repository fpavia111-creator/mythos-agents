export const PROMPTS = [
  {
    name: 'list_hygiene_workflow',
    title: 'Clean a contact list end to end',
    description: 'Walks the host model through a contact-list cleanup with Nausicaa: audit and health score, consent provenance, merge plan, comparison with last export, optional MX check, review files, and bulk-delete requests that wait for a named person.',
    arguments: [
      { name: 'contacts', description: 'Contact export under --root (CSV/JSON)', required: true },
      { name: 'suppression', description: 'Suppression list under --root (optional)', required: false },
      { name: 'previous', description: 'Last period\'s export, for the comparison (optional)', required: false },
      { name: 'rules', description: 'Hygiene rules JSON (optional)', required: false },
    ],
    text: `You are helping a marketing-ops or CRM admin clean a contact list with the nausicaa-of-hygiene tools. Contacts: {{contacts}}. Suppression list: {{suppression}}. Previous export: {{previous}}. Rules file: {{rules}}.

Rules for you: Nausicaa never deletes or edits the CRM; crm_delete_contacts is blocked, do not call it. Consent checks read the exported columns; they are not legal advice on what consent is needed. Do not run the MX check unless the person asks for it.

1. If a rules file was given, a schema error names the bad key with a JSON pointer; ask the person to fix it rather than guessing.
2. Call nausicaa_audit (contacts, suppression, rules). Report the health score and each deduction's explanation, then the counts per suggested action.
3. Call nausicaa_consent_provenance (contacts, rules). List opted-in contacts with no consent source or date; they need re-permission or a record from the source system.
4. Call nausicaa_merge_plan. For each duplicate group, give the survivor, the rule that chose it, and any field where the winner is not the survivor. Point out that opt-outs and hard bounces carry over.
5. If a previous export was given, call nausicaa_compare (previous, contacts) and say what got worse since then (new bounces, unsubscribes, duplicates) and the health change.
6. Only if the person asks: nausicaa_check_mx. Prefer a saved records file; a live check needs allow_network:true and sends domain names only to the chosen public resolver. It needs a human yes and is blocked in review mode.
7. Call nausicaa_write_cleanup for the review sheet and suppression additions. nausicaa_write_clean_copy writes a copy with do_not_email marked (needs a yes unless opted in to Auto); rows are never removed.
8. For contacts the person decides to delete, call nausicaa_request_bulk_delete (ids, reason). It returns needs_approval: show the approval_id and how_to_approve and wait. Deleting personal data stays one click for a named person, even in Auto, and only records a request for the CRM admin.`,
  },
];
