import { toCsv, htmlPage, escapeHtml, sha256, canonical, foldText } from 'mythos-agent-core';
import { ladonText } from './text.js';

const n = (s) => String(s ?? '').trim();
const low = (s) => n(s).toLowerCase();
const DEFAULT_PRIV = /\b(admin|administrator|full ?access|owner|super ?user|root|superadmin|global admin|finance approver|payments?|treasury|security admin)\b/i;
const SHARED = /^(admin|administrator|shared|generic|test|temp|service|info|accounts?|ops)[@._-]/i;
// The same idea in the other eight languages, matched on folded text (lowercase, no
// accents). Latin words need word edges; Japanese, Chinese and Korean words do not have them.
const PRIV_LATIN = /\b(administrator|admin|vollzugriff|superuser|zahlungen|zahlungsfreigabe|administrateur|acces complet|controle total|proprietaire|paiements|tresorerie|administrador|acceso total|control total|propietario|pagos|tesoreria|acesso total|proprietario|pagamentos|tesouraria|amministratore|accesso completo|controllo completo|pagamenti|tesoreria)\b/;
const PRIV_CJK = /(管理者|特権|全権限|フルアクセス|スーパーユーザー|所有者|オーナー|支払|管理员|超级管理员|完全访问|完全控制|所有者|付款|支付审批|管理員|超級管理員|관리자|최고 관리자|전체 접근|전체 권한|소유자|지급|자금)/;
const privIntl = (role) => { const f = foldText(role); return !!f && (PRIV_LATIN.test(f) || PRIV_CJK.test(f)); };

// Account and HR status words from exports in the nine report languages, folded
// (lowercase, no accents). Anything not listed keeps its own value.
const STATUS_WORDS = [
  ['deleted', /^(deleted|removed|geloscht|entfernt|supprime|eliminado|borrado|excluido|removido|eliminato|cancellato|rimosso|削除|削除済|削除済み|已删除|删除|已刪除|刪除|삭제|삭제됨)$/],
  ['disabled', /^(disabled|suspended|locked|blocked|deaktiviert|gesperrt|desactive|suspendu|bloque|desactivado|deshabilitado|suspendido|bloqueado|desativado|suspenso|disattivato|disabilitato|sospeso|bloccato|無効|停止|利用停止|停止中|ロック|禁用|已禁用|停用|已停用|冻结|凍結|비활성|비활성화|정지|사용 중지|사용중지|잠김)$/],
  ['inactive', /^(inactive|inaktiv|inactif|inactivo|inativo|inattivo|休止|休止中|非アクティブ|未激活|非活动|非活動|휴면)$/],
  ['active', /^(active|aktiv|actif|activo|ativo|attivo|有効|在職|在籍|启用|在职|已启用|활성|재직)$/],
];
export function statusWord(v) {
  const f = foldText(v);
  if (!f) return '';
  for (const [code, re] of STATUS_WORDS) if (re.test(f)) return code;
  return low(v);
}
// A leaver in an HR roster, in any of the nine languages.
const LEAVER = /terminat|left|inactive|leaver|ausgeschieden|gekundigt|ausgetreten|parti|sorti|depart|licencie|demission|baja|cesad|despedid|desligad|demitid|cessat|dimess|licenziat|退職|退社|離職|离职|퇴사|퇴직/;
// "No" in an MFA column, in any of the nine languages (the core reader also maps these to "no").
const MFA_OFF = /^(no|false|0|off|disabled|nein|aus|deaktiviert|non|desactive|nao|desactivado|desativado|disattivato|いいえ|無効|なし|×|否|无|無|未启用|关闭|停用|아니요|아니오|미사용|비활성)$/;

function colKey(row, names) {
  const keys = Object.keys(row);
  for (const want of names) { const k = keys.find((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '') === want); if (k) return k; }
  return null;
}
function col(row, names) { const k = colKey(row, names); return k ? row[k] : ''; }
const LOGIN_COLS = ['lastlogin', 'lastlogon', 'lastused', 'lastactive', 'lastseen'];
const ROTATION_COLS = ['lastrotated', 'credentialrotated', 'keyrotated', 'rotatedat', 'lastrotation', 'secretrotated', 'credentiallastrotated'];

