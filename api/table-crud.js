// service_role key経由の汎用テーブル操作API。
//
// これまでbooking-sales.js/booking-costs.js/local-expenses.js/parking-reservations.jsの
// 4ファイルに分かれていた「anonロールの直接書き込みを禁止し、ログイン済みユーザーからの
// リクエストのみservice_role keyで書き込みを許可する」という全く同じ実装パターンを、
// Vercel Hobbyプランのサーバーレス関数数上限(12個)対策として1ファイルに統合したもの。
//
// セキュリティ上の見通しを保つため、統合後も「どのテーブルに」「どのactionが」許可されて
// いるかをTABLE_CONFIGで明示的にホワイトリスト化している(bodyのtable名をそのままクエリに
// 埋め込んで任意テーブルを操作できるような実装にはしていない)。各テーブル・action固有の
// バリデーション/レスポンス形状は、移行前の各ファイルの実装をそのまま踏襲する。
import { getServiceKey } from './lib/app-users-db.js';
import { verifySessionToken } from './lib/session-token.js';

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
// クライアント側(index.html)のACCOUNTING_EMAILSと同じ一覧。経理担当者限定操作の
// サーバー側チェック(checkBookingCostsPaymentDateRestriction等)で使う。
const ACCOUNTING_EMAILS = ['admin@kictravel.jp', 'kanri@kictravel.jp'];

