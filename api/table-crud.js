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
import {
  MIN_WRITE_APP_VERSION, APP_VERSION_OUTDATED_CODE, APP_VERSION_OUTDATED_MESSAGE,
  getRequestAppVersion, isAppVersionAllowedForWrite, getDeploymentId, setAppVersionResponseHeaders,
} from './lib/app-version.js';

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
// クライアント側(index.html)のACCOUNTING_EMAILSと同じ一覧。経理担当者限定操作の
// サーバー側チェック(checkBookingCostsPaymentDateRestriction等)で使う。
const ACCOUNTING_EMAILS = ['admin@kictravel.jp', 'kanri@kictravel.jp'];
// クライアント側(index.html)のERROR_LOG_VIEWER_EMAILSと同じ一覧。error_logsのlistアクションは
// isErrorLogViewer()によるUI制御(メニュー非表示)だけでなく、有効なセッションさえあれば誰でも
// 叩けてしまわないよう、サーバー側でもここに含まれるemailのみに制限する。
const ERROR_LOG_VIEWER_EMAILS = ['admin@kictravel.jp', 'jr@kictravel.jp'];
// クライアント側(index.html)のCARD_HOLDER_ADMIN_EMAILSと同じ一覧。card_holders(カード名義人
// マスタ)のinsert/updateByIdは、isCardHolderAdmin()によるUI制御(メニュー非表示・go()の
// ガード)だけでなく、有効なセッションさえあれば誰でも叩けてしまわないよう、サーバー側でも
// ここに含まれるemailのみに制限する(error_logsのlistアクションと同じ考え方)。
const CARD_HOLDER_ADMIN_EMAILS = ['admin@kictravel.jp'];
// bookings(予約本体)のdeleteByIdのみに適用する制限。予約詳細モーダルの削除ボタンは
// admin-onlyクラスでUI表示を制御しているだけで、有効なセッションさえあればstaff等の
// 他ロールでも直接APIを叩けてしまう抜け穴があった(2026-08-19点検で発見)。card_holders
// と同じ考え方でサーバー側にも二重の防御を追加する。insert/updateByIdは従来通り
// 全ロールで利用できる必要があるため対象外(deleteByIdのみ)。
const BOOKING_DELETE_ADMIN_EMAILS = ['admin@kictravel.jp'];