export function normalizeAccess(rows) {
  return rows.map((r, i) => ({
    row: i + 2,
    system: n(col(r, ['system', 'app', 'application', 'tool'])),
    user: n(col(r, ['user', 'username', 'name', 'account', 'login'])),
    email: low(col(r, ['email', 'mail', 'useremail'])),
    account_type: low(col(r, ['accounttype', 'type', 'kind'])) || 'human',
    role: n(col(r, ['role', 'roles', 'permission', 'permissions', 'group', 'access'])),
    owner: n(col(r, ['owner', 'manager', 'accountowner', 'sponsor'])),
    // null when the export has no last-login column at all (staleness then cannot be checked).
    last_login: colKey(r, LOGIN_COLS) ? n(col(r, LOGIN_COLS)) : null,
    status: statusWord(col(r, ['status', 'state'])) || 'active',
    mfa: low(col(r, ['mfa', '2fa', 'mfaenabled', 'twofactor'])),
    // null when the export has no rotation column at all (rotation then cannot be checked).
    last_rotated: colKey(r, ROTATION_COLS) ? n(col(r, ROTATION_COLS)) : null,
  }));
}

export function normalizeRoster(rows) {
  const m = new Map();
  for (const r of rows) {
    const email = low(col(r, ['email', 'mail', 'workemail']));
    if (email) m.set(email, { status: statusWord(col(r, ['status', 'employmentstatus', 'state'])) || 'active', termination_date: n(col(r, ['terminationdate', 'enddate', 'leftdate'])), manager: n(col(r, ['manager'])) });
  }
  return m;
}

function days(from, to) {
  const a = Date.parse(from), b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.floor((b - a) / 86400000) : null;
}
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-word match for Latin-script roles ("Admin" is not inside "Badminton"), but a
// plain substring match next to Japanese, Chinese or Korean text, which has no spaces
// ("経理管理者" holds "管理者"). \b alone never matches next to those characters.
const EDGE = 'A-Za-z0-9\\u00C0-\\u024F';
const roleRe = (list) => new RegExp(`(?<![${EDGE}])(${list.map(reEsc).join('|')})(?![${EDGE}])`, 'iu');
/**
 * Privileged-role matcher: the base list (built-in, or the policy file's or argument's
 * privileged_roles) plus any roles learned and accepted in Ladon's memory. Learned
 * roles only add to the list; they never remove a built-in or policy role.
 */
export function privMatcher(opts = {}) {
  const base = opts.privileged_roles && opts.privileged_roles.length ? roleRe(opts.privileged_roles) : { test: (s) => DEFAULT_PRIV.test(s) || privIntl(s) };
  const extra = (opts.extra_privileged_roles || []).map(n).filter(Boolean);
  if (!extra.length) return { test: (s) => base.test(s), learned: () => false };
  const ex = roleRe(extra);
  return { test: (s) => base.test(s) || ex.test(s), learned: (s) => !base.test(s) && ex.test(s) };
}
const NON_HUMAN = ['agent', 'service', 'bot'];
export const isNonHuman = (r) => NON_HUMAN.includes(r.account_type);
export function addDays(isoDate, d) { const t = Date.parse(isoDate + 'T00:00:00Z'); return Number.isFinite(t) ? new Date(t + d * 86400000).toISOString().slice(0, 10) : ''; }

/** Merge a policy file (already schema-checked) with call arguments. Arguments win. */
export function effectiveOptions(policy = {}, args = {}) {
  const o = { ...policy };
  for (const k of ['as_of', 'stale_days', 'privileged_roles', 'due_days', 'rotation_max_days']) if (args[k] !== undefined) o[k] = args[k];
  return o;
}

/**
 * Segregation-of-duties check: one person (by email, else user name) holding a role
 * matching roles_a and a role matching roles_b, in any systems.
 */