// テーブルごとに許可するactionをホワイトリスト化する。ここに無い(table, action)の
// 組み合わせは400で拒否する。
const TABLE_CONFIG = {
  // booking_sales/booking_costsのstampIdentity/auditLogは、replace/insertアクションのみが
  // 対象(updatePayments/deleteByBookingは今回のスコープ外、既存の挙動のまま変更しない)。
  booking_sales: { actions: ['replace', 'updatePayments', 'deleteByBooking'], label: '売上明細', stampIdentity: true, auditLog: true },
  // booking_costsは書き込みが全てこのAPI経由であることを確認済み(直接anon書き込み0件)。
  // 毎時バックアップの差分化のためupdated_at列を追加し(scripts/add_updated_at_to_booking_costs.sql)、
  // booking_buses/booking_restaurantsと同じ方式でサーバー側に確実にスタンプする。
  booking_costs: { actions: ['replace', 'insert', 'deleteByBooking'], label: '仕入明細', stampIdentity: true, stampUpdatedAt: true, auditLog: true },
  // deleteByBookingは予約削除(deleteBookingData)用(2026-08-12点検で追加。それまで予約削除の削除対象から漏れていた)
  local_expenses: { actions: ['replace', 'deleteByBooking'], label: '現地費用明細' },
  parking_reservations: { actions: ['list', 'save', 'delete'], label: '駐車場予約' },
  // guide_settlements/guide_settlement_items: 社内スタッフ(index.html、ログインセッション
  // トークンで認証)からの操作に加え、ガイド本人がguide.html(ログイン機構を持たず、精算
  // リンクのaccess_tokenのみで認証する)から自分の精算明細を送信・編集するケースがある。
  // そのためguestInsert/guestUpdateByIdの2アクションのみ、通常のセッショントークンの
  // 代わりにguide_settlements.access_tokenでの認証を許可する(handler側のguest認証分岐、
  // および各doGuest*関数のsettlement_id検証を参照)。
  // stampIdentity/auditLogを今回追加(監査ログ機能)。guide_settlementsの既存created_by列は
  // 従来クライアント自己申告値を信用していたが、stampIdentity有効化により以後のinsertは
  // 検証済みemailで上書きされる。guestInsert/guestUpdateById(ガイド本人、ログインセッション
  // 無し)はsessionが常にnullのため、stampEmail/changedByとも自動的にnullのままになる
  // (ガイド本人送信分はcreated_by/監査ログのchanged_byともスタンプされない、意図通り)。
  guide_settlements: {
    actions: ['insert', 'updateById', 'updateByIds', 'deleteById', 'deleteByIds', 'deleteByField'],
    label: 'ガイド精算',
    allowedDeleteFields: ['booking_ref'],
    stampIdentity: true,
    auditLog: true,
    // 「締めを解除」(status:'open'への書き戻し)はクライアント側のisAccountingUser()で
    // ボタン自体を隠しているが、有効なセッショントークンさえあればAPIを直接叩けてしまう
    // 抜け穴があったため、email_import_queueのexcluded_reasonと同じ方式でサーバー側にも
    // 二重の防御を追加する(2026-08-12点検で発見)。
    restrictedFieldValues: [
      {
        field: 'status',
        value: 'open',
        allowedEmails: ['admin@kictravel.jp', 'kanri@kictravel.jp'],
        message: 'ガイド精算の締め解除は経理担当者のみ操作できます。',
      },
    ],
  },
  guide_settlement_items: {
    actions: ['insert', 'updateById', 'updateByIds', 'deleteById', 'deleteByIds', 'deleteByField', 'guestInsert', 'guestUpdateById'],
    label: 'ガイド精算明細',
    allowedDeleteFields: ['settlement_id'],
    // ガイド本人(guestUpdateById)が編集できるのは受領書番号のみ。ステータス承認・
    // 反映フラグ等、社内スタッフのみが操作すべき項目はここに含めない。
    guestUpdatableFields: ['receipt_no'],
    stampIdentity: true,
    auditLog: true,
  },
  // business_partners(取引先マスタ): permanentlyDeletePartner(完全削除、deleteById)以外は
  // deletePartner/restorePartnerともis_deletedフラグを立てる論理削除(updateById)であり、
  // 実際のDELETE文はdeleteByIdの1箇所のみ(削除済み取引先の復元画面から明示的に実行)。
  business_partners: {
    actions: ['insert', 'updateById', 'deleteById'],
    label: '取引先マスタ',
    stampIdentity: true,
    auditLog: true,
  },
  // agents(取引先マスタ・Agent): business_partnersと完全に同じ論理削除/復元/完全削除の
  // 構造を持つ、送客元エージェント専用の別テーブル。
  // F4/F15対応: created_by/updated_by列追加SQL実行済みのため、auditLogに加えて
  // stampIdentityも有効化(business_partnersと同じ構成)。
  agents: {
    actions: ['insert', 'updateById', 'deleteById'],
    label: '取引先マスタ(Agent)',
    stampIdentity: true,
    auditLog: true,
  },
  // guides(ガイドマスタ): F4/F15対応で、business_partners/agentsと同じ論理削除
  // (is_deleted/deleted_at/deleted_by)・監査ログ(stampIdentity/auditLog)の構造に
  // 移行済み(該当列追加SQL実行済み)。予約詳細のガイド検索から「＋新規ガイド登録」する際
  // (submitNewGuide)、挿入直後の採番id(guide_id)をその場でbooking_guides側に紐付ける
  // 必要があるため、insertReturningで挿入結果を返す。deleteByIdは「削除済み一覧」からの
  // 完全削除(permanentlyDeleteGuide)専用で、通常の削除(deleteGuide)はupdateById経由の
  // 論理削除に変更した。
  guides: {
    actions: ['insert', 'insertReturning', 'updateById', 'deleteById'],
    label: 'ガイドマスタ',
    stampIdentity: true,
    auditLog: true,
  },
  // bookings(予約本体): フェーズ3。他の全テーブルから参照される中核テーブルのため、
  // 今回は書き込み(insert/updateById/deleteById)のみをservice_role経由に移行し、
  // 読み取り(select、一覧表示・ダッシュボード・メールマッチング等)はこれまで通り
  // anon+RLSのまま変更しない(rollout時のリスクを最小化するため)。
  bookings: {
    actions: ['insert', 'updateById', 'deleteById'],
    label: '予約',
    stampIdentity: true,
    auditLog: true,
  },
  // booking_facilities(観光施設・バス駐車場等): 観光地予約管理画面(複数予約横断の
  // 一覧・インライン編集)からのステータス/確認番号/備考の更新、AI読み取り機能からの
  // 一括新規追加(insert)に加え、予約詳細モーダルの「観光施設」タブ保存(旧
  // safeReplaceBookingRows)もreplace経由でservice_role化した(セキュリティ移行
  // バッチA最終分)。読み取りはこれまで通りanon+RLSのまま変更しない。
  // booking_facilitiesはdeadline_completed_at等の目的限定タイムスタンプは持つが汎用
  // updated_atは無い。今回はcreated_by/updated_byのみ追加し、汎用updated_at列の新設は
  // スコープ外とする(stampUpdatedAtは付けない)。
  booking_facilities: {
    actions: ['updateById', 'insert', 'replace', 'deleteByBooking'],
    label: '観光施設・バス駐車場等',
    stampIdentity: true,
    auditLog: true,
  },
  // booking_hotels/booking_buses/booking_restaurants(セキュリティ移行バッチA)。
  // 予約詳細モーダルの保存(旧safeReplaceBookingRows)は既存のbooking_sales等と同じ
  // doReplace(action:'replace')に統一する。booking_hotelsのみ、ホテル管理ページの
  // 重複解消モーダル(insert/updateById)とステータスクイック切替(updateById)がある
  // ため、それらのactionも合わせて許可する。
  // stampIdentity: true の各テーブルは、created_by/updated_by列を持つ(監査ログ機能の
  // 前提整備)。値はクライアントの自己申告を一切信用せず、verifySessionTokenで検証済みの
  // トークンから取り出したemailのみをサーバー側でスタンプする(下記handler参照)。
  // booking_hotelsは既にstatus_updated_at列を持つため、汎用updated_at列は追加しない
  // (stampUpdatedAtは付けない。created_by/updated_byのみ追加・スタンプする)。
  booking_hotels: {
    actions: ['replace', 'insert', 'updateById', 'deleteByBooking'],
    label: 'ホテル明細',
    stampIdentity: true,
    auditLog: true,
  },
  // booking_buses/booking_restaurantsはupdated_at相当の列が無かったため、created_by/
  // updated_byに加えて汎用updated_at列も新設し、insert/replace時にスタンプする。
  // updateByIdは「手配確定状況」画面(旧・仕入先確認メール)のステータスクイック切替のために
  // 追加(2026-08)。任意列の書き換えを許さないよう、updatableFieldsでstatusのみに限定する
  // (email_import_queueと同じ方式)。
  booking_buses: {
    actions: ['replace', 'deleteByBooking', 'updateById'],
    label: 'バス明細',
    stampIdentity: true,
    stampUpdatedAt: true,
    auditLog: true,
    updatableFields: ['status'],
  },
  booking_restaurants: {
    actions: ['replace', 'deleteByBooking'],
    label: 'レストラン明細',
    stampIdentity: true,
    stampUpdatedAt: true,
    auditLog: true,
  },
  // guide_bank_accounts(ガイド口座情報): 1ガイドが0〜N件の口座を持てる子テーブル。
  // 新設テーブルのため最初からservice_role経由のみとし、anonへのGRANTは一切行わない
  // (batch A のような後追い移行が不要)。created_by/updated_by/updated_atは
  // すべてサーバー側でスタンプする。
  guide_bank_accounts: {
    actions: ['insert', 'updateById', 'deleteById', 'listByField'],
    label: 'ガイド口座情報',
    stampIdentity: true,
    stampUpdatedAt: true,
    // 出金伝票(printGuideVouchers/仮払い一覧表用出金伝票)への自動反映用。guide_idでの
    // 検索のみ許可する(anonへのSELECT解放はせず、この専用actionのみで読み取れるようにする)。
    allowedListFields: ['guide_id'],
  },
  // vendor_email_logs(仕入先確認メール送信ログ): created_by/updated_byではなく専用の
  // sent_by列を持つため、通常のstampIdentityは使わずstampSentByFieldで個別に指定する
  // (下記stampNewRows参照)。クライアント自己申告のsent_byを一切信用せず、
  // 検証済みセッションのemail(changedBy)をサーバー側でスタンプする。読み取りは
  // 二重送信チェックのUI表示に使うためanonにもSELECTを許可する(STEP2提示SQL参照)。
  // updateByIdは、ホテル/バス/レストラン/観光施設/水の保存(safeReplaceBookingRows方式で
  // 既存行を全delete→新IDで再insertする)によってsource_idが指す先が変わった際、
  // remapVendorEmailLogSourceIds()がsource_idを新IDへ付け替えるためだけに使う
  // (updatableFieldsでsource_id以外を書き換えられないよう制限する)。
  vendor_email_logs: {
    // deleteByBookingは予約削除(deleteBookingData)用(2026-08-12点検で追加)
    actions: ['insert', 'updateById', 'deleteByBooking'],
    label: '仕入先確認メールログ',
    stampSentByField: 'sent_by',
    updatableFields: ['source_id'],
  },
  // learned_mappings(OCR学習データ): ユーザーの確定操作を「category+input_key+
  // confirmed_value」で蓄積する共通テーブル。新設テーブルのため最初から書き込みは
  // service_role専用(このAPI経由のみ。anon/authenticatedはSELECTのみ)。
  // upsertConfirm: 同じ組み合わせが既に存在すればconfirmed_countをインクリメント、
  // 無ければ新規行を作成する。guestUpsertConfirmはguide.html(ログイン無し・精算リンクの
  // access_tokenのみで認証)からのレシートカテゴリ学習用で、categoryはサーバー側で
  // 'receipt_merchant'に強制する(ゲストが他カテゴリを汚染できないようにするため)。
  learned_mappings: {
    actions: ['upsertConfirm', 'deleteById', 'guestUpsertConfirm'],
    label: 'OCR学習データ',
  },
  // email_import_queue(メール受信箱): 本文(body)を含む機微なテーブルのため、
  // updateById/updateByIdsで任意の列を書き換えられないよう、受信箱UIが実際に更新する
  // 5列だけをupdatableFieldsでホワイトリスト化する(guide_settlement_itemsの
  // guestUpdatableFieldsと同じ方式)。件名・本文・送信者等はこのAPIからは変更できない。
  // 「対象外にする」(excluded_reasonが手動除外の値)は送信元学習にも波及し運用上の影響が
  // 大きいため、クライアント側のisEmailExcludeUser()に加えてサーバー側でも
  // メールアドレスを検証する(有効なセッショントークンさえあればAPIを直接叩ける、
  // という抜け穴を塞ぐ)。
  email_import_queue: {
    actions: ['updateById', 'updateByIds'],
    label: 'メール受信箱',
    updatableFields: ['is_excluded', 'excluded_reason', 'ignored', 'imported', 'postponed'],
    restrictedFieldValues: [
      {
        field: 'excluded_reason',
        value: '手動で対象外に設定',
        allowedEmails: ['admin@kictravel.jp', 'jr@kictravel.jp'],
        message: '「対象外にする」は管理担当者のみ操作できます。',
      },
    ],
  },
  // セキュリティ移行フェーズ グループ1・フェーズA(コード変更のみ、DB側anon権限は
  // まだ剥奪しない。剥奪は別途フェーズBで実施)。
  // booking_guides/tour_guides/tour_day_itinerary/tour_arrangement_notes/booking_water_itemsは
  // booking_hotels等と同じbooking_idキーのdoReplace(action:'replace')にそのまま統一する。
  // F3(予約削除で孤立参照が残る不具合)対応で、booking_guides/tour_guides/
  // tour_day_itinerary/tour_arrangement_notesにdeleteByBookingを追加(deleteBookingData
  // 参照)。bookings(id)へのFK自体はon delete cascadeのため予約本体の削除で自動的にも
  // 消えるが、deleteBookingData側の確認文言(「完全に削除」)との整合性のため明示的に削除する。
  // booking_guidesとtour_guidesは名前が似ているが役割が異なる別テーブル(F6調査結果、
  // 意図的な分離。統合はしない): booking_guidesはガイドのアサイン状況管理
  // (status/payment_method/amountを持つ)、tour_guidesは手配書印字用メタデータのみ
  // (phone/display_orderのみ、status/amountは持たない)。詳細はindex.htmlの
  // bookingGuidesApiCall宣言部のコメント参照。
  booking_guides: { actions: ['replace', 'deleteByBooking'], label: 'ガイド明細(アサイン状況管理)' },
  tour_guides: { actions: ['replace', 'deleteByBooking'], label: '手配書ガイド(印字用メタデータ)' },
  tour_day_itinerary: { actions: ['replace', 'deleteByBooking'], label: '手配書日毎明細' },
  tour_arrangement_notes: { actions: ['replace', 'deleteByBooking'], label: '手配書注意文言' },
  // deleteByBookingは予約削除(deleteBookingData)用(2026-08-12点検で追加。それまで予約削除の削除対象から漏れていた)
  booking_water_items: { actions: ['replace', 'deleteByBooking'], label: 'ミネラルウォーター明細' },
  // tour_arrangement_headers: booking_idに1:1のヘッダー行。既存クライアントコードは
  // replaceではなくupdate(存在時)/insert(新規時)の直接呼び出しのため、汎用の
  // updateById/insertReturningをそのまま使う(insertReturningは新規作成時に採番id を
  // クライアントへ返す必要があるため)。deleteByBookingはF3対応で追加(上記と同じ理由)。
  tour_arrangement_headers: { actions: ['updateById', 'insertReturning', 'deleteByBooking'], label: '手配書ヘッダー' },
  // arrangement_document_days/arrangement_document_notes: キー列がbooking_idではなく
  // arrangement_document_idのため、doReplaceをそのまま使えない。allowedDeleteFieldsと
  // 同じ考え方でキー列をホワイトリスト化した新規action『replaceByKey』を使う
  // (doReplaceByKey/handler側のreplaceByKey分岐を参照)。
  arrangement_document_days: {
    actions: ['replaceByKey', 'insert'],
    label: 'ガイド別手配書日毎明細',
    allowedReplaceKeyFields: ['arrangement_document_id'],
  },
  arrangement_document_notes: {
    actions: ['replaceByKey', 'insert'],
    label: 'ガイド別手配書注意文言',
    allowedReplaceKeyFields: ['arrangement_document_id'],
  },
  // partner_merge_pending(名刺スキャン自動マージ・確認バナー機能): 新設テーブルのため
  // guide_bank_accounts等と同じ方針で最初からservice_role専用の書き込みとする
  // (anonへの直接insert/update/delete GRANTは一切行わない、scripts/create_partner_merge_pending.sql参照)。
  // scanned_byはvendor_email_logsと同じstampSentByField方式で、クライアント自己申告値を
  // 使わず検証済みセッションのemailをサーバー側でスタンプする。
  partner_merge_pending: {
    actions: ['insert', 'updateById'],
    label: '名刺マージ保留候補',
    stampSentByField: 'scanned_by',
  },
  // credit_card_statements(クレジットカード明細): 経理・原価計算に関わるデータのため
  // 監査ログを有効化する(再設計時にscripts/redesign_credit_card_statements.sqlで
  // created_by/updated_by/created_at列を追加済みであることが前提)。無停止移行のため、
  // このAPI経由への切替後もDB側のanon直接書き込み権限は当面維持する(フェーズB相当の
  // REVOKEは別途実施)。
  credit_card_statements: {
    actions: ['insert', 'updateById', 'deleteById', 'deleteByIds'],
    label: 'クレジットカード明細',
    stampIdentity: true,
    auditLog: true,
  },
  // F1(見積もりのservice_role移行)。created_by/updated_by列追加・service_roleへの
  // GRANTを実施済み(SQL実行済み)。無停止移行のため、anon直接書き込み権限は当面維持する
  // (フェーズB相当のREVOKEは別途実施)。estimation_fit_itemsは実データ0件・書き込み経路が
  // コード上存在しないことを確認済みのため対象外(移行しない)。
  // copyWithChildren: 見積もりコピー機能(copyEstimation)専用。ヘッダinsert→
  // copyChildTablesに列挙した子テーブルへのinsertを行い、途中で失敗した場合は
  // それまでにinsertした子テーブル行・ヘッダを削除してロールバックする
  // (doCopyWithChildren参照)。
  estimations: {
    actions: ['insert', 'updateById', 'updateByIds', 'deleteById', 'copyWithChildren'],
    label: '見積もり',
    stampIdentity: true,
    auditLog: true,
    copyChildTables: ['estimation_days', 'estimation_fixed_rows'],
  },
  // estimation_id列をキーにした「全削除→全insert」の置き換え(doReplaceByKey)。
  // 既存のarrangement_document_days等と同じ方式。
  estimation_days: {
    actions: ['replaceByKey'],
    label: '見積もり日程明細',
    allowedReplaceKeyFields: ['estimation_id'],
  },
  estimation_fixed_rows: {
    actions: ['replaceByKey'],
    label: '見積もり固定費・入場料明細',
    allowedReplaceKeyFields: ['estimation_id'],
  },
  // stampIdentity(created_by+updated_by両方が必須)ではなく、vendor_email_logs等と同じ
  // stampSentByFieldを使う。この表はinsertのみで更新されない履歴テーブルのため、
  // 事前調査時のSQL案でもcreated_by列のみを追加対象としており、updated_by列が
  // 存在しない前提(stampIdentityを使うと存在しない列で失敗するため使わない)。
  estimation_booking_reflections: {
    // deleteByBookingは予約削除(deleteBookingData)用(2026-08-12点検で追加)
    actions: ['insert', 'updateById', 'deleteByBooking'],
    label: '見積もり予約反映履歴',
    stampSentByField: 'created_by',
  },
  // 観光施設の営業情報(定休日・営業時間・臨時休業)。AI web検索の結果を保存して再利用し、
  // 手動修正(manually_verified=true)された行はAI再検索で上書きしない。
  // 書き込みはこのAPI経由のみ(anon/authenticatedはSELECTのみ)。
  facility_operating_info: {
    actions: ['insert', 'updateById', 'deleteById'],
    label: '観光施設営業情報',
  },
};

