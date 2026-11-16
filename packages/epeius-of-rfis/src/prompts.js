// MCP prompt: walks a host model through the weekly RFI and submittal review.
export const prompts = [
  {
    name: 'epeius_weekly_rfi_review',
    title: 'Weekly RFI and submittal review',
    description: 'Review the RFI and submittal log against the document index, see who holds what, compare with last week, and prepare (never send) RFIs and transmittals.',
    arguments: [
      { name: 'documents', description: 'Drawing and spec index CSV/JSON, relative to --root', required: true },
      { name: 'rfis', description: 'Current RFI log export', required: true },
      { name: 'submittals', description: 'Submittal log export (optional)', required: false },
      { name: 'previous_rfis', description: 'Last week\'s RFI log export (optional)', required: false },
      { name: 'title_blocks', description: 'Folder of title-block text files (optional)', required: false },
      { name: 'as_of', description: 'Review date YYYY-MM-DD', required: true },
    ],
    text: `You are helping a project engineer run the weekly RFI and submittal review with the Epeius tools. Epeius is not design or engineering advice and never sends anything.

1. If a title-block folder was given ({{title_blocks}}), call epeius_index_title_blocks with folder={{title_blocks}} and documents={{documents}}. Report new sheets and any sheet where the index is behind the title block. Do not replace the index yourself: tell the person to check documents.from-title-blocks.csv and update their index.
2. Call epeius_review_log with documents={{documents}}, rfis={{rfis}}, submittals={{submittals}}, as_of={{as_of}}. List overdue RFIs, references to superseded or unknown documents, possible duplicates and submittal issues.
3. Call epeius_ball_in_court with the same arguments. Present the per-party table and the top of the chase list, each with its reason.
4. If previous_rfis was given ({{previous_rfis}}), call epeius_diff_logs with previous_rfis={{previous_rfis}}, rfis={{rfis}}, as_of={{as_of}} and summarise new, closed and newly overdue RFIs.
5. Call epeius_write_log_report (add previous_rfis if given) so the person has the markdown, CSVs, ball-in-court.csv and the .ics of due dates.
6. Only if the person asks for a new RFI or transmittal: call epeius_draft_rfi with their own subject and question (do not invent the question), or epeius_draft_transmittal with the documents they name. Both need a human yes unless the person opted in to Auto. Show every [MISSING REFERENCE], [CHECK REVISION], [NO CITATION] and [TO CONFIRM] marker and ask the person to resolve them.
7. Sending is a binding send. epeius_request_send always waits for one named human click, even in Auto; tell the person to approve it with "epeius-of-rfis approve <id> --as \\"Their Name\\"". After that, a person sends the RFI or transmittal; Epeius only records the approval.

Check before you finish: every cited document came from the index; nothing was sent; open markers were shown to the person.`,
  },
];
