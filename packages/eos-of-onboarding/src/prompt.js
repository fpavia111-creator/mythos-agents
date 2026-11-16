export const PROMPT = {
  name: 'run_onboarding',
  title: 'Run onboarding and offboarding end to end',
  description: 'Walk through onboarding and offboarding with Eos: status, day-one readiness, owner actions, access request drafts, offboarding removals, and the human clicks for granting and removing access.',
  arguments: [
    { name: 'people', description: 'People CSV/JSON under --root', required: true },
    { name: 'template', description: 'Checklist template JSON under --root', required: true },
    { name: 'status', description: 'Task status CSV/JSON (optional)', required: false },
    { name: 'as_of', description: 'Date to check as of, YYYY-MM-DD (optional, default today)', required: false },
  ],
  text: `You are helping an operations or IT person run onboarding and offboarding with the Eos tools. Eos never grants or removes access and never sends email; people do.

1. Call eos_status with people "{{people}}", template "{{template}}", status "{{status}}" and as_of "{{as_of}}" (leave out any not given). If the template fails validation, show the JSON-pointer errors and stop. Report flags first: access_after_end, access_before_prereqs, contractor_no_end_date, not_ready_for_start, unknown_role, unknown_type.
2. Call eos_readiness_report for people starting in the next week. Read out who is not ready and exactly what blocks them. Give the output_sha256 if the person wants a record.
3. Call eos_owner_actions and give each owner (IT, Ops, Finance, Manager…) their list in priority order with the reasons. Overdue access removals come first.
4. Call eos_offboarding for people whose end date is near or past. Access removals and equipment returns mirror what was granted.
5. Call eos_draft_access_requests and eos_draft_offboarding to write drafts. They may need a human yes. Nothing is submitted.
6. To record a grant, call eos_request_access_grant with person_id and the access task_id; to record a removal, call eos_request_access_removal with person_id, the original access task_id (for "remove-email" use "email") and a reason. Both always return needs_approval first, even in Auto. Tell the person to approve with the approval_id themselves, then repeat the same call. Never approve on their behalf. A grant is refused if a prerequisite is not done.
7. Call eos_write_tracker for the tracker, owner action list and calendar file.
8. idp_grant_access, idp_remove_access and send_email are blocked.

Say that this is a checklist tracker, not HR, employment or legal advice.`,
};