// learned_mappingsのcategoryはこの4種のみ許可する(bodyの値をそのまま保存しない)。
// bankbook_payer(F16): 通帳OCRの入金消込マッチングで、振込人名等(input_key)と
// 確定したREF#(confirmed_value)の組を学習する。cc_merchantと同じ仕組みを流用。
const LEARNED_MAPPING_CATEGORIES = ['email_sender', 'cc_merchant', 'receipt_merchant', 'bankbook_payer'];

// learned_mappingsへの確定upsert。(category, input_key, confirmed_value)が既に存在すれば
// confirmed_count+1とlast_confirmed_atのみ更新し、無ければ新規行を挿入する。
// entries: [{inputKey, confirmedValue}] (categoryは引数で固定)。学習は補助機能のため、
// 1件の失敗で全体をエラーにせず、失敗件数を返すのみとする。
async function doLearnedUpsertConfirm(category, entries, confirmedBy) {
  if (!LEARNED_MAPPING_CATEGORIES.includes(category)) {
    return { status: 400, body: { error: `不正なcategoryです: ${category}` } };
  }
  if (!Array.isArray(entries) || !entries.length) return { status: 400, body: { error: '学習する内容がありません' } };
  let saved = 0;
  let failed = 0;
  for (const e of entries.slice(0, 50)) {
    const inputKey = String(e && e.inputKey || '').trim();
    const confirmedValue = String(e && e.confirmedValue || '').trim();
    if (!inputKey || !confirmedValue) { failed += 1; continue; }
    try {
      const q = `?category=eq.${encodeURIComponent(category)}&input_key=eq.${encodeURIComponent(inputKey)}&confirmed_value=eq.${encodeURIComponent(confirmedValue)}&select=id,confirmed_count`;
      const selRes = await sbFetch('learned_mappings', q);
      if (!selRes.ok) { failed += 1; continue; }
      const existing = await selRes.json();
      if (existing && existing[0]) {
        const upRes = await sbFetch('learned_mappings', `?id=eq.${encodeURIComponent(existing[0].id)}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ confirmed_count: (Number(existing[0].confirmed_count) || 0) + 1, last_confirmed_at: new Date().toISOString() }),
        });
        if (upRes.ok) saved += 1; else failed += 1;
      } else {
        const insRes = await sbFetch('learned_mappings', '', {
          method: 'POST',
          prefer: 'return=minimal',
          body: JSON.stringify({ category, input_key: inputKey, confirmed_value: confirmedValue, confirmed_by: confirmedBy || null }),
        });
        if (insRes.ok) saved += 1; else failed += 1;
      }
    } catch (err) {
      failed += 1;
    }
  }
  return { status: 200, body: { ok: true, saved, failed } };
}

function sbFetch(table, path, opts = {}) {
  const serviceKey = getServiceKey();
  return fetch(`${SB_URL}/rest/v1/${table}${path}`, {
    ...opts,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

async function readJsonSafe(resp) {
  try { return await resp.json(); } catch (e) { return {}; }
}

// PostgRESTが"permission denied for table xxx"を返す典型的な原因は、RLS/GRANTの
// ロックダウンSQL実行時にservice_roleへのGRANT文が反映されていないケース
// (service_roleはRLSはバイパスするが、テーブル自体へのGRANTが無ければ書き込めない)。
// 原因調査を早くできるよう、その場合だけヒントを付け足す(移行前の各ファイルと同じ対策)。
function withGrantHint(message, table) {
  if (/permission denied for table/i.test(String(message || ''))) {
    return `${message}\n\n（service_roleロールに${table}へのGRANTが付与されていない可能性があります。Supabase SQL Editorで次を再実行してください: grant select, insert, update, delete on public.${table} to service_role; notify pgrst, 'reload schema';）`;
  }
  return message;
}

// audit_logsへの記録(ベストエフォート)。監査ログの記録自体が失敗しても、本来の
// 書き込み操作(insert/update/delete)は既に成功しているため、それを失敗扱いにはしない
// (audit_logsテーブル未作成・一時的な障害等でも本来の業務操作を止めないための設計)。
// entries: [{recordId, action:'insert'|'update'|'delete', before, after}]
async function writeAuditLogs(table, entries, changedBy) {
  if (!Array.isArray(entries) || !entries.length) return;
  const rows = entries
    .filter((e) => e && e.recordId != null)
    .map((e) => ({
      table_name: table,
      record_id: String(e.recordId),
      action: e.action,
      changed_by: changedBy || null,
      before_data: e.before != null ? e.before : null,
      after_data: e.after != null ? e.after : null,
    }));
  if (!rows.length) return;
  try {
    await sbFetch('audit_logs', '', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
  } catch (e) {
    // 監査ログ記録の失敗は握りつぶす(ベストエフォート、上記コメント参照)。
  }
}

// 「新規INSERTに成功してから、既存の旧行だけをidで指定してDELETEする」安全な差分置き換え。
// クライアント側のsafeReplaceBookingRowsと同じ考え方(#782の全削除→再挿入事故の再発防止)。
// config.auditLogが有効な場合、削除される旧行はaction:'delete'、新規挿入した行は
// action:'insert'として、それぞれ行単位でaudit_logsに記録する。
async function doReplace(table, label, bookingId, rows, config, changedBy) {
  if (!bookingId) return { status: 400, body: { error: 'bookingIdが指定されていません' } };
  const needAudit = !!(config && config.auditLog);

  const existingRes = await sbFetch(table, `?booking_id=eq.${encodeURIComponent(bookingId)}&select=${needAudit ? '*' : 'id'}`);
  if (!existingRes.ok) return { status: 500, body: { error: '既存データの確認に失敗しました' } };
  const existing = await existingRes.json();
  const existingIds = (existing || []).map((r) => r.id);

  let insertedRows = [];
  if (Array.isArray(rows) && rows.length) {
    const insRes = await sbFetch(table, '', { method: 'POST', prefer: needAudit ? 'return=representation' : 'return=minimal', body: JSON.stringify(rows) });
    if (!insRes.ok) {
      const e = await readJsonSafe(insRes);
      return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の保存に失敗しました` } };
    }
    if (needAudit) insertedRows = await insRes.json();
  }
  if (existingIds.length) {
    const delRes = await sbFetch(table, `?id=in.(${existingIds.join(',')})`, { method: 'DELETE', prefer: 'return=minimal' });
    if (!delRes.ok) {
      const e = await readJsonSafe(delRes);
      return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の旧データ削除に失敗しました（新データは保存済みのため重複している可能性があります）` } };
    }
  }
  if (needAudit) {
    const entries = [
      ...(existing || []).map((r) => ({ recordId: r.id, action: 'delete', before: r, after: null })),
      ...insertedRows.map((r) => ({ recordId: r.id, action: 'insert', before: null, after: r })),
    ];
    await writeAuditLogs(table, entries, changedBy);
  }
  return { status: 200, body: { ok: true } };
}

// doReplaceの汎用版。booking_id以外のキー列(arrangement_document_id等)で「既存行を
// 全削除→新データ挿入」の置き換えを行いたい場合に使う(クライアント側の
// safeReplaceRowsByKeyのサーバー版)。keyFieldはbodyの値をそのままクエリに埋め込まず、
// allowedDeleteFieldsと同じ考え方でconfig.allowedReplaceKeyFieldsのホワイトリストに
// 含まれる列名のみを許可する。
async function doReplaceByKey(table, label, keyField, keyValue, rows, config) {
  if (!config.allowedReplaceKeyFields || !config.allowedReplaceKeyFields.includes(keyField)) {
    return { status: 400, body: { error: `${table}に対して許可されていないキー列です: ${keyField}` } };
  }
  if (keyValue === undefined || keyValue === null || keyValue === '') return { status: 400, body: { error: 'キー値が指定されていません' } };

  const existingRes = await sbFetch(table, `?${keyField}=eq.${encodeURIComponent(keyValue)}&select=id`);
  if (!existingRes.ok) return { status: 500, body: { error: '既存データの確認に失敗しました' } };
  const existing = await existingRes.json();
  const existingIds = (existing || []).map((r) => r.id);

  if (Array.isArray(rows) && rows.length) {
    const insRes = await sbFetch(table, '', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
    if (!insRes.ok) {
      const e = await readJsonSafe(insRes);
      return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の保存に失敗しました` } };
    }
  }
  if (existingIds.length) {
    const delRes = await sbFetch(table, `?id=in.(${existingIds.join(',')})`, { method: 'DELETE', prefer: 'return=minimal' });
    if (!delRes.ok) {
      const e = await readJsonSafe(delRes);
      return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の旧データ削除に失敗しました（新データは保存済みのため重複している可能性があります）` } };
    }
  }
  return { status: 200, body: { ok: true } };
}

// F1(見積もりコピー機能、copyEstimation)専用。ヘッダ1件をinsertし、続けて
// config.copyChildTablesに列挙された子テーブルへ、新しいヘッダのidを紐付けてinsertする。
// 子テーブルのいずれかが失敗した場合、それまでにinsertした子テーブル行(子テーブル単位で
// 一括DELETE)とヘッダ自身を削除してロールバックする(中途半端な見積もりが残らないように
// する。クライアント側の従来の手動ロールバックをサーバー側に移した)。
// children: { [childTable]: rows[] }。childTable名はcopyChildTablesのホワイトリストに
// 無いものは拒否する。各行のキー列(estimation_id)は呼び出し側で新IDをまだ知らないため
// ここで補完する(childRow.estimation_id = 新ヘッダid)。
async function doCopyWithChildren(table, config, headerRow, children) {
  if (!headerRow) return { status: 400, body: { error: 'コピー元のヘッダデータがありません' } };
  const allowedChildTables = config.copyChildTables || [];
  const childEntries = Object.entries(children || {});
  for (const [childTable] of childEntries) {
    if (!allowedChildTables.includes(childTable)) {
      return { status: 400, body: { error: `コピーが許可されていない子テーブルです: ${childTable}` } };
    }
  }

  const insRes = await sbFetch(table, '', { method: 'POST', prefer: 'return=representation', body: JSON.stringify([headerRow]) });
  if (!insRes.ok) {
    const e = await readJsonSafe(insRes);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${config.label}のコピーに失敗しました` } };
  }
  const [created] = await insRes.json();
  const newId = created.id;

  const insertedChildTables = [];
  for (const [childTable, rows] of childEntries) {
    if (!Array.isArray(rows) || !rows.length) continue;
    const childRows = rows.map((r) => ({ ...r, estimation_id: newId }));
    const cRes = await sbFetch(childTable, '', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(childRows) });
    if (!cRes.ok) {
      const e = await readJsonSafe(cRes);
      // ロールバック: これまでinsertできた子テーブルとヘッダ自身を削除する
      for (const t of insertedChildTables) {
        await sbFetch(t, `?estimation_id=eq.${encodeURIComponent(newId)}`, { method: 'DELETE', prefer: 'return=minimal' });
      }
      await sbFetch(table, `?id=eq.${encodeURIComponent(newId)}`, { method: 'DELETE', prefer: 'return=minimal' });
      return {
        status: 500,
        body: { error: (withGrantHint(e.message, childTable) || `${childTable}のコピーに失敗しました`) + '(作成しかけた見積もりはロールバックしました)' },
      };
    }
    insertedChildTables.push(childTable);
  }
  return { status: 200, body: { ok: true, row: created } };
}

