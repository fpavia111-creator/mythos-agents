// Column names that exports in German, French, Spanish, Portuguese, Italian,
// Japanese, Chinese and Korean use for the fields agents read, keyed by the
// agent's own field name. adaptRecords tries these only after the agent's own
// name and its English aliases found nothing, and never for a column another
// field already took, so files that read correctly before read the same way.
//
// Written from common ERP, bank, HR and expense exports (DATEV, SAP, Sage,
// freee, Yayoi, Kingdee, Yonyou, Douzone and others). A wrong or missing word
// can always be fixed with "columns" in mythos-sources.json; the result's
// source report lists every column that was matched by a translated name.
//
// Kept out on purpose: US-only forms (W-9, W-8, TIN), US insurance terms, and
// distances in miles (a "Kilometer" column is a different unit, not a name).
// Accounting debit/credit (Soll/Haben, 借方/貸方) are listed only under the
// ledger names, because a bank statement's "debit" is the opposite side.

import { normHeader } from '../intl.js';

export const COLUMN_LANGUAGES = ['de', 'fr', 'es', 'pt', 'it', 'ja', 'zh', 'ko'];

const W = (de, fr, es, pt, it, ja, zh, ko) => ({ de, fr, es, pt, it, ja, zh, ko });

export const COLUMN_WORDS = {
  // ---- People, users and access ----
  name: W(['Name', 'Vollständiger Name'], ['Nom', 'Nom complet'], ['Nombre', 'Nombre completo'], ['Nome', 'Nome completo'], ['Nome', 'Nome completo', 'Denominazione'], ['名前', '氏名', '名称'], ['名称', '姓名', '名稱'], ['이름', '성명', '명칭']),
  email: W(['E-Mail', 'E-Mail-Adresse', 'Mail'], ['E-mail', 'Courriel', 'Adresse e-mail', 'Adresse électronique'], ['Correo', 'Correo electrónico', 'Email'], ['E-mail', 'Endereço de e-mail'], ['E-mail', 'Indirizzo email', 'Posta elettronica'], ['メールアドレス', 'メール', 'Eメール'], ['邮箱', '电子邮件', '邮件地址', '電子郵件', '電子信箱'], ['이메일', '전자우편', '메일']),
  user: W(['Benutzer', 'Benutzername', 'Anmeldename'], ['Utilisateur', "Nom d'utilisateur"], ['Usuario', 'Nombre de usuario'], ['Usuário', 'Nome de usuário', 'Utilizador'], ['Utente', 'Nome utente'], ['ユーザー', 'ユーザー名', 'ログインID'], ['用户', '用户名', '账号', '帳號'], ['사용자', '사용자명', '계정']),
  status: W(['Status', 'Zustand'], ['Statut', 'État'], ['Estado', 'Estatus'], ['Situação', 'Estado'], ['Stato'], ['ステータス', '状態', '状況'], ['状态', '狀態'], ['상태']),
  type: W(['Typ', 'Art'], ['Type'], ['Tipo'], ['Tipo'], ['Tipo'], ['種類', '種別', '区分', 'タイプ'], ['类型', '類型', '类别'], ['유형', '종류', '구분']),
  role: W(['Rolle', 'Berechtigung', 'Funktion'], ['Rôle', 'Fonction', 'Poste', 'Profil'], ['Rol', 'Puesto', 'Cargo', 'Perfil'], ['Função', 'Papel', 'Cargo', 'Perfil'], ['Ruolo', 'Profilo', 'Mansione'], ['ロール', '役割', '権限', '役職'], ['角色', '权限', '職位', '职位'], ['역할', '권한', '직책']),
  manager: W(['Vorgesetzter', 'Vorgesetzte', 'Führungskraft'], ['Manager', 'Supérieur hiérarchique', 'N+1'], ['Jefe', 'Jefe directo', 'Supervisor'], ['Gestor', 'Gestor direto', 'Supervisor'], ['Manager', 'Supervisore'], ['上長', '上司'], ['直属上级', '上级', '经理'], ['상사', '직속 상사', '팀장']),
  manager_email: W(['E-Mail des Vorgesetzten'], ['E-mail du manager'], ['Correo del jefe'], ['E-mail do gestor'], ['Email del responsabile'], ['上長メールアドレス', '上長メール'], ['上级邮箱', '经理邮箱'], ['상사 이메일', '팀장 이메일']),
  owner: W(['Verantwortlich', 'Verantwortlicher', 'Eigentümer', 'Zuständig'], ['Responsable', 'Propriétaire'], ['Responsable', 'Propietario'], ['Responsável', 'Proprietário'], ['Responsabile', 'Proprietario'], ['担当者', '責任者', '所有者'], ['负责人', '所有者', '责任人'], ['담당자', '책임자', '소유자']),
  system: W(['Anwendung', 'System', 'Applikation'], ['Application', 'Système', 'Outil'], ['Aplicación', 'Sistema', 'Herramienta'], ['Aplicação', 'Aplicativo', 'Sistema', 'Ferramenta'], ['Applicazione', 'Sistema', 'Strumento'], ['アプリケーション', 'システム', 'アプリ'], ['应用', '应用程序', '系统', '系統'], ['애플리케이션', '시스템', '앱']),
  app: W(['Anwendung', 'Applikation', 'Werkzeug'], ['Application', 'Outil'], ['Aplicación', 'Herramienta'], ['Aplicação', 'Aplicativo', 'Ferramenta'], ['Applicazione', 'Strumento'], ['アプリケーション', 'アプリ', 'ツール'], ['应用', '应用程序', '工具'], ['애플리케이션', '앱', '도구']),
  account_type: W(['Kontotyp', 'Benutzertyp', 'Kontoart'], ['Type de compte', "Type d'utilisateur"], ['Tipo de cuenta', 'Tipo de usuario'], ['Tipo de conta', 'Tipo de usuário'], ['Tipo di account', 'Tipo utente'], ['アカウント種別', 'ユーザー種別'], ['账号类型', '用户类型'], ['계정 유형', '사용자 유형']),
  mfa: W(['Zwei-Faktor', 'Zwei-Faktor-Authentifizierung', '2FA'], ['Double authentification', 'Authentification à deux facteurs', 'A2F'], ['Doble factor', 'Autenticación en dos pasos', 'Verificación en dos pasos'], ['Autenticação em dois fatores', 'Verificação em duas etapas'], ['Autenticazione a due fattori', 'Verifica in due passaggi'], ['多要素認証', '二要素認証', '2段階認証'], ['多因素认证', '双因素认证', '两步验证'], ['다중인증', '2단계 인증', '이중인증']),
  last_login: W(['Letzte Anmeldung', 'Zuletzt angemeldet', 'Letzter Login'], ['Dernière connexion'], ['Último acceso', 'Último inicio de sesión'], ['Último acesso', 'Último login'], ['Ultimo accesso'], ['最終ログイン', '最終ログイン日時', '最終アクセス'], ['最后登录', '最后登录时间', '最近登录'], ['마지막 로그인', '최근 로그인', '최종 접속일']),
  last_active: W(['Zuletzt aktiv', 'Letzte Aktivität', 'Letzte Anmeldung'], ['Dernière activité', 'Dernière connexion'], ['Última actividad', 'Último acceso'], ['Última atividade', 'Último acesso'], ['Ultima attività', 'Ultimo accesso'], ['最終利用日', '最終ログイン', '最終アクティビティ'], ['最后活动时间', '最近使用', '最后登录'], ['마지막 활동', '최근 사용일', '마지막 로그인']),
  last_activity: W(['Letzte Aktivität'], ['Dernière activité'], ['Última actividad'], ['Última atividade'], ['Ultima attività'], ['最終アクティビティ', '最終活動日'], ['最后活动时间', '最近互动'], ['마지막 활동', '최근 활동일']),
  last_rotated: W(['Zuletzt rotiert', 'Letzte Rotation'], ['Dernière rotation'], ['Última rotación'], ['Última rotação'], ['Ultima rotazione'], ['最終ローテーション', '最終キー更新'], ['最后轮换', '最近轮换时间'], ['마지막 교체', '최종 교체일']),
  termination_date: W(['Austrittsdatum', 'Letzter Arbeitstag'], ['Date de sortie', 'Date de départ'], ['Fecha de baja', 'Fecha de cese'], ['Data de desligamento', 'Data de demissão'], ['Data di cessazione', 'Data di uscita'], ['退職日', '離職日'], ['离职日期', '離職日期'], ['퇴사일', '퇴직일']),
  person_id: W(['Personalnummer', 'Mitarbeiter-ID', 'Pers.-Nr.'], ['Matricule', 'ID employé'], ['Número de empleado', 'ID de empleado', 'Legajo'], ['Matrícula', 'ID do funcionário', 'Número do funcionário'], ['Matricola', 'ID dipendente'], ['社員番号', '従業員番号', '社員ID'], ['员工编号', '工号', '員工編號'], ['사번', '사원번호', '직원번호']),
  start_date: W(['Eintrittsdatum', 'Startdatum', 'Beginn'], ["Date d'entrée", "Date d'embauche", 'Date de début'], ['Fecha de alta', 'Fecha de ingreso', 'Fecha de inicio'], ['Data de admissão', 'Data de início'], ['Data di assunzione', 'Data inizio'], ['入社日', '開始日'], ['入职日期', '开始日期'], ['입사일', '시작일']),
  end_date: W(['Austrittsdatum', 'Enddatum', 'Letzter Arbeitstag'], ['Date de sortie', 'Date de fin'], ['Fecha de baja', 'Fecha de fin'], ['Data de desligamento', 'Data de término'], ['Data di cessazione', 'Data fine'], ['退職日', '終了日'], ['离职日期', '结束日期'], ['퇴사일', '종료일']),
  employee: W(['Mitarbeiter', 'Mitarbeitername', 'Name des Mitarbeiters'], ['Employé', 'Salarié', 'Collaborateur'], ['Empleado', 'Nombre del empleado'], ['Funcionário', 'Colaborador', 'Nome do funcionário'], ['Dipendente', 'Nome dipendente'], ['社員名', '従業員', '申請者'], ['员工', '员工姓名', '申请人'], ['직원', '직원명', '신청자']),
  company: W(['Firma', 'Unternehmen', 'Firmenname'], ['Société', 'Entreprise', 'Raison sociale'], ['Empresa', 'Compañía', 'Razón social'], ['Empresa', 'Razão social'], ['Azienda', 'Società', 'Ragione sociale'], ['会社名', '企業名', '会社'], ['公司', '公司名称', '企业名称'], ['회사', '회사명', '기업명']),
  // ---- Vendors, customers, orders ----
  vendor: W(['Lieferant', 'Kreditor', 'Lieferantenname'], ['Fournisseur', 'Nom du fournisseur'], ['Proveedor', 'Nombre del proveedor'], ['Fornecedor', 'Nome do fornecedor'], ['Fornitore', 'Ragione sociale fornitore'], ['仕入先', '取引先', '仕入先名'], ['供应商', '供應商', '供应商名称'], ['공급업체', '거래처', '공급사']),
  vendor_id: W(['Lieferantennummer', 'Kreditorennummer', 'Kreditor-Nr.'], ['Code fournisseur', 'N° fournisseur'], ['Código de proveedor', 'N.º de proveedor'], ['Código do fornecedor'], ['Codice fornitore'], ['仕入先コード', '取引先コード'], ['供应商编号', '供应商代码'], ['거래처코드', '공급업체코드']),
  legal_name: W(['Firmierung', 'Rechtlicher Name'], ['Raison sociale', 'Dénomination sociale'], ['Razón social', 'Denominación social'], ['Razão social'], ['Ragione sociale', 'Denominazione sociale'], ['正式名称', '法人名'], ['法定名称', '公司全称'], ['법인명', '상호']),
  country: W(['Land'], ['Pays'], ['País'], ['País'], ['Paese', 'Nazione'], ['国', '国名'], ['国家', '国家/地区'], ['국가']),
  address: W(['Adresse', 'Anschrift', 'Straße'], ['Adresse'], ['Dirección', 'Domicilio'], ['Endereço', 'Morada'], ['Indirizzo'], ['住所'], ['地址'], ['주소']),
  tax_id: W(['Steuernummer', 'USt-IdNr.', 'Umsatzsteuer-ID', 'Steuer-ID'], ['Numéro de TVA', 'N° TVA', 'SIRET', 'SIREN'], ['NIF', 'CIF', 'RFC', 'Número fiscal'], ['CNPJ', 'CPF/CNPJ', 'NIF'], ['Partita IVA', 'P.IVA', 'Codice fiscale'], ['法人番号', '登録番号', 'インボイス登録番号', '適格請求書発行事業者登録番号'], ['统一社会信用代码', '税号', '纳税人识别号', '統一編號'], ['사업자등록번호', '사업자번호', '법인등록번호']),
  phone: W(['Telefon', 'Telefonnummer', 'Tel.'], ['Téléphone', 'Tél.', 'Numéro de téléphone'], ['Teléfono', 'Tel.'], ['Telefone', 'Tel.'], ['Telefono', 'Tel.'], ['電話番号', '電話', 'TEL'], ['电话', '联系电话', '電話'], ['전화번호', '연락처', '전화']),
  customer: W(['Kunde', 'Kunden-E-Mail'], ['Client', 'E-mail client'], ['Cliente', 'Correo del cliente'], ['Cliente', 'E-mail do cliente'], ['Cliente', 'Email cliente'], ['顧客', '顧客メール', 'お客様'], ['客户', '客户邮箱'], ['고객', '고객 이메일']),
  order_id: W(['Bestellnummer', 'Auftragsnummer', 'Bestell-ID'], ['N° de commande', 'Numéro de commande', 'Commande'], ['N.º de pedido', 'Número de pedido', 'Pedido'], ['Nº do pedido', 'Número do pedido', 'Pedido'], ['Numero ordine', 'N. ordine', 'Ordine'], ['注文番号', '受注番号', '注文ID'], ['订单号', '订单编号', '訂單編號'], ['주문번호']),
  po: W(['Bestellnummer', 'Bestellung', 'Bestell-Nr.'], ['Bon de commande', 'N° de commande', 'Numéro de commande'], ['Orden de compra', 'Pedido', 'N.º de pedido'], ['Pedido de compra', 'Ordem de compra', 'Nº do pedido'], ["Ordine d'acquisto", 'Numero ordine', 'N. ordine'], ['発注番号', '注文番号', '発注書番号'], ['采购订单号', '采购单号', '订单号'], ['발주번호', '구매주문번호', '주문번호']),
  line: W(['Position', 'Pos.', 'Zeile'], ['Ligne', 'N° de ligne'], ['Línea', 'Posición'], ['Linha'], ['Riga', 'Posizione'], ['明細番号', '行番号', '行'], ['行号', '行項目'], ['행번호', '라인']),
  item: W(['Artikel', 'Artikelnummer'], ['Article', 'Code article'], ['Artículo', 'Código de artículo'], ['Item', 'Produto', 'Código do item'], ['Articolo', 'Codice articolo'], ['品目', '品番', '品目コード'], ['物料', '物料编码', '品项'], ['품목', '품목코드']),
  qty: W(['Menge', 'Anzahl'], ['Quantité', 'Qté'], ['Cantidad', 'Cant.'], ['Quantidade', 'Qtd', 'Qtde'], ['Quantità', 'Qtà'], ['数量'], ['数量', '數量'], ['수량']),
  unit_price: W(['Einzelpreis', 'Stückpreis', 'Preis'], ['Prix unitaire', 'Prix'], ['Precio unitario', 'Precio'], ['Preço unitário', 'Preço'], ['Prezzo unitario', 'Prezzo'], ['単価'], ['单价', '單價'], ['단가']),
  invoice: W(['Rechnungsnummer', 'Rechnungs-Nr.', 'Rechnung'], ['N° de facture', 'Numéro de facture', 'Facture'], ['N.º de factura', 'Número de factura', 'Factura'], ['Nº da nota fiscal', 'Nota fiscal', 'Número da fatura', 'Fatura'], ['Numero fattura', 'N. fattura', 'Fattura'], ['請求書番号', '請求番号', 'インボイス番号'], ['发票号', '发票号码', '发票编号', '發票號碼'], ['세금계산서번호', '청구서번호', '인보이스번호']),
  receipt: W(['Wareneingang', 'Beleg', 'Quittung'], ['Réception', 'Reçu', 'Bon de réception', 'Justificatif'], ['Recepción', 'Recibo', 'Albarán', 'Comprobante'], ['Recebimento', 'Recibo', 'Comprovante'], ['Ricevimento', 'Ricevuta', 'Bolla di entrata'], ['入庫番号', '受領書', '領収書', '検収番号'], ['收货单号', '入库单号', '收据'], ['입고번호', '영수증', '검수번호']),
  method: W(['Zahlungsart', 'Zahlungsmethode'], ['Mode de paiement', 'Moyen de paiement'], ['Forma de pago', 'Método de pago'], ['Forma de pagamento', 'Meio de pagamento'], ['Metodo di pagamento', 'Modalità di pagamento'], ['支払方法', '決済方法'], ['付款方式', '支付方式'], ['결제수단', '지급방법', '결제방법']),
  order_date: W(['Bestelldatum', 'Auftragsdatum'], ['Date de commande'], ['Fecha del pedido'], ['Data do pedido'], ['Data ordine'], ['注文日', '受注日'], ['下单日期', '订单日期'], ['주문일', '주문일자']),
  delivered_date: W(['Lieferdatum', 'Zugestellt am'], ['Date de livraison', 'Livré le'], ['Fecha de entrega', 'Entregado el'], ['Data de entrega', 'Entregue em'], ['Data di consegna', 'Consegnato il'], ['配達日', '納品日', 'お届け日'], ['送达日期', '签收日期', '交付日期'], ['배송완료일', '배송일', '납품일']),
  tracking: W(['Sendungsnummer', 'Sendungsverfolgung', 'Trackingnummer'], ['Numéro de suivi', 'Suivi'], ['Número de seguimiento', 'Seguimiento'], ['Código de rastreio', 'Rastreamento'], ['Numero di tracciamento', 'Tracking'], ['追跡番号', 'お問い合わせ番号', '送り状番号'], ['运单号', '物流单号', '快递单号'], ['송장번호', '운송장번호']),
  request_id: W(['Anfrage-ID', 'Fallnummer', 'Ticketnummer'], ['N° de demande', 'N° de dossier'], ['N.º de solicitud', 'ID de caso'], ['Nº da solicitação', 'ID do caso'], ['ID richiesta', 'N. pratica'], ['申請番号', '問い合わせ番号', 'ケース番号'], ['申请编号', '工单号', '案例编号'], ['요청번호', '접수번호', '문의번호']),
  requested_at: W(['Angefordert am', 'Anfragedatum', 'Erstellt am'], ['Date de la demande', 'Créé le'], ['Fecha de solicitud', 'Creado el'], ['Data da solicitação', 'Criado em'], ['Data richiesta', 'Creato il'], ['申請日', '依頼日', '作成日'], ['申请日期', '创建时间'], ['요청일', '생성일']),
  reason: W(['Grund'], ['Motif', 'Raison'], ['Motivo', 'Razón'], ['Motivo', 'Razão'], ['Motivo'], ['理由', '返品理由'], ['原因', '退款原因'], ['사유', '반품 사유']),
  reason_code: W(['Grundcode'], ['Code motif'], ['Código de motivo'], ['Código do motivo'], ['Codice motivo'], ['理由コード'], ['原因代码'], ['사유코드']),
  network: W(['Kartennetzwerk', 'Kartenmarke'], ['Réseau', 'Réseau de carte'], ['Red', 'Marca de tarjeta'], ['Bandeira', 'Rede'], ['Circuito', 'Circuito carta'], ['カードブランド', '国際ブランド'], ['卡组织', '卡品牌'], ['카드브랜드', '카드사']),
  returned: W(['Zurückgesendet', 'Retoure erhalten'], ['Retourné'], ['Devuelto'], ['Devolvido'], ['Restituito', 'Reso'], ['返品済み', '返品'], ['已退货', '退货'], ['반품완료', '반품']),
  refunded: W(['Erstattet', 'Erstattungsbetrag'], ['Remboursé', 'Montant remboursé'], ['Reembolsado', 'Importe reembolsado'], ['Reembolsado', 'Valor reembolsado'], ['Rimborsato', 'Importo rimborsato'], ['返金額', '返金済み'], ['退款金额', '已退款'], ['환불액', '환불금액']),
  // ---- Money, dates, descriptions ----
  amount: W(['Betrag', 'Summe', 'Gesamtbetrag', 'Umsatz'], ['Montant', 'Montant TTC'], ['Importe', 'Monto', 'Total'], ['Valor', 'Montante', 'Valor total'], ['Importo', 'Totale'], ['金額', '合計', '合計金額'], ['金额', '金額', '总额', '合计'], ['금액', '합계', '총액']),
  currency: W(['Währung', 'WKZ', 'Währungscode'], ['Devise', 'Monnaie'], ['Moneda', 'Divisa'], ['Moeda'], ['Valuta'], ['通貨', '通貨コード'], ['币种', '货币', '幣別', '幣別'], ['통화', '통화코드']),
  date: W(['Datum', 'Belegdatum', 'Buchungsdatum'], ['Date', 'Date de pièce'], ['Fecha'], ['Data'], ['Data'], ['日付', '年月日', '取引日'], ['日期', '交易日期'], ['날짜', '일자', '거래일자']),
  due_date: W(['Fälligkeitsdatum', 'Fällig am', 'Frist'], ["Date d'échéance", 'Échéance'], ['Fecha de vencimiento', 'Vencimiento'], ['Data de vencimento', 'Vencimento', 'Prazo'], ['Data di scadenza', 'Scadenza'], ['期日', '期限'], ['截止日期', '到期日'], ['마감일', '기한']),
  expires: W(['Ablaufdatum', 'Gültig bis', 'Läuft ab'], ["Date d'expiration", 'Expire le', "Valide jusqu'au"], ['Fecha de vencimiento', 'Caduca', 'Válido hasta'], ['Data de validade', 'Expira em', 'Válido até'], ['Data di scadenza', 'Scadenza', 'Valido fino al'], ['有効期限', '期限'], ['到期日', '有效期至', '过期时间'], ['만료일', '유효기간']),
  description: W(['Beschreibung', 'Bezeichnung', 'Buchungstext', 'Verwendungszweck', 'Text'], ['Description', 'Libellé', 'Désignation'], ['Descripción', 'Concepto', 'Detalle'], ['Descrição', 'Histórico', 'Detalhe'], ['Descrizione', 'Causale'], ['摘要', '内容', '説明', '品名'], ['摘要', '描述', '说明', '品名'], ['적요', '설명', '내용', '품명']),
  memo: W(['Verwendungszweck', 'Buchungstext', 'Beschreibung'], ['Libellé', 'Description', 'Motif'], ['Concepto', 'Descripción'], ['Histórico', 'Descrição'], ['Causale', 'Descrizione'], ['摘要', '内容', '備考'], ['摘要', '备注', '用途'], ['적요', '내용', '비고']),
  reference: W(['Referenz', 'Belegnummer', 'Schecknummer'], ['Référence', 'N° de chèque'], ['Referencia', 'Número de cheque'], ['Referência', 'Número do cheque', 'Documento'], ['Riferimento', 'Numero assegno'], ['参照番号', '伝票番号', '小切手番号'], ['参考号', '凭证号', '支票号'], ['참조번호', '전표번호', '수표번호']),
  // A bank statement's money out and money in (not ledger debit and credit).
  debit: W(['Ausgang', 'Belastung', 'Lastschrift', 'Abgang'], ['Débit'], ['Cargo', 'Cargos', 'Retiro'], ['Débito', 'Saída', 'Saídas'], ['Addebito', 'Addebiti', 'Uscite'], ['出金', 'お引出し', '引出金額', '支払金額'], ['支出', '支出金额', '付款金额'], ['출금', '출금액', '찾으신금액']),
  credit: W(['Eingang', 'Gutschrift', 'Zugang'], ['Crédit'], ['Abono', 'Abonos', 'Depósito'], ['Crédito', 'Entrada', 'Entradas'], ['Accredito', 'Accrediti', 'Entrate'], ['入金', 'お預入れ', '預入金額', '入金額'], ['收入', '收入金额', '存入金额'], ['입금', '입금액', '맡기신금액']),
  // ---- Expenses ----
  report_id: W(['Spesenbericht', 'Abrechnungsnummer'], ['Note de frais', 'N° de note de frais'], ['Informe de gastos', 'N.º de informe'], ['Relatório de despesas', 'Nº do relatório'], ['Nota spese', 'N. nota spese'], ['経費精算番号', '精算書番号', 'レポートID'], ['报销单号', '报告编号'], ['경비보고서번호', '정산번호']),
  submitted_on: W(['Eingereicht am', 'Einreichungsdatum'], ['Soumis le', 'Date de soumission'], ['Fecha de envío', 'Enviado el'], ['Enviado em', 'Data de envio'], ['Inviato il', 'Data di invio'], ['申請日', '提出日'], ['提交日期', '申请日期'], ['제출일', '신청일']),
  category: W(['Kategorie', 'Ausgabenart', 'Kostenart'], ['Catégorie', 'Type de dépense'], ['Categoría', 'Tipo de gasto'], ['Categoria', 'Tipo de despesa'], ['Categoria', 'Tipo di spesa'], ['経費科目', 'カテゴリ', '費目'], ['费用类别', '类别', '费用科目'], ['비용항목', '카테고리']),
  merchant: W(['Händler', 'Zahlungsempfänger', 'Geschäft'], ['Commerçant', 'Marchand'], ['Comercio', 'Establecimiento'], ['Estabelecimento', 'Comerciante'], ['Esercente', 'Negozio'], ['支払先', '店舗名', '加盟店'], ['商户', '商家', '收款方'], ['가맹점', '사용처', '상호']),
  purpose: W(['Zweck', 'Geschäftszweck', 'Anlass'], ['Motif', 'Objet'], ['Motivo', 'Propósito'], ['Motivo', 'Finalidade'], ['Motivo', 'Scopo'], ['目的', '用途'], ['事由', '用途', '目的'], ['목적', '사유', '용도']),
  attendees: W(['Teilnehmer', 'Anzahl Teilnehmer'], ['Participants', 'Nombre de participants'], ['Asistentes', 'Número de asistentes'], ['Participantes', 'Número de participantes'], ['Partecipanti', 'Numero partecipanti'], ['参加人数', '人数'], ['参与人数', '人数'], ['참석인원', '인원수']),
  nights: W(['Nächte', 'Übernachtungen'], ['Nuits', 'Nuitées'], ['Noches'], ['Noites', 'Diárias'], ['Notti', 'Pernottamenti'], ['泊数'], ['晚数', '住宿天数'], ['박수', '숙박일수']),
  days: W(['Tage'], ['Jours'], ['Días'], ['Dias'], ['Giorni'], ['日数'], ['天数'], ['일수']),
  preapproved_by: W(['Vorab genehmigt von', 'Genehmigt von'], ['Pré-approuvé par', 'Approuvé par'], ['Preaprobado por', 'Aprobado por'], ['Pré-aprovado por', 'Aprovado por'], ['Preapprovato da', 'Approvato da'], ['事前承認者', '承認者'], ['预先审批人', '审批人'], ['사전승인자', '승인자']),
  // ---- Inventory ----
  sku: W(['Artikelnummer', 'Artikel-Nr.', 'Materialnummer', 'Material'], ['Référence', 'Réf. article', 'Code article'], ['Código de artículo', 'Referencia'], ['Código do produto', 'Código do item'], ['Codice articolo', 'Articolo'], ['品番', '商品コード', '品目コード'], ['物料编码', '商品编码', '货号', '料号'], ['품목코드', '품번', '상품코드']),
  uom: W(['Einheit', 'Mengeneinheit', 'ME'], ['Unité', 'Unité de mesure'], ['Unidad', 'Unidad de medida'], ['Unidade', 'Unidade de medida'], ['Unità di misura', 'UM'], ['単位'], ['单位', '计量单位'], ['단위']),
  location: W(['Lagerort', 'Lager', 'Standort', 'Ort'], ['Emplacement', 'Entrepôt', 'Lieu', 'Site'], ['Ubicación', 'Almacén', 'Lugar'], ['Local', 'Localização', 'Depósito', 'Armazém'], ['Ubicazione', 'Magazzino', 'Luogo'], ['保管場所', '倉庫', 'ロケーション', '場所'], ['库位', '仓库', '地点', '位置'], ['위치', '창고', '보관장소']),
  lot: W(['Charge', 'Chargennummer', 'Los'], ['Lot', 'N° de lot'], ['Lote', 'N.º de lote'], ['Lote'], ['Lotto'], ['ロット', 'ロット番号'], ['批次', '批号'], ['로트', '로트번호', '배치']),
  expiry: W(['Mindesthaltbarkeitsdatum', 'MHD', 'Verfallsdatum', 'Ablaufdatum'], ['Date de péremption', 'DLUO', 'DLC', "Date d'expiration"], ['Fecha de caducidad', 'Caducidad', 'Vencimiento'], ['Validade', 'Data de validade'], ['Data di scadenza', 'Scadenza'], ['賞味期限', '消費期限', '有効期限'], ['有效期', '保质期至', '失效日期'], ['유통기한', '유효기간', '소비기한']),
  system_qty: W(['Bestand', 'Lagerbestand', 'Buchbestand'], ['Stock', 'Quantité en stock', 'Stock théorique'], ['Existencias', 'Stock', 'Cantidad en stock'], ['Estoque', 'Saldo em estoque', 'Quantidade em estoque'], ['Giacenza', 'Quantità a magazzino', 'Esistenza'], ['在庫数', '理論在庫', '帳簿在庫'], ['库存数量', '账面数量', '系统数量'], ['재고수량', '장부재고', '전산재고']),
  unit_cost: W(['Stückkosten', 'Einstandspreis', 'Durchschnittspreis'], ['Coût unitaire', 'Prix de revient', 'Coût moyen'], ['Costo unitario', 'Coste unitario', 'Costo promedio'], ['Custo unitário', 'Custo médio'], ['Costo unitario', 'Costo medio'], ['単価', '原価', '平均単価'], ['单位成本', '成本单价', '平均成本'], ['단위원가', '원가', '평균단가']),
  counted_qty: W(['Gezählt', 'Zählmenge', 'Istmenge'], ['Quantité comptée', 'Compté'], ['Cantidad contada', 'Conteo'], ['Quantidade contada', 'Contagem'], ['Quantità contata', 'Conteggio'], ['実棚数', '棚卸数', '実地棚卸数'], ['盘点数量', '实盘数量'], ['실사수량', '재고실사수량']),
  recount_qty: W(['Nachzählung'], ['Recomptage'], ['Reconteo'], ['Recontagem'], ['Riconteggio'], ['再棚卸数', '再カウント'], ['复盘数量'], ['재실사수량']),
  counter: W(['Gezählt von', 'Zähler'], ['Compté par'], ['Contado por'], ['Contado por'], ['Contato da', 'Addetto'], ['棚卸担当者'], ['盘点人'], ['실사자']),
  counted_at: W(['Gezählt am', 'Zählzeitpunkt'], ['Compté le', 'Date du comptage'], ['Fecha del conteo'], ['Data da contagem'], ['Data conteggio'], ['棚卸日時', '棚卸日'], ['盘点时间', '盘点日期'], ['실사일시', '실사일']),
  // ---- Licences, seats, certificates ----
  tier: W(['Lizenz', 'Lizenztyp', 'Tarif', 'Edition'], ['Licence', 'Type de licence', 'Formule', 'Édition'], ['Licencia', 'Tipo de licencia', 'Plan', 'Edición'], ['Licença', 'Tipo de licença', 'Plano', 'Edição'], ['Licenza', 'Tipo di licenza', 'Piano', 'Edizione'], ['ライセンス', 'ライセンス種別', 'プラン', 'エディション'], ['许可证', '许可类型', '套餐'], ['라이선스', '라이선스 유형', '요금제', '에디션']),
  monthly_cost: W(['Monatliche Kosten', 'Kosten pro Monat', 'Monatspreis'], ['Coût mensuel', 'Prix mensuel'], ['Costo mensual', 'Coste mensual', 'Precio mensual'], ['Custo mensal', 'Preço mensal'], ['Costo mensile', 'Prezzo mensile'], ['月額', '月額費用', '月額料金'], ['月费', '每月费用', '月度成本'], ['월 비용', '월 요금', '월간 비용']),
  id: W(['Kennung', 'Nummer'], ['Identifiant'], ['Identificador'], ['Identificador'], ['Identificativo'], ['番号'], ['编号', '编码'], ['번호', '아이디']),
  holder: W(['Inhaber'], ['Titulaire'], ['Titular'], ['Titular'], ['Titolare', 'Intestatario'], ['名義人', '保有者'], ['持有人'], ['명의자', '보유자']),
  issuer: W(['Aussteller'], ['Émetteur'], ['Emisor'], ['Emissor'], ['Emittente'], ['発行者', '発行元'], ['颁发者', '签发机构'], ['발급자', '발행자']),
  auto_renew: W(['Automatische Verlängerung'], ['Renouvellement automatique'], ['Renovación automática'], ['Renovação automática'], ['Rinnovo automatico'], ['自動更新'], ['自动续费', '自动续期'], ['자동 갱신']),
  renewal_cost: W(['Verlängerungskosten'], ['Coût de renouvellement'], ['Costo de renovación'], ['Custo de renovação'], ['Costo di rinnovo'], ['更新費用'], ['续费金额', '续期费用'], ['갱신 비용']),
  // ---- Marketing lists ----
  consent: W(['Einwilligung', 'Einverständnis'], ['Consentement'], ['Consentimiento'], ['Consentimento'], ['Consenso'], ['同意', '配信同意', 'メール配信同意'], ['同意', '营销同意', '订阅同意'], ['동의', '수신동의', '마케팅 수신동의']),
  consent_date: W(['Datum der Einwilligung', 'Einwilligungsdatum'], ['Date du consentement'], ['Fecha de consentimiento'], ['Data do consentimento'], ['Data del consenso'], ['同意日', '同意日時'], ['同意日期'], ['동의일', '동의일자']),
  consent_source: W(['Quelle der Einwilligung'], ['Source du consentement'], ['Origen del consentimiento'], ['Origem do consentimento'], ['Fonte del consenso'], ['同意取得元', '同意経路'], ['同意来源'], ['동의 경로', '동의 출처']),
  unsubscribed: W(['Abgemeldet', 'Abmeldung'], ['Désabonné', 'Désinscrit'], ['Dado de baja', 'Baja'], ['Descadastrado'], ['Disiscritto'], ['配信停止', '配信解除'], ['已退订', '退订'], ['수신거부', '구독취소']),
  bounce: W(['Unzustellbar'], ['Rebond'], ['Rebote'], ['Rejeição'], ['Rimbalzo'], ['不達', 'バウンス'], ['退信', '退回'], ['반송', '반송여부']),
  // ---- Ledgers and migrations (used by Olympus) ----
  external_id: W(['Externe ID', 'Alt-ID', 'Altsystem-ID'], ['ID externe', 'Ancien ID'], ['ID externo', 'ID heredado'], ['ID externo', 'ID legado'], ['ID esterno', 'ID legacy'], ['外部ID', '旧システムID'], ['外部编号', '外部ID', '旧系统编号'], ['외부ID', '기존 시스템 ID']),
  document_number: W(['Belegnummer', 'Beleg-Nr.', 'Dokumentnummer'], ['N° de pièce', 'Numéro de pièce', 'N° de document'], ['N.º de documento', 'Número de documento', 'Asiento'], ['Nº do documento', 'Número do documento', 'Lançamento'], ['Numero documento', 'N. documento', 'Numero registrazione'], ['伝票番号', '仕訳番号', '文書番号'], ['凭证号', '单据编号', '凭证编号'], ['전표번호', '문서번호']),
  account: W(['Konto', 'Kontonummer', 'Sachkonto'], ['Compte', 'N° de compte', 'Numéro de compte'], ['Cuenta', 'Número de cuenta', 'Cuenta contable'], ['Conta', 'Número da conta', 'Conta contábil'], ['Conto', 'Numero conto', 'Codice conto'], ['勘定科目', '勘定科目コード', '科目コード'], ['科目代码', '会计科目', '科目编码', '科目'], ['계정과목', '계정코드', '계정']),
  account_name: W(['Kontobezeichnung', 'Kontoname'], ['Libellé du compte', 'Intitulé du compte'], ['Nombre de la cuenta', 'Descripción de la cuenta'], ['Nome da conta', 'Descrição da conta'], ['Descrizione conto', 'Nome conto'], ['勘定科目名', '科目名'], ['科目名称', '会计科目名称'], ['계정과목명', '계정명']),
  balance: W(['Saldo', 'Endsaldo', 'Kontostand'], ['Solde', 'Solde final'], ['Saldo', 'Saldo final'], ['Saldo', 'Saldo final'], ['Saldo', 'Saldo finale'], ['残高', '期末残高'], ['余额', '期末余额', '餘額'], ['잔액', '기말잔액']),
  subsidiary: W(['Gesellschaft', 'Buchungskreis', 'Tochtergesellschaft'], ['Société', 'Filiale', 'Entité'], ['Sociedad', 'Filial', 'Entidad'], ['Empresa', 'Filial', 'Entidade'], ['Società', 'Filiale', 'Entità'], ['会社', '子会社', '会社コード'], ['子公司', '公司代码', '核算主体'], ['법인', '자회사', '회사코드']),
  ledger_debit: W(['Soll', 'Soll-Betrag'], ['Débit'], ['Debe', 'Débito'], ['Débito'], ['Dare'], ['借方', '借方金額'], ['借方', '借方金额'], ['차변', '차변금액']),
  ledger_credit: W(['Haben', 'Haben-Betrag'], ['Crédit'], ['Haber', 'Crédito'], ['Crédito'], ['Avere'], ['貸方', '貸方金額'], ['贷方', '贷方金额'], ['대변', '대변금액']),
};

