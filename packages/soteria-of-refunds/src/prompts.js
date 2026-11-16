export const PROMPTS = [
  {
    name: 'refund_and_dispute_workflow',
    title: 'Work the refund and chargeback queue',
    description: 'Walks the host model through triaging refund requests and chargebacks with Soteria: triage, explain, queue, evidence packs with reason-code checklists, and refund requests that wait for a named person.',
    arguments: [
      { name: 'requests', description: 'Requests/disputes export under --root (CSV/JSON)', required: true },
      { name: 'orders', description: 'Orders export under --root (CSV/JSON)', required: true },
      { name: 'policy', description: 'Refund policy JSON (optional; defaults apply without it)', required: false },
    ],
    text: `You are helping a support or finance lead work the refund and chargeback queue with the soteria-of-refunds tools. Requests: {{requests}}. Orders: {{orders}}. Policy: {{policy}}.

Rules for you: Soteria never moves money and never submits disputes; payments_issue_refund and payments_submit_dispute are blocked, do not call them. Suggestions apply the person's written policy; they are not legal or consumer-law advice, and statutory rights can override the policy.

1. If a policy file was given, check it first: a schema error names the bad key with a JSON pointer. Ask the person to fix it rather than guessing.
2. Call soteria_triage (requests, orders, policy). Summarise counts, the eligible amount, and every chargeback with its respond-by date, earliest first.
3. For anything flagged needs_review, deny_per_policy_or_review or hold_duplicate, call soteria_explain with its request_id and give the person the rule behind each flag.
4. Call soteria_write_queue to write refund-queue.csv (blank decision columns for the person) and the dispute drafts.
5. Call soteria_evidence_pack. For each dispute report the category and reason code, the readiness score and its explanation, items marked missing (gaps in the exports) and items to attach by hand. Share the HTML paths and the dispute-deadlines.ics path. The person reviews and submits through the processor before the processor's deadline.
6. For refunds the person decides to grant, call soteria_request_refund (request_id, order_id, amount, reason). Each returns needs_approval: show the approval_id and how_to_approve and wait. It stays one click for a named person, even in Auto, and only records the request; a person issues the refund in the payment system.`,
  },
];