// insertと同じだが、挿入直後にDBが採番したid等をクライアントに返す必要がある場合
// (例: submitNewGuideがガイド新規登録直後にそのidを予約行へ紐付ける)に使う。
async function doInsertReturning(table, label, rows) {
  if (!Array.isArray(rows) || !rows.length) return { status: 400, body: { error: '追加する行がありません' } };
  const insRes = await sbFetch(table, '', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(rows) });
  if (!insRes.ok) {
    const e = await readJsonSafe(insRes);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の保存に失敗しました` } };
  }
  const inserted = await insRes.json();
  return { status: 200, body: { ok: true, rows: inserted } };
}

async function doInsert(table, label, rows, config, changedBy) {
  if (!Array.isArray(rows) || !rows.length) return { status: 400, body: { error: '追加する行がありません' } };
  const needAudit = !!(config && config.auditLog);
  const insRes = await sbFetch(table, '', { method: 'POST', prefer: needAudit ? 'return=representation' : 'return=minimal', body: JSON.stringify(rows) });
  if (!insRes.ok) {
    const e = await readJsonSafe(insRes);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の保存に失敗しました` } };
  }
  // needAudit時はどのみちreturn=representationで挿入後の行(採番id含む)を取得しているため、
  // 監査ログ記録だけでなく呼び出し元にもそのまま返す(insertReturningを使わずに済むように)。
  // 既存の呼び出し元は追加フィールド(rows)を無視するだけなので後方互換に影響しない。
  if (needAudit) {
    const inserted = await insRes.json();
    await writeAuditLogs(table, inserted.map((r) => ({ recordId: r.id, action: 'insert', before: null, after: r })), changedBy);
    return { status: 200, body: { ok: true, rows: inserted } };
  }
  return { status: 200, body: { ok: true } };
}