export function sodConflicts(rows, rules = []) {
  const out = [];
  if (!rules.length) return out;
  const byPerson = new Map();
  for (const r of rows) { const k = r.email || low(r.user); if (!k) continue; if (!byPerson.has(k)) byPerson.set(k, []); byPerson.get(k).push(r); }
  for (const rule of rules) {
    const A = roleRe(rule.roles_a), B = roleRe(rule.roles_b);
    for (const [person, list] of byPerson) {
      const a = list.filter((r) => A.test(r.role)), b = list.filter((r) => B.test(r.role));
      if (!a.length || !b.length) continue;
      if (a.length === 1 && b.length === 1 && a[0] === b[0] && !rule.same_role_counts) continue;
      out.push({ rule: rule.name, person, rows: [...new Set([...a, ...b].map((r) => r.row))].sort((x, y) => x - y), detail: `${a.map((r) => `${r.system}: ${r.role}`).join(', ')} + ${b.map((r) => `${r.system}: ${r.role}`).join(', ')}` });
    }
  }
  return out;
}

/** Flag access rows for a human reviewer. Suggestions only; nothing is revoked here. */
export function reviewAccess(rows, roster, opts = {}) {
  const asOf = opts.as_of || new Date().toISOString().slice(0, 10);
  const stale = Number(opts.stale_days ?? 90);
  const rotationMax = Number(opts.rotation_max_days ?? 90);
  const dueDays = Number(opts.due_days ?? 14);
  const priv = privMatcher(opts);
  const rotationKnown = rows.some((r) => r.last_rotated !== null && r.last_rotated !== undefined);
  const delegations = (opts.delegations || []).map((d) => ({ from: low(d.from), to: n(d.to), reason: n(d.reason) }));
  const active = rows.filter((r) => r.status !== 'disabled' && r.status !== 'inactive' && r.status !== 'deleted');
  const sod = sodConflicts(active, opts.sod_rules || []);
  const sodByRow = new Map();
  for (const c of sod) for (const row of c.rows) { if (!sodByRow.has(row)) sodByRow.set(row, []); sodByRow.get(row).push(c.rule); }
  const seen = new Map();
  const items = active.map((r) => {
    const flags = []; let score = 0;
    const isPriv = priv.test(r.role);
    const nonHuman = isNonHuman(r);
    const hr = !nonHuman && roster && r.email ? roster.get(r.email) : null;
    if (isPriv) { flags.push('privileged_role'); score += 20; }
    if (!nonHuman && roster) {
      if (!hr) { flags.push('not_in_hr_roster'); score += 30; }
      else if (LEAVER.test(foldText(hr.status))) { flags.push('terminated_in_hr'); score += 60; }
    }
    if (nonHuman && !r.owner) { flags.push('non_human_without_owner'); score += 40; }
    if (nonHuman && rotationKnown) {
      if (!r.last_rotated || /^never$/i.test(r.last_rotated)) { flags.push('non_human_without_rotation_date'); score += 20; }
      else { const d = days(r.last_rotated, asOf); if (d === null) { flags.push('rotation_date_unreadable'); score += 10; } else if (d > rotationMax) { flags.push(`credential_not_rotated_${d}_days`); score += 20; } }
    }
    if (r.last_login === null) flags.push('last_login_not_in_export');
    else if (!r.last_login || /^never$/i.test(r.last_login)) { flags.push('never_logged_in'); score += 15; }
    else { const d = days(r.last_login, asOf); if (d === null) { flags.push('last_login_unreadable'); score += 5; } else if (d > stale) { flags.push(`stale_${d}_days`); score += 20; } }
    if (isPriv && r.mfa && MFA_OFF.test(foldText(r.mfa))) { flags.push('privileged_without_mfa'); score += 30; }
    if (SHARED.test(r.email || r.user)) { flags.push('shared_or_generic_account'); score += 15; }
    for (const rule of sodByRow.get(r.row) || []) { flags.push(`sod_conflict:${rule}`); score += 30; }
    const key = `${low(r.system)}|${r.email || low(r.user)}`;
    if (seen.has(key)) { flags.push(`duplicate_of_row_${seen.get(key)}`); score += 10; } else seen.set(key, r.row);
    const risk = score >= 60 ? 'high' : score >= 30 ? 'medium' : score > 0 ? 'low' : 'none';
    const suggested = flags.some((f) => f === 'terminated_in_hr') ? 'revoke candidate' : risk === 'high' || risk === 'medium' ? 'review closely' : 'confirm or keep';
    // Reviewer: the account owner, else the person's manager from the HR roster.
    const assigned = r.owner || (hr && hr.manager) || '';
    const del = assigned ? delegations.find((d) => d.from === low(assigned)) : null;
    // High-risk lines are due in half the time.
    const due = addDays(asOf, risk === 'high' ? Math.max(1, Math.ceil(dueDays / 2)) : dueDays);
    const learnedPriv = isPriv && priv.learned(r.role);
    const reasons = flags.map((f) => (f === 'privileged_role' && learnedPriv ? FLAG_TEXT.privileged_role_learned : explainFlag(f)));
    return { ...r, risk, score: Math.min(100, score), flags, reasons, suggested_action: suggested, assigned_reviewer: assigned, delegated_to: del ? del.to : '', delegation_reason: del ? del.reason : '', due_date: due, ...(learnedPriv ? { privileged_by: 'learned role (Ladon memory)' } : {}) };
  });
  items.sort((a, b) => b.score - a.score || a.system.localeCompare(b.system) || a.row - b.row);
  const count = (k) => items.filter((i) => i.risk === k).length;
  return {
    as_of: asOf, stale_days: stale, due_days: dueDays, accounts: items.length, skipped_disabled: rows.length - items.length,
    by_risk: { high: count('high'), medium: count('medium'), low: count('low'), none: count('none') },
    agents_and_services: items.filter(isNonHuman).length,
    rotation_checked: rotationKnown, rotation_max_days: rotationMax,
    sod_conflicts: sod, unassigned_reviewer: items.filter((i) => !i.assigned_reviewer && !i.delegated_to).length,
    roster_checked: !!roster, items,
    note: 'Suggestions only. A named reviewer decides keep / modify / revoke for every line.' + (rotationKnown ? '' : ' No credential-rotation column in the export, so rotation was not checked.'),
  };
}

