// Exports Helios reads directly. A file already in Helios's own columns is read as it is.
import { exportProfile, fullName } from 'mythos-agent-core';

const NEVER = { 'Never logged in': 'never', 'Never accessed': 'never', never: 'never' };

const SEAT_FIELDS = {
  app: { aliases: ['Application', 'Tool', 'Product', 'Vendor'] },
  user: { aliases: ['Display Name', 'Full Name', 'User Name', 'Username', 'Name', 'Member'], required: true },
  email: { type: 'email', aliases: ['Email Address', 'E-mail', 'User Email', 'User Principal Name', 'UPN', 'Work Email'] },
  tier: { aliases: ['Plan', 'License', 'Licenses', 'License Type', 'Seat Type', 'Edition', 'Subscription'] },
  monthly_cost: { type: 'money', aliases: ['Monthly Cost', 'Cost Per Month', 'Cost', 'Price', 'Monthly Price', 'Seat Price'] },
  last_active: { type: 'date', aliases: ['Last Active', 'Last Login', 'Last Sign In', 'Last Seen', 'Last Used', 'Last Activity', 'Last Activity Date', 'Last Login Date'] },
  premium_features_used: { type: 'bool', aliases: ['Premium Features Used', 'Premium Used', 'Uses Premium', 'Advanced Features Used'] },
  status: { aliases: ['Account Status', 'User Status', 'State'] },
};

const SEAT_PROFILES = [
  exportProfile('m365_active_user_detail', {
    app: { value: 'Microsoft 365' },
    user: 'Display Name',
    email: 'User Principal Name',
    tier: 'Assigned Products',
    last_active: { compute: (r, _get, h) => Object.keys(r).filter((k) => /last activity date$/i.test(k)).map((k) => h.date(r[k])).filter(Boolean).sort().pop() || '', default: 'never' },
    status: { from: 'Is Deleted', values: { true: 'removed', false: 'active' } },
  }, { note: 'Seat prices are not in the Microsoft 365 usage report. Savings show as unknown until monthly_cost is set in mythos-sources.json or a cost column is added.' }),
  exportProfile('google_workspace_users', {
    app: { value: 'Google Workspace' },
    user: fullName('First Name [Required]', 'Last Name [Required]'),
    email: 'Email Address [Required]',
    tier: ['Licenses [READ ONLY]', 'New Licenses [UPLOAD ONLY]'],
    last_active: { from: 'Last Sign In [READ ONLY]', values: NEVER },
    status: { from: 'Status [READ ONLY]', values: { Active: 'active', Suspended: 'suspended' } },
  }, { note: 'Seat prices are not in the Google Workspace users download. Savings show as unknown until monthly_cost is set in mythos-sources.json or a cost column is added.' }),
  exportProfile('github_copilot_seats', {
    app: { value: 'GitHub Copilot' },
    user: 'assignee.login',
    tier: 'plan_type',
    last_active: { from: 'last_activity_at', default: 'never' },
    status: { value: 'active' },
  }, { note: 'The Copilot seats list has no email or price. Savings show as unknown until monthly_cost is set in mythos-sources.json.' }),
  exportProfile('atlassian_users', {
    app: { value: 'Atlassian' },
    user: 'User name',
    email: 'email',
    last_active: { compute: (r, _get, h) => Object.keys(r).filter((k) => /^last seen in/i.test(k)).map((k) => h.date(r[k])).filter(Boolean).sort().pop() || '', default: 'never' },
    status: { from: 'User status', values: { Active: 'active', Suspended: 'suspended', Deactivated: 'deactivated', Invited: 'active' } },
  }, { note: 'Seat prices are not in the Atlassian users export. Savings show as unknown until monthly_cost is set in mythos-sources.json.' }),
];

const ROSTER_FIELDS = {
  email: { type: 'email', aliases: ['Work Email', 'Email Address', 'Business Email', 'Primary Email', 'E-mail'], required: true },
  name: { aliases: ['Full Name', 'Employee Name', 'Display Name', 'Employee'] },
  status: { aliases: ['Employment Status', 'Employee Status', 'Worker Status'] },
  manager_email: { type: 'email', aliases: ['Manager Email', 'Supervisor Email', 'Manager E-mail'] },
  manager: { aliases: ['Supervisor', 'Reports To', 'Reporting to', 'Manager Name'] },
};
const ROSTER_PROFILES = [
  exportProfile('bamboohr_employees', {
    email: ['Work Email', 'Email'],
    name: fullName('First Name', 'Last Name'),
    status: { from: ['Termination Date', 'Status', 'Employment Status'], consume: false, compute: (_r, get) => (String(get('Termination Date') || '').trim() || /terminat/i.test(get('Employment Status') || '') ? 'terminated' : /inactive/i.test(get('Status') || '') ? 'inactive' : 'active') },
    manager: ['Supervisor', 'Reporting to', 'Reports To'],
  }),
  exportProfile('google_workspace_users', {
    email: 'Email Address [Required]',
    name: fullName('First Name [Required]', 'Last Name [Required]'),
    status: { from: 'Status [READ ONLY]', values: { Active: 'active', Suspended: 'inactive' } },
    manager_email: 'Manager Email',
  }),
];

export const SOURCES = {
  seats: { label: 'Seat or licence export', args: ['seats', 'previous'], fields: SEAT_FIELDS, profiles: SEAT_PROFILES },
  roster: { label: 'HR roster', args: ['roster'], fields: ROSTER_FIELDS, profiles: ROSTER_PROFILES },
};