async function doDeleteByBooking(table, label, bookingId) {
  if (!bookingId) return { status: 400, body: { error: 'bookingIdが指定されていません' } };
  const delRes = await sbFetch(table, `?booking_id=eq.${encodeURIComponent(bookingId)}`, { method: 'DELETE', prefer: 'return=minimal' });
  if (!delRes.ok) {
    const e = await readJsonSafe(delRes);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の削除に失敗しました` } };
  }
  return { status: 200, body: { ok: true } };
}

// booking_sales専用: 入金消込(通帳OCRの自動マッチング等)で、既存1行のpaymentsのみを更新する。
async function doUpdatePayments(table, rowId, payments) {
  if (!rowId) return { status: 400, body: { error: 'rowIdが指定されていません' } };
  const upRes = await sbFetch(table, `?id=eq.${encodeURIComponent(rowId)}`, {
    method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ payments }),
  });
  if (!upRes.ok) {
    const e = await readJsonSafe(upRes);
    return { status: 500, body: { error: withGrantHint(e.message, table) || '入金反映に失敗しました' } };
  }
  return { status: 200, body: { ok: true } };
}

// parking_reservations専用: 一覧取得。テーブル未作成時はエラーにせず空配列を返す
// (移行前のparking-reservations.jsと同じフォールバック挙動)。
async function doParkingList(table, limit) {
  const lim = Number(limit) > 0 ? Math.min(Number(limit), 200) : 10;
  const r = await sbFetch(table, `?select=*&order=created_at.desc&limit=${lim}`);
  if (!r.ok) {
    const e = await readJsonSafe(r);
    if (/relation .* does not exist/i.test(e.message || '')) return { status: 200, body: { rows: [], tableMissing: true } };
    return { status: 500, body: { error: withGrantHint(e.message, table) || '一覧の取得に失敗しました' } };
  }
  const rows = await r.json();
  return { status: 200, body: { rows } };
}

// parking_reservations専用: idがあれば更新、なければ新規作成(upsert)。
async function doParkingSave(table, id, payload) {
  if (!payload || typeof payload !== 'object') return { status: 400, body: { error: '保存する内容がありません' } };

  if (id) {
    const r = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const e = await readJsonSafe(r);
      return { status: 500, body: { error: withGrantHint(e.message, table) || '更新に失敗しました' } };
    }
    const rows = await r.json();
    return { status: 200, body: { ok: true, row: rows[0] || null } };
  }

  const r = await sbFetch(table, '', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(payload) });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    if (/relation .* does not exist/i.test(e.message || '')) {
      return { status: 500, body: { error: `${table}テーブルが未作成です。管理者にSupabase側でのテーブル作成を依頼してください。` } };
    }
    return { status: 500, body: { error: withGrantHint(e.message, table) || '登録に失敗しました' } };
  }
  const rows = await r.json();
  return { status: 200, body: { ok: true, row: rows[0] || null } };
}

async function doParkingDelete(table, id) {
  if (!id) return { status: 400, body: { error: 'idが指定されていません' } };
  const r = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || '削除に失敗しました' } };
  }
  return { status: 200, body: { ok: true } };
}

// 汎用actions(主にguide_settlements/guide_settlement_items向け。社内スタッフは
// これまでもanonキーで全フィールドを自由に読み書きできていたため、フィールドの
// ホワイトリスト化はせず、認証(有効なログインセッション)のみを要件とする。
async function doUpdateById(table, label, id, fields, config, changedBy) {
  if (!id) return { status: 400, body: { error: 'idが指定されていません' } };
  if (!fields || typeof fields !== 'object') return { status: 400, body: { error: '更新内容が指定されていません' } };
  const needAudit = !!(config && config.auditLog);
  let beforeRow = null;
  if (needAudit) {
    const beforeRes = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}&select=*`);
    if (beforeRes.ok) {
      const beforeRows = await beforeRes.json();
      beforeRow = beforeRows && beforeRows[0] ? beforeRows[0] : null;
    }
  }
  // return=representationにして更新後の行を返す。呼び出し元(bookings.saveBookingDetail等)が
  // 「更新対象の行が実際に存在したか(0件更新でないか)」を判定するために使う。
  const r = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(fields) });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の更新に失敗しました` } };
  }
  const updatedRows = await r.json();
  if (needAudit && updatedRows && updatedRows[0]) {
    await writeAuditLogs(table, [{ recordId: id, action: 'update', before: beforeRow, after: updatedRows[0] }], changedBy);
  }
  return { status: 200, body: { ok: true, rows: updatedRows } };
}

async function doUpdateByIds(table, label, ids, fields, config, changedBy) {
  if (!Array.isArray(ids) || !ids.length) return { status: 400, body: { error: 'idが指定されていません' } };
  if (!fields || typeof fields !== 'object') return { status: 400, body: { error: '更新内容が指定されていません' } };
  const needAudit = !!(config && config.auditLog);
  let beforeRows = [];
  if (needAudit) {
    const beforeRes = await sbFetch(table, `?id=in.(${ids.map(encodeURIComponent).join(',')})&select=*`);
    if (beforeRes.ok) beforeRows = await beforeRes.json();
  }
  const r = await sbFetch(table, `?id=in.(${ids.map(encodeURIComponent).join(',')})`, { method: 'PATCH', prefer: needAudit ? 'return=representation' : 'return=minimal', body: JSON.stringify(fields) });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の更新に失敗しました` } };
  }
  if (needAudit) {
    const afterRows = await r.json();
    const beforeById = {};
    beforeRows.forEach((row) => { beforeById[row.id] = row; });
    await writeAuditLogs(table, afterRows.map((row) => ({ recordId: row.id, action: 'update', before: beforeById[row.id] || null, after: row })), changedBy);
  }
  return { status: 200, body: { ok: true } };
}

