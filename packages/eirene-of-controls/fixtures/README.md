Sample logs, decisions and evidence files for demos and tests. Fictional; no customer data. tampered-audit.jsonl is deliberately edited.

| Path | What it is |
|---|---|
| `talos-audit.jsonl` | Talos (agent-guard) log, valid chain |
| `olympus-audit.jsonl` | Unsigned (v1) mythos-agent-core log, valid chain |
| `tampered-audit.jsonl` | The Olympus log with a line edited and one removed |
| `signed-audit.jsonl` | Signed (v2) mythos-agent-core log with a signed key rotation on line 3 |
| `signed-rechained-audit.jsonl` | `signed-audit.jsonl` with line 4 edited and the hash chain recomputed without the key; the chain checks out, the signature does not |
| `keys/audit-public.pem` | Public key for `signed-audit.jsonl` (the first key; the second is introduced by the rotation line). The private keys were generated outside the repository for the sample and are not included |
| `controls.json` | A control list in the 0.1 array form |
| `evidence/2026-Q3/`, `evidence/2026-Q4/` | Two periods of made-up evidence files (access review, change log, backup test, incident drill) for mapping and folder diffs |
| `.decisions/` | One Alethea decision record |