const FLAG_TEXT = {
  privileged_role: 'Role looks privileged (admin, full access, payments…).',
  privileged_role_learned: 'Role is privileged for this customer (a fact a person accepted in Ladon\'s memory).',
  not_in_hr_roster: 'Email not found in the HR roster.',
  terminated_in_hr: 'Person is marked as a leaver in the HR roster.',
  non_human_without_owner: 'Agent or service account with no named owner.',
  non_human_without_rotation_date: 'Agent or service account with no credential rotation date.',
  rotation_date_unreadable: 'Credential rotation date could not be read.',
  never_logged_in: 'Account has never been used.',
  last_login_unreadable: 'Last login date could not be read.',
  last_login_not_in_export: 'This export has no last-login column, so stale and never-used accounts could not be checked.',
  privileged_without_mfa: 'Privileged account without MFA.',
  shared_or_generic_account: 'Looks like a shared or generic account.',
};
/** Plain-language reason for a flag code. Pass a translator (ladonText(lang)) for another language. */
export function explainFlag(f, t = null) {
  if (FLAG_TEXT[f]) return t ? t(`fl_${f}`) : FLAG_TEXT[f];
  let m;
  if ((m = /^stale_(\d+)_days$/.exec(f))) return t ? t('fl_stale', { days: m[1] }) : `No login for ${m[1]} days.`;
  if ((m = /^credential_not_rotated_(\d+)_days$/.exec(f))) return t ? t('fl_not_rotated', { days: m[1] }) : `Credential not rotated for ${m[1]} days.`;
  if ((m = /^sod_conflict:(.+)$/.exec(f))) return t ? t('fl_sod', { rule: m[1] }) : `Segregation-of-duties rule "${m[1]}": the same person holds both sides.`;
  if ((m = /^duplicate_of_row_(\d+)$/.exec(f))) return t ? t('fl_dup', { row: m[1] }) : `Same system and person as row ${m[1]}.`;
  return f;
}

