// MCP prompts for Penelope of Recon.

export const PROMPTS = [
  {
    name: 'month_end_bank_rec',
    title: 'Month-end bank reconciliation, end to end',
    description: 'Walks a host model through reading the statement, reconciling, rolling last month forward, the workpaper and learned rules. Adjusting entries stay a human click.',
    arguments: [
      { name: 'bank', description: 'Bank statement under --root (CSV/JSON, CAMT.053, BAI2 or OFX)', required: true },
      { name: 'gl', description: 'GL cash-account detail under --root', required: true },
      { name: 'gl_balance', description: 'Ending GL cash balance for the period', required: true },
      { name: 'prior', description: "Last period's reconciliation.csv (leave blank for the first month)", required: false },
      { name: 'rules', description: 'Accepted match-rules JSON (leave blank if none)', required: false },
    ],
    text: `You are helping a bookkeeper close the month for one bank account with the penelope-of-recon tools. Bank file: {{bank}}. GL detail: {{gl}}. GL ending balance: {{gl_balance}}. Prior workpaper: {{prior}}. Accepted rules: {{rules}}. Ignore an argument that is blank or shown in brackets.

1. Call penelope_read_statement on the bank file. Report the format, line count and closing balance. If balance_check says opening + lines does not equal closing, stop and tell the bookkeeper the file looks incomplete.
2. Call penelope_reconcile with bank, gl, gl_balance (and rules if given; the statement's closing balance is used when bank_balance is left out). Report matches by confidence, bank-only and GL-only items and whether adjusted balances tie. List low-confidence and group matches for a person to check.
3. If a prior workpaper is given, call penelope_roll_forward with prior, bank, gl and gl_balance. Report which carried items cleared, which are still open and any stale items, and whether the roll-forward and balances tie.
4. Call penelope_write_workpaper so the bookkeeper has reconciliation.csv, reconciliation.md, reconciliation.html (with blank sign-off lines) and proposed-entries.csv. Quote output_sha256.
5. Matches the bookkeeper confirms can be recorded with penelope_accept_match (needs a yes unless opted in to Auto). After a few months of accepted matches, call penelope_suggest_rules and show each suggestion in plain words. Only call penelope_accept_rule for a suggestion the bookkeeper explicitly accepts; it needs their yes.
6. For each bank fee or interest line, you may call penelope_request_adjusting_entry. It returns needs_approval: a named person must approve it (mythos-approve <id> --as "Name" or the approvals page), then repeat the same call. Never call ledger_post_journal; it is blocked. Penelope never posts.

Say clearly that matches are proposals and that this is not accounting or audit advice.`,
  },
];