// テーブルごとに許可するactionをホワイトリスト化する。ここに無い(table, action)の
// 組み合わせは400で拒否する。
const TABLE_CONFIG = {
  // booking_sales/booking_costsのstampIdentity/auditLogは、replace/insertアクションのみが
  // 対象(updatePayments/deleteByBookingは今回のスコープ外、既存の挙動のまま変更しない)。
  // updateByIdはremapSalesAgentIds()(replace後のagent_id付け替え)専用に追加した
  // (2026-08、REF#967のagent_id消失不具合の恒久対応)。
  booking_sales: {
    actions: ['replace', 'updatePayments', 'deleteByBooking', 'updateById'], label: '売上明細', stampIdentity: true, auditLog: true,
    // readable: query/queryBatch action(読み取り専用、RLS対応フェーズ2 バッチ1)で許可する
    // 絞り込み列と演算子・並び替え列のホワイトリスト(doQueryPage参照)。
    readable: {
      filters: { booking_id: ['eq', 'in'] },
      order: ['sort_order', 'created_at', 'id'],
    },
  },
  // booking_costsは書き込みが全てこのAPI経由であることを確認済み(直接anon書き込み0件)。
  // 毎時バックアップの差分化のためupdated_at列を追加し(scripts/add_updated_at_to_booking_costs.sql)、
  // booking_buses/booking_restaurantsと同じ方式でサーバー側に確実にスタンプする。
  // auditDiffIgnoreFields: source_idはremapCostSourceIds()(index.html)により、この行自体の
  // 内容とは無関係な理由(連携元のホテル/バス/レストラン/観光施設タブが別に保存され、
  // それらのidが変わった)で書き換わる。この列だけを理由に「内容が変わった」と audit_logs に
  // 記録してしまうと、他のタブの保存のたびにbooking_costs全行がdelete+insertとして記録され
  // 続けてしまう(2026-08-22点検で判明した肥大化の主因)。doReplace()の新旧内容比較から
  // この列を除外することで、実際にitem_name/amount等が変わった行だけを記録する。
  // source_table/source_snapshotは追加時点で1回だけセットされ以後変化しないため除外しない。
  booking_costs: {
    actions: ['replace', 'insert', 'deleteByBooking'], label: '仕入明細', stampIdentity: true, stampUpdatedAt: true, auditLog: true, auditDiffIgnoreFields: ['source_id'],
    readable: {
      filters: {
        booking_id: ['eq', 'in'],
        id: ['eq'],
        item_name: ['eq'],
        memo: ['eq', 'isNull', 'ilikeContains'],
        payment_method: ['eq', 'in', 'isNull'],
        amount: ['eq'],
        payment_date: ['isNull'],
      },
      order: ['created_at', 'id'],
    },
  },
  // deleteByBookingは予約削除(deleteBookingData)用(2026-08-12点検で追加。それまで予約削除の削除対象から漏れていた)
  local_expenses: { actions: ['replace', 'deleteByBooking'], label: '現地費用明細' },
  parking_reservations: { actions: ['list', 'save', 'delete'], label: '駐車場予約' },
  // error_logsはRLS無効・anonにSELECT/INSERT/UPDATE/DELETE/TRUNCATE全権限が付与されたまま
  // 放置されており、公開anonキーだけで全ユーザーのエラーログ(スタックトレース含む)を
  // 誰でも閲覧・改ざん・削除できる状態だった(2026-08-14点検で発見)。まず読み取り(list)
  // のみをこのAPI経由(service_role key)に切替え、書き込み(INSERT)はlogError()から
  // 従来どおりanonキーで行う(anonにはINSERTのみ残す想定。剥奪自体はscripts/
  // lock_down_error_logs_writes.sqlをJUNさんが実行してから有効になる)。
  error_logs: { actions: ['list'], label: 'エラーログ' },
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
  // stampUpdatedAt(2026-09-08追加): 従来はindex.html側の各updateById呼び出しが個別に
  // updated_atをセットしており、たまたま全箇所で一貫していただけでサーバー側の保証が
  // 無かった(email_import_queueで実際に発生した「anon直接書き込みでupdated_atが
  // 更新されず差分バックアップから漏れる」問題と同じ構造的リスク)。booking_costs等と
  // 同じ方式に揃え、クライアントの自己申告値を使わずサーバー側で確実にスタンプする。
  bookings: {
    actions: ['insert', 'updateById', 'deleteById'],
    label: '予約',
    stampIdentity: true,
    stampUpdatedAt: true,
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
    actions: ['updateById', 'insert', 'replace', 'deleteByBooking', 'markCostAdded'],
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
    actions: ['replace', 'insert', 'updateById', 'deleteByBooking', 'markCostAdded'],
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
    actions: ['replace', 'deleteByBooking', 'updateById', 'markCostAdded'],
    label: 'バス明細',
    stampIdentity: true,
    stampUpdatedAt: true,
    auditLog: true,
    updatableFields: ['status'],
  },
  booking_restaurants: {
    actions: ['replace', 'deleteByBooking', 'markCostAdded'],
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
  // markCostAdded: 手配タブ「仕入明細へ追加」ボタンのcost_added更新専用(下記handler参照)。
  // booking_water_itemsはcreated_by/updated_by列を持たないためstampIdentityは付けない。
  booking_water_items: { actions: ['replace', 'deleteByBooking', 'markCostAdded'], label: 'ミネラルウォーター明細' },
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
  // business_partner_contacts(取引先マスタ担当者・フェーズ1): business_partners自体は
  // 変更せず、同じ会社に複数の担当者を紐付けるための新設テーブル。partner_merge_pending
  // と同じ方針で最初からservice_role専用の書き込みとする(scripts/
  // create_business_partner_contacts_table.sql参照)。deleteByIdは一覧画面からの
  // 担当者削除(論理削除はupdateById、完全削除まではフェーズ1のスコープ外)用に含めるが、
  // 今回のフェーズ1では未使用。
  business_partner_contacts: {
    actions: ['insert', 'insertReturning', 'updateById', 'deleteById'],
    label: '取引先マスタ担当者',
    stampIdentity: true,
    auditLog: true,
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
    readable: {
      filters: {
        matched_booking_id: ['eq'],
        matched_booking_cost_id: ['notNull'],
        merchant_name: ['eq'],
        match_status: ['eq'],
      },
      order: ['transaction_date'],
    },
  },
  // invoices(請求書): 金銭データを扱う最重要テーブルの一つだが、tour_arrangement_headers等
  // 似た名前の別テーブルとの取り違えでservice_role移行対象から漏れ、anonキーからの直接
  // insert/update/deleteが残ったまま放置されていた(2026-08点検で判明)。
  // booking_hotels等と同じ手順(service_role API化→フロント切替→検証→REVOKE)で対応する。
  // このコミットではREVOKE(anon/authenticatedからの実際の権限剥奪)は行わない
  // (scripts/lock_down_invoices_writes.sql参照。作成のみで未実行)。
  // created_by/updated_by列がinvoicesにはまだ無いため(booking_costs等と異なり、この
  // 移行以前に追加された形跡が無い)、他テーブルと違いstampIdentityは有効化しない
  // (列が無い状態でstampすると insert/update 自体がDBエラーで失敗するため)。将来
  // 監査で作成者/更新者を追う必要が出た場合は、別途created_by/updated_by列を追加する
  // マイグレーションを先に実行してから有効化すること。
  // auditLogはstampIdentityと独立して機能する(通常カラムの前後比較のみで動作する)ため
  // 有効化する。insertReturningではなくinsertを使うのは、doInsert()内のコメントの通り
  // auditLog:true時はどのみちreturn=representationで挿入後の行(採番id含む)を取得して
  // いるため、それをそのままrowsとして呼び出し元に返せる(insertReturningはauditLog非対応)。
  // 請求先ごとに1件・番号固定方式(2026-08〜)への移行に伴い、「同じinvoice_noの既存行が
  // あればUPDATE、無ければINSERT」はフロント側でinvoice_noによる存在確認(直接SELECT)を
  // 行ってから、既存のupdateById/insertのどちらかを呼ぶ方式にした(前回調査で推奨された
  // 案A方式。invoice_no用の新規action追加は不要と判断)。deleteById/deleteByIdsは、
  // 移行時の旧採番レコード一括削除、および将来の個別削除用に追加する。
  invoices: {
    actions: ['insert', 'updateById', 'updateByIds', 'deleteById', 'deleteByIds', 'deleteByBooking'],
    label: '請求書',
    auditLog: true,
    readable: {
      filters: {
        booking_id: ['eq', 'in'],
        agent_name: ['eq', 'isNull', 'notNull'],
        agent_id: ['isNull'],
        is_consolidated: ['eq'],
        currency: ['eq'],
        status: ['eq'],
      },
      order: ['created_at'],
    },
  },
  // tour_arrangements(手配書ヘッダー・共通ドラフト)/tour_arrangement_days(同日毎明細)/
  // bullet_train_arrangements(新幹線手配)/arrangement_documents(ガイド別手配書ヘッダー):
  // 4テーブルとも、tour_arrangement_headers等似た名前の別テーブルとの取り違えで
  // service_role移行対象から漏れ、anonキーからの直接insert/update/delete/upsertが
  // 残ったまま放置されていた(2026-08点検で判明。bullet_train_arrangementsには
  // 「anon全権限」のRLSポリシーも残存)。invoicesと同じ手順(service_role API化→
  // フロント切替→検証→REVOKE)で対応する。このコミットではREVOKE(anon/authenticatedからの
  // 実際の権限剥奪)は行わない(scripts/lock_down_tour_arrangements_writes.sql参照。
  // 作成のみで未実行)。
  // created_by/updated_by列の存在がコード上確認できない(tour_arrangementsのみ
  // 新規作成insert時にcreated_byを送っている実績があるが、updated_by列はいずれの
  // テーブルにも使用実績が無い)ため、invoicesと同じ考え方でstampIdentityは
  // 有効化しない(列が無い状態で有効化するとinsert/update自体がDBエラーで失敗するため)。
  tour_arrangements: {
    // tour_arrangementsはbooking_id列を持たずbooking_ref(予約のref_no)で紐づいている
    // ため、deleteByBookingではなくdeleteByField(allowedDeleteFields: ['booking_ref'])を
    // 使う(予約削除時のdeleteBookingData参照)。
    actions: ['insertReturning', 'updateById', 'deleteById', 'deleteByField'],
    label: '手配書',
    allowedDeleteFields: ['booking_ref'],
    auditLog: true,
  },
  // tour_arrangement_days: 1手配書(tour_arrangements.id)に対する日毎明細。保存は
  // 既存のarrangement_document_days等と同じ「全削除→再挿入」(replaceByKey、キー列は
  // arrangement_id)。予約削除時のみ複数手配書分をまとめて削除する必要があるため、
  // deleteByField(arrangement_id。配列値もdoDeleteByFieldがin.()で対応)も合わせて許可する。
  tour_arrangement_days: {
    actions: ['replaceByKey', 'deleteByField'],
    label: '手配書日毎明細',
    allowedReplaceKeyFields: ['arrangement_id'],
    allowedDeleteFields: ['arrangement_id'],
  },
  // bullet_train_arrangements: 予約詳細モーダル「新幹線」タブの一括保存
  // (saveBulletTrainItems)はbooking_refキーの全削除→再挿入(replaceByKey)。サイドバー
  // 「新幹線手配」一覧画面(bt-modal)は1件ずつのupdateById/insertReturning/deleteById、
  // CSV一括取込(importBtCsv)はinsert。予約削除時のdeleteByField(booking_ref)も許可する。
  bullet_train_arrangements: {
    actions: ['replaceByKey', 'updateById', 'insertReturning', 'deleteById', 'insert', 'deleteByField'],
    label: '新幹線手配',
    allowedReplaceKeyFields: ['booking_ref'],
    allowedDeleteFields: ['booking_ref'],
    auditLog: true,
    // bullet_train_arrangements_unique制約(booking_ref+ride_date+train_number+
    // departure_station+arrival_station、buildBulletTrainRows/btDupKey参照)があるため、
    // doReplaceByKeyの既定順序(INSERT→DELETE)では、内容を変更しない行が旧行とキーの
    // 重複でINSERT時にunique制約違反となる(2026-08、予約#1068で発覚)。旧コードの
    // sb.from(...).delete()→insert()と同じDELETE→INSERT順序に切り替える。
    replaceByKeyDeleteFirst: true,
  },
  // arrangement_documents: ガイド別手配書のヘッダー行(booking_idに1:N、booking_guide_idに
  // 1:1)。新規作成(syncArrangementDocumentsFromDraft)はinsertReturning(挿入直後の採番idを
  // 子テーブル(arrangement_document_days/notes)へarrangement_document_idとして紐付ける
  // 必要があるため)、編集保存(pullGuideDocFromDraft/saveGuideDocEditor)はupdateById。
  // 個別削除機能は無く、削除は予約削除時のdeleteByBooking(cascade)のみ。
  arrangement_documents: {
    actions: ['insertReturning', 'updateById', 'deleteByBooking'],
    label: 'ガイド別手配書',
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
  // 見積もり削除時(deleteEstimation)のestimation_id一括削除専用(セキュリティ移行、
  // 2026-09点検で対応。F1事前調査時点では実データ0件・anon直接deleteのみだったため
  // 移行対象外としていたが、anon/authenticatedからのDML遮断(REVOKE)の前提として
  // service_role経由の削除経路をここで用意する)。
  estimation_fit_items: {
    actions: ['deleteByField'],
    label: '見積もりFIT明細',
    allowedDeleteFields: ['estimation_id'],
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
  // card_holders(カード名義人マスタ): クレジットカード払いの「名義人を選択」欄の候補元
  // (scripts/create_card_holders_table.sql参照)。読み取り(select)はanon/authenticatedにも
  // SELECTを許可しているため各画面が直接読み取る。新規追加(insert)・無効化(updateById、
  // is_active=falseへの更新のみ。物理削除はしない)はこのAPI経由のservice_role操作のみとし、
  // かつCARD_HOLDER_ADMIN_EMAILSに含まれるemailのみ実行できるようhandler側で追加チェックする
  // (下記の'insert'/'updateById'分岐内、table==='card_holders'の判定を参照)。
  card_holders: {
    actions: ['insert', 'updateById'],
    label: 'カード名義人マスタ',
  },
  // booking_edit_presence(予約編集の「編集中表示」用プレゼンス): ロック(排他制御)は行わず、
  // 誰が今この予約を編集中かの気づきのための記録のみ(scripts/create_booking_edit_presence_table.sql
  // 参照)。新設テーブルのため最初からservice_role専用とし、anon/authenticatedへのGRANTは
  // 一切行わない。heartbeat/insert/updateById等の汎用actionではなく、このテーブル専用の
  // heartbeat/list_active/releaseという3つの非汎用actionのみを許可し、handler側に個別の
  // 実装(doPresenceHeartbeat/doPresenceListActive/doPresenceRelease)を用意している
  // (下記の該当action分岐を参照)。
  booking_edit_presence: {
    actions: ['heartbeat', 'list_active', 'release'],
    label: '編集中プレゼンス',
  },
};

// learned_mappingsのcategoryはこの5種のみ許可する(bodyの値をそのまま保存しない)。
// bankbook_payer(F16): 通帳OCRの入金消込マッチングで、振込人名等(input_key)と
// 確定したREF#(confirmed_value)の組を学習する。cc_merchantと同じ仕組みを流用。
// partner_merge: 取引先マスタの類似検出(findSimilarPartnerWithAi、index.html)で、
// AI判定によりマージ候補として提示され、人間がマージを確定した組み合わせ
// (input_key=新規会社名の組、confirmed_value=マージ先取引先id)を学習する。
// 他カテゴリと同じく、この学習はあくまで次回以降のAI呼び出し省略にのみ使い、
// 自動確定には使わない(index.html側のfindSimilarPartnerWithAi参照)。
const LEARNED_MAPPING_CATEGORIES = ['email_sender', 'cc_merchant', 'receipt_merchant', 'bankbook_payer', 'partner_merge', 'agent_merge'];

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

// business_partners(取引先マスタ)への新規insert時、正規化後の会社名が既存の有効な
// (is_deleted=false)取引先と完全一致する場合はブロックする、サーバー側の最終防波堤。
// あいまい一致(表記ゆれ吸収)まではクライアント側(findDuplicatePartner)の役割のままとし、
// ここでは「同じ文字列の二重登録」だけを防ぐ軽量チェックに留める。取引先マスタ画面の
// 新規登録フォーム(savePartner)にクライアント側チェックを追加しても、将来別の呼び出し元
// (登録経路の追加・改修漏れ)が同じ穴を再現しうるため、APIレイヤーにも入れておく
// (2026-08-21、チームラボの旧表記が新規idで繰り返し再作成された実害への対応)。
function normalizeCompanyNameForExactMatch(s) {
  return String(s || '').normalize('NFKC').trim().replace(/\s+/g, '').toLowerCase();
}
async function findExactDuplicateBusinessPartner(rows) {
  const keys = rows.map((r) => normalizeCompanyNameForExactMatch(r && r.company_name)).filter(Boolean);
  if (!keys.length) return null;
  const existRes = await sbFetch('business_partners', '?select=id,company_name&is_deleted=eq.false', { method: 'GET' });
  if (!existRes.ok) return null; // 取得に失敗した場合はチェックをスキップし、既存の保存動作を壊さない
  const existing = await readJsonSafe(existRes);
  if (!Array.isArray(existing)) return null;
  const existingByKey = new Map(existing.map((p) => [normalizeCompanyNameForExactMatch(p.company_name), p]));
  for (const r of rows) {
    const key = normalizeCompanyNameForExactMatch(r && r.company_name);
    if (key && existingByKey.has(key)) {
      return { newName: r.company_name, existing: existingByKey.get(key) };
    }
  }
  return null;
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

// booking_edit_presence(予約編集の「編集中表示」)の3つの専用action実装。
// ロック(排他制御)ではなく、あくまで「誰が今この予約を見ているか」の気づきのための
// ハートビート記録。user_emailは検証済みセッション(changedBy)を使い、クライアント申告値は
// 信用しない(なりすまし防止)。user_nameは表示専用の値であり、誤っていても実害が無い
// (セキュリティ上重要な識別子はuser_emailのみ)ため、クライアントが送ってきた値をそのまま使う。
const PRESENCE_STALE_MS = 5 * 60 * 1000; // 5分。list_activeの「編集中」判定・クライアント側の
// 自動失効表示と揃える基準値(サーバー側の時計を基準にすることで、クライアントの時計ズレの
// 影響を受けないようにする)。

// heartbeat: (booking_id, user_email)のunique制約を使ったupsert。同じ人が同じ予約を複数タブで
// 開いても1行に集約される。PostgRESTのon_conflict+resolution=merge-duplicatesによるupsertを使う。
async function doPresenceHeartbeat(table, bookingId, changedBy, userName) {
  if (!bookingId) return { status: 400, body: { error: 'bookingIdが指定されていません' } };
  if (!changedBy) return { status: 401, body: { error: 'ログインセッションが無効です。再度ログインしてください。' } };
  const r = await sbFetch(table, '?on_conflict=booking_id,user_email', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify([{
      booking_id: bookingId,
      user_email: changedBy,
      user_name: userName ? String(userName).slice(0, 200) : null,
      last_heartbeat_at: new Date().toISOString(),
    }]),
  });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || 'ハートビートの送信に失敗しました' } };
  }
  return { status: 200, body: { ok: true } };
}