export const SHEET_COLUMNS = ['system', 'user', 'email', 'account_type', 'role', 'owner', 'last_login', 'last_rotated', 'risk', 'flags', 'suggested_action', 'assigned_reviewer', 'delegated_to', 'due_date', 'reviewer_decision', 'reviewer_name', 'review_date', 'notes'];

export function sheetCsv(review) {
  return toCsv(review.items.map((i) => ({ ...i, last_rotated: i.last_rotated ?? '', flags: i.flags.join('; '), reviewer_decision: '', reviewer_name: '', review_date: '', notes: i.delegated_to ? `Delegated by ${i.assigned_reviewer}${i.delegation_reason ? ': ' + i.delegation_reason : ''}` : '' })), SHEET_COLUMNS);
}

/**
 * recertification-summary.md. `lang` picks the language of the prose (en, de, fr, es,
 * pt, it, ja, zh, ko); column names, codes and the CSV stay in English.
 */
export function summaryMarkdown(review, generatedAt, lang = 'en') {
  const t = ladonText(lang); const en = !lang || lang === 'en';
  const reasons = (i) => (en ? i.reasons : i.flags.map((f) => (f === 'privileged_role' && i.privileged_by ? t('fl_privileged_role_learned') : explainFlag(f, t))));
  const L = [`# ${t('title')}`, '', t('generated', { at: generatedAt, as_of: review.as_of, stale: review.stale_days, due: review.due_days }), ''];
  if (!en) L.push(`_${t('translation_note')}_`, '');
  L.push(
    `- ${t('accounts_line', { n: review.accounts, skipped: review.skipped_disabled })}`,
    `- ${t('risk_line', review.by_risk)}`,
    `- ${t('agents_line', { n: review.agents_and_services, rotation: review.rotation_checked ? t('rotation_checked', { days: review.rotation_max_days }) : t('rotation_not') })}`,
    `- ${t('roster_line', { v: review.roster_checked ? t('roster_yes') : t('roster_no') })}`,
    `- ${t('sod_line', { n: review.sod_conflicts.length })}`,
    `- ${t('unassigned_line', { n: review.unassigned_reviewer })}`, '');
  L.push(`## ${t('how_title')}`, '', t('how_body'), '');
  L.push(`## ${t('highest')}`, '', `| ${t('th_system')} | ${t('th_user')} | ${t('th_role')} | ${t('th_risk')} | ${t('th_due')} | ${t('th_why')} |`, '|---|---|---|---|---|---|');
  for (const i of review.items.filter((x) => x.risk === 'high' || x.risk === 'medium').slice(0, 50)) L.push(`| ${i.system} | ${i.user || i.email} | ${i.role} | ${t(`risk_${i.risk}`)} | ${i.due_date} | ${reasons(i).join(' ')} |`);
  if (review.sod_conflicts.length) { L.push('', `## ${t('sod_title')}`, ''); for (const c of review.sod_conflicts) L.push(`- **${c.rule}** — ${c.person}: ${c.detail}`); }
  if (review.memory && (review.memory.used.length || review.memory.skipped.length)) {
    L.push('', `## ${t('mem_title')}`, '', t('mem_intro'), '');
    for (const f of review.memory.used) L.push(`- \`${f.id}\` ${f.kind}: ${memoryText(f, t)} (${t('accepted_by', { who: f.accepted_by })})`);
    for (const f of review.memory.skipped) L.push(`- \`${f.id}\` ${f.kind}: ${t('not_used', { why: en || !f.why_code ? f.why : t(`why_${f.why_code}`, f.why_params || {}) })}`);
  }
  L.push('', t('closing'), '');
  return L.join('\n');
}

const memoryText = (f, t) => (f.kind === 'privileged_role' ? t('mem_priv', { role: f.value.role }) : f.kind === 'sod_rule' ? t('mem_sod', { name: f.value.name, a: f.value.roles_a.join(', '), b: f.value.roles_b.join(', ') }) : f.kind === 'delegation' ? t('mem_del', { from: f.value.from, to: f.value.to }) : JSON.stringify(f.value));

