// Exports Ladon reads directly. A file already in Ladon's own columns is read as it is.
import { exportProfile, fullName } from 'mythos-agent-core';

const NEVER = { 'N/A': 'never', no_information: 'never', not_supported: 'never', 'Never logged in': 'never', 'Never accessed': 'never', never: 'never' };
const latest = (...vals) => vals.map((v) => String(v ?? '').trim()).filter((v) => /^\d{4}-\d{2}-\d{2}/.test(v)).sort().pop() || '';

const ACCESS_FIELDS = {
  system: { aliases: ['Application', 'App', 'Product', 'Tool'] },
  user: { aliases: ['Display Name', 'Full Name', 'User Name', 'Username', 'Name', 'Login'], required: true },
  email: { type: 'email', aliases: ['Email Address', 'E-mail', 'User Email', 'User Principal Name', 'UPN', 'Work Email', 'Primary Email'] },
  account_type: { aliases: ['Account Type', 'User Type', 'Kind'] },
  role: { aliases: ['Roles', 'Role Name', 'Permission', 'Permissions', 'Permission Set', 'Profile', 'Access Level', 'Security Role', 'Group'] },
  owner: { aliases: ['Account Owner', 'Manager', 'Manager Email', 'Sponsor'] },
  last_login: { type: 'date', aliases: ['Last Login', 'Last Sign In', 'Last Sign-in', 'Last Logon', 'Last Active', 'Last Activity', 'Last Seen', 'Last Login Date', 'Last Activity Date', 'Last Used'] },
  last_rotated: { type: 'date', aliases: ['Last Rotated', 'Credential Rotated', 'Key Rotated', 'Rotated At', 'Last Rotation', 'Secret Rotated'] },
  status: { aliases: ['Account Status', 'User Status', 'State'] },
  mfa: { type: 'bool', aliases: ['MFA', '2FA', 'MFA Enabled', 'Two Factor', 'Two-Factor Enabled', 'MFA Status', '2-Step Verification'] },
};

