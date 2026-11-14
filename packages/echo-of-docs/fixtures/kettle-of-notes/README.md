# Kettle of Notes (`kettle-of-notes`)

> Lists, summarises and drafts notes. Four tools. MIT, Node ≥ 18.

See the [guide](docs/guide.md), the [changelog](CHANGELOG.md) and [how policies work](#policies).

## Install

```bash
npx -y kettle-of-notes@0.2.1 mcp --root ./notes
npm run lint
```

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `kettle_list` | **allow** | List notes |
| `kettle_sumarize` | **allow** | Summarise notes |
| `kettle_draft_note` | **allow** | Draft a note |
| `kettle_export` | **ask** | Export notes to PDF |
| `delete_notes` | **block** | Refused |

## Modes

Review, Assist and Auto, as in every pack.

## CLI

```bash
kettle-of-notes call kettle_list '{"dir":"notes"}'
kettle-of-notes call kettle_draft_note '{"folder":"notes"}'
```

## License

Apache-2.0 © 2026 Kettle Labs (fictional)