const DECISIONS = ['keep', 'modify', 'revoke'];

/**
 * Read a filled recertification sheet and report progress: open, overdue, signed,
 * incomplete sign-offs, self-reviews, signed by someone other than the assigned or
 * delegated reviewer, and a chase list per reviewer.
 */
export function campaignStatus(rows, { as_of } = {}) {
  const asOf = as_of || new Date().toISOString().slice(0, 10);
  const lines = rows.map((r, i) => {
    const g = (k) => n(r[k]);
    const decision = low(r.reviewer_decision);
    const reviewer = g('delegated_to') || g('assigned_reviewer');
    const issues = []; const codes = [];
    const issue = (text, code, params = {}) => { issues.push(text); codes.push({ code, params }); };
    let state;
    if (!decision) {
      const d = g('due_date') ? days(g('due_date'), asOf) : null;
      state = d !== null && d > 0 ? 'overdue' : 'open';
      if (state === 'overdue') issue(`overdue by ${d} day(s) (due ${g('due_date')})`, 'overdue', { days: d, due: g('due_date') });
      if (!g('due_date')) issue('no due date', 'no_due');
    } else if (!DECISIONS.includes(decision)) { state = 'invalid'; issue(`decision "${r.reviewer_decision}" is not keep, modify or revoke`, 'bad_decision', { d: r.reviewer_decision }); }
    else {
      state = 'decided';
      if (!g('reviewer_name')) issue('decision has no reviewer_name', 'no_name');
      if (!g('review_date')) issue('decision has no review_date', 'no_date');
      else if (g('due_date') && days(g('due_date'), g('review_date')) > 0) issue(`signed after the due date (${g('review_date')} > ${g('due_date')})`, 'late', { date: g('review_date'), due: g('due_date') });
      const who = low(g('reviewer_name'));
      const local = low(g('email')).split('@')[0].replace(/[._-]+/g, ' ');
      if (who && (who === low(g('user')) || (local && who.replace(/\s*\(.*\)$/, '') === local))) issue('self-review: the reviewer is the account holder', 'self');
      if (who && reviewer && who !== low(reviewer) && who !== low(g('assigned_reviewer'))) issue(`signed by ${g('reviewer_name')}, not the assigned reviewer (${reviewer})`, 'wrong_signer', { name: g('reviewer_name'), reviewer });
      if (issues.length) state = 'incomplete';
    }
    return { line: i + 2, system: g('system'), user: g('user') || g('email'), risk: low(r.risk), reviewer: reviewer || '(unassigned)', delegated: !!g('delegated_to'), due_date: g('due_date'), decision: decision || '', state, issues, issue_codes: codes };
  });
  const by = (s) => lines.filter((l) => l.state === s).length;
  const reviewers = new Map();
  for (const l of lines) {
    if (!reviewers.has(l.reviewer)) reviewers.set(l.reviewer, { reviewer: l.reviewer, total: 0, decided: 0, open: 0, overdue: 0, needs_fix: 0, delegated: 0 });
    const s = reviewers.get(l.reviewer); s.total++;
    if (l.delegated) s.delegated++;
    if (l.state === 'decided') s.decided++; else if (l.state === 'overdue') s.overdue++; else if (l.state === 'open') s.open++; else s.needs_fix++;
  }
  const decided = by('decided');
  return {
    as_of: asOf, lines: lines.length, decided, open: by('open'), overdue: by('overdue'), incomplete: by('incomplete'), invalid: by('invalid'),
    percent_complete: lines.length ? Math.round((decided / lines.length) * 1000) / 10 : 0,
    decisions: { keep: lines.filter((l) => l.decision === 'keep').length, modify: lines.filter((l) => l.decision === 'modify').length, revoke: lines.filter((l) => l.decision === 'revoke').length },
    revocations_to_request: lines.filter((l) => l.decision === 'revoke' && l.state === 'decided').map((l) => ({ line: l.line, system: l.system, user: l.user })),
    chase_list: [...reviewers.values()].filter((r) => r.open + r.overdue + r.needs_fix > 0).sort((a, b) => b.overdue - a.overdue || b.open + b.needs_fix - (a.open + a.needs_fix) || a.reviewer.localeCompare(b.reviewer)),
    reviewers: [...reviewers.values()].sort((a, b) => a.reviewer.localeCompare(b.reviewer)),
    exceptions: lines.filter((l) => l.state !== 'decided'),
    note: 'Reads what the sheet says. Revocations still go through ladon_request_revocation (one named human click each).',
  };
}

