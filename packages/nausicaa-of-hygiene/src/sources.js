// Exports Nausicaa reads directly. A file already in Nausicaa's own columns is read as it is.
import { exportProfile } from 'mythos-agent-core';

const name = (first, last, full) => ({ from: [first, last, ...(full ? [full] : [])], compute: (_r, get) => [get(first), get(last)].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ') || String((full && get(full)) ?? '').trim() });
const filled = (v) => String(v ?? '').trim() !== '';

const CONTACT_FIELDS = {
  id: { aliases: ['Contact ID', 'Record ID', 'Lead ID', 'Subscriber ID', 'Member ID'] },
  email: { aliases: ['Email Address', 'E-mail', 'Email 1', 'Primary Email', 'Work Email'], required: true },
  name: { aliases: ['Full Name', 'Contact Name', 'Display Name'] },
  company: { aliases: ['Company Name', 'Account Name', 'Organization', 'Organisation', 'Account'] },
  last_activity: { type: 'date', aliases: ['Last Activity', 'Last Activity Date', 'Last Active', 'Last Engaged', 'Last Opened', 'Last Contacted', 'Last Engagement Date'] },
  bounce: { aliases: ['Bounce', 'Bounced', 'Bounce Status', 'Bounce Type', 'Bounce Reason', 'Email Bounced Reason'] },
  consent: { aliases: ['Consent', 'Marketing Consent', 'Opt In', 'Email Opt In', 'Opted In'] },
  consent_date: { type: 'date', aliases: ['Consent Date', 'Opt In Date', 'Opt-in Date', 'Subscribed Date', 'Date Subscribed'] },
  consent_source: { aliases: ['Consent Source', 'Opt In Source', 'Consent Method', 'Opt-in Method', 'Signup Source'] },
  unsubscribed: { aliases: ['Unsubscribed', 'Opted Out', 'Unsubscribe', 'Email Opt Out', 'Do Not Email'] },
  status: { aliases: ['Subscription Status', 'Email Status', 'Subscriber Status'] },
};

const CONTACT_PROFILES = [
  exportProfile('hubspot_contacts', {
    id: 'Record ID',
    email: 'Email',
    name: name('First Name', 'Last Name'),
    company: ['Company Name', 'Associated Company', 'Company name'],
    last_activity: ['Last Activity Date', 'Last Engagement Date', 'Last Contacted'],
    bounce: { from: 'Email hard bounce reason', transform: (v) => `hard bounce: ${v}` },
    unsubscribed: 'Unsubscribed from all email',
    consent_source: "Legal basis for processing contact's data",
    consent: { from: ["Legal basis for processing contact's data"], consume: false, compute: (_r, get) => (/consent/i.test(String(get("Legal basis for processing contact's data") ?? '')) ? 'yes' : '') },
  }, { note: 'HubSpot shows consent only when the exported view includes "Legal basis for processing contact\'s data" (or your own consent properties). Without it, consent shows as unknown. "Marketing contact status" is a billing setting and is not read as consent.' }),
  exportProfile('salesforce_contacts_report', {
    id: ['Contact ID', 'Lead ID'],
    email: 'Email',
    name: name('First Name', 'Last Name', 'Full Name'),
    company: ['Account Name', 'Company / Account', 'Company'],
    last_activity: 'Last Activity',
    bounce: 'Email Bounced Reason',
    unsubscribed: 'Email Opt Out',
  }, { skipRow: (r, get) => !filled(get('Email')) && Object.values(r).filter(filled).length <= 1, note: 'Standard Salesforce contact and lead fields carry an opt-out but no opt-in, so consent shows as unknown unless your report adds a consent column.' }),
  exportProfile('salesforce_data_loader', {
    id: 'Id',
    email: 'Email',
    name: name('FirstName', 'LastName', 'Name'),
    company: ['Account.Name', 'Company', 'AccountId'],
    last_activity: 'LastActivityDate',
    bounce: 'EmailBouncedReason',
    unsubscribed: 'HasOptedOutOfEmail',
  }, { note: 'Standard Salesforce contact and lead fields carry an opt-out but no opt-in, so consent shows as unknown unless your export adds a consent field.' }),
  exportProfile('mailchimp_audience', {
    id: ['LEID', 'EUID'],
    email: 'Email Address',
    name: name('First Name', 'Last Name'),
    consent: { from: ['CONFIRM_TIME'], consume: false, compute: (_r, get) => (filled(get('CONFIRM_TIME')) ? 'yes' : '') },
    consent_date: { from: ['CONFIRM_TIME', 'OPTIN_TIME'], compute: (_r, get) => String(get('CONFIRM_TIME') || get('OPTIN_TIME') || '').trim() },
    consent_source: { from: ['CONFIRM_IP', 'OPTIN_IP'], consume: false, compute: (_r, get) => (filled(get('CONFIRM_IP')) ? 'mailchimp confirmed opt-in' : filled(get('OPTIN_IP')) ? 'mailchimp signup form' : filled(get('OPTIN_TIME')) ? 'mailchimp import or added by hand' : '') },
    unsubscribed: { compute: (_r, get) => (filled(get('UNSUB_TIME')) ? 'yes' : 'no') },
    status: { compute: (_r, get) => (filled(get('UNSUB_TIME')) ? 'unsubscribed' : filled(get('CLEAN_TIME')) ? 'bounced' : 'subscribed') },
  }, { note: 'Mailchimp exports one file per status. A CONFIRM_TIME is read as recorded consent; an OPTIN_TIME alone is not, because Mailchimp also sets it for imported contacts. "Cleaned" addresses are read as bounced. The export has no last-engagement date, so stale contacts cannot be found from it.' }),
];

export const SOURCES = {
  contacts: { label: 'Contact list', args: ['contacts', 'previous'], fields: CONTACT_FIELDS, profiles: CONTACT_PROFILES },
};