// list_active: 指定booking_idについて、last_heartbeat_atがPRESENCE_STALE_MS以内(=まだ有効)の
// 行を取得し、リクエスト元(changedBy)自身の行は結果から除外して返す(「自分以外の編集中」を
// 知りたいため)。
async function doPresenceListActive(table, bookingId, changedBy) {
  if (!bookingId) return { status: 400, body: { error: 'bookingIdが指定されていません' } };
  const sinceIso = new Date(Date.now() - PRESENCE_STALE_MS).toISOString();
  const q = `?booking_id=eq.${encodeURIComponent(bookingId)}&last_heartbeat_at=gte.${encodeURIComponent(sinceIso)}&select=user_email,user_name,last_heartbeat_at`;
  const r = await sbFetch(table, q);
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || '編集中ユーザーの取得に失敗しました' } };
  }
  const rows = await r.json();
  const others = (rows || []).filter((row) => row.user_email !== changedBy);
  return { status: 200, body: { rows: others } };
}

// release: 自分(changedBy)の行のみを削除する(booking_id+user_emailで絞り込み、他人の行を
// 誤って消せないようにする)。changedByが無い(セッション無効)場合は何もせず正常終了とする
// (モーダルを閉じる操作自体は妨げたくないため)。
async function doPresenceRelease(table, bookingId, changedBy) {
  if (!bookingId) return { status: 400, body: { error: 'bookingIdが指定されていません' } };
  if (!changedBy) return { status: 200, body: { ok: true } };
  const q = `?booking_id=eq.${encodeURIComponent(bookingId)}&user_email=eq.${encodeURIComponent(changedBy)}`;
  const r = await sbFetch(table, q, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || '編集中表示の解除に失敗しました' } };
  }
  return { status: 200, body: { ok: true } };
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