async function doDeleteById(table, label, id, config, changedBy) {
  if (!id) return { status: 400, body: { error: 'idが指定されていません' } };
  const needAudit = !!(config && config.auditLog);
  let beforeRow = null;
  if (needAudit) {
    const beforeRes = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}&select=*`);
    if (beforeRes.ok) {
      const beforeRows = await beforeRes.json();
      beforeRow = beforeRows && beforeRows[0] ? beforeRows[0] : null;
    }
  }
  const r = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の削除に失敗しました` } };
  }
  if (needAudit && beforeRow) {
    await writeAuditLogs(table, [{ recordId: id, action: 'delete', before: beforeRow, after: null }], changedBy);
  }
  return { status: 200, body: { ok: true } };
}

async function doDeleteByIds(table, label, ids, config, changedBy) {
  if (!Array.isArray(ids) || !ids.length) return { status: 400, body: { error: 'idが指定されていません' } };
  const needAudit = !!(config && config.auditLog);
  let beforeRows = [];
  if (needAudit) {
    const beforeRes = await sbFetch(table, `?id=in.(${ids.map(encodeURIComponent).join(',')})&select=*`);
    if (beforeRes.ok) beforeRows = await beforeRes.json();
  }
  const r = await sbFetch(table, `?id=in.(${ids.map(encodeURIComponent).join(',')})`, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の削除に失敗しました` } };
  }
  if (needAudit && beforeRows.length) {
    await writeAuditLogs(table, beforeRows.map((row) => ({ recordId: row.id, action: 'delete', before: row, after: null })), changedBy);
  }
  return { status: 200, body: { ok: true } };
}

// field/valueによる読み取りは、TABLE_CONFIG.allowedListFieldsに明示されている列に限定する
// (bodyから任意の列名を受け取ってそのままクエリに埋め込むことを避けるため)。銀行口座情報
// (guide_bank_accounts)等、anonへのSELECT解放をしたくない機密性の高いテーブルを
// service_role経由で安全に読み取るために追加した(F: ガイド銀行口座情報の出金伝票反映)。
async function doListByField(table, label, config, field, value) {
  if (!config.allowedListFields || !config.allowedListFields.includes(field)) {
    return { status: 400, body: { error: `${table}に対して許可されていない検索条件です: ${field}` } };
  }
  if (value === undefined || value === null || value === '') return { status: 400, body: { error: '検索条件の値が指定されていません' } };
  const filter = Array.isArray(value) ? `in.(${value.map(encodeURIComponent).join(',')})` : `eq.${encodeURIComponent(value)}`;
  const r = await sbFetch(table, `?${field}=${filter}&select=*`, { method: 'GET' });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の取得に失敗しました` } };
  }
  const rows = await r.json();
  return { status: 200, body: { ok: true, rows } };
}

// field/valueによる削除は、TABLE_CONFIG.allowedDeleteFieldsに明示されている列に限定する
// (bodyから任意の列名を受け取ってそのままクエリに埋め込むことを避けるため)。
async function doDeleteByField(table, label, config, field, value) {
  if (!config.allowedDeleteFields || !config.allowedDeleteFields.includes(field)) {
    return { status: 400, body: { error: `${table}に対して許可されていない削除条件です: ${field}` } };
  }
  if (value === undefined || value === null || value === '') return { status: 400, body: { error: '削除条件の値が指定されていません' } };
  const filter = Array.isArray(value) ? `in.(${value.map(encodeURIComponent).join(',')})` : `eq.${encodeURIComponent(value)}`;
  const r = await sbFetch(table, `?${field}=${filter}`, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の削除に失敗しました` } };
  }
  return { status: 200, body: { ok: true } };
}

// guide.html(ログイン機構を持たない、精算リンクのaccess_tokenのみで認証)からの
// リクエスト用。access_tokenをguide_settlementsテーブルに照会し、該当する精算レコード
// (guestSettlement)を返す。見つからなければ「リンクが無効」として扱う。
async function resolveGuestSettlement(guestToken) {
  if (!guestToken) return null;
  const r = await sbFetch('guide_settlements', `?access_token=eq.${encodeURIComponent(guestToken)}&select=id,booking_ref,status`);
  if (!r.ok) return null;
  const rows = await r.json();
  return rows && rows[0] ? rows[0] : null;
}

// ガイド本人によるguide_settlement_items新規送信(領収書等)。クライアントが送ってきた
// settlement_idは信用せず、access_tokenから解決した本人の精算IDを必ず全行に強制設定する
// (他人の精算リンクのaccess_tokenを使わない限り、他の精算への書き込みはできない)。
async function doGuestInsert(table, label, rows, guestSettlement, config) {
  if (!Array.isArray(rows) || !rows.length) return { status: 400, body: { error: '追加する行がありません' } };
  const safeRows = rows.map((row) => ({ ...row, settlement_id: guestSettlement.id }));
  // ガイド本人にはログインセッションが無いため、changed_by/created_byは常にnull(スタンプしない)。
  return doInsert(table, label, safeRows, config, null);
}

// ガイド本人によるguide_settlement_items編集(受領書番号の修正等)。
// 1) 更新可能フィールドをTABLE_CONFIG.guestUpdatableFieldsでホワイトリスト化
// 2) 対象行が自分の精算(guestSettlement.id)に属することを更新前に確認
async function doGuestUpdateById(table, label, config, id, fields, guestSettlement) {
  if (!id) return { status: 400, body: { error: 'idが指定されていません' } };
  const allowed = config.guestUpdatableFields || [];
  const safeFields = {};
  Object.keys(fields || {}).forEach((k) => { if (allowed.includes(k)) safeFields[k] = fields[k]; });
  if (Object.keys(safeFields).length === 0) return { status: 400, body: { error: '更新可能な項目がありません' } };

  const checkRes = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}&select=id,settlement_id`);
  if (!checkRes.ok) return { status: 500, body: { error: '対象データの確認に失敗しました' } };
  const checkRows = await checkRes.json();
  if (!checkRows || !checkRows[0] || checkRows[0].settlement_id !== guestSettlement.id) {
    return { status: 403, body: { error: 'この項目を編集する権限がありません' } };
  }
  // ガイド本人にはログインセッションが無いため、changed_by/updated_byは常にnull(スタンプしない)。
  return doUpdateById(table, label, id, safeFields, config, null);
}

