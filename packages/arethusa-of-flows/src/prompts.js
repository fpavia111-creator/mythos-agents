export const PROMPTS = Object.freeze([
  {
    name: 'arethusa_flow_review',
    title: 'Review workflow automations',
    description: 'Walks the host model through a full review of exported automation flows: audit, dependency map and rotation plan, report with SARIF, drafted fixes, and the one-click change requests a person must approve.',
    arguments: [
      { name: 'exports', description: 'Comma-separated export files under --root (n8n, Zapier, Make, Power Automate, Workato)', required: true },
      { name: 'history', description: 'Run history CSV/JSON (optional)', required: false },
      { name: 'policy', description: 'Policy JSON with suppressions and thresholds (optional)', required: false },
      { name: 'baseline', description: 'findings.csv from the last review (optional)', required: false },
    ],
    text: [
      'Review these workflow automation exports with arethusa-of-flows: {{exports}}. History: {{history}}. Policy: {{policy}}. Baseline: {{baseline}}.',
      '',
      '1. If a policy file was given, validate it first: a policy error stops the run with a JSON-pointer path; tell the user which key to fix.',
      '2. Call arethusa_audit with exports, history, as_of (today) and policy. Start with high findings in active flows: hardcoded_secret, open_webhook, destructive_without_filter, money_moving, failing_runs. Never ask for or repeat a secret value; Arethusa reports only where it is.',
      '3. Call arethusa_dependency_map with the same exports. Show shared credentials and secrets (blast radius) and any flow that calls another flow\'s webhook. Present the rotation plan in priority order (P1 first).',
      '4. Call arethusa_write_report with exports, history, policy and baseline (if any). It writes flow-audit.md, findings.csv (owner and decision columns left blank for people) and findings.sarif. With a baseline, lead with new findings and list resolved ones.',
      '5. Call arethusa_draft_changes to write proposals and redacted copies. It asks for a human yes unless Auto is on for it. Nothing is applied to any platform.',
      '6. Human step: for each flow a person decides to enable, disable or modify, call arethusa_request_flow_change. It is always one named human click (production_deploy), even in Auto. The flow owner applies the change on the platform; Arethusa never runs, enables or edits a flow, and automation_update_flow and automation_run_flow are blocked.',
      '',
      'Finish with: the top risks, the rotation plan, which change requests are waiting for a person, and what a static export review cannot see (live credentials, platform-side settings).',
    ].join('\n'),
  },
]);
