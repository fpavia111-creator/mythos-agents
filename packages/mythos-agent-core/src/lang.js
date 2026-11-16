// Language of the text people read: reports, the approvals page and the
// command-line messages around them. Tool results, codes, JSON keys and the
// audit log stay in English so scripts and audits read the same everywhere;
// the model that calls the tools answers the user in their own language.
//
// Translations are written by Claude and marked for review by a native
// speaker. A missing string falls back to English, never to a blank.

export const LANGS = ['en', 'de', 'fr', 'es', 'pt', 'it', 'ja', 'zh', 'ko'];
export const LANG_NAMES = { en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', pt: 'Português (Brasil)', it: 'Italiano', ja: '日本語', zh: '简体中文', ko: '한국어' };
export const HTML_LANG = { en: 'en', de: 'de', fr: 'fr', es: 'es', pt: 'pt-BR', it: 'it', ja: 'ja', zh: 'zh-Hans', ko: 'ko' };

/** 'de-AT' -> 'de', 'pt-BR' -> 'pt', 'zh-Hans-CN' -> 'zh', anything unknown -> 'en'. */
export function normLang(x) {
  const s = String(x ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!s) return 'en';
  const base = s.split('-')[0].split('.')[0];
  return LANGS.includes(base) ? base : 'en';
}

/** True when x names a language we have text for (before falling back to English). */
export const isLang = (x) => LANGS.includes(String(x ?? '').trim().toLowerCase().replace(/_/g, '-').split('-')[0]);

/**
 * A text function for one language over a catalog { key: { en, de, ... } }.
 * t(key, vars) fills {name} placeholders; an unknown key is returned as is.
 */
export function makeText(catalog, lang) {
  const l = normLang(lang);
  return (key, vars = {}) => {
    const e = catalog[key];
    const s = e ? (e[l] ?? e.en) : key;
    return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
  };
}

/** Merge catalogs (later wins). */
export const mergeCatalogs = (...cs) => Object.assign({}, ...cs);

// ---------------------------------------------------------------------------
// The approvals page and the one-click categories
// ---------------------------------------------------------------------------

export const CORE_TEXT = {
  approvals_title: { en: 'Mythos approvals', de: 'Mythos-Freigaben', fr: 'Approbations Mythos', es: 'Aprobaciones de Mythos', pt: 'Aprovações do Mythos', it: 'Approvazioni Mythos', ja: 'Mythos 承認', zh: 'Mythos 审批', ko: 'Mythos 승인' },
  state_folder: {
    en: 'State folder: {dir}. Approvals are single-use and expire {hours} h after you approve.',
    de: 'Statusordner: {dir}. Eine Freigabe gilt genau einmal und läuft {hours} Std. nach der Freigabe ab.',
    fr: 'Dossier d’état : {dir}. Une approbation ne sert qu’une fois et expire {hours} h après avoir été donnée.',
    es: 'Carpeta de estado: {dir}. Cada aprobación sirve una sola vez y caduca {hours} h después de darla.',
    pt: 'Pasta de estado: {dir}. Cada aprovação vale uma única vez e expira {hours} h depois de concedida.',
    it: 'Cartella di stato: {dir}. Ogni approvazione vale una sola volta e scade {hours} ore dopo essere stata data.',
    ja: '状態フォルダー: {dir}。承認は1回限り有効で、承認から {hours} 時間で失効します。',
    zh: '状态文件夹：{dir}。每次审批只能使用一次，批准后 {hours} 小时失效。',
    ko: '상태 폴더: {dir}. 승인은 한 번만 쓸 수 있으며 승인 후 {hours}시간이 지나면 만료됩니다.',
  },
  no_pending: { en: 'No pending approvals.', de: 'Keine offenen Freigaben.', fr: 'Aucune approbation en attente.', es: 'No hay aprobaciones pendientes.', pt: 'Nenhuma aprovação pendente.', it: 'Nessuna approvazione in attesa.', ja: '保留中の承認はありません。', zh: '没有待审批的请求。', ko: '대기 중인 승인이 없습니다.' },
  one_click: { en: 'one-click', de: 'Ein-Klick-Aktion', fr: 'action en un clic', es: 'acción de un clic', pt: 'ação de um clique', it: 'azione con un clic', ja: 'ワンクリック操作', zh: '一键操作', ko: '원클릭 작업' },
  one_click_note: {
    en: 'A one-click action is always approved by a named person and is never allowed on Auto.',
    de: 'Eine Ein-Klick-Aktion gibt immer eine namentlich genannte Person frei; sie läuft nie automatisch.',
    fr: 'Une action en un clic est toujours approuvée par une personne nommée et ne passe jamais en automatique.',
    es: 'Una acción de un clic siempre la aprueba una persona con nombre y nunca se permite en automático.',
    pt: 'Uma ação de um clique é sempre aprovada por uma pessoa identificada e nunca roda no automático.',
    it: 'Un’azione con un clic è sempre approvata da una persona con nome e non è mai consentita in automatico.',
    ja: 'ワンクリック操作は必ず氏名のある担当者が承認し、自動実行は許可されません。',
    zh: '一键操作必须由署名的人员批准，绝不允许自动执行。',
    ko: '원클릭 작업은 항상 이름이 확인된 사람이 승인하며 자동 실행은 허용되지 않습니다.',
  },
  requested: { en: 'Requested {ts}', de: 'Angefragt {ts}', fr: 'Demandé le {ts}', es: 'Solicitado el {ts}', pt: 'Solicitado em {ts}', it: 'Richiesto il {ts}', ja: '依頼日時 {ts}', zh: '请求时间 {ts}', ko: '요청 시각 {ts}' },
  approving: { en: 'What you are approving', de: 'Was Sie freigeben', fr: 'Ce que vous approuvez', es: 'Lo que está aprobando', pt: 'O que você está aprovando', it: 'Che cosa state approvando', ja: '承認する内容', zh: '您要批准的内容', ko: '승인하는 내용' },
  arguments: { en: 'Arguments', de: 'Argumente', fr: 'Arguments', es: 'Argumentos', pt: 'Argumentos', it: 'Argomenti', ja: '引数', zh: '参数', ko: '인수' },
  your_name: { en: 'Your name', de: 'Ihr Name', fr: 'Votre nom', es: 'Su nombre', pt: 'Seu nome', it: 'Il vostro nome', ja: 'お名前', zh: '您的姓名', ko: '이름' },
  note: { en: 'Note', de: 'Notiz', fr: 'Note', es: 'Nota', pt: 'Observação', it: 'Nota', ja: 'メモ', zh: '备注', ko: '메모' },
  approve_once: { en: 'Approve once', de: 'Einmal freigeben', fr: 'Approuver une fois', es: 'Aprobar una vez', pt: 'Aprovar uma vez', it: 'Approva una volta', ja: '1回だけ承認', zh: '批准一次', ko: '한 번 승인' },
  reject: { en: 'Reject', de: 'Ablehnen', fr: 'Refuser', es: 'Rechazar', pt: 'Rejeitar', it: 'Rifiuta', ja: '却下', zh: '拒绝', ko: '거부' },
  page_footer: {
    en: 'Local page. No scripts, no trackers, nothing leaves this machine.',
    de: 'Lokale Seite. Keine Skripte, keine Tracker, nichts verlässt diesen Rechner.',
    fr: 'Page locale. Aucun script, aucun traceur, rien ne quitte cette machine.',
    es: 'Página local. Sin scripts, sin rastreadores, nada sale de este equipo.',
    pt: 'Página local. Sem scripts, sem rastreadores, nada sai desta máquina.',
    it: 'Pagina locale. Nessuno script, nessun tracker, niente lascia questo computer.',
    ja: 'ローカルページです。スクリプトもトラッカーもなく、このマシンの外には何も送られません。',
    zh: '本地页面。没有脚本，没有跟踪器，任何内容都不会离开这台机器。',
    ko: '로컬 페이지입니다. 스크립트와 추적기가 없으며 아무것도 이 컴퓨터 밖으로 나가지 않습니다.',
  },
  approved_msg: {
    en: 'Approved {id} as {name}. The agent can now repeat the same call once.',
    de: '{id} freigegeben von {name}. Der Agent kann denselben Aufruf jetzt einmal wiederholen.',
    fr: '{id} approuvé par {name}. L’agent peut maintenant refaire le même appel une fois.',
    es: '{id} aprobado por {name}. El agente ya puede repetir la misma llamada una vez.',
    pt: '{id} aprovado por {name}. O agente agora pode repetir a mesma chamada uma vez.',
    it: '{id} approvato da {name}. L’agente ora può ripetere la stessa chiamata una volta.',
    ja: '{name} が {id} を承認しました。エージェントは同じ呼び出しを1回だけ再実行できます。',
    zh: '{name} 已批准 {id}。智能体现在可以将同一调用再执行一次。',
    ko: '{name}님이 {id}를 승인했습니다. 에이전트는 이제 같은 호출을 한 번 다시 실행할 수 있습니다.',
  },
  rejected_msg: { en: 'Rejected {id} as {name}.', de: '{id} abgelehnt von {name}.', fr: '{id} refusé par {name}.', es: '{id} rechazado por {name}.', pt: '{id} rejeitado por {name}.', it: '{id} rifiutato da {name}.', ja: '{name} が {id} を却下しました。', zh: '{name} 已拒绝 {id}。', ko: '{name}님이 {id}를 거부했습니다.' },
  unknown_decision: { en: 'Unknown decision.', de: 'Unbekannte Entscheidung.', fr: 'Décision inconnue.', es: 'Decisión desconocida.', pt: 'Decisão desconhecida.', it: 'Decisione sconosciuta.', ja: '不明な判断です。', zh: '未知的决定。', ko: '알 수 없는 결정입니다.' },
  language: { en: 'Language', de: 'Sprache', fr: 'Langue', es: 'Idioma', pt: 'Idioma', it: 'Lingua', ja: '言語', zh: '语言', ko: '언어' },
  review_note: {
    en: '',
    de: 'Übersetzt von Claude; die Prüfung durch Muttersprachler steht noch aus.',
    fr: 'Traduit par Claude ; relecture par un locuteur natif en attente.',
    es: 'Traducido por Claude; pendiente de revisión por un hablante nativo.',
    pt: 'Traduzido pelo Claude; revisão por falante nativo pendente.',
    it: 'Tradotto da Claude; revisione da parte di un madrelingua in sospeso.',
    ja: 'Claude による翻訳です。ネイティブ話者による確認はまだです。',
    zh: '由 Claude 翻译，尚待母语人士审校。',
    ko: 'Claude가 번역했으며 원어민 검토는 아직 하지 않았습니다.',
  },
  // One-click categories, as the approver reads them.
  cat_go_live: { en: 'go-live', de: 'Produktivstart', fr: 'mise en production', es: 'puesta en marcha', pt: 'entrada em produção', it: 'avvio in produzione', ja: '本番稼働', zh: '正式上线', ko: '운영 개시' },
  cat_revoke_access: { en: 'revoke access', de: 'Zugriff entziehen', fr: 'retrait d’accès', es: 'revocar acceso', pt: 'revogar acesso', it: 'revoca accesso', ja: 'アクセス取り消し', zh: '撤销访问权限', ko: '접근 권한 회수' },
  cat_delete_personal_data: { en: 'delete personal data', de: 'personenbezogene Daten löschen', fr: 'suppression de données personnelles', es: 'eliminar datos personales', pt: 'excluir dados pessoais', it: 'cancellazione dati personali', ja: '個人データの削除', zh: '删除个人数据', ko: '개인정보 삭제' },
  cat_move_money: { en: 'move money', de: 'Geld bewegen', fr: 'mouvement de fonds', es: 'mover dinero', pt: 'movimentar dinheiro', it: 'movimento di denaro', ja: '資金の移動', zh: '资金划转', ko: '자금 이동' },
  cat_binding_send: { en: 'binding send', de: 'verbindlicher Versand', fr: 'envoi engageant', es: 'envío vinculante', pt: 'envio vinculante', it: 'invio vincolante', ja: '拘束力のある送信', zh: '具约束力的发送', ko: '구속력 있는 발송' },
  cat_production_deploy: { en: 'production deploy', de: 'Produktivbereitstellung', fr: 'déploiement en production', es: 'despliegue en producción', pt: 'implantação em produção', it: 'rilascio in produzione', ja: '本番環境へのデプロイ', zh: '生产环境部署', ko: '운영 환경 배포' },
  cat_accept_learning: { en: 'accept a learned fact', de: 'gelernte Angabe übernehmen', fr: 'accepter un fait appris', es: 'aceptar un dato aprendido', pt: 'aceitar um fato aprendido', it: 'accettare un fatto appreso', ja: '学習した事実の承認', zh: '接受学到的事实', ko: '학습한 사실 승인' },
};

/** The core text function for one language. */
export const coreText = (lang) => makeText(CORE_TEXT, lang);