const byField = new Map();
for (const [field, langs] of Object.entries(COLUMN_WORDS)) {
  const list = []; const seen = new Map();
  for (const lang of COLUMN_LANGUAGES) for (const w of langs[lang] || []) {
    const k = normHeader(w);
    if (!k) continue;
    // A word shared by languages (摘要 in Japanese and Chinese) is listed once, with both.
    if (seen.has(k)) { const e = seen.get(k); if (!e.lang.split(', ').includes(lang)) e.lang += `, ${lang}`; continue; }
    const e = { lang, word: w }; seen.set(k, e); list.push(e);
  }
  byField.set(field, list);
}

/** Translated column names for one of an agent's fields: [{ lang, word }], [] when there are none. */
export function translatedNames(field) { return byField.get(field) || []; }

/** The translated names of a concept in one language, or every language (for agents that pick columns themselves). */
export function namesFor(concept, lang = null) {
  const c = COLUMN_WORDS[concept];
  if (!c) return [];
  return lang ? [...(c[lang] || [])] : COLUMN_LANGUAGES.flatMap((l) => c[l] || []);
}

/** Every known column name, normalised: used to tell which text encoding a file was saved in. */
export const KNOWN_HEADER_WORDS = new Set([...byField.values()].flat().map((x) => normHeader(x.word)).concat(Object.keys(COLUMN_WORDS).map(normHeader)).filter((k) => k && k.length > 1));