/** Compare two access exports (previous and current period). Keyed by system + email (or user). */
export function accessDiff(prevRows, curRows, opts = {}) {
  const priv = privMatcher(opts);
  const live = (r) => !['disabled', 'inactive', 'deleted'].includes(r.status);
  const key = (r) => `${low(r.system)}|${r.email || low(r.user)}`;
  const P = new Map(), C = new Map();
  for (const r of prevRows) if (!P.has(key(r))) P.set(key(r), r);
  for (const r of curRows) if (!C.has(key(r))) C.set(key(r), r);
  const brief = (r) => ({ system: r.system, user: r.user || r.email, email: r.email, account_type: r.account_type, role: r.role, status: r.status });
  const added = [], removed = [], role_changed = [], privilege_gained = [], reactivated = [], deactivated = [], owner_changed = [];
  for (const [k, c] of C) {
    const p = P.get(k);
    if (!p) { if (live(c)) added.push({ ...brief(c), privileged: priv.test(c.role), non_human: isNonHuman(c) }); continue; }
    if (!live(p) && live(c)) reactivated.push(brief(c));
    if (live(p) && !live(c)) deactivated.push(brief(c));
    if (low(p.role) !== low(c.role)) {
      role_changed.push({ ...brief(c), from: p.role, to: c.role });
      if (!priv.test(p.role) && priv.test(c.role)) privilege_gained.push({ ...brief(c), from: p.role, to: c.role });
    }
    if (isNonHuman(c) && low(p.owner) !== low(c.owner)) owner_changed.push({ ...brief(c), from: p.owner, to: c.owner });
  }
  for (const [k, p] of P) if (!C.has(k) && live(p)) removed.push(brief(p));
  const newPriv = added.filter((a) => a.privileged);
  return {
    previous: prevRows.length, current: curRows.length,
    counts: { added: added.length, removed: removed.length, role_changed: role_changed.length, privilege_gained: privilege_gained.length + newPriv.length, reactivated: reactivated.length, deactivated: deactivated.length, new_non_human: added.filter((a) => a.non_human).length, owner_changed: owner_changed.length },
    added, removed, role_changed, privilege_gained: [...privilege_gained, ...newPriv.map((a) => ({ ...a, from: '(new account)', to: a.role }))], reactivated, deactivated, owner_changed,
    review_first: [...privilege_gained.map((x) => `${x.system}: ${x.user} gained ${x.to}`), ...newPriv.map((x) => `${x.system}: new privileged account ${x.user} (${x.role})`), ...reactivated.map((x) => `${x.system}: ${x.user} was reactivated`), ...added.filter((a) => a.non_human && !a.privileged).map((x) => `${x.system}: new ${x.account_type} ${x.user}`)],
    note: 'Changes between two exports. A change is not wrong by itself; the reviewer decides.',
  };
}

/**
 * Evidence pack for a recertification campaign: a JSON record (with the sha256 of the
 * sheet it was built from) and a self-contained HTML page. Deterministic: no clock time,
 * only the as_of date, so the same sheet always gives the same hash.
 */