const ACCESS_PROFILES = [
  exportProfile('okta_users_api', {
    system: { value: 'Okta' },
    user: fullName('profile.firstName', 'profile.lastName'),
    email: ['profile.email', 'profile.login'],
    last_login: { from: 'lastLogin', default: 'never' },
    status: { from: 'status', values: { ACTIVE: 'active', PROVISIONED: 'active', RECOVERY: 'active', LOCKED_OUT: 'active', PASSWORD_EXPIRED: 'active', STAGED: 'inactive', SUSPENDED: 'disabled', DEPROVISIONED: 'deleted' } },
    last_rotated: 'passwordChanged',
  }, { note: 'The Okta users list carries no roles and no MFA enrolment, so privileged-role and MFA checks need those columns added.' }),
  exportProfile('entra_users', {
    system: { value: 'Microsoft Entra ID' },
    user: 'displayName',
    email: { from: ['mail', 'userPrincipalName'], compute: (_r, get) => get('mail') || get('userPrincipalName') },
    account_type: { from: 'userType', values: { Member: 'human', Guest: 'guest' } },
    role: 'jobTitle',
    status: { from: 'accountEnabled', values: { true: 'active', false: 'disabled' } },
  }, { note: 'The Entra "Download users" file has no last sign-in, role assignment or MFA columns, so those checks are skipped for this file.' }),
  exportProfile('m365_active_users', {
    system: { value: 'Microsoft 365' },
    user: 'Display name',
    email: 'User principal name',
    role: 'Title',
    status: { from: 'Block credential', values: { true: 'disabled', false: 'active' } },
    last_rotated: 'Last password change timestamp',
  }, { note: 'The Microsoft 365 "Active users" export has no last sign-in or MFA columns, so those checks are skipped for this file.' }),
  exportProfile('google_workspace_users', {
    system: { value: 'Google Workspace' },
    user: fullName('First Name [Required]', 'Last Name [Required]'),
    email: 'Email Address [Required]',
    owner: 'Manager Email',
    role: 'Employee Title',
    last_login: { from: 'Last Sign In [READ ONLY]', values: NEVER },
    status: { from: 'Status [READ ONLY]', values: { Active: 'active', Suspended: 'disabled' } },
    mfa: '2sv Enrolled [READ ONLY]',
  }, { note: 'Admin roles are not in the Google Workspace users download; the role column here is the job title.' }),
  exportProfile('slack_members', {
    system: { value: 'Slack' },
    user: ['fullname', 'displayname', 'username'],
    email: 'email',
    role: 'status',
    account_type: { from: 'status', compute: (_r, get) => (/bot/i.test(get('status') || '') ? 'bot' : /guest/i.test(get('status') || '') ? 'guest' : 'human') },
    status: { from: 'status', consume: false, compute: (_r, get) => (/deactivated/i.test(get('status') || '') ? 'disabled' : 'active') },
    mfa: 'has-2fa',
  }, { note: 'The Slack member list has no last-active column, so stale accounts could not be checked from this file.' }),
  exportProfile('github_org_members', {
    system: { value: 'GitHub' },
    user: 'login',
    email: 'saml_name_id',
    role: { from: 'role', values: { owner: 'Owner', admin: 'Owner', member: 'Member' } },
    last_login: { from: 'last_active', values: NEVER },
    mfa: 'tfa_enabled',
  }),
  exportProfile('aws_iam_credential_report', {
    system: { value: 'AWS IAM' },
    user: 'user',
    role: { from: 'user', consume: false, compute: (_r, get) => (get('user') === '<root_account>' ? 'root' : '') },
    account_type: { from: ['password_enabled'], compute: (_r, get) => (get('user') === '<root_account>' ? 'human' : /^false$/i.test(get('password_enabled') || '') ? 'service' : 'human') },
    last_login: { from: ['password_last_used', 'access_key_1_last_used_date', 'access_key_2_last_used_date'], compute: (_r, get) => latest(get('password_last_used'), get('access_key_1_last_used_date'), get('access_key_2_last_used_date')), default: 'never' },
    last_rotated: { from: ['access_key_1_last_rotated', 'access_key_2_last_rotated', 'password_last_changed'], compute: (_r, get) => latest(get('access_key_1_last_rotated'), get('access_key_2_last_rotated'), get('password_last_changed')) },
    status: { value: 'active' },
    mfa: 'mfa_active',
  }, { note: 'IAM policies and groups are not in the credential report, so only the root account is marked privileged from this file.' }),
  exportProfile('atlassian_users', {
    system: { value: 'Atlassian' },
    user: 'User name',
    email: 'email',
    role: 'Org role',
    status: { from: 'User status', values: { Active: 'active', Suspended: 'disabled', Deactivated: 'disabled', Invited: 'inactive' } },
    last_login: { compute: (r, _get, h) => Object.keys(r).filter((k) => /^last seen in/i.test(k)).map((k) => h.date(r[k])).filter(Boolean).sort().pop() || '', default: 'never' },
  }),
];

const ROSTER_FIELDS = {
  email: { type: 'email', aliases: ['Work Email', 'Email Address', 'Business Email', 'Primary Email', 'E-mail'], required: true },
  name: { aliases: ['Full Name', 'Employee Name', 'Display Name', 'Employee'] },
  status: { aliases: ['Employment Status', 'Employee Status', 'Worker Status'] },
  termination_date: { type: 'date', aliases: ['Termination Date', 'End Date', 'Last Day', 'Last Day of Work', 'Separation Date'] },
  manager: { aliases: ['Supervisor', 'Reports To', 'Reporting to', 'Manager Name'] },
};
const ROSTER_PROFILES = [
  exportProfile('bamboohr_employees', {
    email: ['Work Email', 'Email'],
    name: fullName('First Name', 'Last Name'),
    status: { from: ['Termination Date', 'Status', 'Employment Status'], consume: false, compute: (_r, get) => (String(get('Termination Date') || '').trim() || /terminat/i.test(get('Employment Status') || '') ? 'terminated' : /inactive/i.test(get('Status') || '') ? 'inactive' : 'active') },
    termination_date: 'Termination Date',
    manager: ['Supervisor', 'Reporting to', 'Reports To'],
  }),
];

export const SOURCES = {
  access: { label: 'Account and access export', args: ['access', 'previous', 'current'], fields: ACCESS_FIELDS, profiles: ACCESS_PROFILES },
  roster: { label: 'HR roster', args: ['roster'], fields: ROSTER_FIELDS, profiles: ROSTER_PROFILES },
};