// 読み取り専用: 指定table_name+record_idのaudit_logsを新しい順に返す(変更履歴ボタン用)。
// ログインセッションのみを要件とし(guestアクションからは呼ばれない)、対象tableは
// TABLE_CONFIG上でauditLog:trueのものに限定する(監査対象外テーブルの履歴詮索を防ぐ)。
async function doAuditHistory(targetTable, recordId) {
  if (!targetTable || !recordId) return { status: 400, body: { error: 'table/recordIdが指定されていません' } };
  const targetConfig = TABLE_CONFIG[targetTable];
  if (!targetConfig || !targetConfig.auditLog) {
    return { status: 400, body: { error: `${targetTable}は変更履歴の対象外です` } };
  }
  const r = await sbFetch(
    'audit_logs',
    `?table_name=eq.${encodeURIComponent(targetTable)}&record_id=eq.${encodeURIComponent(recordId)}&order=changed_at.desc&select=*`
  );
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, 'audit_logs') || '変更履歴の取得に失敗しました' } };
  }
  const rows = await r.json();
  return { status: 200, body: { ok: true, rows } };
}

// 旧エンドポイント(/api/booking-costs等)からのリクエストの後方互換対応。
// 統合前のフロントエンドJSがブラウザに残ったまま(デプロイ後もタブを開きっぱなしのユーザー)
// でも、bodyにtableが無い場合はvercel.jsonのルーティングで付与されるlegacyTableクエリ
// パラメータから推測してtable-crud.jsの処理に合流させることで、「デプロイ直後は動くが、
// 既に開いていたタブだけ404で保存できない」という事故を防ぐ(2026-07-27 本番インシデント対応)。
// vercel.jsonでこれらの旧パスは全てこの同じapi/table-crud.jsにルーティングされる
// (別ファイルではないためVercelの関数数は増えない)。
// 保存処理のボトルネック調査用の計測(2026-08時点、体感の保存遅延の原因切り分けのため一時追加)。
// globalThisはVercelのサーバーレス関数インスタンスが使い回される(=ウォーム)間は保持される
// ため、その最初の1回だけcoldStart:trueになる。レスポンスJSONに__metaとして
// {serverMs, coldStart}を付加するだけで、他の処理・レスポンス形状には一切影響しない。
export default async function handler(req, res) {
  const __reqT0 = Date.now();
  const __wasCold = !globalThis.__tableCrudWarm;
  globalThis.__tableCrudWarm = true;
  const __origJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object') {
      body.__meta = { serverMs: Date.now() - __reqT0, coldStart: __wasCold };
    }
    return __origJson(body);
  };

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!getServiceKey()) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  const body = req.body || {};
  const table = body.table || (req.query && req.query.legacyTable);
  const { action, token, guestToken } = body;

  // guestInsert/guestUpdateByIdのみ、ログインセッションを持たないguide.html(ガイド本人が
  // 精算リンクのaccess_tokenだけでアクセスする画面)からの呼び出しを許可する。それ以外の
  // 全actionは、これまで通り社内スタッフのログインセッショントークン検証を必須とする。
  const isGuestAction = action === 'guestInsert' || action === 'guestUpdateById' || action === 'guestUpsertConfirm';
  let guestSettlement = null;
  let session = null;
  if (isGuestAction) {
    guestSettlement = await resolveGuestSettlement(guestToken);
    if (!guestSettlement) return res.status(401).json({ error: '精算リンクが無効です。リンクの有効期限が切れているか、URLが正しくない可能性があります。' });
  } else {
    session = verifySessionToken(token);
    if (!session) return res.status(401).json({ error: 'ログインセッションが無効です。再度ログインしてください。' });
  }

  // auditHistoryは特定テーブルのactionホワイトリストに属さない横断的な読み取り専用action
  // (変更履歴ボタン用)。ゲスト操作からは呼ばれない(isGuestActionの場合ここには来ない)。
  if (action === 'auditHistory') {
    const { recordId } = req.body;
    const result = await doAuditHistory(table, recordId);
    return res.status(result.status).json(result.body);
  }

  const config = TABLE_CONFIG[table];
  if (!config) return res.status(400).json({ error: `不明なtableです: ${table}` });
  if (!config.actions.includes(action)) return res.status(400).json({ error: `${table}に対して許可されていないactionです: ${action}` });

  // 監査ログ機能の前提整備(セキュリティ移行バッチA)：created_by/updated_byは
  // クライアントの自己申告値を一切使わず、verifySessionTokenで検証済みのemailのみを
  // サーバー側でスタンプする(guide_settlements等の既存created_byが「クライアントの
  // 自己申告値をそのまま信用する」設計になっている問題を、stampIdentity対象テーブルでは
  // 再現しない)。audit_logsのchanged_byも同じ検証済みemailを使う(stampIdentityの有無に
  // 関わらず、セッションがあれば常にchangedByとして使える。ゲスト操作はsessionが常にnullの
  // ためchangedByも自動的にnullになる)。
  const stampEmail = config.stampIdentity && session ? session.email : null;
  const changedBy = session ? session.email : null;
  function stampNewRows(rows) {
    if (!Array.isArray(rows)) return rows;
    // vendor_email_logs等、created_by/updated_byではなく専用の1列(例: sent_by)のみを
    // 検証済みemailでスタンプしたいテーブル向け。stampIdentityとは独立して機能する。
    if (config.stampSentByField) {
      return rows.map((r) => ({ ...r, [config.stampSentByField]: changedBy }));
    }
    if (!stampEmail) return rows;
    const extra = config.stampUpdatedAt ? { updated_at: new Date().toISOString() } : {};
    return rows.map((r) => ({ ...r, created_by: stampEmail, updated_by: stampEmail, ...extra }));
  }
  function stampUpdateFields(fields) {
    if (!stampEmail || !fields || typeof fields !== 'object') return fields;
    const extra = config.stampUpdatedAt ? { updated_at: new Date().toISOString() } : {};
    return { ...fields, updated_by: stampEmail, ...extra };
  }

  // config.updatableFieldsが設定されているテーブルでは、そこに列挙された列だけを更新可能とする
  // (email_import_queue等、本文のような機微な列をこのAPIから書き換えられないようにするため)。
  // 許可されていない列が1つでも含まれていた場合は、黙って捨てるのではなく明示的に400で拒否する
  // (クライアント側の実装ミスを気づかず握り潰さないため)。
  function validateUpdatableFields(fields) {
    if (!config.updatableFields) return null;
    if (!fields || typeof fields !== 'object') return { status: 400, body: { error: '更新内容が指定されていません' } };
    const invalid = Object.keys(fields).filter((k) => !config.updatableFields.includes(k));
    if (invalid.length) {
      return { status: 400, body: { error: `${table}に対して更新が許可されていない項目です: ${invalid.join(', ')}` } };
    }
    return null;
  }

  // 特定の列に特定の値を書き込む操作を、指定のメールアドレスのみに制限する
  // (例: email_import_queueのexcluded_reason='手動で対象外に設定')。
  // クライアント側のボタン表示制御に加えた二重の防御で、検証済みセッションのemailで判定する。
  function checkRestrictedFieldValues(fields) {
    if (!config.restrictedFieldValues || !fields || typeof fields !== 'object') return null;
    for (const rule of config.restrictedFieldValues) {
      if (fields[rule.field] === rule.value) {
        if (!changedBy || !rule.allowedEmails.includes(changedBy)) {
          return { status: 403, body: { error: rule.message } };
        }
      }
    }
    return null;
  }

  // booking_costsの「出金日」(payment_date)欄は、経理担当者以外はクライアント側で
  // 入力欄自体が無効化されているが、それはUI上の制御に過ぎず、有効なセッション
  // トークンさえあればAPIを直接叩いて書き換えられる抜け穴があった(2026-08-12点検で
  // 発見)。booking_costsはdoReplace(全削除→再挿入)方式で保存されるため、
  // guide_settlementsのような「特定の値」への単純な制限では対応できない
  // (idが毎回変わるため、新規行と既存行を内容(仕入先名+金額+出金日以外の内容)で
  // 緩やかに照合し、出金日だけが変更されている行を検出する。remapCostSourceIds等の
  // 既存の「内容一致で対応付ける」パターンと同じ考え方)。一意に対応付けられない場合は
  // 誤検知で全スタッフの通常保存を止めてしまう方が実害が大きいため、安全側(=許可)に倒す。
  async function checkBookingCostsPaymentDateRestriction(bookingId, rows) {
    if (!bookingId || !Array.isArray(rows)) return null;
    if (changedBy && ACCOUNTING_EMAILS.includes(changedBy)) return null;
    const existingRes = await sbFetch('booking_costs', `?booking_id=eq.${encodeURIComponent(bookingId)}&select=item_name,amount,memo,payment_date`);
    if (!existingRes.ok) return null; // 確認自体に失敗した場合は誤って全員をブロックしないよう許可する
    const existing = await existingRes.json();
    const usedExisting = new Set();
    for (const row of rows) {
      const match = (existing || []).find((e, i) =>
        !usedExisting.has(i) && e.item_name === (row.item_name || '') && Number(e.amount || 0) === Number(row.amount || 0) && (e.memo || '') === (row.memo || ''));
      if (!match) continue; // 対応する既存行が一意に見つからない(新規行等)場合は対象外
      usedExisting.add(existing.indexOf(match));
      const existingDate = match.payment_date || null;
      const newDate = row.payment_date || null;
      if (existingDate !== newDate) {
        return { status: 403, body: { error: '仕入明細の出金日は経理担当者のみ変更できます。' } };
      }
    }
    return null;
  }

  try {
    if (action === 'replace') {
      const { bookingId, rows } = req.body;
      if (table === 'booking_costs') {
        const denied = await checkBookingCostsPaymentDateRestriction(bookingId, rows);
        if (denied) return res.status(denied.status).json(denied.body);
      }
      const result = await doReplace(table, config.label, bookingId, stampNewRows(rows), config, changedBy);
      return res.status(result.status).json(result.body);
    }
    if (action === 'insert') {
      const { rows } = req.body;
      const result = await doInsert(table, config.label, stampNewRows(rows), config, changedBy);
      return res.status(result.status).json(result.body);
    }
    if (action === 'replaceByKey') {
      const { keyField, keyValue, rows } = req.body;
      const result = await doReplaceByKey(table, config.label, keyField, keyValue, stampNewRows(rows), config);
      return res.status(result.status).json(result.body);
    }
    if (action === 'insertReturning') {
      const { rows } = req.body;
      const result = await doInsertReturning(table, config.label, rows);
      return res.status(result.status).json(result.body);
    }
    if (action === 'copyWithChildren') {
      const { headerFields, children } = req.body;
      const stampedHeader = stampNewRows([headerFields])[0];
      const result = await doCopyWithChildren(table, config, stampedHeader, children);
      return res.status(result.status).json(result.body);
    }
    if (action === 'deleteByBooking') {
      const { bookingId } = req.body;
      const result = await doDeleteByBooking(table, config.label, bookingId);
      return res.status(result.status).json(result.body);
    }
    if (action === 'updatePayments') {
      const { rowId, payments } = req.body;
      const result = await doUpdatePayments(table, rowId, payments);
      return res.status(result.status).json(result.body);
    }
    if (action === 'list') {
      const { limit } = req.body;
      const result = await doParkingList(table, limit);
      return res.status(result.status).json(result.body);
    }
    if (action === 'save') {
      const { id, payload } = req.body;
      const result = await doParkingSave(table, id, payload);
      return res.status(result.status).json(result.body);
    }
    if (action === 'delete') {
      const { id } = req.body;
      const result = await doParkingDelete(table, id);
      return res.status(result.status).json(result.body);
    }
    if (action === 'updateById') {
      const { id, fields } = req.body;
      const invalid = validateUpdatableFields(fields);
      if (invalid) return res.status(invalid.status).json(invalid.body);
      const denied = checkRestrictedFieldValues(fields);
      if (denied) return res.status(denied.status).json(denied.body);
      const result = await doUpdateById(table, config.label, id, stampUpdateFields(fields), config, changedBy);
      return res.status(result.status).json(result.body);
    }
    if (action === 'updateByIds') {
      const { ids, fields } = req.body;
      const invalid = validateUpdatableFields(fields);
      if (invalid) return res.status(invalid.status).json(invalid.body);
      const denied = checkRestrictedFieldValues(fields);
      if (denied) return res.status(denied.status).json(denied.body);
      const result = await doUpdateByIds(table, config.label, ids, fields, config, changedBy);
      return res.status(result.status).json(result.body);
    }
    if (action === 'deleteById') {
      const { id } = req.body;
      const result = await doDeleteById(table, config.label, id, config, changedBy);
      return res.status(result.status).json(result.body);
    }
    if (action === 'deleteByIds') {
      const { ids } = req.body;
      const result = await doDeleteByIds(table, config.label, ids, config, changedBy);
      return res.status(result.status).json(result.body);
    }
    if (action === 'deleteByField') {
      const { field, value } = req.body;
      const result = await doDeleteByField(table, config.label, config, field, value);
      return res.status(result.status).json(result.body);
    }
    if (action === 'listByField') {
      const { field, value } = req.body;
      const result = await doListByField(table, config.label, config, field, value);
      return res.status(result.status).json(result.body);
    }
    if (action === 'upsertConfirm') {
      const { category, entries } = req.body;
      const result = await doLearnedUpsertConfirm(category, entries, changedBy);
      return res.status(result.status).json(result.body);
    }
    if (action === 'guestUpsertConfirm') {
      // ゲスト(ガイド本人)からの学習はレシートカテゴリのみ。categoryはbodyの値を使わず
      // サーバー側で強制し、confirmed_byはログインセッションが無いためnullのままとする。
      const { entries } = req.body;
      const result = await doLearnedUpsertConfirm('receipt_merchant', entries, null);
      return res.status(result.status).json(result.body);
    }
    if (action === 'guestInsert') {
      const { rows } = req.body;
      const result = await doGuestInsert(table, config.label, rows, guestSettlement, config);
      return res.status(result.status).json(result.body);
    }
    if (action === 'guestUpdateById') {
      const { id, fields } = req.body;
      const result = await doGuestUpdateById(table, config.label, config, id, fields, guestSettlement);
      return res.status(result.status).json(result.body);
    }

    return res.status(400).json({ error: '不明なactionです' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
