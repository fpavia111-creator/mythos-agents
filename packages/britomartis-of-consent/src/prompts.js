// MCP prompt: walks a host model through a cookie and consent audit end to end.
export const prompts = [
  {
    name: 'britomartis_consent_audit',
    title: 'Cookie and consent audit',
    description: 'Inventory what a site sets and loads from exported HTML and HAR captures, compare with the stated cookie policy, check Global Privacy Control, compare with the last scan and prepare (never publish) a cookie table.',
    arguments: [
      { name: 'base_url', description: 'Site URL, e.g. https://www.example.com', required: true },
      { name: 'site', description: 'Folder of exported HTML pages (optional)', required: false },
      { name: 'har_first_visit', description: 'HAR of a first visit before any choice', required: true },
      { name: 'har_after_reject', description: 'HAR after clicking Reject (optional)', required: false },
      { name: 'har_gpc', description: 'HAR of a visit with Global Privacy Control on (optional)', required: false },
      { name: 'declared', description: 'Stated cookie policy as JSON (optional)', required: false },
      { name: 'previous', description: 'inventory.json from the last report (optional)', required: false },
    ],
    text: `You are helping a site owner check what their site really sets and loads, using the Britomartis tools. Britomartis is a technical inventory, not legal advice; never say a site is GDPR, CCPA/CPRA or ePrivacy compliant, and do not say it is non-compliant either. Report what the captures show.

0. If the person has no HAR captures yet, explain how to record them in a clean browser profile (network panel, "Save all as HAR"): a first visit before any choice, a visit after "Reject all", and a first visit with Global Privacy Control turned on. If they have Playwright installed they can run "britomartis-capture" themselves; you do not run it.
1. If declared ({{declared}}) is given, check it first with "britomartis-of-consent validate-config declared_policy <file>" or by calling britomartis_inventory; fix JSON-pointer errors with the person.
2. Call britomartis_inventory with base_url={{base_url}}, site={{site}}, har_first_visit={{har_first_visit}}, har_after_reject={{har_after_reject}}, har_gpc={{har_gpc}}, declared={{declared}}. Leave out arguments that were not given.
3. Present errors first: nonessential_before_consent, nonessential_after_reject, claim_contradicted, gpc_signal_ignored, samesite_none_insecure. Say which purposes are guesses and quote the vendor list version each guess came from.
4. If previous ({{previous}}) is given, call britomartis_diff_inventory with previous={{previous}} and the same capture arguments, and list new cookies, new hosts and new gaps.
5. Call britomartis_write_report so the person has consent-audit.md, consent-audit.html, the CSVs and inventory.json for next time.
6. If the person wants a cookie table, call britomartis_draft_policy_table (needs a human yes unless they opted in to Auto). Show every [TO CONFIRM] marker; the person decides purposes, providers and durations.
7. Publishing is a production deploy: britomartis_request_publish always waits for one named human click, even in Auto, and is refused while [TO CONFIRM] markers remain. Tell the person to approve with "britomartis-of-consent approve <id> --as \\"Their Name\\"". A person changes the live site, banner or tag manager; Britomartis never does.`,
  },
];
