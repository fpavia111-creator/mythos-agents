# Eucleia of Outreach (`eucleia-of-outreach`)

> A draft-only gate in front of outreach email. Checks every draft; never sends. Releasing a batch is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Eucleia checks outreach drafts (CSV/JSON: `to, subject, body, send_at`, optional `time_zone`) before a person sends them from their own mail tool. A draft is **held** if any check fails:
- the address or its domain is on your suppression list, or it is a duplicate in the batch;
- the subject is empty or 30 characters or more, or starts with a fake `RE:`/`FWD:` on a first email;
- the body is empty or 100 words or more;
- the subject or body still has an unfilled placeholder (`{{first_name}}`, `{Company}`, `*|FNAME|*`, `%FNAME%`, `[First Name]`);
- a link uses a URL shortener or a raw IP address, or (when you set `link_allowlist`) points outside your allowed domains, including the unsubscribe link;
- the sender name, a postal address or an unsubscribe method (the footer fields the US CAN-SPAM Act asks for) is missing;
- `send_at` is outside the send window: Tuesday or Wednesday, 8:00–17:00 America/Chicago by default. Days, hours, time zone, several windows and blackout dates are configurable; when a draft has a `time_zone`, the window is checked in the recipient's zone. Daylight-saving changes come from the time-zone database, not fixed offsets. Held drafts get the next open slot.

Common spam-trigger phrases ("free", "guaranteed", "click here"…, plus your own) are cited with the field, the character position and a snippet. They are warnings by default; set `spam_policy: "hold"` to hold instead. Plain `http` links and more than 3 links are warnings.

It writes `ready.csv`, `held.csv` and one text file per ready draft with the footer added. It can plan send slots for the ready drafts (inside each recipient's window, at most `max_per_day` per day, at least `min_gap_minutes` apart, skipping blackout dates) as `schedule.csv` plus a calendar file with one entry per sending day. Releasing a batch re-checks everything and writes `release.json` (a sha256 per draft; the file's hash goes into the audit log) for the person who sends.

Opt-outs can be imported from **Mailchimp** (unsubscribed or cleaned export), **HubSpot** (contacts export with "Unsubscribed from all email" or "Email hard bounce reason") and **Resend** (contacts export with `unsubscribed`). The format is detected from the header. Import only adds; nothing is ever removed.

### Config file

`eucleia-config` JSON (unknown keys, wrong types and unknown time zones are refused with a JSON-pointer error; check one with `eucleia-of-outreach validate-config eucleia-config <file>`):

```json
{
  "from_name": "Sample Sender", "postal_address": "100 Example Ave, Austin, TX 78701",
  "unsubscribe": "Reply STOP or visit https://example.com/unsubscribe",
  "days": ["Tue", "Wed"], "start_hour": 8, "end_hour": 17, "time_zone": "America/Chicago",
  "windows": [{ "days": ["Thu"], "start_hour": 13, "end_hour": 15 }],
  "blackout_dates": ["2026-11-25"],
  "link_allowlist": ["example.com"], "max_links": 3,
  "spam_words": ["savings"], "spam_policy": "warn",
  "max_per_day": 25, "min_gap_minutes": 6,
  "max_subject_chars": 30, "max_body_words": 100
}
```

`windows`, when given, replaces `days`/`start_hour`/`end_hour`.

## Install

```bash
npm install -g eucleia-of-outreach
eucleia-of-outreach demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add eucleia-of-outreach -- npx -y eucleia-of-outreach@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "eucleia-of-outreach": { "command": "npx", "args": ["-y", "eucleia-of-outreach@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `eucleia_check_draft` | **allow** | Check one draft; every failure listed |
| `eucleia_check_batch` | **allow** | Check a CSV/JSON batch |
| `eucleia_prepare_outbox` | **allow** | Write `ready.csv`, `held.csv` and `drafts/` to `mythos-out/eucleia` |
| `eucleia_plan_schedule` | **allow** | Plan send slots; write `schedule.csv` and `schedule.ics` (no addresses in the calendar) |
| `eucleia_add_suppression` | **ask (Auto-eligible)** | Add an opt-out to the suppression list (adds only, never removes) |
| `eucleia_import_suppression` | **ask (Auto-eligible)** | Import opt-outs and bounces from a Mailchimp, HubSpot or Resend export (adds only) |
| `eucleia_release_batch` | **ask · one-click** | Re-check and write `release.json` for a person to send; sends nothing |
| `eucleia_send_email` | **block** | Listed so agents see the refusal. Eucleia never sends email. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## MCP prompt

`eucleia_outreach_batch` (arguments: `drafts`, `config`, `suppression`, optional `esp_export`, `start_from`) walks a host model through import → check → plan → outbox → release, and stops at the release for a person's click.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `eucleia-of-outreach approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`eucleia-of-outreach kill`).

Only `eucleia_add_suppression` and `eucleia_import_suppression` can go on Auto (`--mode auto --auto eucleia_add_suppression,eucleia_import_suppression`), so opt-outs are honoured without waiting. Releasing a batch is `binding_send`: it stays **one-click even in Auto**, and sending stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
eucleia-of-outreach tools
eucleia-of-outreach call eucleia_check_batch '{"drafts":"drafts.csv","suppression":"suppression.csv","config":"eucleia.json"}'
eucleia-of-outreach eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an email sender, ESP or CRM. It has no mail credentials and sends nothing.
- Not legal advice, and passing the checks does not make a campaign compliant with CAN-SPAM, GDPR, CASL or any other law. It checks the fields and rules listed above.
- It does not verify that addresses exist or that you have consent to contact them.
- The spam-phrase list is a short built-in list of common triggers, not a spam filter score; it does not predict inbox placement. Link checks look only at the URLs in the text; Eucleia does not fetch them.
- No live ESP connection: suppression import works on export files you download.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/eucleia-of-outreach>