// doReplace()の新旧内容比較で無視する共通列(replaceのたびに必ず変わる/持ち回りされない
// メタ情報のため、これらだけが異なる行を「内容が変わった」とは扱わない)。
const AUDIT_DIFF_IGNORE_COMMON = ['id', 'booking_id', 'created_at', 'updated_at', 'created_by', 'updated_by'];

// 行の「内容シグネチャ」。ignoreFieldsに挙げた列を除いた全カラムをkeyソートしてJSON化する
// (部分キーではなく全カラム一致にすることで、別内容の行を誤って同一と判定するリスクを
// 無くす)。同一シグネチャの行同士は、どの具体的な行同士が対応するかを問わず「変更なし」
// として扱ってよい(1対1のID同定が必要な既存のremapCreditCardStatementSourceIds等とは
// 異なり、ここでは「変更があったか」の判定のみが目的のため、多重集合としての一致で十分)。
function rowContentSignature(row, ignoreFields) {
  const clean = {};
  Object.keys(row).sort().forEach((k) => {
    if (!ignoreFields.includes(k)) clean[k] = row[k];
  });
  return JSON.stringify(clean);
}

// existing(保存前の全行)とinsertedRows(保存後の全行)を内容シグネチャで多重集合マッチングし、
// 「実際に変更・追加された行(unmatchedInserted)」「実際に削除された行(unmatchedExisting)」
// だけを返す。内容が完全一致する行同士は消し込まれ、audit_logsへの記録対象から外れる。
function diffReplaceRowsForAudit(existing, insertedRows, ignoreFields) {
  const pool = new Map();
  (existing || []).forEach((r) => {
    const sig = rowContentSignature(r, ignoreFields);
    if (!pool.has(sig)) pool.set(sig, []);
    pool.get(sig).push(r);
  });
  const unmatchedInserted = [];
  (insertedRows || []).forEach((r) => {
    const sig = rowContentSignature(r, ignoreFields);
    const queue = pool.get(sig);
    if (queue && queue.length) {
      queue.shift(); // 内容一致する旧行を1つ消費 = この新行は「変更なし」
    } else {
      unmatchedInserted.push(r);
    }
  });
  const unmatchedExisting = [...pool.values()].flat();
  return { unmatchedExisting, unmatchedInserted };
}