export function evidencePack(status, { sheet_sha256, sheet_path, campaign, lang = 'en' }) {
  const record = {
    kind: 'ladon-recertification-evidence', campaign: campaign || 'access recertification', as_of: status.as_of,
    sheet: { path: sheet_path, sha256: sheet_sha256 },
    totals: { lines: status.lines, decided: status.decided, open: status.open, overdue: status.overdue, incomplete: status.incomplete, invalid: status.invalid, percent_complete: status.percent_complete },
    decisions: status.decisions, revocations_to_request: status.revocations_to_request,
    reviewers: status.reviewers, exceptions: status.exceptions.map((e) => ({ line: e.line, system: e.system, user: e.user, state: e.state, issues: e.issues })),
    complete: status.lines > 0 && status.decided === status.lines,
    note: 'Records what the sheet says on the as_of date. It does not prove that the reviews took place or that access is appropriate, and it is not an audit opinion.',
  };
  const json = JSON.stringify(record, null, 2) + '\n';
  // The page is in `lang`; the record above (and so its hash) is the same in every language.
  const t = ladonText(lang); const en = !lang || lang === 'en';
  const name = campaign || (en ? record.campaign : t('title'));
  const state = (s) => (en ? s : t(`st_${s}`));
  const byLine = new Map(status.exceptions.map((e) => [e.line, e]));
  const issues = (e) => (en || !byLine.get(e.line)?.issue_codes ? e.issues : byLine.get(e.line).issue_codes.map((c) => t(`is_${c.code}`, c.params)));
  const tr = (cells, th) => `<tr>${cells.map((c) => `<${th ? 'th' : 'td'}>${escapeHtml(c)}</${th ? 'th' : 'td'}>`).join('')}</tr>`;
  const body = [
    `<h1>${escapeHtml(name)}</h1>`,
    `<p class="mut">${escapeHtml(t('ev_as_of', { date: record.as_of }))} · ${escapeHtml(t('ev_sheet'))} <code>${escapeHtml(sheet_path)}</code> · sha256 <code>${escapeHtml(sheet_sha256)}</code></p>`,
    ...(en ? [] : [`<p class="mut"><em>${escapeHtml(t('translation_note'))}</em></p>`]),
    `<div class="tiles"><div class="tile">${t('ev_lines')}<b>${status.lines}</b></div><div class="tile">${t('ev_decided')}<b class="ok">${status.decided}</b></div><div class="tile">${t('ev_overdue')}<b class="bad">${status.overdue}</b></div><div class="tile">${t('ev_open')}<b>${status.open}</b></div><div class="tile">${t('ev_needs_fixing')}<b class="warn">${status.incomplete + status.invalid}</b></div><div class="tile">${t('ev_complete')}<b>${status.percent_complete}%</b></div></div>`,
    `<h2>${t('ev_decisions')}</h2><p>keep ${status.decisions.keep} · modify ${status.decisions.modify} · revoke ${status.decisions.revoke}</p>`,
    `<h2>${t('ev_reviewers')}</h2><div class="wrap"><table>${tr([t('ev_reviewer'), t('ev_lines'), t('ev_decided'), t('ev_open'), t('ev_overdue'), t('ev_needs_fixing'), t('ev_delegated')], true)}${status.reviewers.map((r) => tr([r.reviewer, r.total, r.decided, r.open, r.overdue, r.needs_fix, r.delegated])).join('')}</table></div>`,
    `<h2>${t('ev_exceptions')}</h2>${record.exceptions.length ? `<div class="wrap"><table>${tr([t('ev_line'), t('th_system'), t('th_user'), t('ev_state'), t('ev_issues')], true)}${record.exceptions.map((e) => tr([e.line, e.system, e.user, state(e.state), issues(e).join('; ')])).join('')}</table></div>` : `<p class="ok">${t('ev_none')}</p>`}`,
    `<h2>${t('ev_revocations')}</h2>${status.revocations_to_request.length ? `<ul>${status.revocations_to_request.map((r) => `<li>${escapeHtml(r.system)}: ${escapeHtml(r.user)} (${escapeHtml(t('ev_rev_line', { n: r.line }))})</li>`).join('')}</ul><p class="mut">${escapeHtml(t('ev_each_click'))}</p>` : `<p>${t('ev_none')}</p>`}`,
    `<p class="mut">${escapeHtml(en ? record.note : t('ev_note'))}</p>`,
  ].join('\n');
  const html = htmlPage({ title: t('ev_title', { campaign: name }), bodyHtml: body, footer: `ladon-of-access · evidence sha256 ${sha256(canonical(record))}`, lang });
  return { record, json, html, record_sha256: sha256(canonical(record)) };
}
