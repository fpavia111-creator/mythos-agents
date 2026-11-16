// Exports Epeius reads directly. A file already in Epeius's own columns is read as it is.
import { exportProfile } from 'mythos-agent-core';

const text = (v) => String(v ?? '').trim();
const impact = (flag, value) => ({ from: [flag, value], compute: (_r, get) => [text(get(flag)), text(get(value))].filter(Boolean).join(': ') });

const RFI_FIELDS = {
  rfi_no: { aliases: ['RFI No', 'RFI Number', 'RFI #', 'Number', 'No.', '#'], required: true },
  subject: { aliases: ['Title', 'RFI Subject'] },
  question: { aliases: ['Description', 'RFI Question', 'Request'] },
  references: { aliases: ['Refs', 'Reference', 'Drawing Number', 'Drawing', 'Spec Section', 'Sheet'] },
  status: { aliases: ['RFI Status', 'State'] },
  sent_date: { type: 'date', aliases: ['Sent', 'Date Sent', 'Date Initiated', 'Initiated At', 'Created Date', 'Issued'] },
  due_date: { type: 'date', aliases: ['Due Date', 'Response Due', 'Due', 'Required By'] },
  answered_date: { type: 'date', aliases: ['Answered', 'Response Date', 'Closed Date', 'Date Closed', 'Date Answered'] },
  ball_in_court: { aliases: ['Ball In Court', 'With', 'Assigned To', 'Assignee', 'Assignees', 'Responsible'] },
  cost_impact: { aliases: ['Cost Impact'] },
  schedule_impact: { aliases: ['Schedule Impact'] },
};
const SUBMITTAL_FIELDS = {
  submittal_no: { aliases: ['Submittal No', 'Submittal Number', 'Submittal #', 'Number', '#'], required: true },
  spec_section: { aliases: ['Spec Section', 'Section', 'Specification Section'] },
  description: { aliases: ['Title', 'Submittal Title', 'Name'] },
  status: { aliases: ['Submittal Status', 'State'] },
  required_by: { type: 'date', aliases: ['Required By', 'Final Due Date', 'Due Date', 'Required On-Site Date', 'Submit By'] },
  submitted_date: { type: 'date', aliases: ['Submitted Date', 'Date Submitted', 'Received Date', 'Sent Date'] },
  returned_date: { type: 'date', aliases: ['Returned Date', 'Date Returned', 'Closed Date', 'Distributed Date'] },
  revision: { aliases: ['Rev', 'Rev.', 'Revision Number'] },
  ball_in_court: { aliases: ['Ball In Court', 'With', 'Assigned To', 'Responsible'] },
};
const DOCUMENT_FIELDS = {
  doc_id: { aliases: ['Drawing No.', 'Drawing No', 'Drawing Number', 'Sheet Number', 'Sheet', 'Number', 'Document Number'], required: true },
  type: { aliases: ['Document Type', 'Discipline', 'Kind'] },
  title: { aliases: ['Drawing Title', 'Sheet Title', 'Name', 'Document Title'] },
  revision: { aliases: ['Rev', 'Rev.', 'Revision Number', 'Current Revision'] },
  issued: { type: 'date', aliases: ['Drawing Date', 'Issue Date', 'Date Issued', 'Received Date', 'Date'] },
  status: { aliases: ['Document Status', 'State'] },
  file: { aliases: ['Text File', 'File Name', 'Path'] },
};

export const SOURCES = {
  rfis: {
    label: 'RFI log', args: ['rfis', 'previous_rfis'], fields: RFI_FIELDS,
    profiles: [
      exportProfile('procore_rfis', {
        rfi_no: '#',
        subject: 'Subject',
        references: { from: ['Drawing Number', 'Reference'], compute: (_r, get) => [text(get('Drawing Number')), text(get('Reference'))].filter(Boolean).join('; ') },
        status: { from: ['Closed?'], compute: (_r, get) => (/^(yes|true|y|1)$/i.test(text(get('Closed?'))) || text(get('Closed Date')) ? 'closed' : 'open') },
        sent_date: 'Initiated At',
        due_date: 'Due Date',
        answered_date: { from: ['Closed Date', 'Latest Assignee Response Date'], compute: (_r, get) => text(get('Closed Date')) || text(get('Latest Assignee Response Date')) },
        ball_in_court: 'Ball In Court',
        cost_impact: impact('Cost Impact', 'Cost Impact Value'),
        schedule_impact: impact('Schedule Impact', 'Schedule Impact Value'),
      }, { note: 'The Procore RFI CSV has no question text and no status column: an RFI is read as closed when "Closed?" says yes or it has a closed date, and open otherwise. Duplicate-question checks use the subject only.' }),
    ],
  },
  submittals: { label: 'Submittal log', fields: SUBMITTAL_FIELDS, profiles: [] },
  documents: { label: 'Drawing and specification register', fields: DOCUMENT_FIELDS, profiles: [] },
};