// 「新規INSERTに成功してから、既存の旧行だけをidで指定してDELETEする」安全な差分置き換え。
// クライアント側のsafeReplaceBookingRowsと同じ考え方(#782の全削除→再挿入事故の再発防止)。
// config.auditLogが有効な場合、旧行・新行を内容シグネチャで突き合わせ、実際に内容が
// 変わった行だけを記録する(削除される旧行はaction:'delete'、新規/変更後の行は
// action:'insert')。replaceは毎回全行を作り直すため、内容が完全に同一の行(=変更なし)まで
// 毎回delete+insertとして記録すると、明細行数の多い予約ほどaudit_logsが際限なく
// 肥大化してしまう(2026-08-22点検、booking_costsで実際に発生していた問題への対策)。
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
    const ignoreFields = [...AUDIT_DIFF_IGNORE_COMMON, ...((config && config.auditDiffIgnoreFields) || [])];
    const { unmatchedExisting, unmatchedInserted } = diffReplaceRowsForAudit(existing, insertedRows, ignoreFields);
    const entries = [
      ...unmatchedExisting.map((r) => ({ recordId: r.id, action: 'delete', before: r, after: null })),
      ...unmatchedInserted.map((r) => ({ recordId: r.id, action: 'insert', before: null, after: r })),
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

  async function doInsert() {
    if (!Array.isArray(rows) || !rows.length) return null;
    const insRes = await sbFetch(table, '', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
    if (!insRes.ok) {
      const e = await readJsonSafe(insRes);
      return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の保存に失敗しました` } };
    }
    return null;
  }
  async function doDelete(messageSuffix) {
    if (!existingIds.length) return null;
    const delRes = await sbFetch(table, `?id=in.(${existingIds.join(',')})`, { method: 'DELETE', prefer: 'return=minimal' });
    if (!delRes.ok) {
      const e = await readJsonSafe(delRes);
      return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の旧データ削除に失敗しました${messageSuffix}` } };
    }
    return null;
  }

  // 既定は「新規INSERTに成功してから、既存の旧行だけをidで指定してDELETEする」順序
  // (#782の全削除→再挿入事故の再発防止。doReplace()と同じ考え方。INSERTが失敗しても
  // 旧データがそのまま残るため、保存の途中失敗によるデータ全損を避けられる)。
  // ただしconfig.replaceByKeyDeleteFirstが立っているテーブルは、この既定の順序だと
  // 「内容を変更しない行(例: pax数のみ変更等)」の新INSERTが、まだ削除していない旧行と
  // 内容が重複しunique制約(例: bullet_train_arrangementsのbooking_ref+ride_date+
  // train_number+departure_station+arrival_station)に違反して保存自体が失敗する
  // (2026-08、予約#1068の新幹線タブ保存失敗で発覚)。該当テーブルに限り、旧経路の
  // sb.from(...).delete()→insert()と同じDELETE→INSERTの順序に切り替える
  // (DELETE成功後にINSERTが失敗すると当該キーのデータが一時的に空になるリスクは
  // 受け入れる。旧コードも同じ順序・同じリスクで長期間運用されていた実績があるため)。
  if (config.replaceByKeyDeleteFirst) {
    const delErr = await doDelete('');
    if (delErr) return delErr;
    const insErr = await doInsert();
    if (insErr) return insErr;
  } else {
    const insErr = await doInsert();
    if (insErr) return insErr;
    const delErr = await doDelete('（新データは保存済みのため重複している可能性があります）');
    if (delErr) return delErr;
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
    // 一意制約違反(PostgreSQL 23505)は、原因が分かるよう日本語の説明と code を付けて返す
    // (例: 新規予約でREF#が既存と重複した場合。以前は英語のDBエラー文だけで原因が分かりにくかった)。
    if (e.code === '23505') {
      return { status: 409, body: { error: `${label}: 同じ値が既に登録されているため保存できません（${e.message || ''}${e.details ? ' / ' + e.details : ''}）`, code: 'DUPLICATE_KEY' } };
    }
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

// 一覧取得(降順・limit付き)の汎用実装。parking_reservations向けに作られたが、
// table/limit以外にテーブル固有の処理を持たないため、同じ形(created_at降順の単純な
// 一覧)で十分なerror_logsのlistアクションもこの関数をそのまま流用する。
// テーブル未作成時はエラーにせず空配列を返す(移行前のparking-reservations.jsと
// 同じフォールバック挙動)。
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
  const beforeRes = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}&select=*`);
  let beforeRow = null;
  if (beforeRes.ok) {
    const beforeRows = await beforeRes.json();
    beforeRow = beforeRows && beforeRows[0] ? beforeRows[0] : null;
  }
  if (!beforeRow) {
    return { status: 404, body: { error: `${label}が見つかりません（既に削除されている可能性があります）` } };
  }
  // return=representationで実際に削除された行を受け取り、0件だった場合は
  // (直前のSELECTと削除実行の間に対象が消えた等)成功扱いにせずエラーを返す。
  // PostgRESTはWHERE句が0件にマッチしてもHTTP 2xxを返すため、この確認が無いと
  // 削除できていないのに「削除しました」と表示されてしまう。
  const r = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=representation' });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の削除に失敗しました` } };
  }
  const deletedRows = await readJsonSafe(r);
  if (!Array.isArray(deletedRows) || deletedRows.length === 0) {
    return { status: 409, body: { error: `${label}の削除対象が見つかりませんでした（0件削除）。既に削除されている可能性があります。` } };
  }
  if (needAudit) {
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
// ===== 読み取り専用 query/queryBatch/rpc action(RLS対応フェーズ2 バッチ1、2026-09) =====
// invoices/booking_costs/booking_sales/credit_card_statementsのブラウザ直接SELECT
// (anonキー)を廃止し、ログイン検証つきのこのAPI(service_role)経由に統一するための汎用
// 読み取り口。bodyから受け取った列名・演算子をそのままクエリに埋め込まないよう、
// TABLE_CONFIG[table].readable に明示された列・演算子・並び替え列だけを許可する。
//
// 1,000件上限対策: PostgRESTは1リクエスト最大1,000件(Supabase既定のmax-rows)で黙って
// 切り捨てるため、サーバー内で1,000件ずつ取得を繰り返す。ただしVercelのレスポンス上限
// (約4.5MB)と関数の実行時間上限を超えないよう、累積サイズ約3MBまたは経過時間約5秒で
// 打ち切り、続きの位置をnextOffsetとして返す(件数ではなくサイズ・時間で打ち切る)。
// クライアント(index.htmlのtableQueryAll)はnextOffsetがnullになるまで取り切る。
// ページ間で並びがぶれて行の重複・欠落が起きないよう、並び順の最後に必ずidを付ける。
const QUERY_PAGE_SIZE = 1000;
// 各リクエストの最初のページは200件に抑え、その平均行サイズから以降のページ件数を決める
// (最初から1,000件取ると、1行が大きいテーブルでは最初の1ページだけでレスポンス上限を超えうるため)。
// 1予約分のような小さいクエリ(200件未満)は1回の取得で完結するため影響しない。
const QUERY_FIRST_PAGE_SIZE = 200;
const QUERY_MAX_BYTES = 3 * 1024 * 1024;
const QUERY_MAX_MS = 5000;
const QUERY_MAX_IN_VALUES = 200;
const QUERY_BATCH_MAX = 5;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

// 値をPostgRESTのin.(...)用にダブルクォートで囲む(カンマ・括弧を含む値でも壊れないように)。
function pgrstQuote(v) {
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// 1つのクエリ指定(body.query)を検証し、PostgRESTのクエリ文字列の配列(key=value)を組み立てる。
// 不正なら { error } を返す。
function buildQueryParams(table, q) {
  const config = TABLE_CONFIG[table];
  if (!config || !config.readable) return { error: `${table}は読み取り(query)の対象外です` };
  if (!q || typeof q !== 'object') return { error: '検索条件(query)が指定されていません' };
  const readable = config.readable;

  // select: '*' か、列名(英小文字の識別子)のカンマ区切り。'*'を許す以上、列を絞る指定の
  // 可否は安全性に影響しないため、列名の形式チェックのみとする。
  const selectRaw = q.select == null ? '*' : String(q.select).replace(/\s+/g, '');
  if (selectRaw !== '*') {
    const cols = selectRaw.split(',');
    if (!cols.length || cols.some((c) => !IDENT_RE.test(c))) return { error: `selectの指定が不正です: ${q.select}` };
  }
  const params = [`select=${encodeURIComponent(selectRaw)}`];

  const filters = Array.isArray(q.filters) ? q.filters : [];
  for (const f of filters) {
    if (!f || typeof f !== 'object') return { error: '絞り込み条件の形式が不正です' };
    const { col, op, value } = f;
    const allowedOps = readable.filters[col];
    if (!allowedOps) return { error: `${table}に対して許可されていない絞り込み列です: ${col}` };
    if (!allowedOps.includes(op)) return { error: `${table}.${col}に対して許可されていない演算子です: ${op}` };
    if (op === 'eq') {
      // PostgRESTのeq.nullは「NULLと一致」にならない(何にも一致しない)ため、nullの検索は
      // isNullを明示させる(黙って0件になる取り違えを防ぐ)。
      if (value === null || value === undefined) return { error: `${col}のeqにnullは指定できません(isNullを使ってください)` };
      if (!['string', 'number', 'boolean'].includes(typeof value)) return { error: `${col}のeqの値が不正です` };
      params.push(`${col}=eq.${encodeURIComponent(String(value))}`);
    } else if (op === 'in') {
      if (!Array.isArray(value) || !value.length) return { error: `${col}のinの値は1件以上の配列で指定してください` };
      if (value.length > QUERY_MAX_IN_VALUES) return { error: `${col}のinは1回${QUERY_MAX_IN_VALUES}件までです(呼び出し側で分割してください)` };
      if (value.some((v) => v === null || v === undefined || !['string', 'number', 'boolean'].includes(typeof v))) {
        return { error: `${col}のinの値が不正です` };
      }
      params.push(`${col}=in.(${encodeURIComponent(value.map(pgrstQuote).join(','))})`);
    } else if (op === 'isNull') {
      params.push(`${col}=is.null`);
    } else if (op === 'notNull') {
      params.push(`${col}=not.is.null`);
    } else if (op === 'ilikeContains') {
      // 部分一致。ユーザー入力の%と_はワイルドカードとして扱わないようエスケープし、前後に%を付ける。
      // PostgRESTはlike/ilikeの値中の*を%に置き換えるため、*を含む値は拒否する。
      if (typeof value !== 'string' || !value) return { error: `${col}の部分一致の値が不正です` };
      if (value.includes('*')) return { error: `${col}の部分一致に*は使えません` };
      if (value.length > 200) return { error: `${col}の部分一致の値が長すぎます` };
      const escaped = value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      params.push(`${col}=ilike.${encodeURIComponent('%' + escaped + '%')}`);
    } else {
      return { error: `不明な演算子です: ${op}` };
    }
  }

  const orders = Array.isArray(q.order) ? q.order : [];
  const orderParts = [];
  for (const o of orders) {
    if (!o || !readable.order.includes(o.col)) return { error: `${table}に対して許可されていない並び替え列です: ${o && o.col}` };
    orderParts.push(`${o.col}.${o.ascending === false ? 'desc' : 'asc'}`);
  }
  // ページ間の並びを一意にするため、並び順の最後に必ずidを付ける(既にidがあれば付けない)。
  if (!orders.some((o) => o.col === 'id')) orderParts.push('id.asc');
  params.push(`order=${orderParts.join(',')}`);

  let limit = null;
  if (q.limit != null) {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_PAGE_SIZE) return { error: `limitは1〜${QUERY_PAGE_SIZE}で指定してください` };
  }
  let offset = 0;
  if (q.offset != null) {
    offset = Number(q.offset);
    if (!Number.isInteger(offset) || offset < 0) return { error: 'offsetの指定が不正です' };
  }
  return { params, limit, offset, count: q.count === true };
}

// 1クエリ分を、サイズ・時間の予算内で取得する。limit指定時はその件数だけ1回取得する
// (呼び出し元が明示的に件数を絞っているため続きは返さない)。
// budget: { bytes, deadline } を複数クエリ(queryBatch)で共有する。
async function runQuery(table, built, budget) {
  const label = TABLE_CONFIG[table].label;
  const base = built.params.join('&');
  if (built.count) {
    // 件数のみ(supabase-jsの {count:'exact', head:true} 相当)。
    const r = await sbFetch(table, `?${base}`, { method: 'HEAD', headers: { Prefer: 'count=exact' } });
    if (!r.ok) throw new Error(withGrantHint(`${label}の件数取得に失敗しました(HTTP ${r.status})`, table));
    const cr = r.headers.get('content-range') || '';
    const total = Number(cr.split('/')[1]);
    if (!Number.isFinite(total)) throw new Error(`${label}の件数取得に失敗しました(content-range不正)`);
    return { rows: [], count: total, nextOffset: null };
  }
  let rows = [];
  let offset = built.offset;
  let pageSize = built.limit || QUERY_FIRST_PAGE_SIZE;
  while (true) {
    const { r, text } = await timedFetchText(budget, () => sbFetch(table, `?${base}&limit=${pageSize}&offset=${offset}`, { method: 'GET' }));
    if (!r.ok) {
      let msg = '';
      try { msg = JSON.parse(text).message || ''; } catch (e) { /* ignore */ }
      throw new Error(withGrantHint(msg, table) || `${label}の取得に失敗しました(HTTP ${r.status})`);
    }
    const page = JSON.parse(text);
    if (!Array.isArray(page)) throw new Error(`${label}の取得結果が不正です`);
    const pageBytes = Buffer.byteLength(text, 'utf8');
    // 見積もりより大きいページ(行サイズが途中で急に大きくなった場合)で予算を超える場合は、
    // このページを含めずに打ち切り、同じ位置から次のリクエストで取り直す(このリクエストで
    // 既に行を取得済みの場合のみ。最初のページは進捗のため必ず含める)。
    if (rows.length > 0 && pageBytes > budget.bytes) return { rows, nextOffset: offset };
    rows = rows.concat(page);
    budget.bytes -= pageBytes;
    offset += page.length;
    if (built.limit) return { rows, nextOffset: null };
    if (page.length < pageSize) return { rows, nextOffset: null };
    // 予算切れ(次のページが予算に収まらない)なら、ここまでの行と続きの位置を返す
    // (部分結果ではなく「続きがある」ことを明示する。クライアントがnextOffsetから取り切る)。
    pageSize = nextPageSize(budget, pageBytes, page.length);
    if (pageSize < 1) return { rows, nextOffset: offset };
  }
}

function newQueryBudget() {
  // sb: このリクエスト内でSupabase(PostgREST)を呼んだ回数・合計時間・最大時間(レスポンスの__sbとして返し、
  // index.htmlのwindow.__tableCrudCallLogに記録する。速度の内訳を実測で切り分けるため)。
  return { bytes: QUERY_MAX_BYTES, deadline: Date.now() + QUERY_MAX_MS, sb: { calls: 0, ms: 0, maxMs: 0 } };
}

// Supabaseへのfetchと本文の読み込みまでを計測する(budget.sbに加算)。
async function timedFetchText(budget, doFetch) {
  const t0 = Date.now();
  try {
    const r = await doFetch();
    const text = await r.text();
    return { r, text };
  } finally {
    const ms = Date.now() - t0;
    budget.sb.calls += 1;
    budget.sb.ms += ms;
    if (ms > budget.sb.maxMs) budget.sb.maxMs = ms;
  }
}

// 1ページ取得した後に、次のページを何件で取得するか(0なら打ち切ってnextOffsetを返す)。
// サイズの判定を「取得した後」だけで行うと、1レスポンスが予算+1ページ分(例: 3MB+3MB)まで
// 膨らみVercelのレスポンス上限(約4.5MB)を超えうるため、直前のページの1行あたりの平均サイズから
// 次のページのサイズを見積もり、予算内に収まる件数だけを取得する。
function nextPageSize(budget, pageBytes, pageRows) {
  if (budget.bytes <= 0 || Date.now() >= budget.deadline) return 0;
  const avg = pageRows > 0 ? pageBytes / pageRows : 1;
  return Math.max(0, Math.min(QUERY_PAGE_SIZE, Math.floor(budget.bytes / Math.max(avg, 1))));
}

async function doQuery(table, q) {
  const built = buildQueryParams(table, q);
  if (built.error) return { status: 400, body: { error: built.error } };
  const budget = newQueryBudget();
  const result = await runQuery(table, built, budget);
  return { status: 200, body: { ok: true, ...result, __sb: budget.sb } };
}

// 複数テーブルのクエリを1リクエストでまとめて取得する(予約詳細を開く時の売上・仕入・
// Invoiceの3件等、クライアント→Vercelの往復とコールドスタートの発生回数を減らすため)。
// サイズ・時間の予算は全クエリで共有し、取り切れなかったクエリはnextOffsetを返す
// (クライアントが残りをquery actionで取り切る)。1件でも検証エラーなら何も実行しない。
async function doQueryBatch(queries) {
  if (!Array.isArray(queries) || !queries.length) return { status: 400, body: { error: 'queriesが指定されていません' } };
  if (queries.length > QUERY_BATCH_MAX) return { status: 400, body: { error: `queriesは${QUERY_BATCH_MAX}件までです` } };
  const builtList = [];
  for (const q of queries) {
    const table = q && q.table;
    const built = buildQueryParams(table, q);
    if (built.error) return { status: 400, body: { error: built.error } };
    builtList.push({ table, built });
  }
  const budget = newQueryBudget();
  const results = await Promise.all(builtList.map(({ table, built }) => runQuery(table, built, budget)));
  return { status: 200, body: { ok: true, results, __sb: budget.sb } };
}

// RPC(入出金画面)。ホワイトリストの3本だけをservice_roleで呼ぶ。関数はSECURITY INVOKERのまま
// (DEFINER化しない)。移行後にanon/authenticated/publicからEXECUTEをREVOKEする
// (scripts/enable_rls_batch1.sql参照)。
const RPC_WHITELIST = {
  get_payment_monthly_summary: { paged: false },
  search_payment_income: { paged: true },
  search_payment_outflow: { paged: true },
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 引数を検証する。不正なら { error } を返す。
function validateRpcCall(fn, params) {
  const spec = RPC_WHITELIST[fn];
  if (!spec) return { error: `許可されていないRPCです: ${fn}` };
  const p = params || {};
  const unknown = Object.keys(p).filter((k) => !['p_from', 'p_to', 'p_search'].includes(k));
  if (unknown.length) return { error: `不明な引数です: ${unknown.join(', ')}` };
  if (!DATE_RE.test(String(p.p_from || '')) || !DATE_RE.test(String(p.p_to || ''))) {
    return { error: '日付(p_from/p_to)はYYYY-MM-DD形式で指定してください' };
  }
  if (p.p_search !== undefined) {
    if (!spec.paged) return { error: `${fn}はp_searchを受け付けません` };
    if (typeof p.p_search !== 'string' || !p.p_search || p.p_search.length > 200) {
      return { error: '検索語(p_search)は1〜200文字の文字列で指定してください' };
    }
  }
  return { spec, p };
}

const RPC_PARALLEL_PAGES = 8; // 残りページを並列取得する時の同時実行数(出金6,370件=残り6ページ+末尾確認1が1段で済む)

// 1本のRPCを予算内で取得する。失敗時は例外(部分結果は返さない)。
// 集合を返す2本はGET+Rangeでページングする(POSTだとPostgRESTがRangeを無視するため)。関数側でORDER BY済み。
// 入出金画面(2026-09、Preview実測で本番より大幅に遅かった件の対応): 以前は200件のプローブページの後に
// 1,000件ずつ「直列」に取得しており、出金6,370件で8回の往復が直列に並んでいた(各回で関数全体が
// 再実行される)。最初のページ(1,000件)で Prefer: count=exact により総件数を得て、残りのページを
// 並列に取得する(直列の往復は2段になる)。総件数が得られない場合は従来どおり直列に取得する。
async function runRpc(fn, params, offsetIn, budget) {
  const { spec, p } = validateRpcCall(fn, params);
  const serviceKey = getServiceKey();
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const failMsg = (r, text) => {
    let msg = '';
    try { msg = JSON.parse(text).message || ''; } catch (e) { /* ignore */ }
    return msg || `${fn}の実行に失敗しました(HTTP ${r.status})`;
  };
  if (!spec.paged) {
    const { r, text } = await timedFetchText(budget, () => fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers, body: JSON.stringify({ p_from: p.p_from, p_to: p.p_to }),
    }));
    if (!r.ok) throw new Error(failMsg(r, text));
    return { rows: JSON.parse(text), nextOffset: null };
  }
  // GETでは値がnullでも文字列"null"として渡ってしまうため、p_searchは指定時のみ付ける。
  const qs = [`p_from=${encodeURIComponent(p.p_from)}`, `p_to=${encodeURIComponent(p.p_to)}`];
  if (p.p_search !== undefined) qs.push(`p_search=${encodeURIComponent(p.p_search)}`);
  const url = `${SB_URL}/rest/v1/rpc/${fn}?${qs.join('&')}`;
  const getPage = async (from, size, withCount) => {
    const h = { ...headers, 'Range-Unit': 'items', Range: `${from}-${from + size - 1}` };
    if (withCount) h.Prefer = 'count=exact';
    const { r, text } = await timedFetchText(budget, () => fetch(url, { method: 'GET', headers: h }));
    if (!r.ok) throw new Error(failMsg(r, text));
    const page = JSON.parse(text);
    if (!Array.isArray(page)) throw new Error(`${fn}の結果が不正です`);
    let total = null;
    if (withCount) {
      const t = Number(String(r.headers.get('content-range') || '').split('/')[1]);
      if (Number.isFinite(t)) total = t;
    }
    return { page, bytes: Buffer.byteLength(text, 'utf8'), total };
  };

  let offset = Number.isInteger(offsetIn) && offsetIn >= 0 ? offsetIn : 0;
  const first = await getPage(offset, QUERY_PAGE_SIZE, true);
  let rows = first.page;
  budget.bytes -= first.bytes;
  offset += first.page.length;
  if (first.page.length < QUERY_PAGE_SIZE) return { rows, nextOffset: null };
  const avg = first.bytes / first.page.length;

  if (first.total != null) {
    // 予算内に収まる件数だけ、残りのページを並列に取得する
    const fitRows = Math.floor(Math.max(0, budget.bytes) / Math.max(avg, 1));
    const end = Math.min(first.total, offset + fitRows);
    const reqs = []; // { start, size }
    for (let st = offset; st < end; st += QUERY_PAGE_SIZE) reqs.push({ start: st, size: Math.min(QUERY_PAGE_SIZE, end - st) });
    // 総件数の取得後に行が増えた場合に備え、末尾の次のページも同時に確認する(通常は0件。直列の往復は増やさない)
    const reachesEnd = end >= first.total;
    if (reachesEnd) reqs.push({ start: end, size: QUERY_PAGE_SIZE });
    const pages = new Array(reqs.length);
    let next = 0;
    const worker = async () => {
      while (next < reqs.length) {
        const i = next++;
        pages[i] = await getPage(reqs[i].start, reqs[i].size, false);
      }
    };
    await Promise.all(Array.from({ length: Math.min(RPC_PARALLEL_PAGES, reqs.length) }, worker));
    for (let i = 0; i < pages.length; i++) {
      const pg = pages[i];
      if (!pg.page.length) return { rows, nextOffset: null };
      // 見積もりより大きいページで予算を超える場合は、ここで打ち切り続きの位置を返す
      if (pg.bytes > budget.bytes) return { rows, nextOffset: offset };
      rows = rows.concat(pg.page);
      budget.bytes -= pg.bytes;
      offset += pg.page.length;
      // 想定より短いページ(取得中に行が減った、または末尾)ならそこで終わり
      if (pg.page.length < reqs[i].size) return { rows, nextOffset: null };
    }
    // ここに来るのは、予算の都合で途中までしか取得していない場合か、末尾の次のページも満杯だった場合
    return { rows, nextOffset: offset };
  }

  // 総件数が得られない場合: 従来どおり直列に取得する
  let pageSize = nextPageSize(budget, first.bytes, first.page.length);
  while (true) {
    if (pageSize < 1) return { rows, nextOffset: offset };
    const pg = await getPage(offset, pageSize, false);
    if (pg.bytes > budget.bytes) return { rows, nextOffset: offset };
    rows = rows.concat(pg.page);
    budget.bytes -= pg.bytes;
    offset += pg.page.length;
    if (pg.page.length < pageSize) return { rows, nextOffset: null };
    pageSize = nextPageSize(budget, pg.bytes, pg.page.length);
  }
}

