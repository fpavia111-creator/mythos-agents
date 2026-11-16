export const PROMPTS = [
  {
    name: 'erasure_request_workflow',
    title: 'Handle one erasure request end to end',
    description: 'Walks the host model through one data-subject erasure request with Macaria: map, find, retention, log, checklist, deletion requests (human click), deadlines and the evidence pack.',
    arguments: [
      { name: 'dir', description: 'Folder of exports under --root', required: true },
      { name: 'identifiers', description: 'The identifiers you hold for the requester, as JSON, e.g. {"email":"...","phone":"...","ids":["C-1"]}', required: true },
      { name: 'received', description: 'Date the request was received (YYYY-MM-DD)', required: true },
      { name: 'regime', description: 'gdpr, uk_gdpr, ccpa, cpra or other', required: false },
      { name: 'rules', description: 'Path to your retention rules JSON (optional)', required: false },
    ],
    text: `You are helping a privacy lead handle one erasure (deletion) request with the macaria-of-erasure tools. Exports folder: {{dir}}. Identifiers: {{identifiers}}. Received: {{received}}. Regime: {{regime}}. Retention rules file: {{rules}}.

Rules for you: never repeat raw identifiers back in your replies; use the masked forms the tools return. Macaria never deletes anything, and you must not claim the person's data has been erased. This is not legal advice; say so if asked which law or exemption applies.

1. Ask the person to confirm the requester's identity has been verified by their documented method. Do not continue to step 5 until they confirm.
2. Call macaria_map_data with dir. Point out files that hold personal data and files flagged for a retention check.
3. Call macaria_find_subject with dir and the identifiers. Report rows found per file and how they matched (exact or hashed). If nothing matched, say which identifiers you used and stop for the person to decide.
4. If a rules file was given, call macaria_retention_check (dir, identifiers, rules). List rows on hold or retained, citing each rule or hold id. Rows with no_rule or date_missing need a person's judgement.
5. Call macaria_log_request (identifiers, received, regime, rules). It may need a human yes; if it returns needs_approval, show the approval_id and how_to_approve, and wait.
6. Call macaria_build_checklist (dir, identifiers, received, regime, rules). Share the file paths.
7. For each file whose rows may be deleted (not on hold, not retained), prepare a macaria_request_deletion call with system, rows, reason and the same identifiers. Each one returns needs_approval: a named person must approve it (one click, even in Auto). Never try macaria_delete_records; it is blocked.
8. Call macaria_deadlines (with ics:true if the person wants calendar reminders) and flag any overdue or due-soon request.
9. When the system owners report back, call macaria_evidence_pack (dir, identifiers, rules) and share the HTML path, the output_sha256 and the open items. Explain that the pack covers only the exports searched.`,
  },
];
