// MCP prompt: walks a host model through a dependency license review before a release.
export const prompts = [
  {
    name: 'lycurgus_license_review',
    title: 'Dependency license review',
    description: 'Check a project\'s dependencies against the written license policy, see what changed since the last release, write the report, SBOM, SARIF and a third-party notices draft, and prepare (never publish) the release request.',
    arguments: [
      { name: 'project', description: 'Project folder, relative to --root', required: true },
      { name: 'policy', description: 'License policy JSON, relative to --root', required: true },
      { name: 'baseline', description: 'sbom.cdx.json from the last release (optional)', required: false },
      { name: 'as_of', description: 'Date used to expire exceptions, YYYY-MM-DD (optional)', required: false },
    ],
    text: `You are helping an engineer apply their team's written license policy with the Lycurgus tools. Lycurgus applies the policy as written; it is not legal advice, it does not decide what a license allows, and it never says a project is cleared for distribution. Do not say so either.

1. Check the policy file first: "lycurgus-of-licenses validate-config license_policy {{policy}}". If it fails, show the JSON-pointer errors and stop until the person fixes them. Do not edit the policy yourself.
2. Call lycurgus_check with project={{project}}, policy={{policy}}, as_of={{as_of}} (leave out as_of if not given). The lockfile type (npm, pnpm, yarn, Python, Go) is detected. Report the result (pass, pass_with_review, fail) and list denied packages first, then review and unknown ones, each with its policy section.
3. Point out every package whose license came from a license text: "license_from_text" (close match) and "license_text_low_confidence" (a person must read the file), and any "license_text_mismatch". Never treat a low-confidence match as allowed.
4. If a baseline SBOM was given ({{baseline}}), call lycurgus_diff_sbom with baseline={{baseline}} and the same project and policy. Lead with "needs a look": new dependencies and license changes that are not allowed.
5. Call lycurgus_write_report for the report, licenses.csv, CycloneDX SBOM, SARIF and check-summary.json. Call lycurgus_write_notices for THIRD-PARTY-NOTICES.md and show its "Needs a person" list; [TO ADD] markers mean a license text was not found locally.
6. For review or unknown packages, lycurgus_draft_exceptions writes unsigned stubs (needs a human yes unless the person opted in to Auto). A person fills in the reason and approver and adds them to the policy; denied packages are replaced or removed, never excepted by you.
7. Releasing is a production deploy. lycurgus_request_release always waits for one named human click, even in Auto; it is refused when the check failed, and a pass with review items needs review_note naming who reviewed them. Tell the person to approve with "lycurgus-of-licenses approve <id> --as \\"Their Name\\"". A person publishes; Lycurgus never does.`,
  },
];