async function doRpc(fn, params, offsetIn) {
  const v = validateRpcCall(fn, params);
  if (v.error) return { status: 400, body: { error: v.error } };
  const budget = newQueryBudget();
  const result = await runRpc(fn, params, offsetIn, budget);
  return { status: 200, body: { ok: true, ...result, __sb: budget.sb } };
}

// 入出金画面を開く時の3本(月別集計・入金明細・出金明細)を1リクエストでまとめて取得する
// (以前は月別集計→明細の2往復が直列だった)。サイズ予算は全件で共有し、取り切れなかったものは
// nextOffsetを返す(クライアントがrpc actionで続きを取る)。1件でも検証エラーなら何も実行しない。
async function doRpcBatch(calls) {
  if (!Array.isArray(calls) || !calls.length) return { status: 400, body: { error: 'callsが指定されていません' } };
  if (calls.length > 3) return { status: 400, body: { error: 'callsは3件までです' } };
  for (const c of calls) {
    const v = validateRpcCall(c && c.fn, c && c.params);
    if (v.error) return { status: 400, body: { error: v.error } };
  }
  const budget = newQueryBudget();
  const results = await Promise.all(calls.map((c) => runRpc(c.fn, c.params, 0, budget)));
  return { status: 200, body: { ok: true, results, __sb: budget.sb } };
}

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

