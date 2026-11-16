// Exports Eos reads directly. A file already in Eos's own columns is read as it is.
import { exportProfile, fullName } from 'mythos-agent-core';

const PEOPLE_FIELDS = {
  person_id: { aliases: ['Employee #', 'Employee ID', 'Employee Number', 'Worker ID', 'Person ID', 'Staff ID'] },
  name: { aliases: ['Full Name', 'Employee Name', 'Display Name', 'Preferred Name', 'Worker'], required: true },
  type: { aliases: ['Worker Type', 'Employment Type', 'Employee Type', 'Kind'] },
  role: { aliases: ['Job Title', 'Title', 'Position', 'Business Title'] },
  manager: { aliases: ['Supervisor', 'Reports To', 'Reporting to', 'Manager Name', 'Owner'] },
  email: { type: 'email', aliases: ['Work Email', 'Email Address', 'Business Email', 'Primary Email'] },
  start_date: { type: 'date', aliases: ['Start Date', 'Hire Date', 'Date of Hire', 'Original Hire Date', 'Start'], required: true },
  end_date: { type: 'date', aliases: ['End Date', 'Termination Date', 'Last Day', 'Contract End Date', 'Separation Date'] },
};

export const SOURCES = {
  people: {
    label: 'People starting or leaving', fields: PEOPLE_FIELDS,
    profiles: [
      exportProfile('bamboohr_employees', {
        person_id: 'Employee #',
        name: fullName('First Name', 'Last Name'),
        type: { from: ['Employment Status'], consume: false, compute: (_r, get) => (/contract|freelanc|1099|consult/i.test(String(get('Employment Status') ?? '')) ? 'contractor' : 'employee') },
        role: 'Job Title',
        manager: ['Supervisor', 'Reporting to', 'Reports To'],
        email: ['Work Email', 'Email'],
        start_date: 'Hire Date',
        end_date: 'Termination Date',
      }, { note: 'The person type is read as "contractor" when Employment Status says contractor, freelance, consultant or 1099, and "employee" otherwise. Your checklist template needs those two types.' }),
    ],
  },
};