// 画面の版(X-App-Version)による書き込みガードの対象外とするaction(lib/app-version.js参照)。
// ここに無いactionは全て「書き込み系」として版の確認を必須にする(新しいactionを追加した時に
// 確認漏れで古い画面から書き込めてしまわないよう、書き込み側を列挙するのではなく対象外側を列挙する)。
// - 読み取り専用action: 拒否しない。書き込みを止めれば古い画面の読み取りからデータが壊れることは
//   無く、逆に読み取りを拒否すると、旧コードは多くの箇所でエラーを見ずに「0件」として表示するため、
//   データが消えたように見えて誤操作を招く。読み取りは表示だけに使われるので許可する。
//   (index.htmlのTABLE_CRUD_IDEMPOTENT_READ_ACTIONSと同じ一覧+appInfo)
// - guest系action: guide.html(ガイド本人がログイン無しで使う精算画面)からの呼び出し。guide.htmlは
//   RLS対象の4テーブルを読み書きせず、ガイドに再読み込みを求める理由が無いため対象外。
// - appInfo: 版の確認そのもの(データに触れない)。
const APP_VERSION_EXEMPT_ACTIONS = new Set([
  'query', 'queryBatch', 'rpc', 'rpcBatch', 'auditHistory', 'list', 'listByField', 'list_active',
  'guestInsert', 'guestUpdateById', 'guestUpsertConfirm',
  'appInfo',
]);

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

  // 画面側の「新しい版があります」表示用(lib/app-version.js参照)。エラー応答も含め全応答に付ける。
  setAppVersionResponseHeaders(res);

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!getServiceKey()) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  const body = req.body || {};
  const table = body.table || (req.query && req.query.legacyTable);
  const { action, token, guestToken } = body;

  // 版の確認(画面の定期確認用)。データに触れず、デプロイIDと書き込みに必要な最低版だけを返すため
  // ログイン不要。
  if (action === 'appInfo') {
    return res.status(200).json({ ok: true, deployment: getDeploymentId(), minWriteVersion: MIN_WRITE_APP_VERSION });
  }

  // 書き込み系actionは、画面の版(X-App-Version)が無い・古い場合に拒否する(lib/app-version.js参照)。
  // ログイン検証より前に行う(古い画面からは、セッションが有効でも書き込ませない)。
  // 旧エンドポイント(legacyTable)経由の呼び出しは統合前の古い画面からのものなので、同様に拒否される。
  if (!APP_VERSION_EXEMPT_ACTIONS.has(action) && !isAppVersionAllowedForWrite(getRequestAppVersion(req))) {
    return res.status(426).json({ error: APP_VERSION_OUTDATED_MESSAGE, code: APP_VERSION_OUTDATED_CODE, minWriteVersion: MIN_WRITE_APP_VERSION });
  }

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

  // query/queryBatch/rpc/rpcBatchは読み取り専用action。テーブルごとのactionsホワイトリストではなく、
  // TABLE_CONFIG[table].readable(列・演算子)/RPC_WHITELISTで許可範囲を判定する。
  // ゲスト操作からは呼べない(isGuestActionに含めていないため、上でログイン検証済み)。
  if (action === 'query' || action === 'queryBatch' || action === 'rpc' || action === 'rpcBatch') {
    try {
      let result;
      if (action === 'query') result = await doQuery(table, req.body.query);
      else if (action === 'queryBatch') result = await doQueryBatch(req.body.queries);
      else if (action === 'rpcBatch') result = await doRpcBatch(req.body.calls);
      else result = await doRpc(req.body.fn, req.body.params, req.body.offset);
      return res.status(result.status).json(result.body);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
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
      if (table === 'card_holders' && (!changedBy || !CARD_HOLDER_ADMIN_EMAILS.includes(changedBy))) {
        return res.status(403).json({ error: 'カード名義人マスタの追加はadmin@kictravel.jpのみ操作できます' });
      }
      const { rows } = req.body;
      if (table === 'business_partners' && Array.isArray(rows)) {
        const dup = await findExactDuplicateBusinessPartner(rows);
        if (dup) {
          // 会社名完全一致時、以前は保存を拒否するだけだったが、business_partner_contacts
          // (フェーズ1)追加により、クライアント側で「既存の会社に担当者として追加する」
          // 選択肢を出せるよう、既存取引先のid/会社名を構造化フィールドとしても返す。
          return res.status(409).json({
            error: `会社名「${dup.newName}」は既存の取引先「${dup.existing.company_name}」と完全に同じ表記のため、重複登録としてブロックしました。既存の取引先に担当者として追加するか、表記を変えて登録してください。`,
            code: 'DUPLICATE_COMPANY_NAME',
            existingPartnerId: dup.existing.id,
            existingCompanyName: dup.existing.company_name,
          });
        }
      }
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
      if (table === 'error_logs' && (!changedBy || !ERROR_LOG_VIEWER_EMAILS.includes(changedBy))) {
        return res.status(403).json({ error: 'エラーログの閲覧権限がありません' });
      }
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
      if (table === 'card_holders' && (!changedBy || !CARD_HOLDER_ADMIN_EMAILS.includes(changedBy))) {
        return res.status(403).json({ error: 'カード名義人マスタの更新はadmin@kictravel.jpのみ操作できます' });
      }
      const { id, fields } = req.body;
      const invalid = validateUpdatableFields(fields);
      if (invalid) return res.status(invalid.status).json(invalid.body);
      const denied = checkRestrictedFieldValues(fields);
      if (denied) return res.status(denied.status).json(denied.body);
      const result = await doUpdateById(table, config.label, id, stampUpdateFields(fields), config, changedBy);
      return res.status(result.status).json(result.body);
    }
    // 手配タブ(ホテル/バス/レストラン/観光施設/水)の「仕入明細へ追加」ボタン専用。
    // 以前はindex.htmlからanonキーで直接update({cost_added:true})していたが、anonの
    // UPDATE権限剥奪後は本番で失敗し続けていた(toast:falseのため画面に出ていなかった)。
    // 汎用updateByIdを開放すると任意列を書き換えられるため(booking_busesはstatusのみに
    // 限定している等)、cost_added列だけを・boolean値だけを書き換えられる専用actionとする。
    // updated_by等のスタンプ(stampIdentityのテーブルのみ)は既存updateByIdと同じ
    // stampUpdateFieldsを通す。audit_logsへの記録は、テーブル設定のauditLogの有無に
    // 関わらず(booking_water_itemsはauditLog:falseのため)この操作では常に行う。
    // 対象idが存在しない(0件更新)場合は成功扱いにせず404を返す。
    if (action === 'markCostAdded') {
      const { id, value } = req.body;
      if (!id) return res.status(400).json({ error: 'idが指定されていません' });
      if (typeof value !== 'boolean') return res.status(400).json({ error: 'cost_addedにはtrue/falseのみ指定できます' });
      const result = await doUpdateById(table, config.label, id, stampUpdateFields({ cost_added: value }), { ...config, auditLog: true }, changedBy);
      if (result.status === 200 && !(Array.isArray(result.body.rows) && result.body.rows.length)) {
        return res.status(404).json({ error: `${config.label}の対象行が見つかりませんでした(id=${id})。他の方の保存で行が作り直された可能性があります。` });
      }
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
      if (table === 'bookings' && (!changedBy || !BOOKING_DELETE_ADMIN_EMAILS.includes(changedBy))) {
        return res.status(403).json({ error: '予約データの削除はadmin@kictravel.jpのみ操作できます' });
      }
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
    if (action === 'heartbeat') {
      const { bookingId, userName } = req.body;
      const result = await doPresenceHeartbeat(table, bookingId, changedBy, userName);
      return res.status(result.status).json(result.body);
    }
    if (action === 'list_active') {
      const { bookingId } = req.body;
      const result = await doPresenceListActive(table, bookingId, changedBy);
      return res.status(result.status).json(result.body);
    }
    if (action === 'release') {
      const { bookingId } = req.body;
      const result = await doPresenceRelease(table, bookingId, changedBy);
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
