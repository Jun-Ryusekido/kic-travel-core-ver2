# SESSION_NOTES

## RLS再調査(2026-09-30、調査のみ・変更なし。Supabase警告 rls_disabled_in_public 再通知を受けて)

【制約】このセッションにはDB接続情報(DATABASE_URL / service_role key)が無く、pg_tables.rowsecurity・pg_policies は
**取得できていない**(SQL未実行・DB変更なし)。代わりにフロントに公開されているpublishable(anon)キーで、GET(limit=0+件数)のみ・
行データは取得せず、コード上の48テーブル名を1つずつ確認した(=「anonから実効で読めるか」。RLSフラグそのものではない)。
コードに現れないテーブルはこの方法では列挙できない。

### anonからの実効の可読性(2026-09-30 実測)
- 読める・行あり(30テーブル。RLS無効か、anonに読めるポリシーがある): agents(156) arrangement_document_days(10)
  arrangement_document_notes(104) arrangement_documents(26) booking_buses(154) booking_facilities(1406) booking_guides(27)
  booking_hotels(319) booking_restaurants(5535) booking_water_items(4) bookings(1363) bullet_train_arrangements(70)
  business_partner_contacts(365) business_partners(1172) card_holders(4) email_import_queue(8124) estimation_booking_reflections(3)
  estimation_days(169) estimation_fixed_rows(156) estimations(22) facility_operating_info(1) guide_settlement_items(2647)
  guide_settlements(63) guides(135) learned_mappings(822) local_expenses(780) tour_arrangement_headers(317)
  tour_arrangement_notes(1268) tour_day_itinerary(5) tour_guides(3) vendor_email_logs(2)
  → これが警告の実体。**公開キーを知る誰でも全件読める**(email_import_queue=メール本文、guide_settlements=ガイド精算 等)。
- 読めるが0件(GRANTは残るがRLS有効でポリシー無し、または本当に空。**DBで要確認**): access_logs, estimation_fit_items,
  tour_arrangements, tour_arrangement_days, estimation_day_fixed_items(これはメモ上RLS有効済み=同じ見え方)。
  tour_arrangements は loadArrangementsList 等が直接読むため、RLS有効ならその画面は既に空表示のはず(空が正常か要確認)。
- 読めない(permission denied=対応済み): app_users audit_logs booking_costs booking_sales booking_edit_presence
  business_partner_aliases business_partner_guide_notices credit_card_statements email_import_queue_archive error_logs
  guide_bank_accounts invoices parking_reservations
- partner_merge_pending: TABLE_CONFIGにあるがpublicスキーマに存在しない(PGRST205)。

### Supabaseクライアントの使われ方
- ブラウザ(index.html・guide.html): publishableキー(sb_publishable_…、anon相当)で createClient。**Supabase Auth使用0件**
  (ログインは app_users 独自方式+署名トークン)。よってブラウザは常に anon ロールで、`authenticated` ポリシーは誰にも当たらない。
- サーバー(api/*.js。Vercel Node/Edge): SUPABASE_SERVICE_ROLE_KEY で PostgREST を fetch(RLSバイパス)。table-crud / email-import /
  login / add-user / change-password / list-users / extract-card。Edge Function(Supabase側)は無し。
- scripts/・parking-automation・email-automation: service_role必須化済み(anonフォールバックはPR済みで除去)。
- ブラウザの直接アクセス(残り): SELECT — 上記30テーブル+dynamic(fetchAllRowsGeneric/copyEstimation/confirmArrCopy/checkNoSaveConflict)、
  INSERT — access_logs(logAction/doLogin)・error_logs(logError)、SELECT — access_logs(loadLogs)、
  RPC 7本 — get_gross_summary/top_tours/trends, get_guide_settlements_summary, get_hotel_cancel_alert_counts, search_hotel_management,
  search_business_partners、Storage — guide-receipts の list/remove(deleteBookingData)。guide.html — bookings, guide_settlements,
  guide_settlement_items, learned_mappings のSELECT(書き込みは table-crud の guest* action)。
- ブラウザ(コード)からの直接書き込みは全テーブルAPI経由済み。例外は access_logs/error_logs のINSERT 3箇所のみ(下の追加調査で再確認)。
  【訂正】この行は初版で「anonの書き込み権限は…INSERTのみ**のはず**」と書いたが、DB権限の実測はしておらず推測だった。
  実際の権限一覧はそれと食い違う(下記「anon書き込み権限の追加調査」)。

### 画面別の依存(RLS無効の30テーブル、主なもの)
- 予約一覧/詳細/ダッシュボード: bookings, booking_hotels/buses/restaurants/facilities/guides/water_items, tour_arrangement_headers/notes,
  tour_guides, tour_day_itinerary, local_expenses, bullet_train_arrangements, estimation_booking_reflections(openBookingDetail 他)
- 手配書/ガイド資料: arrangement_documents/_days/_notes, tour_* (openGuideDocEditor, buildGuideDocExportPayload)
- 見積: estimations, estimation_days, estimation_fixed_rows(loadEstimations, openEstimationEditor, copyEstimation)
- ガイド精算/仮払い: guide_settlements, guide_settlement_items, guides, local_expenses(loadGuideSettlements, loadGuideAdvanceList) + guide.html
- 取引先/Agent: business_partners, business_partner_contacts, agents, learned_mappings, card_holders
- メール受信箱: email_import_queue(8124行。fetchEmailInboxPendingRows, renderEmailInboxPage 他)
- 観光地/ホテル管理・運行カレンダー: booking_facilities/hotels, facility_operating_info, vendor_email_logs, renderTourCalendar
- バックアップ/アーカイブ/予約削除: 上記ほぼ全テーブル(backupBookingDataBeforeDelete, exportFullBackup, exportFiscalYearArchive)

### 結論(提案。SQLは未実行)
- **今すぐ「ポリシー無しでRLS有効化」すると、上記30テーブルを直接読む画面がほぼ全部空表示になりアプリが実質止まる**(書き込みは
  APIなので無事だが、読み取りが空になり、旧メモにある「空データのまま保存」の事故リスクも再燃)。RPC7本もSECURITY INVOKERなら空を返す
  (SECURITY DEFINERの関数が無いかは要確認: 下記SQL)。
- ユーザーの当初案(認証済みユーザーのみのポリシー)は、Supabase Auth未使用のため **`TO authenticated` は誰にも当たらず全面遮断**、
  `TO anon USING (true)` にすると警告は消えるが実質全公開のまま(過去にJUNが不採用と決定済み)。
- 方針は従来どおり: 直接SELECTをtable-crudのquery/rpc(ログイン検証つき)へ移行 → バッチ2〜4順にRLS有効化+anon/authenticated REVOKE。
  移行が済むまでの暫定策としては、(a)公開キーのローテーション(古い画面の全員再読み込みが必要)や(b)新規読み取り経路の禁止は効果が限定的で、
  実効的な閉鎖は移行完了のみ。優先度は露出の大きい順: email_import_queue → guide_settlements/items/guides → business_partners/contacts/agents
  → bookings系 → 見積系 → 手配書系 → 残り。
- ポリシー案(移行完了後の最終形、テーブル共通): `alter table public.<t> enable row level security;`+
  `revoke all on public.<t> from anon, authenticated;`+`grant select,insert,update,delete on public.<t> to service_role;`(ポリシーは作らない)。
  access_logs/error_logs のみ、ブラウザ直INSERTを残すなら `create policy ... for insert to anon with check (true)`(SELECT不可)、
  もしくはINSERTもAPI化して同じ最終形にする(推奨)。guide.html用の4テーブルSELECTも guest* action 相当のAPI化が必要。

### 残タスク
1. JUNがSQL Editorで読み取り専用SQLを実行して実フラグを確定(このセッションでは未取得):
   - `select tablename, rowsecurity from pg_tables where schemaname='public' order by rowsecurity, tablename;`
   - `select tablename, policyname, roles, cmd, qual from pg_policies where schemaname='public' order by 1,2;`
   - `select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef;`
     (SECURITY DEFINER関数=RLSを迂回。anonにEXECUTEが残っていないかも確認)
   - 既存の scripts/investigate_batch4_readable_tables.sql も実行(ビュー・未把握テーブルの洗い出し)
2. 本ファイル上部「作業の順番」のバッチ2→3→4を再開(バッチ2の計画は承認済み)。0件表示のtour_arrangements等の実態確認。
3. guide.html の直接SELECT4テーブルとaccess_logs/error_logsのブラウザ直接アクセス、Storage(guide-receipts)のAPI化。
4. 実行順序の厳守: コードをデプロイ→実機確認→RLS/REVOKE。RLSを先行させない。

## anon書き込み権限の追加調査(2026-09-30、調査のみ・コード/DB変更なし。DB権限そのものは未取得)

【背景】JUNがSupabaseの権限一覧で確認した anon の書き込み権限: card_holders(INSERT/UPDATE/DELETE)、estimation_day_fixed_items(同)、
learned_mappings(同)、email_import_queue(INSERT)、access_logs/error_logs(INSERT)。前回の「書き込みはINSERT2テーブルだけ」は
コード上の話としては正しいが、DB権限とは別物だった(権限は「できる」設定で、コードが使うかは別問題)。
調査範囲: index.html・guide.html・api/・api/lib/・scripts/(SQL/JS/PS1)・email-automation(VBA/BAS/PS1/XML)・parking-automation・
archive/・claude/・public/・templates/・vercel.json・package.json。`.github/`と`*.gs`(Apps Script)はリポジトリに存在しない。
index.htmlはNUL文字を含むためgrepは`-a`必須(-Iだと取りこぼす)。

### 1〜2. 6テーブルへの書き込み経路(キー種別・実行場所・ファイル:行)
- ブラウザの直接書き込み(anonキー=sb_publishable_…)は index.html の3箇所のみ(sb.from全190箇所を複数行チェーン含め機械確認。
  guide.htmlは書き込みなし):
  - access_logs INSERT: index.html:3792(logAction。全操作の監査ログ)、index.html:3911(ログイン失敗の記録)
  - error_logs INSERT: index.html:3866(logError。エラーの自動記録)
  - 上記以外の`.insert/.update/.upsert/.delete`は0件。sb.rpc 7本は定義SQLにINSERT/UPDATE/DELETE無し(読み取り専用)。sb.storage は
    guide-receiptsの list/remove のみ(index.html:10455,10457。テーブルではない)。
- email_import_queue への書き込み(**anonキーを使うものは無い**):
  - api/email-import.js:112 POST(on_conflict=subject,sender,received_at)= Vercel関数、service_role(:116)、x-import-key認証。
    呼び出し元は Outlook VBA(email-automation/exports/2026-08-14/Module1_updated.bas:110-111)と
    catchup-missed-mail.ps1:216-217(Windowsタスクスケジューラ)。どちらも x-import-key のみでanonキーは送らない。
  - api/table-crud.js:302(updateById/updateByIds。5列ホワイトリスト)= Vercel関数、service_role。呼び出し元は index.html の
    emailImportQueueApiCall(index.html:5972)。
  - scripts(手元PCで手動/タスク実行、すべて SUPABASE_SERVICE_ROLE_KEY 必須・anonフォールバック無し): dedupe_email_import_queue.js:98-100(DELETE)、
    bulk_apply_email_classification.js:44-46(PATCH)、clear_old_email_import_html_body.js:103-105(PATCH)、restore_email_snapshot.js:74-76(PATCH)。
    restore_hayabusa_missing8.js:44-48 は汎用sbInsertだが呼び出しは booking_buses(:83)のみ。
  - 【要注意】読み取りだがanonキー: email-automation/catchup-missed-mail.ps1:171-172 が sender,received_at を anon の
    GET(/rest/v1/email_import_queue)で直接読む(重複排除用。失敗しても警告のみで続行=REVOKE後は重複防止が黙って効かなくなる。
    重複は unique制約+ignore-duplicates で最終的に防がれる)。バッチ2でAPI化が必要(下の残タスク)。
  - ps1 :23 に anonキー(JWT)がハードコードされている(:171-172でのみ使用)。
- learned_mappings: 書き込みは全て API(service_role)= api/table-crud.js:290(upsertConfirm/deleteById/guestUpsertConfirm)、
  :595-606(実体のGET/PATCH/POST)。呼び出し元 index.html:5981(learnedMappingsApiCall)、guide.html:325(guestUpsertConfirm)。
  ブラウザの直接アクセスはSELECTのみ: index.html:6091, 29701、guide.html:299。
- card_holders: 書き込みは API のみ = api/table-crud.js:551(insert/updateById。admin@kictravel.jp限定チェック :1827,:1893)、
  index.html:4044,4055(cardHoldersApiCall :5878)。ブラウザの直接アクセスはSELECTのみ: index.html:4005(loadCardHolders)、:6060(fetchCcCardHolderStaff)。
- estimation_day_fixed_items: **コード内の参照が0件**(index.html・api・scripts・email-automation・parking-automationとも。
  文字列としては scripts/investigate_batch4_readable_tables.sql:36 と本メモのみ)。テーブルの作成SQLもリポジトリに無い
  (ダッシュボード等で作られた孤児テーブルの可能性)。実測: anonから読めて0件(*/0)。
- access_logs/error_logs の**読み取り**: access_logs は index.html:29869(loadLogs)がanon SELECT。error_logsの閲覧は
  api/table-crud.js:89(list。閲覧者制限 :1875)経由。
- archive/generate-haichisho.js:15-22 はanonキーで/rest/v1をGETのみ(bookings・tour_arrangement*・booking_hotels等。6テーブルへの書き込み無し。
  アーカイブ済みで現行の経路ではないが、bookings系のSELECT REVOKE時に動かなくなる)。
- PowerShellバックアップ(scripts/backup_supabase.ps1:41, backup_supabase_daily.ps1:55)は service_role 必須。読み取りのみ。
- api/table-crud.js は access_logs をTABLE_CONFIGに持たない(サーバー経由の書き込み経路は無い)。error_logsは list のみ。

### 権限が食い違う理由(推測。DBで要確認)
- リポジトリのSQLは意図としては安全側: create_card_holders_table.sql:35-44 と create_learned_mappings.sql:20-29 は RLS有効+
  読み取りポリシーのみ+`grant select to anon, authenticated`。lock_down_email_import_queue_writes.sql:20-21 は
  `revoke insert,update,delete ... from anon`。しかし**GRANT SELECT は既定権限を消さない**。Supabaseでpublicに作った表は
  既定で anon/authenticated に全権限が付く(2026/10/30より前)ため、明示的なREVOKEをしない限り INSERT/UPDATE/DELETE が残る。
  card_holders/learned_mappings は REVOKE 文がSQLに無い → 権限が残っていて不思議ではない(RLSが有効で書き込みポリシーが無ければ
  実害は出ないが、RLSの実状態は未確認)。
- email_import_queue の anon INSERT が残っているのは、lock_down_email_import_queue_writes.sql が**未実行、または後から再GRANT**された可能性。
  RLSが無効のままなら、公開キーを知る誰でも受信箱に偽メールを投入できる(要確認・優先)。
- ※以上はコードとSQLファイルからの推測。実際の権限・RLS・既定権限(pg_default_acl)はDBを見ないと確定できない。

### 3. card_holders
- 前回の48テーブルに**含まれていた**(実測: anonから読めて4行)。使われ方は上記(画面: アカウント管理内「カード名義人マスタ」= index.html:4253 の
  go('card-holders')→loadCardHolders、カード払いの名義人プルダウン = fetchCcCardHolderStaff)。バックアップ対象にも入っている。

### 4. publicスキーマのテーブル名の突き合わせ(前回48との差分)
- scripts/*.sql に`create table`があるのは18テーブルのみ(残り約30テーブルはリポジトリに作成SQLが無い=ダッシュボード等で作成)。
  SQLに出るテーブル名で前回48に無いものは0件(SQL上の差分に見えた get_payment_monthly_summary/search_payment_income/search_payment_outflow は関数)。
- 前回48に無く、メモ・SQL・DBプローブで見つかった名前:
  - estimation_day_fixed_items: DBに存在(anon読み取り可・0件)、コード参照0件(上記)。
  - audit_logs: DBに存在(anon読み取り不可=REVOKE済み)。コードはサーバー側(table-crud)からのみ。
  - 存在しない(anonのプローブで PGRST205): booking_final_checks(ファイナルチェックの記録テーブル案。未作成)、
    business_partner_facts / business_partner_web_candidates(Web取り込み機能の予定テーブル。未作成)、
    suppliers / partner_merge_pending(DROP済み: scripts/drop_partner_merge_pending.sql ほか)。
- 限界: publicスキーマの全テーブルはpg_tables/information_schemaを見ないと確定しない。コードにもメモにも出ない孤児テーブル
  (estimation_day_fixed_items のような)が他にあり得る。anonキーではOpenAPI一覧(/rest/v1/)がsecret key専用で取得できない。

### 5. 「anonの書き込み権限をREVOKEしたら止まる処理」
- card_holders(INSERT/UPDATE/DELETE): **止まる処理なし**(書き込みは全てAPI)。SELECTは index.html:4005,6060 が使うため、SELECTのREVOKEはまだ不可。
- learned_mappings(INSERT/UPDATE/DELETE): **止まる処理なし**(書き込みは全てAPI、guide.htmlもguestUpsertConfirm)。SELECT(index.html:6091,29701、guide.html:299)は不可。
- estimation_day_fixed_items(INSERT/UPDATE/DELETE): **止まる処理なし**(コード参照0件)。ただし未把握の外部利用(手動SQL・別ツール)は
  コードからは検出不能。SELECTを含む全REVOKEでも、コード上は止まらない。
- email_import_queue(INSERT): **止まる処理なし(リポジトリ上のコードでは)**。Outlook VBA・catchup PS1・全スクリプトがAPI/service_role経由。
  唯一のリスクは**JUNのPCのOutlookに入っているマクロが古い版(anon直POST)のままの場合**。リポジトリ上のVBAは2026/08/14・08/21に
  x-import-key方式へ更新済みだが、実機のマクロがそれかは確認できない → REVOKE前にOutlookのVBAエディタで確認すること。
  (SELECTのREVOKEはindex.htmlの9箇所+catchup-missed-mail.ps1:171 が止まる。バッチ2のAPI化が先。)
- access_logs(INSERT): **止まる処理あり**: index.html:3792(logAction)と:3911(ログイン失敗)。どちらも失敗を握りつぶす(console.errorのみ)ため、
  画面は普通に動くが**監査ログが黙って記録されなくなる**。先にAPI経由の記録に切り替える必要がある。
- error_logs(INSERT): **止まる処理あり**: index.html:3866(logError)。失敗はconsole.errorのみで黙って記録されなくなる(エラー通知トーストは出る)。
  同様に先にAPI化が必要(ログイン前のエラーも記録するなら、ログイン検証なしの専用actionが要る点に注意=スパム対策の設計が要る)。

### 残タスク(この追加調査分)
1. JUNがSQL Editorで実状態を確定(読み取り専用): 
   - `select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated') and privilege_type<>'SELECT' order by 2,1,3;`
   - `select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by 2,1;`
   - `select tablename, policyname, roles, cmd, qual, with_check from pg_policies where schemaname='public' order by 1,2;`
   - `select defaclrole::regrole, defaclobjtype, defaclacl from pg_default_acl;`(既定権限が原因か確認)
   - `select tablename from pg_tables where schemaname='public' order by 1;`(全テーブル名。estimation_day_fixed_itemsのような孤児の洗い出し)
2. email_import_queue の anon INSERT: 上記1でRLS/ポリシーを見て、実害(偽メール投入)があるか判断 → 業務時間外に
   lock_down_email_import_queue_writes.sql 相当のREVOKEを実行(戻しSQL付き)。前にOutlookマクロが最新版か確認。
3. catchup-missed-mail.ps1:171 のanon GETを x-import-key 経由に変更(api/email-import.js に読み取りaction追加。ps1は手元PC反映が必要)。
4. access_logs/error_logs のINSERTをAPI経由に移し、anon INSERTをREVOKE(設計: 未ログイン時のログイン失敗記録・スパム対策)。
5. estimation_day_fixed_items: 用途を確認し、不要ならバックアップ→DROPを検討(金銭データでは無いが「削除」なので4ステップ手順に従う)。
6. card_holders/learned_mappings/estimation_day_fixed_items の anon INSERT/UPDATE/DELETE(+TRUNCATE等)をREVOKE(止まる処理なし。SELECTは残す)。
7. **バッチ2(email_import_queue)は着手済みだが未実装で中断**: 調査で分かった実装上の要点 — 直接アクセス9箇所(index.html:13838 fetchPromoBodyMatchIds、
   :14537 fetchEmailInboxPendingRows、:14723 computeEmailExclusionPlan、:14904 applyEmailInboxSearch、:15009 renderEmailInboxPage、
   :15159 prefetch、:15239 sendEmailToBooking、:15345 sendEmailToPartnerMaster)+ ps1:171。既存のquery基盤(table-crud.js buildQueryParams)は
   received_atのgte・複数キーワードのOR ilike・selectの列制限が未対応 → readableに追加が必要。失敗を握りつぶしている箇所
   (:13842, :15011, :15160)は明示エラーに直す。コード変更はまだ何も入っていない。

### 7. parking_reservations(追加調査、2026-09-30。調査のみ・変更なし)
- 使っているのは3経路だけで、**anonキーを使う処理はコード上に1つも無い**:
  1. ブラウザ「駐車場 今すぐ予約」モーダル(index.html:13471-13700)→ /api/table-crud(Vercel関数・service_role): 一覧 index.html:13551(list, limit10)、
     削除 :13581(delete)、登録/更新 :13697(save)。ラッパー :13541-13542(parkingReservationsApiCall)。サーバー側は api/table-crud.js:82
     (actions: list/save/delete)、実装 :1020-1062(doParkingList/Save/Delete)、キー使用 sbFetch :620-630(apikey/Authorization とも service key)。
     旧URL /api/parking-reservations は vercel.json:24 が table-crud に転送。ログイン検証つきセッショントークン+書き込みは画面の版ガード(426)対象。
  2. parking-automation/book-parking-now.js(JUNさんのPCで手動実行するPlaywright自動化): `createClient(URL, SUPABASE_SERVICE_ROLE_KEY)` :237。
     未設定なら :229-234 でエラー終了(anonフォールバック無し)。読み取り :240-244(status='即時実行待ち')、更新 :60/:63/:68(実行中/完了/失敗を書き戻し)。
  3. scripts/backup_supabase_daily.ps1:155(日次バックアップ。読み取りのみ、SUPABASE_SERVICE_ROLE_KEY 必須 :55)。
- 使われなくなった経路: parking-automation/parking-kyoto-terrsa.js:63-68 と parking-kyoto-terrsa-midnight.js:115-120 は、以前anonキーでINSERTしていたが
  2026-09にanonキーとDB記録を削除済み(使用禁止スクリプト。コンソール出力のみ)。parking-automation/ の他ファイル・lib にSupabase参照は無い
  (package.json:14 に @supabase/supabase-js があるのは book-parking-now.js 用)。guide.html・api/その他・email-automation・vercel cron・.github は参照なし。
- リポジトリ内のSQL: scripts/lock_down_parking_reservations.sql:17 `revoke all ... from anon, authenticated`、:20 `grant select,insert,update,delete ... to service_role`。
  作成SQLは parking-automation/README.md:317-333(`alter table ... disable row level security`)にあるのみ。
  **parking_reservations に対する `create policy` は、リポジトリのどのSQL/README にも無い**。よって「anon向けCRUDポリシー(USING true)」は
  リポジトリ外(ダッシュボード等)で作られたもので、コードでは追跡できない(RLSを後から有効化した際に作られた可能性)。
- 実測(anon公開キーでGET limit=0): 42501 permission denied → **現状はGRANTが無いので読み書きできない**(lock_down SQLが効いている)。
- リスク: ポリシー(USING true)はGRANTが無い間は無害だが、誰かが `grant ... to anon` や既定権限の再適用をした瞬間に、
  支払方法・車両ナンバー・運転手氏名・電話番号が全件読み書き可能になる(GRANTとRLSポリシーの二重の安全弁のうち、ポリシー側が無効)。
- REVOKE/ポリシー削除で止まる処理: **無し**(上記3経路は全てservice_role。service_roleはRLSをバイパスするのでポリシー削除でも動く)。
  提案(未実行): `drop policy "<名前>" on public.parking_reservations;` を、事前に pg_policies で名前を確認し、RLS有効状態(relrowsecurity)を確認してから実行。
  RLSを有効のまま残し、ポリシー0件=service_roleのみ、が最終形。戻しは `create policy ... for all to anon using (true) with check (true);`(元の定義を pg_policies で控えておくこと)。
- 残タスク: JUNが `select policyname, roles, cmd, qual, with_check from pg_policies where tablename='parking_reservations';` と
  `select relrowsecurity from pg_class where oid='public.parking_reservations'::regclass;` を確認 → ポリシー削除を業務時間外に(バックアップ→確認→実行→再確認の4ステップ)。

## RLS全体整理(2026-09-30 第3報。調査と設計のみ・コード/DB/別ブランチの変更なし。SQLは案で未実行)

【前提】JUNがSQL Editorで確認した実DB: A群=RLS無効+anon SELECT(17)、B群=RLS有効だがanon向けSELECTポリシーが USING(true) で実質公開(17)。
email_import_queue は anon の INSERT と SELECT が実際に通る。別ブランチ claude/magical-ride-6phzj3 は別セッションが作業中のため読むだけ(変更していない)。
なお「バッチ2」の呼び名は**別ブランチ側では estimations 系**(下記638ef49)。email_import_queue の移行は、番号を付けず「email_import_queue移行(最優先)」と呼ぶ。

### 1. コミット状態(git fetch後、2026-09-30)
- origin/main = d326a3c(PR #219 マージ)。本作業ブランチ claude/jolly-bohr-wsq2w8 はその上に SESSION_NOTES.md の追記3コミットのみ(コード差分なし)。
- claude/magical-ride-6phzj3 は main に対し 8コミット先行(0後行)。すべて別セッション(session_01PNZtD1…)、PR #220 相当・未マージ:
  1. 2b2ebda(09-28) SESSION_NOTES.md のみ: PR #219 マージ後の作業手順を記録
  2. e312a5a(09-29) `scripts/emergency_fix_estimation_fixed_rows_anon_policy.sql`(新規115行)、`scripts/investigate_dangerous_anon_policies.sql`(新規51行): SQLのみ・コード変更なし
  3. 638ef49(09-29) `api/lib/app-version.js`(+6/-1。APP_VERSION/MIN_WRITE を 2026092901 へ)、`api/table-crud.js`(+100/-20)、`index.html`(+117/-69): estimations/estimation_days/estimation_fixed_rows/business_partner_contacts・RPC search_business_partners を query/rpc 経由に置換、空データで進む危険3件を修正
  4. 04e79da(09-29) SESSION_NOTES.md のみ: 緊急対応・APP_VERSION・Preview実機確認手順(11項目)
  5. 2de97b6(09-29) `index.html`: loadGuideAdvanceList を日付未指定で開くと Bad Request になる不具合の修正
  6. a650421(09-29) SESSION_NOTES.md のみ: 上記の原因調査・残課題・仮払い一覧の表示見直し依頼
  7. 1adaf90(09-29) `index.html`: 仮払い一覧は日付未指定時に既定で直近60日、バッチ対象外3テーブルの失敗は小さい注意表示
  8. 54a8f3a(09-29) SESSION_NOTES.md のみ: 上記の記録(恒久対応=3テーブルのAPI経由化はバッチ3・4に含める)
  - `scripts/enable_rls_batch2.sql` は**まだ存在しない**(e312a5a のSTEP 5と04e79da が「これから作成」と記載)。

### 2. e312a5a のSQL全文(実行はしていない。STEP 0/1/2/4 と investigate は読み取り専用SELECT。書き込みは STEP 3 と STEP 5 予定分のみ)
STEP 3 の本体:
```sql
revoke insert, update, delete, truncate, references, trigger on public.estimation_fixed_rows from anon, authenticated;
drop policy if exists "Allow anon full access to estimation_fixed_rows" on public.estimation_fixed_rows;
drop policy if exists estimation_fixed_rows_temp_read_only on public.estimation_fixed_rows;
create policy estimation_fixed_rows_temp_read_only on public.estimation_fixed_rows for select to anon, authenticated using (true);
comment on policy estimation_fixed_rows_temp_read_only on public.estimation_fixed_rows is '2026-09-29緊急対応の暫定措置。バッチ2(API経由化)デプロイ・確認後に削除すること。';
notify pgrst, 'reload schema';
```
STEP 5(バッチ2のRLS有効化SQL `enable_rls_batch2.sql` に含める予定、ファイル単体では実行しない):
```sql
drop policy if exists estimation_fixed_rows_temp_read_only on public.estimation_fixed_rows;
revoke select on public.estimation_fixed_rows from anon, authenticated;
```
STEP 0(rowsecurity / pg_policies / role_table_grants の確認)、STEP 2(削除後のanon許可ポリシー数)、STEP 4(pg_policies / grants / has_table_privilege 6種の確認)はすべてSELECT。
investigate_dangerous_anon_policies.sql は SELECT 3本(anon/publicの無条件書き込み系ポリシー、anon/publicのSELECTポリシー一覧、RLS有効でポリシー0件のテーブル)。

### 3. 別ブランチ(638ef49)の所見 — **未解消の直接SELECTが残っている**
- `index.html`(別ブランチ)11909-11910 の copyEstimation 内 `fetchChildRows = async (table)=>{ const {data: rows} = await sb.from(table).select('*').eq('estimation_id', id); ... }` が
  estimation_days / estimation_fixed_rows(:11914-11915)を**まだブラウザから直接**読む。しかも error を見ず `rows||[]` で空配列にする。
  04e79da の「直接のsb.from/sb.rpc呼び出しは0件になったことをgrepで確認済み」は、テーブル名が変数の `sb.from(table)` を見落としている。
- 影響: e312a5a のSTEP 5(SELECTポリシー削除+REVOKE)や estimation_days のRLS有効化を先に実行すると、見積もりの「コピー」が
  日程・固定費が空のまま**エラー無しで成功**する(コピー元は無事だが、コピー先が空)。実機確認手順(04e79da の手順3)でも、
  ポリシー削除前なら見落とす。→ 別セッションに伝えて修正してもらうこと(本セッションは別ブランチに触れない)。
- 同種の動的指定は main にも残る(下の一覧の[動的]): fetchAllRowsGeneric(:6156)、confirmArrCopy(:13143)、checkNoSaveConflict(:13315)。

### 4. 33テーブルの anon キー使用箇所(git show で main と別ブランチの index.html を機械抽出。行番号は main の d326a3c。別ブランチでは +20〜60行ずれる)
【使用先の全範囲】anon(公開)キーを持つファイルはこの4つだけ: `index.html`、`guide.html`、`archive/generate-haichisho.js`(:15 `process.env.SUPABASE_KEY || 'sb_publishable_…'`)、
`email-automation/catchup-missed-mail.ps1`(:23 anon JWT。:171-172 で使用)。scripts/・parking-automation・api/・*.bas・*.vba は service_role 必須または API 経由
(`.gs` は存在しない)。sb.from は index.html 全190箇所(コメント内0)を同一行パターンで機械抽出済み。
`archive/generate-haichisho.js` は vercel.json にも api/ にも無い未配線の旧コードで、bookings(:195)・tour_arrangements(:199)・tour_arrangement_days(:207)・booking_hotels(:209)を anon GET する。
RPC は全て SECURITY INVOKER(リポジトリのSQL定義。本番で prosecdef=false を確認済みなのは入出金3本と search_business_partners の4本のみ。gross系・仮払い集計・ホテル系は本番未確認=要確認)で、内部で読むテーブルは anon 権限で読む:
get_gross_summary/get_gross_top_tours/get_gross_trends → bookings、get_guide_settlements_summary → guide_settlements+guide_settlement_items、
get_hotel_cancel_alert_counts → booking_hotels、search_hotel_management → booking_hotels+bookings、search_business_partners → business_partners+business_partner_contacts。

**A群(RLS無効+anon SELECT) 17テーブル**

- `arrangement_document_days`: main= index.html backupBookingDataBeforeDelete:10387, openGuideDocEditor:20152, buildGuideDocExportPayload:20340, runSkippableIsolated:20991 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `arrangement_document_notes`: main= index.html backupBookingDataBeforeDelete:10388, openGuideDocEditor:20153, buildGuideDocExportPayload:20341, runSkippableIsolated:20992 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `arrangement_documents`: main= index.html backupBookingDataBeforeDelete:10361, loadGuideDocsList:19959, syncArrangementDocumentsFromDraft:20021, openGuideDocEditor:20151, buildGuideDocExportPayload:20339, runSkippableIsolated:20985 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `booking_guides`: main= index.html openBookingDetail:9549, backupBookingDataBeforeDelete:10356, checkGuideDoubleBookings:19036, remapGuideArrangementDocuments:19664, syncArrangementDocumentsFromDraft:20019, runSkippableIsolated:20984, renderTourCalendar:27129, checkNoSaveConflict[動的]:13315 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `booking_water_items`: main= index.html generateLocalExpensesFromArrangements:9130, openBookingDetail:9574, backupBookingDataBeforeDelete:10367, _fetchFreshArrangementSourceTables:19462, confirmArrCopy[動的]:13143 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `bullet_train_arrangements`: main= index.html generateLocalExpensesFromArrangements:9133, openBookingDetail:9575, backupBookingDataBeforeDelete:10355, loadBulletTrains:25320, onBtCsvFileSelected:25652 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `business_partner_contacts`: main= index.html loadRepresentativeContactsByPartnerIds:25827, renderPartnerContactsList:27500, loadBusinessPartnerContactsIndex:27657, fetchRepresentativeContact:27721; RPC経由: search_business_partners(index.html:27353) / 別ブランチ= 別ブランチで解消(直接4→0、RPCもAPI化)
- `estimation_days`: main= index.html exportBookingArchive:10165, exportFiscalYearArchive:10295, openEstimationEditor:11979, loadGuideAdvanceList:21475, copyEstimation[動的]:11899 / 別ブランチ= 別ブランチで**未解消**(copyEstimation の動的SELECT copyEstimation[動的]:11910 が残る。他は解消)
- `estimations`: main= index.html exportBookingArchive:10147, exportFiscalYearArchive:10279, deleteBookingData:10500, loadEstimations:11777, copyEstimation:11878, openEstimationEditor:11964, loadGuideAdvanceList:21466 / 別ブランチ= 別ブランチで解消(7→0)
- `facility_operating_info`: main= index.html loadFacilityOperatingInfoCache:17060 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `tour_arrangement_days`: main= index.html openArrangementEditor:9906, exportBookingArchive:10157, exportFiscalYearArchive:10289; archive/generate-haichisho.js:207 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `tour_arrangement_headers`: main= index.html openBookingDetail:9610, backupBookingDataBeforeDelete:10357, renderTourCalendar:27130 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `tour_arrangement_notes`: main= index.html openBookingDetail:9613, backupBookingDataBeforeDelete:10360 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `tour_arrangements`: main= index.html loadArrangementsList:9849, openArrangementEditor:9901, exportBookingArchive:10146, exportFullBackup:10226, exportFiscalYearArchive:10278, backupBookingDataBeforeDelete:10363, deleteBookingData:10478, loadGuideAdvanceList:21465; archive/generate-haichisho.js:199 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `tour_day_itinerary`: main= index.html generateLocalExpensesFromArrangements:9131, openBookingDetail:9612, backupBookingDataBeforeDelete:10359 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `tour_guides`: main= index.html openBookingDetail:9611, backupBookingDataBeforeDelete:10358 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `vendor_email_logs`: main= index.html fetchVendorEmailSentMap:6223, backupBookingDataBeforeDelete:10369, remapVendorEmailLogSourceIds:19529 / 別ブランチ= 未対応(別ブランチでも変化なし)

**B群(RLS有効だが anon SELECT ポリシー USING(true)) 17テーブル**

- `agents`: main= index.html loadAgents:28948, _ensureAgentsCacheLoaded:28964, processAgentCardFile:29324, loadDeletedAgents:29641, showInvoicePreview:30633/30636 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `bookings`: main= index.html fetchAllBookings:4276, fetchBookingsListLight:4297, refreshAgentUnlinkedBanner:5041, openBookingDetail:9406, backupBookingDataBeforeDelete:10347, showArrCopyRefSuggest:13066, confirmArrCopy:13127/13132, submitEmailSplit:16068/16074, warnRestaurantConflicts:16736, renderRestaurantConflicts:16833, saveBooking:21188, loadGross:21232/21233/21263, findCcMatchCandidates:23623/23646, loadCreditCardStatements:23739, openCcMatchModal:23947, searchCcManualMatch:24121, onBtCsvFileSelected:25632, tcBuildAgentColorMap:26890, renderTourCalendar:27110; guide.html:150; archive/generate-haichisho.js:195; RPC経由: get_gross_summary(:21256), get_gross_trends(:21350), get_gross_top_tours(:21403), search_hotel_management(:25232) / 別ブランチ= 未対応(別ブランチでも変化なし)
- `booking_buses`: main= index.html generateLocalExpensesFromArrangements:9127, openBookingDetail:9571, backupBookingDataBeforeDelete:10352, remapArrDayForeignKeys:19423, _fetchFreshArrangementSourceTables:19459, renderTourCalendar:27128, fetchAllRowsGeneric[動的]:6156, confirmArrCopy[動的]:13143, checkNoSaveConflict[動的]:13315 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `booking_facilities`: main= index.html fetchAllBookingFacilities:4319, fetchAllFacilityDeadlineItems:4765, generateLocalExpensesFromArrangements:9129, openBookingDetail:9573, backupBookingDataBeforeDelete:10354, fmFetchExistingForDupCheck:18184, _fetchFreshArrangementSourceTables:19461, confirmArrCopy[動的]:13143 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `booking_hotels`: main= index.html generateLocalExpensesFromArrangements:9132, openBookingDetail:9562, backupBookingDataBeforeDelete:10351, ensureEmailInboxSuggestIndex:14133, remapArrDayForeignKeys:19422, _fetchFreshArrangementSourceTables:19458, hmFetchExistingForDupCheck:22882, loadHotelManagement:25129, renderTourCalendar:27122, fetchAllRowsGeneric[動的]:6156, confirmArrCopy[動的]:13143, checkNoSaveConflict[動的]:13315; archive/generate-haichisho.js:209; RPC経由: get_hotel_cancel_alert_counts(:25161), search_hotel_management(:25232) / 別ブランチ= 未対応(別ブランチでも変化なし)
- `booking_restaurants`: main= index.html generateLocalExpensesFromArrangements:9128, openBookingDetail:9572, backupBookingDataBeforeDelete:10353, fetchOtherRestaurantRowsByDates:16703, renderRestaurantConflicts:16791, remapArrDayForeignKeys:19424, _fetchFreshArrangementSourceTables:19460, confirmArrCopy[動的]:13143 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `business_partners`: main= index.html loadSuppliersCache:7772, loadBusCompaniesCache:7890, loadHotelPartnersCache:7951, loadFacilityPartnersCache:7994, loadRestaurantPartnersCache:8288, loadAllPartnersCache:8326, ensureEmailInboxSuggestIndex:14145, printArrangementSummaryList:26208, loadPartners:27283, processCardFile:28008, handleMultiLocBatchUpload:28311, batchSaveAndNext:28458, loadDeletedPartners:28889, fetchAllRowsGeneric[動的]:6156; RPC経由: search_business_partners(index.html:27353) / 別ブランチ= 未対応(別ブランチでも変化なし)
- `guides`: main= index.html _resolveGuideIdByName:11146, askVoucherPaymentInfo:11185, populateGuideRegistrySelects:21605, loadGuideRegistry:21631, loadDeletedGuides:21886 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `guide_settlements`: main= index.html generateLocalExpensesFromArrangements:9164, exportBookingArchive:10148, exportFullBackup:10227, exportFiscalYearArchive:10280, backupBookingDataBeforeDelete:10362, deleteBookingData:10452, loadGuideSettlements:10561, syncAdvancePaymentsFromCosts:10910, loadGuideAdvanceList:21467, printGuideSettlementFromList:21995; guide.html:133,143; RPC経由: get_guide_settlements_summary(:21935) / 別ブランチ= 未対応(別ブランチでも変化なし)
- `guide_settlement_items`: main= index.html exportBookingArchive:10177, exportFiscalYearArchive:10302, backupBookingDataBeforeDelete:10400, loadGuideSettlements:10564, printGuideSettlementFromList:21999; guide.html:156; RPC経由: get_guide_settlements_summary(:21935) / 別ブランチ= 未対応(別ブランチでも変化なし)
- `local_expenses`: main= index.html openBookingDetail:9688, backupBookingDataBeforeDelete:10368, loadGuideAdvanceList:21468 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `estimation_booking_reflections`: main= index.html openBookingDetail:9703, backupBookingDataBeforeDelete:10370 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `estimation_fit_items`: main= **なし** / 別ブランチ= 使用0件
- `estimation_fixed_rows`: main= index.html exportBookingArchive:10166, exportFiscalYearArchive:10296, openEstimationEditor:11982, copyEstimation[動的]:11899 / 別ブランチ= 別ブランチで**未解消**(copyEstimation の動的SELECT copyEstimation[動的]:11910 が残る。他は解消)
- `card_holders`: main= index.html loadCardHolders:4005, fetchCcCardHolderStaff:6060 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `learned_mappings`: main= index.html fetchLearnedMappings:6091, loadLearnedMappingsAdmin:29701; guide.html:299 / 別ブランチ= 未対応(別ブランチでも変化なし)
- `email_import_queue`: main= index.html fetchPromoBodyMatchIds:13838, fetchEmailInboxPendingRows:14537, computeEmailExclusionPlan:14723, applyEmailInboxSearch:14904, renderEmailInboxPage:15009, prefetchEmailInboxNextPageBodies:15159, sendEmailToBooking:15239, sendEmailToPartnerMaster:15345; email-automation/catchup-missed-mail.ps1:171 / 別ブランチ= 未対応(別ブランチでも変化なし)

### 5. 使用0件のテーブルのロックSQL/ロールバックSQL(案・未実行)
共通の実行前確認(読み取り専用。CLAUDE.md「RLSポリシー削除・REVOKE作業の手順」): 
`select tablename, rowsecurity from pg_tables where schemaname='public' and tablename in (…);` と
`select tablename, policyname, roles, cmd, qual from pg_policies where schemaname='public' and tablename in (…);` を実行し、ポリシー名を控える。
ロックSQLは service_role への GRANT を必ず含める(過去に GRANT漏れで permission denied が起きた: scripts/fix_group1_service_role_grants.sql)。
REVOKE の前提は、APIサーバー側(service_role)がRLSをバイパスすることと、下の「使用0件」が anon 経路(ブラウザ/guide.html/archive/ps1/RPC)で0件であること。

**(a) 今すぐ可: estimation_fit_items**(anon経路の使用0件。サーバー側は table-crud.js の deleteByField のみ=service_role、scripts/check_estimation_fit_items_count.js も service_role 必須)
```sql
-- ロック
revoke all on table public.estimation_fit_items from anon, authenticated;
alter table public.estimation_fit_items enable row level security;
grant select, insert, update, delete on table public.estimation_fit_items to service_role;
notify pgrst, 'reload schema';
-- ロールバック(元はRLS有効+anon SELECTポリシー USING(true) のため、SELECTを戻せば元どおり読める)
grant select on table public.estimation_fit_items to anon, authenticated;
--   指示どおり「RLS無効に戻す」場合のみ追加: alter table public.estimation_fit_items disable row level security;
--   (元がRLS有効なので、厳密な原状回復ならdisableしない)
notify pgrst, 'reload schema';
```
**(b) 別ブランチ(claude/magical-ride-6phzj3)のマージ+本番デプロイ+全員再読み込み後に0件になる: estimations、business_partner_contacts**(A群=RLS無効)
- business_partner_contacts は RPC search_business_partners も同ブランチでAPI化されるため、RPCのEXECUTE REVOKEも同時に行う。
```sql
-- ロック
revoke all on table public.estimations from anon, authenticated;
alter table public.estimations enable row level security;
grant select, insert, update, delete on table public.estimations to service_role;
revoke all on table public.business_partner_contacts from anon, authenticated;
alter table public.business_partner_contacts enable row level security;
grant select, insert, update, delete on table public.business_partner_contacts to service_role;
revoke execute on function public.search_business_partners(text, text) from anon, authenticated, public;
notify pgrst, 'reload schema';
-- ロールバック(SELECTのみ・RLS無効に戻す)
alter table public.estimations disable row level security;
grant select on table public.estimations to anon, authenticated;
alter table public.business_partner_contacts disable row level security;
grant select on table public.business_partner_contacts to anon, authenticated;
grant execute on function public.search_business_partners(text, text) to anon, authenticated, public;
notify pgrst, 'reload schema';
```
**(c) 条件付き(copyEstimation の動的SELECT修正後に0件): estimation_days、estimation_fixed_rows**
- 修正前に実行すると、見積もりのコピーが空の日程・固定費でエラー無しに成功する(上の3.参照)。
```sql
-- ロック
revoke all on table public.estimation_days from anon, authenticated;
alter table public.estimation_days enable row level security;
grant select, insert, update, delete on table public.estimation_days to service_role;
drop policy if exists estimation_fixed_rows_temp_read_only on public.estimation_fixed_rows;   -- e312a5a STEP 5
revoke all on table public.estimation_fixed_rows from anon, authenticated;
alter table public.estimation_fixed_rows enable row level security;
grant select, insert, update, delete on table public.estimation_fixed_rows to service_role;
notify pgrst, 'reload schema';
-- ロールバック
alter table public.estimation_days disable row level security;
grant select on table public.estimation_days to anon, authenticated;
create policy estimation_fixed_rows_temp_read_only on public.estimation_fixed_rows for select to anon, authenticated using (true);
grant select on table public.estimation_fixed_rows to anon, authenticated;
notify pgrst, 'reload schema';
```
- 上記以外の31テーブルは anon 経路の使用があり、現時点で使用0件のテーブルは estimation_fit_items のみ(他ブランチのマージ後は+estimations、business_partner_contacts)。

### 6. 使用箇所のあるテーブル: 置き換え先・優先順位(露出の大きさ順のバッチ案)
【置き換え先の既存パターン(api/table-crud.js)】TABLE_CONFIG[table].readable(filters/order のホワイトリスト)+ index.html の tableQueryAll / tableQueryAllIn(200件分割)/ tableQueryBatch(5クエリ/回)/
tableQueryMaybeSingle / tableQueryCount / rpcCallAll(RPC_WHITELIST。別ブランチで params 宣言方式へ汎用化)。読み取りは ログイン検証必須(verifySessionToken)・失敗は例外(部分結果を返さない)。
現状 readable を持つのは booking_sales / booking_costs / invoices / credit_card_statements / business_partner_guide_notices / business_partner_aliases(main)。
guide.html はログイン無し(精算リンクの access_token)なので、table-crud の guest 系と同様の**読み取り専用ゲストaction**(トークン照合つき)が別途必要。
`.or()` / `gte` / 複数キーワード ilike / 列の絞り込み(selectable)は現行 readable が未対応 → 着手前に各呼び出しの絞り込みを洗い出し、演算子を最小限で追加する。
新規に取得処理を作る箇所は CLAUDE.md の「5分TTLキャッシュ・必要列のみ」を最初から適用する。

【露出の大きさ(公開キーで誰でも読める量・機微度)による優先順位案】行数は 2026-09-30 の anon 実測。
1. **email_import_queue**(8,124行、メール本文・送信者。anon INSERT も通る=偽メール投入可)— 最優先。設計は次の7.
2. **ガイド精算系**: guide_settlements(63行。**access_token を含み、anonが全トークンを読める=他人のガイド精算リンクで書き込み操作(guestInsert等)が可能**)、
   guide_settlement_items(2,647行)、guides(135行)。guide.html の読み取り(:133,143,150,156)と get_guide_settlements_summary の対応が必要。
3. **取引先・Agent**: business_partners(1,172行)、agents(156)、learned_mappings(822。送信元学習)、card_holders(4)。business_partner_contacts(365)は別ブランチ側で完了予定。
4. **予約系**: bookings(1,363。24箇所+guide.html+archive+RPC4本)、booking_hotels/buses/restaurants/facilities、local_expenses(780。金額)、estimation_booking_reflections。
   最も箇所が多く、backupBookingDataBeforeDelete / exportFullBackup / exportFiscalYearArchive など全テーブル読みの機能を含むため最後寄りだが、bookings 自体の露出は大きい(顧客・日程)。分割して段階的に。
5. **手配書・ツアー系**: tour_arrangements 系、arrangement_document 系、bullet_train_arrangements、tour_guides、tour_day_itinerary、booking_guides、booking_water_items、vendor_email_logs、facility_operating_info(1行)。
   行数は少なく(0〜1,268)、`archive/generate-haichisho.js` は退役(削除)が最短。
6. **使用0件(先行)**: estimation_fit_items → 上の5.(a)。estimations / business_partner_contacts → 別ブランチのマージ後に5.(b)。
- 各バッチの共通手順: コード→デプロイ→実機確認→全員再読み込み(APP_VERSION引き上げ)→業務時間外にRLS有効化+REVOKE(ロールバックSQL併記)。RLS有効化を先行させない。

### 7. email_import_queue 移行設計(実装はしない。コード変更ゼロのまま保留)
【ブラウザの直接アクセス8箇所(main d326a3c の index.html。すべて anon SELECT。書き込みは既に emailImportQueueApiCall=table-crud 経由)】
| 関数 | 行 | 内容 | 置き換え案 |
|---|---|---|---|
| fetchPromoBodyMatchIds | 13838 | id IN(500件) + body に広告キーワードのOR ilike。失敗は握りつぶし(continue) | readable に `ilikeContainsAny`(本文のキーワード配列、最大20件)を追加。id は200件ずつ tableQueryBatch。失敗は画面に警告表示(補助判定でも黙らない) |
| fetchEmailInboxPendingRows | 14537 | imported=false, ignored=false, (is_excluded=false), received_at>=since, order received_at desc, 列は id/subject/sender/received_at/postponed/is_excluded/excluded_reason | filters に imported/ignored/is_excluded の eq、received_at の `gte`(新規)を追加。tableQueryAll。失敗は例外→既存の画面エラー |
| computeEmailExclusionPlan | 14723 | 未処理全件を body 込みで取得(数千行×本文) | tableQueryAll(サーバーが約3MB/5秒で分割)。件数が多いので進捗表示を検討。失敗は例外(既存どおり) |
| applyEmailInboxSearch | 14904 | imported=false, ignored=false, id IN(500), body ilike %term% | ilikeContains(既存)。id は200件分割+tableQueryBatch。`*` を含む検索語はサーバーが拒否するのでメッセージ表示。既存のエラー表示div(:14913)を維持 |
| renderEmailInboxPage | 15009 | 表示ページ(50件)の body を id IN で取得。失敗は無視して本文が空に見える | tableQueryAllIn。**失敗時は一覧の上に赤字の警告を表示**(空の本文を成功扱いにしない) |
| prefetchEmailInboxNextPageBodies | 15159 | 次ページの先読み。失敗は無視 | 同上の取得。失敗は先読みなので静かに諦めてよいが、本表示時(上行)に必ず再取得されエラーが出る |
| sendEmailToBooking | 15239 | id=eq の1行を subject,body,html_body,sender で取得(.single()) | tableQueryMaybeSingle。0件・失敗は alert(既存 :15240) |
| sendEmailToPartnerMaster | 15345 | id=eq の1行を subject,body,sender で取得 | 同上(既存 :15346 の alert を維持) |
- ほか(anon SELECT): `email-automation/catchup-missed-mail.ps1:171-172`(下記の専用アクション)。書き込み(INSERT)は Outlook VBA/ps1 とも x-import-key の `api/email-import.js` 経由でanonキー不使用(前回調査)。

【api/table-crud.js への追加(案)】TABLE_CONFIG.email_import_queue に readable:
- filters: id[eq,in]、imported[eq]、ignored[eq]、is_excluded[eq]、received_at[gte(新規。ISO日時文字列のみ)]、body[ilikeContains, ilikeContainsAny(新規)]
- 新規: `selectable`(読める列のホワイトリスト: id, subject, sender, received_at, postponed, is_excluded, excluded_reason, imported, ignored, body, html_body。`*` は不可。attachments 等は出さない)
- order: received_at, id。既存の updatableFields(5列)・restrictedFieldValues は変更しない。
- 認証: 既存の query と同じ verifySessionToken(ログイン必須。ゲストには開放しない)。

【catchup-missed-mail.ps1:171 を置き換える x-import-key 認証つき読み取りアクション(案)】
- 入口: 既存の `api/email-import.js`(POST `/api/email-import-insert`、vercel.json の legacyMode=insert)。ハンドラ冒頭の `x-import-key` 検証(timingSafeEqual、EMAIL_IMPORT_API_KEY)を通過した後に、`body.action === 'listKeysSince'` を追加(既存 `checkDuplicate` と同じ形)。
- リクエスト: `{ "action": "listKeysSince", "since": "2026-09-29T12:34:56+09:00" }`(ps1 の `Get-JstString $lastCheck` と同じ形式)。`since` は ISO8601 を正規表現で検証し、過去60日より古い/未来は 400。
- 処理: service_role で `email_import_queue?select=sender,received_at&received_at=gte.<since>&order=received_at.asc,id.asc` を 1,000件ずつ取得(offset ループ、最大20ページ・約5秒で打ち切り)。読み出す列は sender と received_at のみ(本文は返さない)。
- レスポンス: `{ ok:true, rows:[{sender, received_at}], truncated:false }`。打ち切った場合は truncated:true。エラーは 502 と `{error}`。received_at は今と同じ +00:00 形式のまま返す(ps1 の +09:00 への正規化コードは無変更で動く)。
- ps1 側の変更: :168-182 の Invoke-RestMethod(anon GET)を `Invoke-RestMethod -Uri $IMPORT_API_URL -Method Post -Headers @{'x-import-key'=$IMPORT_API_KEY}`(既存 :216-217 と同形)に変え、:23 の anon JWT 定数を削除。失敗時は現状の WARNING 継続でよいが、`truncated:true` の場合は WARNING を出す(重複は unique制約+ignore-duplicates が最終防御)。
- **順序(JUNの手順)**: ①api/email-import.js の新アクションを含むPRをマージ → ②本番デプロイ完了を確認(Vercelの Deployments。新アクションを curl か PowerShell で1回叩き、`ok:true` を確認) → ③JUNのPC上の ps1 を差し替え(旧ps1は anon SELECT が生きている間は動き続けるので、差し替えを急ぐ必要はないが、RLS/REVOKE より前に必須) → ④catchup-log.txt の `Existing queue keys since LastCheck: N` が0でないことを確認 → ⑤その後に email_import_queue の SELECT REVOKE。先に③を行うと新アクションが無く重複防止が止まる。

【email_import_queue のRLS/REVOKE SQL(案・未実行。デプロイ+実機確認+ps1差し替え後にJUNが業務時間外に実行。anon の INSERT の REVOKE は含めない=Outlookマクロ確認待ち)】
```sql
-- 事前確認(読み取り専用)。ポリシー名を控える
select tablename, rowsecurity from pg_tables where schemaname='public' and tablename='email_import_queue';
select policyname, roles, cmd, qual, with_check from pg_policies where schemaname='public' and tablename='email_import_queue';
-- 本体(<SELECTポリシー名> は上の結果から。cmd が SELECT または ALL で roles に anon/public を含むものが対象。INSERT用ポリシーは残す)
drop policy if exists "<SELECTポリシー名>" on public.email_import_queue;
revoke select, update, delete, truncate, references, trigger on public.email_import_queue from anon, authenticated;
alter table public.email_import_queue enable row level security;
grant select, insert, update, delete on public.email_import_queue to service_role;
notify pgrst, 'reload schema';
-- ロールバック(SELECTのみを戻す。INSERTは元々変更しない)
grant select on public.email_import_queue to anon, authenticated;
create policy email_import_queue_anon_select on public.email_import_queue for select to anon, authenticated using (true);
notify pgrst, 'reload schema';
```
- 注意: INSERT を残す間は、公開キーを知る誰でも受信箱へ偽メールを投入できる状態が続く(Outlookマクロが x-import-key 版と確認できたら別SQLで INSERT を REVOKE)。
  `on conflict (subject,sender,received_at)` の unique制約は既存。

### 8. e312a5a と、今日JUNがSQL Editorで実行したSQLとの重複・競合(実行はしていない)
| 今日実行したSQL | e312a5a との関係 |
|---|---|
| TRUNCATE/REFERENCES/TRIGGER の剥奪、default privileges の REVOKE | **重複(害なし)**: STEP 3(a) は estimation_fixed_rows だけに `revoke insert, update, delete, truncate, references, trigger` を実行。REVOKEは無い権限に対してもエラーにならず冪等。今日のREVOKEが先に効いていれば no-op。default privileges(将来作るテーブルの既定権限)には e312a5a は触れない |
| card_holders / learned_mappings / estimation_day_fixed_items の書き込み権限剥奪 | 重複なし(e312a5a は estimation_fixed_rows のみ)。estimation_day_fixed_items と estimation_fixed_rows は名前が似ているが**別テーブル** |
| error_logs の RLS 有効化 + INSERT専用ポリシー | 重複なし。ただし investigate_dangerous_anon_policies.sql の1本目(anon/publicの無条件 INSERT/ALL ポリシー)には、この error_logs の INSERT ポリシーが**「危険」として出てくる**(qual が null のため)。意図した許可なので出力を読む時に区別すること |
| parking_reservations の anon ポリシー4本の削除 | 重複なし。investigate の1本目は実行前なら parking_reservations の4本を拾えたはずで、実行後は出なくなる(削除の確認に使える) |
- **競合はなし**。留意点: (1) JUNのB群一覧に estimation_fixed_rows が「RLS有効+SELECT USING(true)」で入っているのは、e312a5a の STEP 3 が実行済みの状態と整合する(`select policyname from pg_policies where tablename='estimation_fixed_rows';` が `estimation_fixed_rows_temp_read_only` のみなら確定)。
  (2) e312a5a は別ブランチにしか無く main には入っていない(記録としては別ブランチのマージ待ち)。
  (3) 上記3.のとおり、STEP 5 を予定どおり enable_rls_batch2.sql に入れる前に copyEstimation の直接SELECTを直す必要がある(コードとSQLの実行順の競合)。
  (4) 同じ estimation_fixed_rows に対する e312a5a の STEP 3(b)(`create policy ... to anon, authenticated using (true)`)は、公開SELECTを意図して残す暫定措置であり、今日の「危険なポリシー削除」方針とは逆向き。STEP 5 まで公開が続く点を認識しておくこと。

### 9. 残タスク(この第3報分)
1. **別セッションに連絡**(本セッションは別ブランチに触れない): copyEstimation(別ブランチ index.html:11909-11910)の直接SELECTをAPI化+エラー表示化。04e79da の「直接0件」の記述訂正。enable_rls_batch2.sql の作成は修正後。
   → **2026-09-30 作業ブランチ claude/jolly-bohr-wsq2w8 で修正済み(コミット 465a1bd)。詳細は次の「RLS バッチ2 追加修正」参照。別セッションには 465a1bd の取り込みを連絡すること。**
2. JUNが pg_policies / pg_tables を確認(estimation_fixed_rows の現ポリシー名、B群17の各SELECTポリシー名、gross系などRPCの prosecdef)。
3. estimation_fit_items のロック(5.(a))を業務時間外に(JUN判断)。
4. email_import_queue 移行の実装(コード)を再開する指示待ち。実装時は本7.の設計に従い、mainではなく別ブランチのマージ状況を見てから index.html の衝突を避ける(別セッションの index.html 変更とは別領域だが同一ファイル)。
5. guide.html の読み取り(bookings/guide_settlements/guide_settlement_items/learned_mappings)を守る読み取り専用ゲストactionの設計。archive/generate-haichisho.js の退役。

## RLS バッチ2 追加修正: copyEstimation の直接SELECT(2026-09-30。マージ・SQL実行なし。別ブランチ自体は無変更)

### 経緯と状態
- 不具合: 638ef49 の copyEstimation が、テーブル名を変数にした `sb.from(table)` で estimation_days / estimation_fixed_rows をブラウザ(anon)から直接SELECTし、
  エラーも見ず `rows||[]` にしていた。04e79da の「直接呼び出し0件」は変数指定を検索から漏らしていた。RLSを有効化/暫定SELECTポリシーを削除すると、
  日程・固定費が空の見積もりコピーが**エラー無しで成功**する。
- 作業ブランチの構成: `fcb4535`(origin/claude/magical-ride-6phzj3 の8コミット=54a8f3a までを --no-ff でマージ。競合なし・SESSION_NOTES.md は自動で両方残った)
  → `465a1bd`(修正。index.html のみ +16/-6)。別ブランチ claude/magical-ride-6phzj3 は 54a8f3a のまま変更していない。
- 修正内容(index.html copyEstimation): fetchChildRows を `tableQueryAll(table, {select:'*', filters:[estimation_id eq], order:[sort_order]})` に変更(openEstimationEditor と同じ呼び方)。
  取得に失敗したら alert『コピー元の日程・固定費を読み込めなかったため、コピーを作成しませんでした:…』を出して**コピー自体を作らず中止**(copyWithChildren を呼ばない)。
  0件は「元から明細が無い」正常結果として扱う(tableQueryAll は1回でも失敗すれば例外で、部分結果や空配列を成功として返さない)。
- **別セッション/別ブランチへの取り込み**: `git cherry-pick 465a1bd`(index.html の copyEstimation だけの変更)で足りる。
  APP_VERSION: 638ef49 が 2026092901 に上げ済み。638ef49 と本修正を**同じデプロイで出す**限り追加の版上げは不要。
  638ef49 だけを先にデプロイし、本修正を後から出す場合は、その間に開かれた旧タブ(版 2026092901・修正前の copyEstimation)が
  RLS有効化後に空のコピーを作れてしまうため、本修正のデプロイ時に APP_VERSION / MIN_WRITE_APP_VERSION を再度引き上げること。

### 変数指定の sb.from の再確認(マージ+修正後のコード。index.html 31,498行・guide.html 513行を行単位で機械抽出)
- 修正前(main d326a3c と別ブランチ 638ef49 以降): 変数指定は4箇所(fetchAllRowsGeneric / copyEstimation / confirmArrCopy / checkNoSaveConflict)。
- 修正後: **3箇所**(copyEstimation が消えた)。実際に指すテーブル(コードを開いて確認):
  - `fetchAllRowsGeneric` index.html:6156 ← 呼び出し 6175 は 'business_partners'、6182 は VENDOR_EMAIL_SOURCES(全2件): booking_hotels, booking_buses
  - `confirmArrCopy` index.html:13176 `sb.from(cfg.table)` ← ARR_COPY_CONFIG(全5件): booking_hotels, booking_buses, booking_restaurants, booking_facilities, booking_water_items
  - `checkNoSaveConflict` index.html:13348 ← 呼び出し3件: booking_hotels(13371)、booking_buses(13453)、booking_guides(19028)
  - guide.html: 変数指定 0件(全て文字列リテラル)
- `sb.rpc(`: 6本すべて文字列リテラル(get_gross_summary / get_gross_trends / get_gross_top_tours / get_guide_settlements_summary / get_hotel_cancel_alert_counts / search_hotel_management)。
  **search_business_partners の sb.rpc は0件**(index.html:27428 は rpcCallAll 経由=API)。`sb.storage` は deleteBookingData の guide-receipts 2箇所のみ(テーブルではない)。
  `X.from(` は sb.from / sb.storage.from / Array.from のみ。`sb` の別名代入・`sb[...]` は0件。
- **estimation_days / estimation_fixed_rows / estimations / business_partner_contacts / RPC search_business_partners へのブラウザ直接アクセスは、
  文字列リテラルの sb.from も上の変数指定3箇所も含め、index.html・guide.html のどちらにも0件。** 上記4テーブルはこの2ファイル以外(archive/generate-haichisho.js・ps1)でも読んでいない
  (前回調査済み: archive は bookings / tour_arrangements / tour_arrangement_days / booking_hotels のみ)。

### 検証(Bash復旧後に実施。合成データ・疑似Supabase・実DBではない)
- ハーネス(scratchpad/h。コミット対象外): 本物の index.html を headless Chromium(Playwright)で開き、/api/table-crud には**本物の api/table-crud.js**(疑似PostgREST付き)を接続、
  ブラウザ側 supabase-js は「直接アクセスを記録し、RLS有効化後を模して空を返す」スタブに差し替え。画面関数を実際に呼んで(confirm/alert は自動応答)確認。
- 修正後(465a1bd): **16/16 成功**: 見積もり一覧の表示 / 編集画面(日程2件を読み込み)/ コピー成功(新見積もり=下書き、日程2・固定費2が内容一致で複製、alertなし)/
  コピー失敗(estimation_days 取得失敗・estimation_fixed_rows 取得失敗の各々で: alert表示、見積もりが増えない)/ 取引先(RPC search_business_partners 経由で一覧表示、連絡先=business_partner_contacts をAPI取得、
  RPC失敗時は画面にエラー表示)/ ガイド仮払い一覧(完走、エラー・注意表示なし、estimations・estimation_days をAPI取得)/ 対象5項目の直接アクセス記録0件。
- 修正前(別ブランチ 54a8f3a の index.html を同じ環境で実行): 9/16。**不具合を再現**: コピーは成功扱いで日程0・固定費0の見積もりが作られ、alertなし。直接アクセス検出 estimation_days, estimation_fixed_rows。
- できていないこと: 実DB・実RLS・実ログイン・実データでの確認(このセッションには接続情報が無い)、ガイド仮払い一覧の**表の中身**(手配書・現地費用のデータをハーネスに入れていない)、
  スマホ幅の表示(今回は表示の変更なし)。ブラウザ拡張(Claude in Chrome)は未接続。

### 【2026-10-01 追記】既存PR #220 と Preview URL(PRは作成していない)
- 作成前の確認で、claude/magical-ride-6phzj3 を head とする open なPRが既にあった: **PR #220**「RLS対応バッチ2: estimations/business_partner_contacts等のAPI経由化、estimation_fixed_rowsの緊急ポリシー是正」
  (https://github.com/Jun-Ryusekido/kic-travel-core-ver2/pull/220 、base=main d326a3c、head=54a8f3a、8コミット、6ファイル +557/-109、mergeable_state=clean、draft=false、2026-09-29作成)。
  他に open なPRは #144(Agent照合をagent_id基準に統一、claude/agent-id-canonical-lookup、2026-09-03〜)のみ。ご指示どおり、claude/jolly-bohr-wsq2w8 のPRは**作成していない**。
- #220 の Vercel Preview(vercel[bot] のコメントより。状態 Ready): **https://kic-travel-core-ver2-git-claude-6aca2a-jun-ryusekido-s-projects.vercel.app**
  この環境からは vercel.app へ到達できない(プロキシが 403 を返す)ため、私は開けていない。Previewのデプロイ自体の成否は上記コメントの Ready 表示のみが根拠。
- **注意: #220 の head は 54a8f3a で、修正 465a1bd(copyEstimation のAPI化)を含まない。** この Preview で下の手順3・4(見積もりのコピー)を行うと、修正前の挙動
  (現在は直接SELECTがまだ動くためコピー自体は成功するが、RLS有効化後は空コピーになるコード)を見ることになり、修正の確認にならない。
  465a1bd を確認するには、465a1bd を含むコミットが PR の head になる必要がある。選択肢: (a) JUNまたは別セッションが claude/magical-ride-6phzj3 に 465a1bd を cherry-pick して push(#220 の Preview が更新される。
  このセッションは別ブランチに触れない決まりのため実施しない)、(b) claude/jolly-bohr-wsq2w8 → main の別PRを作る(#220 と8コミットが重複するため、先にマージした方の後、もう一方が競合/重複になる点に注意。今回は見送り)。
  どちらにするかのご指示待ち。マージは一切していない。

### JUNさんが確認する手順(実機。Preview URL について)
- **Preview URL は PR を作らないと発行されない(Vercelのデプロイは PR/ブランチ push で作られるが、この環境からは vercel.app に到達できず、URLを確認できない)。**
  このため今回はマージ前に Preview で確認することはできない。確認したい場合は、JUNさんが PR 作成を指示 → Vercel の Preview URL(GitHub PR のチェック欄の「Visit Preview」)で以下を実施する。
  Preview のURLは PR ごとに `https://kic-travel-core-ver2-git-<ブランチ名>-<チーム名>.vercel.app` 形式になるが、完全なURLは発行後にしか分からない(ここでは記載しない)。
  Preview は本番と同じSupabase(本番DB)に接続するため、テスト用データ(TEST-BATCH2)で確認し、確認後に削除する。
1. 見積もり一覧: サイドバー「見積もり」→ 一覧が表示される(エラー表示にならない)。
2. 見積もり編集: 見積もりを1件新規作成(日程2行・固定費2行)して保存 → 一覧へ戻る → 開き直す → 日程・固定費が全て表示される。
3. **見積もりのコピー(今回の修正対象)**: 上の見積もりの「コピー」→ 確認ダイアログ OK → タイトルが「…(コピー)」の下書きが増え、開くと日程・固定費が元と同じ内容で入っている(空ではない)。
4. **コピーの失敗時**: ブラウザ開発者ツール → Network → 「Request blocking」に `table-crud` を追加した状態で「コピー」→ alert「コピー元の日程・固定費を読み込めなかったため、コピーを作成しませんでした」が出て、一覧に「(コピー)」が増えない
   (確認後は必ずブロックを解除)。
5. 取引先マスタ: 担当者が登録済みの取引先を開く → 担当者一覧が表示される。検索欄・カテゴリで絞り込みが効く。担当者を編集して保存 → 反映される。
6. ガイド仮払い一覧(予約台帳の「🧑‍✈️ ガイド仮払い一覧」): 日付未指定で開く → 直近60日が自動入力され一覧が表示される。見積もりにガイド代がある日程が仮払い額に反映される。「⚠ 一部の情報を取得できませんでした」が出ない。
7. 上記すべてで、開発者ツールのコンソールにエラーが出ていない。

### 実行順序(RLS/REVOKE。厳守)
- **`scripts/enable_rls_batch2.sql`(未作成)の STEP 5 — `estimation_fixed_rows_temp_read_only` ポリシーの削除と `revoke select on estimation_fixed_rows from anon, authenticated`(e312a5a の STEP 5)— は、
  次の全てが済むまで実行しない**: ①本修正(465a1bd 相当)を含むコードのマージ ②本番デプロイの完了確認 ③上記「JUNさんが確認する手順」の1〜7の実機確認 ④全員の再読み込み(APP_VERSION 2026092901 以降)。
  estimation_days / estimations / business_partner_contacts のRLS有効化・REVOKE・RPC search_business_partners の EXECUTE REVOKE も同じ条件。
  順序: コード修正 → マージ → 本番デプロイ確認 → 実機確認 → 全員再読み込み → 業務時間外にSQL(ロールバックSQL併記)→ 再検証(SELECTで件数確認+画面のハードリロード)。
- 本セッションではSQLを一切実行していない。マージ(main)もしていない。PRも作っていない。

## 最新の決定事項と作業順(2026-09-25 JUN決定。新しいセッションはまずここを読む)

### 作業の順番
1. extract-card のログイン確認(単独の小さいPR) ← 最優先。他の作業より先
2. バッチ2 → 3. バッチ3 → 4. 外部から読めるその他のテーブル(バッチ4) → 5. Web取り込み機能
- 1の後、バッチ2の前に: partner-similarity / ai-inbox のログイン確認(別の小さいPR。JUN決定、下記)

### 1. extract-card のログイン確認 — PR #213 マージ済み(main dc065b8、2026-09-25)。実機確認は後日
- 【決定(JUN、2026-09-25)】有料APIの穴を早く塞ぐため、Previewでの実機確認を後回しにしてマージした
  (Preview status success を確認してからマージ)。実機確認は後日: ログイン中のAI読み取り(OCR各種・向き判定・
  観光施設のWeb検索)、guide.html の領収書読み取り(1枚/複数枚)、未ログイン・古い画面で401になること。
- PR #213 のコミット: d0e041d(コード)/ 5076c25(読み取り専用SQL)/ 2f98fab・74d1365(SESSION_NOTES)。
  753b1fa(帰着日の逆転チェック)は含まれていない(別セッションのブランチ claude/blissful-rubin-5z8ftu にあり、未マージ)。
- 動かなかった場合の戻し方(コードのコミットだけを戻す。SESSION_NOTES・SQLは残す):
  1. 最速: Vercelの Deployments で、1つ前の本番デプロイ(main 196fd16)を「Instant Rollback」する(数十秒。コードは戻らない)。
  2. その後コードを戻す: origin/main から新しいブランチを作り `git revert d0e041d` → push → PR → Preview確認 → マージ。
     (GitHubのPR #213画面の「Revert」ボタンはマージ全体(SESSION_NOTES・SQL含む)を戻すため、使うならその点に注意)
  - 戻した場合: extract-card は再びログイン確認なしになる(穴が開く)。index.htmlがX-Session-Tokenを送るだけ・
    guide.htmlがguestTokenを送るだけの状態は、戻した後のサーバーでも無害(無視される)。
- 問題: api/extract-card.js に verifySessionToken が無く、未ログインで有料のAI(Anthropic API)・Web検索
  (mode:'facility-operating-info'、web_search max_uses 4)を誰でも呼び出せた。
- ログインなしの正当な呼び出し元(調査結果): guide.html の領収書読み取り(receiptImageBase64、2箇所)だけ。
  他はすべて index.html(ログイン済み)。public/js/image-compress.js の向き判定(orientationVariants)も index.html からのみ。
  scripts/・email-automation・parking-automation からの呼び出しは無し。
- 【決定(JUN)】guide.html は精算リンクで確認する: ログインが無い場合は guestToken(精算リンクのaccess_token)を
  guide_settlements と照合(table-crudのresolveGuestSettlementと同じ方式)。ゲストは領収書読み取りだけ
  (他の入力はサーバーで捨てる。receiptImageBase64が無ければ403)。
- 実装: 画面(index.html)のfetchラッパーが /api/ への全リクエストに X-Session-Token(currentUser.token)を付ける。
  extract-card はそれを verifySessionToken で検証。無効なら 401 {code:'SESSION_REQUIRED'}(AIは呼ばない)。
  guide.html は2箇所のbodyに guestToken を追加。
- 古い画面から呼ばれた場合: 古いindex.htmlはヘッダーを送らないため 401。全呼び出し元(24箇所)が !ok をエラー表示する
  (「ログインを確認できませんでした。画面を再読み込みしてから…」)。AI読み取りは読み取り専用のためデータは壊れない。
  向き判定だけは失敗時に黙って0度扱いだが、直後の本体の読み取りが401でエラー表示になる。古いguide.html
  (キャッシュ)は guestToken を送らないため 401 → 「読み取りに失敗しました: …再読み込み…」。
  ログインの有効期限(12時間)切れも同じ401。
- 他のAPIの確認結果(有料APIでログイン確認なし): partner-similarity.js(取引先・Agentの類似判定)、
  ai-inbox.js(メールの関連性判定・REF#抽出)。どちらも index.html からのみ・Edgeランタイム(Nodeのcryptoが
  使えないためWeb Crypto版の検証が必要)。【決定(JUN)】別の小さいPRで対応(画面側のヘッダー送信は1のPRで入る)。
  他の関数: email-importは x-import-key で認証、login/change-password/add-user/list-users は有料API呼び出し無し。
- SQL要否: 不要。

### 1b. partner-similarity / ai-inbox のログイン確認 — PR #214 マージ済み(main 06b2c8c、2026-09-25)。実機確認は後日
- 【決定(JUN)】PR #213と同様、Preview status success を確認してマージ。実機確認(取引先・Agentの類似判定、メールの関連性判定・REF#抽出)は後日。
- 戻し方: Vercelで1つ前の本番デプロイ(main dc065b8)をInstant Rollback → `git revert 1f1962c` のPR。
- どちらもEdgeランタイムのため、Web Crypto版の検証 api/lib/session-token-edge.js(verifySessionTokenEdge)を追加。
  トークン形式・秘密鍵・期限は lib/session-token.js と同じ(Node側で発行したトークンをEdge側で検証できることをハーネスで確認)。
- 画面側の変更は不要(PR #213 の fetchラッパーが X-Session-Token を付けている)。
- 未ログイン・古い画面(PR #213 より前の index.html)から呼ばれた場合:
  - 取引先・Agentの類似判定(callPartnerSimilarityAi / callAgentSimilarityAi): !ok を黙って「AI候補なし」扱い →
    完全一致の重複チェックだけが動く(表記ゆれの重複は警告されない。データは壊れない)。
  - メールの関連性判定(classify): 判定されないまま一覧に残り、次回再判定(隠れる方向には倒れない)。
  - REF#抽出(extractRefs): エラー表示。
- SQL要否: 不要。

### バッチ2
- 計画は承認済み: 空データ対策4件、search_business_partners を先にAPI経由化、APP_VERSIONの引き上げ、コミット4分割。1の完了後に着手。
- estimation_fixed_rows: 現状確認SQL(scripts/investigate_estimation_fixed_rows_access.sql、読み取り専用)をJUNが実行し、
  anonから読める状態ならバッチ2に含める。(コード上は index.html の直接SELECT 4箇所: 見積一覧/複製/読み込み等)

### バッチ4の準備
- バッチ1〜3に入っていないテーブルのうち anon/authenticated が実際に読めるもの(RLS無効、またはRLS有効でも
  読めるポリシーがある)を洗い出す読み取り専用SQL: scripts/investigate_batch4_readable_tables.sql(JUNが実行)。

### 5. Web取り込み機能(着手は5の順番が来てから)
- 「観光施設」カテゴリを追加する。「その他」からの振り分けは、予約(booking_facilities)で使われている施設名と
  照合した候補一覧を出し、JUNが確認してから移す。
- 新テーブル business_partner_facts / business_partner_web_candidates と business_partners.official_url の追加は案どおり。
  (新規テーブルはCLAUDE.mdのとおり service_role へのGRANT+RLS有効化を同じSQLファイルに含める)
- 営業時間は facility_operating_info を正として継続。
- 追加項目の採否は案どおり(外国語対応・車椅子対応・客室数は保留)。
- モデルは実装後に10件ほど試し、精度と実費(usage)を比べてから決める。一括実行は必ず費用見込みの確認ダイアログを出す。

### booking_buses.driver_check_in / driver_check_out(2026-09-25 調査、JUN確認: date型で実在)
- 画面に入力欄は無い(バスタブの表、AI読み取りの確認ダイアログ showBusConfirmDialog のどちらにも無い)。
  保存処理 buildBusRows にも含まれない(driver_hotel_name/phone/address/amount も同様)。→ JUNの指示どおり報告のみ。
- 読み込み側の扱い: mapBusDbRow が DB値を bdBusItems に読み込む(保存時の食い違い検知は buildBusRows 同士で
  比較するため、この列は比較対象外)。「他のREF#からコピー」(ARR_COPY_CONFIG.bus)も読み込むが、保存時に落ちる。
  AI読み取り(バス)で返る値は、バス自体の情報が無い行の開始日/終了日の補完(fillMissingBusGenericFields)にだけ使われ、
  列には保存されない。仮払い一覧の自動生成(8893行付近)は DB の driver_check_in を「ドライバー宿泊費」の日付に使うが、
  driver_hotel_amount>0 の行だけ(画面から保存されないため、実質は過去データのみ)。
- 注意: バスの保存は replace(全削除→再挿入)のため、DBにこれらの列の値があっても、その予約のバスタブを保存すると
  NULL に戻る。値が残っている行があるかは JUN の確認SQLで確かめる(下記、未実行)。

### ドライバー宿泊(2026-09-25 JUN決定: 案C。第1段階 PR #216 マージ済み(main 294fc32、2026-09-27))
- SQL(add_lodging_for_to_booking_hotels.sql)はJUNが本番で実行済み(列追加・関数2本の更新、2本とも lodging_for を含むことを確認)。
- Preview確認(JUN、テスト予約TEST-DRV、確認後に削除済み): DRVの目印、区分切替で支払方法が現地払い、備考の駐車場案内、「対象外」ボタンの
  メッセージ、日付逆転で保存が止まる、仮払い一覧でD(ドライバー)として生成、ホテル予約管理に出ない、すべてOK。
- デプロイ後は APP_VERSION 2026092502 のため、古い画面からの保存は426 → 全員に再読み込みを依頼する。
- 実態(JUN): ドライバーが現地で払い仮払いで精算するのが多い。別宿は「ゲストのホテルに大型バスの駐車場が無く、駐車場に近い別ホテルに
  ドライバーだけ泊まる」が中心(ゲストと同じ夜に別ホテル)。前泊・後泊で別ホテルもたまにある。
- 【決定】案C: booking_hotels に区分 lodging_for('guest'既定/'driver')を追加し、ホテルタブの行として管理する。
- 第1段階の実装(index.html):
  - ホテルタブの「ホテル名」セルの中に区分の選択(ゲスト/ドライバー)を置く(列を増やすと、スマホのカード表示がnth-childで配置している
    ため全項目がずれる。セル内に置けばずれない)。見出しは「ホテル名 / 区分」。ドライバーの行は紫の「DRV」、備考欄の案内文を
    「近くのバス駐車場など」に。375px幅で横スクロールなし・PC表示もChromiumのスクリーンショットで確認。
    ドライバーに切り替えた時、支払方法が未入力なら「現地払い」を入れる(入力済みなら変えない)。
  - 日付の逆転チェック(#215)はドライバーの行にもそのまま適用(表示に「・ドライバー宿泊」)。ツアー日程の外でも止めない。
  - 仮払い一覧の自動生成: ドライバーの行は区分「D（ドライバー）」、内容「ホテル名 ドライバー宿泊」、支払方法は行の支払方法。
  - 仕入明細へ追加: ドライバーの行は薄い「対象外」ボタン(押すと理由「仮払いの精算で計上するため…」を表示。スマホはツールチップが出ないため)。
    addArrRowToCostNow でも拒否。
    既に追加済み(cost_added)の行は従来どおり「済み」。サーバー側(markCostAdded)の拒否は入れていない(画面のみ)。
  - 「他のREF#からコピー」は区分もコピーする。手配書の日毎明細のホテル選択肢に【DRV】を付け、行程貼り付けの自動リンクはドライバーの行を除外。
    手配一覧の印刷(printArrangementSummaryList)はホテル名に「(ドライバー宿泊)」を付けた(出力の本格対応は第2段階)。
  - 除外した箇所: ホテル予約管理の一覧RPC search_hotel_management・キャンセル期日アラートRPC get_hotel_cancel_alert_counts(SQL)、
    ホテル予約管理の全件読み込み(ホテル別/マトリクス/ツアー別タブ、hotelManagementCache)、ホテル予約管理の取込時の重複チェック
    (hmFetchExistingForDupCheck)、手配確定状況の催促一覧(fetchVendorEmailCandidates)。ダッシュボードのアラートはホテル明細を
    参照していない(到着日アラート・対応が必要な予約は bookings・観光施設が対象)ため変更なし。
  - 除外していない箇所(判断が必要なら第2段階): ツアー運行カレンダー(renderTourCalendar、ドライバーのホテルも表示される)、
    メール受信箱のREF#候補インデックス(ホテル名で予約を探すだけ)、予約の削除・アーカイブ・バックアップ(全件対象のまま)。
  - APP_VERSION / MIN_WRITE_APP_VERSION を 2026092502 に上げた(古い画面は lodging_for を送らず、ドライバーの行を保存すると
    全削除→再挿入で「ゲスト」に戻るため)。デプロイ後、古い画面からの保存は426になる → 全員に再読み込みを依頼する。
- SQL(JUNが本番で実行済み。上記参照): scripts/add_lodging_for_to_booking_hotels.sql。STEP 0(RPC定義の確認)→ STEP 1(列追加・CHECK制約)→
  STEP 2(RPC 2本の置き換え)→ STEP 3(確認)。**コードのデプロイ(マージ)より前に実行する**(Previewも本番DBを使うため、Previewの
  確認より前)。列を先に足しても古いコードは影響なし。
- driver_*(booking_buses の6列、全154行が空)の整理(JUN承認済み。PR #218 マージ済み(main 0f0a761、2026-09-28)): (1) 仮払い一覧の自動生成のバスの driver_hotel_amount
  分岐を削除 (2) バスのAI読み取りのプロンプトから driver_* を外し、fillMissingDriverHotelDates / fillMissingBusGenericFields の
  driver_* 参照を削除(宿泊情報はホテルタブで入力する) (3) #215 で入れた buildBusRows / mapBusDbRow の driver_* 引き継ぎは、
  (1)(2)と同じPRで削除(値が無いことを確認済みのため)。ARR_COPY_CONFIG.bus の空欄化も同時に削除。列自体は削除しない。
- 第2段階(検討事項): 手配書・手配確認書・PDF等へのドライバー宿泊の表示 / ゲストのホテルに駐車場が無い夜に、ドライバー宿泊と
  バス駐車場(観光施設・バス駐車場タブ)の手配が揃っているかの確認(手配漏れの警告) / ツアー運行カレンダーでの扱い /
  markCostAdded のサーバー側拒否。

### 仮払い一覧「よく使う項目」が ¥0 になる件(2026-09-27 JUN決定: (c)→(b)。PR #218 マージ済み(main 0f0a761、2026-09-28))
- 原因(既存の不具合): 数量を自動計算できない時(手配書タブの日毎明細にバスの割当が無い)に qty=''・amount=0 で行を作るのに、画面は
  数量を「1」と表示し、保存も qty=1 にしていた →「単価3,000 × 数量1 = ¥0」。「よく使う項目を追加」ボタン単体でも同じ。
- 修正: (c) 手配書の日毎明細にバスの割当が無ければ、バス明細タブの開始日〜終了日から数える(countBusDaysFromBusRows。1行=1社、
  延べ会社日数=各行の日数の合計(終了日が空欄なら1日)、実働日数=いずれかの行の期間に含まれる日付の数)。
  (b) それでも決まらなければ数量は空欄(未確定)・金額0のまま、画面は数量欄を空欄(案内「未確定」・黄色枠)、金額欄に「数量未確定」、
  保存は qty=NULL(読み込みも NULL→空欄)。(a) 数量1・金額=単価 は不採用(それらしい金額が入り誤りに気づきにくいため)。
  単価を変えても未確定の間は金額0、数量を入力すると計算、数量を消すと未確定に戻る。
- 列の確認(JUN実行、2026-09-27): local_expenses.qty numeric NULL許容・既定値1 / unit_price integer NULL許容・既定値0 /
  amount integer NULL許容・既定値0。STEP 2(drop not null)は不要(実行していない)。
  既定値1が入るのは qty を「省略」した時だけ。画面は qty:null を明示的に送り(JSONでnullは残る)、table-crud の replace は行を
  スプレッドするだけで null を落とさず、PostgREST への INSERT に Prefer: missing=default も付けないため、NULL のまま入る
  (実handlerで Supabase への送信本文を捕捉するハーネスで確認)。Preview(TEST-QTY、JUN)でも DB で未確定5行が qty=NULL・amount=0、
  数量2を入れたお茶代が qty=2・amount=6000 を確認。バス明細(3日間)から数量3で生成、予備費は未確定のままもOK。
- 印刷部分(printLocalExpenses)は別セッション(claude/compassionate-franklin-fks2nl)担当のため変更していない。印刷は数量を it.qty||1 で
  出すため、未確定の行は「1」と印刷される(金額は0) → 別セッション側で「未確定」表示にするかの判断が必要。
  ガイド仮払い一覧(loadGuideAdvanceList)の明細表示「単価×数量」も it.qty||1 のまま(同様に「×1」と出る。今回は変更していない)。

### バスのAI読み取りで0件の時の案内(2026-09-27 JUN決定、PR #218 マージ済み(main 0f0a761))
- マージ前のPreview確認(JUN、TEST-QTY、確認後に削除済み): 宿泊だけの文面で案内の文だけが出て「対象日程…」は出ない、ボタンは潰れず1行、
  仮払い一覧表0件のままバスの台数を変えて保存しても「0件になっています」の確認は出ない。すべてOK。Preview status success を確認してマージ。
- テキスト・ファイル/画像の両方で、0件なら確認ダイアログを開かず「バスの手配情報が見つかりませんでした。ドライバーの宿泊の情報は、
  ホテルタブで読み取り、区分を「ドライバー」にしてください。」を表示。Preview(JUN)で確認済み。
- 【修正(JUN、マージ前)】対象日程の文言は「AIがバスを見つけたが日程の範囲外で除外した」時だけ出す。テキスト読み取りで日程の絞り込みが
  ある時、画面は busResponseFormat:'object' を送り、api/extract-card.js がAIに {buses, excluded_by_date} で返させる
  (buildBusObjectFormatInstruction。フラグの無い古い画面・絞り込みが無い時・他のタブは従来どおり配列)。excluded_by_date>0 なら
  対象日程の文言(除外件数つき)だけ、それ以外は案内だけ。ファイル/画像の読み取りは元々日程の絞り込みが無いため案内だけ。
- 【修正】案内の文が長く、「AIで読み取り」「閉じる」ボタンが縦に潰れていた(375px幅でボタンの高さ72px)→ 行を折り返し可能にし、
  ボタンを縮めない(flex-shrink:0・nowrap)、状態の文は残りの幅で折り返す。Chromiumで375px・1280pxとも潰れないこと・横スクロール
  なしを確認。ホテル・レストラン・観光施設・水・請求書・ホテル予約管理・施設管理のAI読み取り欄も同じ作り(未修正。長い文言が出ると同様)。

### 「〜明細が0件になっています。本当に保存しますか？」が保存のたびに出る件(2026-09-27 JUN報告、PR #218(main 0f0a761)で仮払い一覧表のみ修正)
- 原因: 確認の基準 originalXxxCount は予約を開いた時(openBookingDetail)にだけ設定され、保存後に更新されない。そのため、編集中に
  行を全部消して保存(1回目は正しく確認が出る)した後も基準が1件以上のまま残り、他のタブだけを保存しても毎回確認が出る。
- 修正(仮払い一覧表のみ): saveLocalExpenses の保存成功後に originalLocalExpenseCount = bdLocalExpenses.length。
- 同じ問題(未修正): 売上・仕入・ホテル・バス・レストラン・観光施設・ミネラルウォーター・ガイド・手配書のガイド・手配書の日毎明細
  (originalSalesCount/CostsCount/HotelCount/BusCount/RestaurantCount/FacilityCount/WaterCount/GuideCount/ArrGuideCount/ArrDayCount)。
  いずれも保存後に基準を更新していない。予約を開き直せば基準は正しくなる。

### ファイナルチェック・ガイド資料確認書類・施設ごとの「ガイドへの注意事項」(2026-09-28 調査・設計、未着手)
- 【着手条件】下記の読み取り専用SQL(資料館の表記揺れの確認)の結果をJUNが共有するまで着手しない。印刷部分は PR #217 のマージ後に着手。
  【更新(JUN、2026-09-28)】SQL結果は共有済み。印刷以外(マスタ画面の注意事項・別名、手配行の紐付け、ファイナルチェックの支払方法の確認、
  施設名の統一の入力時の置き換え)は着手してよい。印刷は引き続き #217 のマージ後。
- 背景(JUN): PR #217 の「支払済みの行をすべて赤字・赤枠」は取りやめ。二重払いはほぼ広島平和記念資料館だけ(カードで事前決済済みなのに
  ガイドが窓口で支払う)で、全体に警告を出すと多すぎて効かないため、注意は起きやすい施設に絞る。#217 は「数量未確定」の表示だけを
  残してマージし、赤字・赤枠は取り除く(別セッションが対応中)。
- 【決定(JUN、2026-09-28)】
  1. 注意事項は新テーブル business_partner_guide_notices(1施設に複数・種類付き)で持つ。列案: business_partner_id / notice_type
     ('payment'支払い・'document'持参書類・'other') / content / required_doc(必ず渡す書類。例「予約メール」) / sort_order / is_active /
     updated_at・updated_by(サーバーでスタンプ)。登録・編集は取引先マスタの画面。api/table-crud 経由・5分TTLキャッシュ。
  2. 仮払い一覧表の印刷(printLocalExpenses)には「支払い」の注意だけを出す(その施設が手配に入っている時だけ、表の上に1行ずつ大きく。
     他の行の表示は変えない。班が複数なら、その班の行に含まれる施設の注意だけをその班のページに)。
  3. 別名の「含む」照合を入れる(登録はマスタ画面からだけ)。
  4. 印刷部分の実装もこのセッションで行う(#217 のマージ後)。
  5. 実装の順番: 最初の段階 = この注意事項(マスタ・別名・紐付け・印刷の表示・ファイナルチェックの支払方法の確認)。その後にファイナル
     チェック本体 → 記録・ファイナル時の確認 → ガイド資料確認書類 → 出力の記録等。
- 紐付けの設計(名前の一致に頼らない):
  - booking_facilities.business_partner_id(uuid、空欄可、on delete set null)を追加。候補から選んだ時にIDを入れ、その後に名前を書き換えたら
    IDを外す。「他のREF#からコピー」もIDをコピー。観光施設の保存は全削除→再挿入のため APP_VERSION / MIN_WRITE_APP_VERSION を上げる。
  - 新テーブル business_partner_aliases(business_partner_id / alias / 正規化キー / 照合方法 完全一致・含む / created_by)。
    正規化 = NFKC・小文字・空白と「、､,・」の除去。
  - 照合の順番(3か所で同じ関数): 行のID → 正規化した名前がマスタ名と完全一致 → 別名の完全一致 → 別名を含む。
    2番目以降で見つかっても行にIDを自動では書き込まない。
  - ファイナルチェックで「マスタ未紐付けの施設行」を⚠にし、「マスタから選ぶ」「この名前を別名として登録」をその場でできるようにする。
  - 既存行の紐付け(一括更新)は CLAUDE.md の4ステップ(バックアップ→件数提示・確認→実行→確認)で行う。
  - 残課題「名前だけで紐付いている箇所のID化」に対し、観光施設の行では先にIDを持たせることになる(facility_operating_info の名前照合も
    後で同じ照合関数に乗せられる)。レストランへの同じ列の追加は将来。
- 3か所での使い方: (1) 仮払い一覧表の印刷 = 上記2。(2) ガイド資料確認書類 = 施設の行に注意文を添える(65歳以上の名簿は「持参書類」)。
  required_doc のある施設は書類一覧に必ず「施設名(予約メール)」の行を出す。(3) ファイナルチェック = 「支払い」の注意がある施設の行で、
  支払方法が現地払い(レストランは現金払い)なら❌、空欄なら⚠、それ以外(事前決済・請求書払い・カード・全旅クーポン・無料)は✓。
- 【マージ済み】PR #219(コード)は main d326a3c にマージ済み(2026-09-28)。Preview(TEST-NOTICE)確認後にマージ。
  マージ後の作業(この順で。SQL本文はscripts/add_guide_notices_and_partner_aliases.sqlのSTEP 3参照):
  1. 全員への再読み込みの依頼(APP_VERSIONを2026092801に上げたため、古い画面からの観光施設タブの保存は426で止まる)
  2. STEP 3a(対象の確認・バックアップ)→ 3b(紐付け・名前の統一、件数ガード付き)→ 3c(確認)を業務時間外に実行
     (開いたままの画面で保存されると、その予約の行が元の名前・未紐付けに戻るため。観光施設タブには保存時の食い違い検知が無い)
  3. 実行後、もう一度全員に再読み込みを依頼(SQL直接修正後の画面確認はハードリロードで、CLAUDE.mdの通り)
- 読み取り専用SQL(JUN実行済み。結果は下記):
  select facility_name, count(*) as n, min(date) as first_date, max(date) as last_date from public.booking_facilities
  where facility_name ilike '%資料館%' or facility_name ilike '%平和%' group by facility_name order by n desc;
- SQL(最初の段階): scripts/add_guide_notices_and_partner_aliases.sql(新テーブル2つ(service_role への GRANT と RLS 有効化を含む)・
  booking_facilities.business_partner_id 追加・別名の初期登録・既存行の紐付けと名前の統一)、scripts/merge_duplicate_peace_museum_partner.sql。
  実行状況は下記「実行済みSQL」参照。
- 読み取り専用SQLの結果(JUN、2026-09-28): 広島平和記念資料館 54件(2026-08-17〜2027-04-14)/ 平和記念公園、資料館、貞子記念碑、原爆ﾄﾞｰﾑ 3件 /
  平和記念資料館、原爆ﾄﾞｰﾑ､貞子碑 3件 / 平和記念会館・貞子記念碑・原爆ドーム 2件 / 平和記念資料館 2件(2024年) /
  平和記念公園(平和資料館) 1件 / 平和記念資料館・原爆ドーム・貞子碑 1件。
- 【決定(JUN、2026-09-28)】別名: 上記の6表記は「完全一致」で登録。「含む」は「平和記念資料館」「平和資料館」の2つだけ(「資料館」単独は
  他の施設を拾うため使わない)。拾えない表記はファイナルチェックの「マスタ未紐付け」で拾う。初期登録・既存行の紐付けはJUNがSQL Editorで実行。
- 【決定(JUN、2026-09-28)】施設名は「広島平和記念資料館」に統一する。
  - 今後の入力: 別名に一致する名前が入力された時(手入力・AI読み取り・コピー)、マスタの名前に置き換えるよう確認のうえで促す(黙って
    変えない)。置き換えたら business_partner_id も入れる。施設名の候補には重複登録 c7d17aec を出さない(候補は削除済みを除いて
    出すため、論理削除で自動的に出なくなる。loadFacilityPartnersCache の is_deleted の条件で確認)。
  - 既存の行: 資料館に紐付く行の facility_name を「広島平和記念資料館」に更新する(STEP 3、コードのデプロイと全員の再読み込みの後)。
    元の表記に他の見学先(原爆ドーム・貞子碑・平和記念公園など)が含まれる行は、備考(memo)の先頭に「元の表記: …」を残す(既存の備考は
    「 / 」の後ろに残す)。判定は「元の表記がマスタ名の一部かどうか」(「平和記念資料館」は一部なので残さない)。班の印「(2班)」等は
    照合から外し、置き換え後の名前にも残す。見込み: 対象66件・名前の置き換え12件・備考に残す10件(仕入明細の追加元の名前は実行時に件数を確認)。
- 実行済みSQL(JUN、2026-09-28): scripts/add_guide_notices_and_partner_aliases.sql の STEP 0・1・2、
  scripts/merge_duplicate_peace_museum_partner.sql(重複登録の統合)。
  - STEP 0: 取引先マスタに 2dabf14a 広島平和記念資料館(本体・有効)/ acd8bb8e 広島平和記念資料館(削除済み)/ c7d17aec 平和記念資料館、
    原爆ﾄﾞｰﾑ､貞子碑(同じ資料館の重複登録・有効)。
  - STEP 1: 2テーブルとも rowsecurity=true、anon の SELECT なし、service_role の SELECT あり。booking_facilities.business_partner_id 追加。
  - STEP 2: 確認中だった2表記も含めて実行。exact 5件・contains 2件、すべて本体 2dabf14a に紐付き(6表記のうち2つは正規化すると同じ)。
  - 重複の統合: M1-1 で c7d17aec を参照する行は全テーブルで0件(担当者も本体・重複とも0件)。M2-1 で重複の行に住所・電話・備考等は無く、
    転記不要。M3b を件数0・0で実行し、M3c で c7d17aec が is_deleted=true・deleted_by=merge_duplicate_partner_20260928、本体は有効のままを確認。
  - 未実行: STEP 3(既存行の紐付け・名前の統一)。コードのデプロイ(APP_VERSIONを上げた版)と全員の再読み込みの後、業務時間外に実行し、
    実行後にもう一度全員に再読み込みを依頼する(観光施設タブには保存時の食い違い検知が無く、開いたままの画面で保存されると
    その予約の行が元の名前・未紐付けに戻るため)。
- 名前を変えると影響する箇所(2026-09-28 調査):
  - 仕入明細(booking_costs)の source_snapshot.item_name: 「仕入明細へ追加」時点の名前を持ち、名前が変わると「追加元の仕入先名・日付が
    変更されています」の警告が出る → STEP 3 で追加元の名前だけ更新する(仕入明細の仕入先名 item_name・金額は変えない)。
  - 観光地予約管理のAI取込の重複チェック(fmDupMatchKeyEqual: booking_id + facility_name + date): 元の表記のメールを取り込むと、
    名前を統一した既存行と一致せず重複と判定されない → 照合に同じ正規化・別名を使うようコードで対応する。
  - 名前の文字列を持つが紐付けに使っていないもの(変更不要): 仮払い一覧表の内容(local_expenses.content、自動生成時のコピー)、
    ガイド別手配書の日毎明細(arrangement_document_days、スナップショット)、手配書の日毎明細の行程・OTHERS欄(自由記述)。
  - 名前で引く営業時間情報(facility_operating_info)は、統一後は「広島平和記念資料館」の情報が出る(元の表記の情報があれば出なくなる)。
  - 手配タブの行のid付け替え(_arrangementSourceRemapConfig の facility_name+date 一致)は、保存の前後で同じ画面の名前を比べるため影響なし。
- 【実装 PR #219 マージ済み(main d326a3c、2026-09-28)】最初の段階のうち印刷以外:
  - api/table-crud.js: business_partner_guide_notices(insert/updateById/deleteById/query)・business_partner_aliases(insert/deleteById/query)を
    追加(stampIdentity・stampUpdatedAt・auditLog、readable は business_partner_id 等のみ)。
  - APP_VERSION / MIN_WRITE_APP_VERSION を 2026092801 に上げた(古い画面は business_partner_id を送らず、観光施設タブの保存で紐付けが
    消えるため)。デプロイ後、古い画面からの保存は426 → 全員に再読み込みを依頼する。
  - 観光施設の行: business_partner_id を読み込み・保存・「他のREF#からコピー」で引き継ぐ。候補から選ぶとIDが入り、名前を手で書き換えると
    IDを外す。照合は resolveFacilityPartner(行のID → マスタ名 → 別名(完全一致)→ 別名(含む)。班の印は外す。「含む」が2社に当たれば未紐付け)。
  - 名前の統一の確認(unifyFacilityNamesWithMaster): 手入力(施設名欄のonchange)・AI読み取り(saveFacilityConfirm)・他のREF#からコピー・
    観光地予約管理のAI取込(saveFmFacilityConfirm)で、別名の表記なら一覧で確認してマスタ名に置き換え(IDも入れる。元の表記がマスタ名の
    一部でなければ備考の先頭に「元の表記: …」)。マスタ名と同じ名前は確認なしでIDだけ入れる。キャンセルした行は変えない。
  - 観光地予約管理のAI取込の重複チェック(fmDupMatchKeyEqual)は、照合結果(取引先ID、無ければ正規化した名前)+班の印で比べる。
  - 取引先マスタの編集画面に「ガイドへの注意事項・別名」の欄(種類・文言・必ず渡す書類・有効、別名は完全一致/含む。含むは4文字以上)。
    取引先の保存ボタンとは別に、各行のボタンでその場で登録。削除の確認には内容を表示。新規登録中は「保存後に登録」と表示。
  - 予約詳細に「✅ ファイナルチェック」ボタン(第1段階): 「支払い」の注意事項がある施設の行の支払方法(現地払い/現金払い=❌、空欄=⚠、
    他=✓)、別名のまま名前が統一されていない行(⚠、「名前を統一」ボタン)、取引先マスタと紐付かない観光施設の行(⚠、折りたたみ)。
    「移動」で観光施設タブの該当行へ移動・強調(セルの背景色+枠、3秒間)。キャンセルの行は対象外。各項目に「観光施設 N行目」を付け、
    日付未入力でも見分けられるようにする(2026-09-28 JUNのPreview指摘、修正済み)。
  - バックアップ(scripts/backup_supabase.ps1・backup_supabase_daily.ps1)の対象に新テーブル2つを追加(service_roleで読むため読める)。
  - 検証(scratchpadのハーネス、index.htmlの実関数をvmで実行): 57件成功(正規化がSQLの alias_key と一致、照合の順番・班の印・曖昧な
    「含む」、名前の統一(確認・キャンセル・備考・二重付与なし)、重複チェック、ファイナルチェックの行番号表示、5分キャッシュ)。実handlerで14件成功
    (新テーブルの書き込み・スタンプ・監査ログ・query のホワイトリスト、古い版(2026092502)からの書き込みは426)。
    Chromium で取引先マスタの欄・ファイナルチェックを 375px/1280px で表示し、横スクロールなし・ボタンの潰れなしを確認。「移動」時の
    強調(背景色+枠)が適用後に表示され3秒で消えることも確認。
  - Preview確認(2026-09-28 JUN、TEST-NOTICE、確認後に削除済み): 注意事項・別名の登録、別名入力時の置き換え確認と備考への元の表記、
    ファイナルチェックの❌(現地払い)/✓(事前決済)、「移動」でのスクロール、行番号の表示、「移動」での強調、すべてOK。
  - 未実装: 仮払い一覧表の印刷の表示(PR #217 のマージ後)、ファイナル済みにする時の自動実行・記録、他のタブの項目、ガイド資料確認書類。
- ファイナルチェック本体の設計(報告済み・JUN判断待ちの点あり):
  - 予約詳細に「ファイナルチェック」ボタン。❌/⚠/✓ をタブごとに表示し、各項目から該当タブ・行へ移動(行は参照で渡す)。スマホは1項目1カード。
    判定は保存前の編集中のメモリで行う(追加の通信はガイドのダブルブッキングと手配書の有無だけ)。
  - 現状: finalized への変更時のチェックは無い(自動でステータスが変わるのはInvoice発行の invoiced だけ)。手配書Excel・ミール
    バウチャーは出力した記録が無い(手配書は日毎明細・arrangement_documents の有無で代用。バウチャーは「必要か」までしか分からない)。
    checkGuideDoubleBookings は相手のキャンセル予約も重複と表示する(流用時に除外する)。
  - 行程(日毎の必要なバス・食事)の構造化データは無い → バスの無い日・食事の抜け・ホテルの空きは⚠とし、「確認した」を
    「項目の種類+対象キー」(例 bus_day:2026-10-03)で記録して次回は確認済み表示にする案。
  - ファイナル済みにする時(保存前が finalized 以外→保存する値が finalized): ❌は理由必須、⚠は項目ごとに「確認した」。記録テーブル案
    booking_final_checks(trigger / error_count / warn_count / override_reason / acknowledged jsonb / result jsonb / created_at・created_by)。
  - ドライバー宿泊と駐車場: 駐車場の行は施設名(駐車場/パーキング/parking)でしか見分けられない。ゲストのホテルにバス駐車場が無いことを
    示す列が無いため、案 booking_hotels.bus_parking_unavailable(行ごと)。当面は「ドライバーのホテル行がある夜に駐車場の行があるか」まで。
- ガイド資料確認書類の設計(報告済み・JUN判断待ちの点あり):
  - 「KIC0782_J1」は bookings.tour_code そのもの(J1 はシリーズの接尾辞。班ではない)。班は行の名前の末尾「(N班)」だけで、ガイド
    (booking_guides)と班の対応は取れない → ガイドごとに1枚(期間で行を絞る)の案。
  - 足りないもの: 添乗員・シェフの人数(案 bookings.pax_tour_leader / pax_chef)、観光施設の「ガイドに渡す書類」(案
    booking_facilities.guide_doc_type。全旅クーポンは自動)。英文日程・ルーミングリスト・ロゴ用紙はデータが無く固定の行。
  - 出力は ExcelJS(読み込み済み)で新しいテンプレートに書き込む(arrangement_excel.js は手配書専用のため新モジュール)。
    JUNのサンプル(0782_J1_ガイド資料確認書類.xlsx)をリポジトリ(templates/)に入れてもらう必要あり。
- 【決定(JUN、2026-09-28、いずれもおすすめ(A)のとおり)】
  1. J1はツアーコードの一部(bookings.tour_code をそのまま出す。班ではない)。
  2. バス駐車場なしの印はホテルの行ごとに持つ(booking_hotels.bus_parking_unavailable)。
  3. ⚠/❌の分け方は報告のとおり(ホテルの空き・バスのない日・食事の抜けは⚠、未予約のまま・NG回答・数量未確定・Invoiceの不一致は❌)。
     手動のチェック(ボタン)は記録せず、ファイナル時のものだけ記録する。
  4. ガイド資料確認書類はガイドごとに1枚、ガイドの期間で行を絞る(班番号の列は作らない)。
  5. サンプルExcel(0782_J1_ガイド資料確認書類)はJUNが添付する(未着手・受け取り待ち)。

### 作業の進め方(再確認、2026-09-27 JUN): push の前に必ず git diff を提示し、JUNの確認を得てから push する(CLAUDE.md)。

### 残課題(追加分)
- 名前だけで紐付いている箇所のID化(facility_operating_info と施設名など)は、他の「名前だけで紐付いている箇所」と
  まとめて後で検討する(JUN決定、2026-09-25)。
- PR #217(別セッション、仮払い一覧表の印刷の「支払済み」注意書き等)は #218 の後にマージする。#217 にも isLocalExpenseQtyUndetermined が
  同じ名前で追加されているため、#217 側で重複を削除して main(0f0a761)を取り込み直す(別セッションが対応)。印刷(printLocalExpenses)と
  ガイド仮払い一覧の「×1」表示(数量未確定の行)も #217 側で対応する。
  【更新(JUN、2026-09-28)】取り込み直し・重複削除は済み。#217 は「数量未確定」の表示だけを残してマージし、支払済みの赤字・赤枠は
  取り除く(別セッションが対応中)。施設ごとの注意事項の印刷表示は、#217 のマージ後にこのセッションで実装する(上記「ファイナルチェック…」参照)。
- 【別PRでまとめて直す(JUN決定、2026-09-28)】AI読み取り欄のボタンが長い文言で潰れる可能性: ホテル・レストラン・観光施設・
  ミネラルウォーター・請求書・ホテル予約管理・施設管理の各AI読み取り欄(hotel/rest/fac/water/inv/hm/fm-ocr-status)。バスは PR #218 で
  修正済み(行を折り返し可能にし、ボタンは flex-shrink:0・nowrap、状態の文は flex:1 1 220px で折り返す)。同じ直し方で揃える。
- 【別PRでまとめて直す(JUN決定、2026-09-28)】「〜明細が0件になっています」確認が、保存後も基準を更新せず出続ける件: 売上・仕入・
  ホテル・バス・レストラン・観光施設・ミネラルウォーター・ガイド・手配書のガイド・手配書の日毎明細(originalSalesCount / CostsCount /
  HotelCount / BusCount / RestaurantCount / FacilityCount / WaterCount / GuideCount / ArrGuideCount / ArrDayCount)。仮払い一覧表は
  PR #218 で修正済み(saveLocalExpenses の保存成功後に originalLocalExpenseCount を更新)。各タブの保存成功後に同様に更新する。
- 【既存の問題(PR #220 Preview実機確認で発覚、2026-09-29)】loadGuideAdvanceList(ガイド仮払い一覧)を日付未指定のまま開くと、
  全予約(数千件規模)が対象になり、tour_arrangements/guide_settlements/local_expensesへの.in()の値が数千件になって
  Supabase側でURL長超過等により失敗しうる(mainのコードにも同じ形で存在する既存の問題。以前はエラーを無視していたため
  気付かれていなかった)。
  - 【対応済み(b)、PR #220に含める、JUN決定】日付が両方とも未指定のまま開いた時は、既定で「直近60日」(今日〜60日後、
    「直近60日」ボタンと同じ範囲)を自動で入力欄に反映して読み込む(全件検索にしない)。共通の日付計算は
    guideAdvanceDefaultRange() に切り出し、setGuideAdvanceRangeDefault() と両方から使う。
  - 【対応済み、PR #220に含める、JUN決定】バッチ2対象外の3テーブル(tour_arrangements/guide_settlements/local_expenses)の
    取得が失敗した場合、静かに空扱いにするだけでなく、一覧の上に「⚠ 一部の情報を取得できませんでした(仮払額などが
    欠けている可能性があります)」を小さく表示する(id="ga-partial-warn"。エラー画面にはしない。日付範囲ごとの
    5分TTLキャッシュにも成否(partialFail)を含めて保存し、キャッシュから復元した時も正しく表示/非表示を切り替える)。
  - 【恒久対応(a)は見送り、バッチ3・4の計画に含める(JUN決定)】この3テーブルもAPI経由(200件チャンク)に移行することを、
    フェーズ2バッチ3・バッチ4の対象テーブルの検討に含める。
  - 検証: scratchpadハーネスで11件成功(日付未指定→既定値の自動反映・入力欄への反映、明示指定時は上書きしない、
    3テーブル失敗時の注意表示の表示/非表示、バッチ2対象の失敗時は従来どおりエラー表示、正常系)。Chromiumで
    375px/1280px表示を確認(横スクロールなし)。

### ガイド仮払い一覧(loadGuideAdvanceList)の表示見直し(2026-09-29 JUN依頼、バッチ2の別PR・マージ後に着手。設計のみをまず報告)
- 背景: JUNの使い方は「状況確認」(どの予約が・いつ・いくら仮払いか)。現状は1予約で明細行が十数行並び、¥0の行
  (請求書払い・全旅クーポン・無料等、支払い済み/不要)が大半を占め、必要な情報が埋もれる。
- 【依頼内容(2026-09-29、当初案の訂正後の最終版)】
  - 1予約につき1行(REF#・ツアー・IN/OUT・ガイド名・電話・想定ガイド費・仮払額の合計。現状の列を維持)。
    あわせて「現地払い ○件 / 支払い済み ○件」の件数を表示する。
  - 行のクリックで明細を開閉(初期は閉じる)。開いたら全部の明細を出す(¥0の行も含む。隠さない)。
  - 明細は2グループに分ける: 上=現地で払う行(現地払いで金額あり。太字)、下=支払い済み・不要の行
    (請求書払い・全旅クーポン・無料・事前決済・カード等。薄い色)。
  - 印刷(A4横)は「現地で払う行だけ」と「全部」を選べるようにする(既定は現地で払う行だけ)。
  - 数量未確定の行の表示(PR #217)は維持する。
  - スマホ(375px)で横スクロールが出ないこと。
  - 【JUN指示】案を報告してから実装する(先に設計案のみ)。バッチ2(PR #220)のマージ後、別PRで着手する。
- 未着手(設計もまだ)。バッチ2マージ後に着手する。

### 仮払い一覧表の「数量未確定」表示(PR #217(ブランチ claude/compassionate-franklin-fks2nl)、未マージ。マージはJUNの確認後)
- qty が空欄/NULLの行(「よく使う項目」で数量が決まらない行。PR #218 で金額0・数量NULLで保存するようになった)は:
  - 仮払い一覧表の印刷(printLocalExpenses): 数量欄を空欄、金額欄を「数量未確定」(太字)と表示(以前は it.qty||1 で「1」)。
  - ガイド仮払い一覧(loadGuideAdvanceList)の「単価×数量」: 「単価×数量未確定」と表示(以前は「×1」)。
  - 判定は PR #218 の isLocalExpenseQtyUndetermined を使う。合計は金額欄の合計のため影響なし。
- qty が0の行は「0」と表示する(以前は it.qty||1 で「1」。JUN承認)。ただし予約詳細の読み込みで r.qty||1 のため、
  DBの0は1として読み込まれる(#218 の読み込み部分。変更していない)。
- 確認: 印刷関数・ガイド仮払い一覧の明細行を抜き出したハーネスで描画。列幅は元のまま(内容43%・支払方法18%)。
- SQL要否: 不要。

### 【方針変更】支払済み項目の注意書きはやめ、「起きやすい施設だけ」施設ごとの注意事項で出す(2026-09-28 JUN決定)
- 背景: 広島平和記念資料館で、Web予約・カード決済済み(予約ID 5560628、34名 4,220円)なのに、ガイドが現地でも
  現金で購入して二重払いになった(2026-09-24、32名分 5,120円。65歳以上の割引も適用されず)。施設からの確認メールが
  長く、ガイドが読み込んでいなかった。
- 当初 PR #217 で、仮払い一覧表の印刷に「支払済み」の赤枠と支払方法欄の赤太字「(支払済)」を入れた
  (事前決済・請求書払い、のちにクレジットカードも対象。印刷時のカード表示の短縮も検討)。
- JUN決定: 二重払いはほぼ広島平和記念資料館だけで起きており、支払済みの行をすべて赤字・赤枠にすると警告が多すぎて
  効かなくなる。注意は起きやすい施設に絞り、取引先マスタの「ガイドへの注意事項」として施設ごとに登録して出す仕組みに
  作り直す(別セッションで設計)。PR #217 からは赤枠・赤太字・カード表示の短縮・LOCAL_EXPENSE_PREPAID_METHODS を
  すべて取り除き、「数量未確定」の表示だけを残した。
- 資料館の二重払い分の返金は、レシートと予約IDを添えて資料館(unei@pcf.city.hiroshima.jp)に相談する余地あり(未対応)。

## RLS対応(Supabase警告 rls_disabled_in_public、2026-09〜)

最終形: 対象テーブルへのブラウザ直接アクセスを0にし、ログイン検証つきAPI(service_role)経由に統一
→ RLS有効化(ポリシーなし) → anon/authenticatedのGRANTを全REVOKE。
anon向けSELECTポリシー案は不採用(ログインはapp_users独自方式でブラウザは常にanonのため、
公開anon keyで誰でも読める状態が続く)。フロントでのSupabase Auth使用は0件を確認済み。

### 完了テーブル(RLS有効化済み・JUNがSQL Editorで実行)
- guide_bank_accounts, app_users, audit_logs, email_import_queue_archive, estimation_day_fixed_items(A区分5件)
- 【バッチ1完了(2026-09-25夜、JUN実行・確認済み)】invoices, booking_costs, booking_sales, credit_card_statements
  - enable_rls_batch1.sql を業務時間後に実行。STEP1で 1-5(4テーブルを参照する他の関数・ビュー)0件、1-2(ポリシー)0件を
    確認してから本体を実行。実行後、4テーブルとも rowsecurity=true、anon/authenticatedのSELECT権限なしを確認。
    RPC 3本(get_payment_monthly_summary / search_payment_income / search_payment_outflow)のEXECUTE REVOKEも本体に含む。
  - 実行後、本番で予約詳細の明細・Invoice一覧・入出金管理が正常に表示されることを確認。
  - テスト予約TEST-RLSは削除済み(予約0件・請求書0件を確認)。
  - 翌朝(2026-09-26)スタッフ全員に再読み込みを依頼する(書き込みガード(PR #212)により旧画面からの保存は426で止まる)。

### 実行済みSQL(JUN実行・確認済み)
- 上記A区分5件のRLS有効化
- facility_operating_info: anon/authenticatedのINSERT/UPDATE/DELETE/TRUNCATEをREVOKE
- B/C区分全テーブル: TRUNCATE/REFERENCES/TRIGGERをREVOKE
- 現状のanon/authenticated権限: error_logsはINSERTのみ、残り21テーブルはSELECTのみ
- RPC 4件(get_payment_monthly_summary, search_payment_income, search_payment_outflow,
  search_business_partners)は本番でもprosecdef=false(SECURITY INVOKER)と確認

### フェーズ1(本番で既に壊れている箇所の修正) — 完了・mainへマージ済み(PR #206、main de405ae)
- 手配タブ「仕入明細へ追加」のcost_added更新(旧index.html:6583の`sb.from(payload.table).update()`、
  anon直接UPDATE)を、table-crud.jsの専用action `markCostAdded` 経由に変更。
  対象5テーブル: booking_hotels/booking_buses/booking_restaurants/booking_facilities/booking_water_items。
  cost_added列・boolean値のみ書き換え可、ログイン検証必須、0件更新は404、audit_logsへ常に記録。
  booking_water_itemsはupdated_by列が無いためupdated_byのスタンプは無し(他4テーブルはあり)。
- scripts/配下のanonフォールバック20本をservice_role必須化(未設定時はエラー終了)。
- parking-automation(案1実施): 使用禁止の parking-kyoto-terrsa.js / -midnight.js から、anonキーと
  parking_reservationsへのDB記録を削除(APIは新設せず、結果はコンソール出力のみ)。【使用禁止】注記は維持。
- SQL要否: 不要(コードのみ)。
- 本番デプロイ: PRのVercel Preview(e30b261)はsuccess。本番(main de405ae)のデプロイ完了はClaudeの
  セッションからは確認できない(vercel.appへの通信がネットワークポリシーで遮断)ためJUNがVercel画面で確認。
- JUN実機確認待ち: 手配タブ「仕入明細へ追加」5種類、失敗時の挙動。

### 小修正(バッチ1着手前に割り込み): 「仕入明細へ追加」後の未保存ダイアログ — PR #207 マージ済み(main 4ecab57)
- 実機確認(#782)で、追加ボタン押下だけで閉じる時に「保存されていない変更があります」が出た。
  原因: 追加元タブのbdLoadSnapshotがcost_added:falseのまま、かつ追加した仕入明細行が
  bdLoadSnapshot.costsに無いため、両タブが「変更あり」判定になっていた。
- 修正: markCostAdded成功時は該当行のcost_addedだけ、仕入明細はinsert成功時に追加行だけを
  スナップショットへ追従(他の未保存編集は引き続き検知)。markCostAddedのみ失敗時は従来どおり「変更あり」。
- SQL要否: 不要。

### cost_added/仕入明細の整合性修正(計画a/b/c) — PR #208 マージ済み(main 682f6f2)
- 計画c(最優先): buildFacilityRowsの自動完了を「ステータスが対象外→対象へ変わった時(と新規行)」のみに限定。
  ToDo画面の「完了を取り消す」(ステータスは手配OKのまま)が、予約詳細の保存のついでに新しい完了日時で
  黙って巻き戻されていた+その予約は開くだけで常に「変更あり」だった。既存の完了日時は元々上書きしていない。
  (e)=0件のため既存データの手当ては不要。
- 計画a: 仕入明細の保存確定直後(手配タブの新ID再挿入より前)に、直前の保存状態から消えた紐付き行を検出し、
  他の行から参照されていない追加元をmarkCostAdded(false)で戻す(resetCostAddedForRemovedCostRows)。
  削除→保存せず閉じた場合は戻さない。
- 計画b(短期案): _remapArrangementSourceIdを、sort_order順の保存後行に対し「同じキー内の何番目か」で対応付け。
  同じキーの行数が保存前後で不一致ならnull+console.warn(1件でも付け替えない)。
- SQL要否: 不要(コードのみ)。
- 調査2のSQL結果(JUN実行): (b)17件 / (c)133件 / (d)9件 / (e)0件。
  - (b)(c)(d)の対応結果は下記「データ修正(cost_added)の状況」参照(すべて対応済み)。
  - 手がかり: cost_added列は2026-07-23追加、source_table/source_idは2026-08-05追加(それ以前の追加は紐付けが無い)。

### invoices 一意インデックス(通貨込み) — JUN実行済み(2026-09-24)。旧合算インデックス削除・新2本作成・currency NOT NULLを確認
- scripts/invoices_unique_indexes_with_currency.sql: currency NOT NULL化(default 'JPY'維持)、
  旧 invoices_one_consolidated_per_booking(booking_id) を drop → (booking_id, currency) WHERE is_consolidated、
  個別 (booking_id, agent_name, currency) NULLS NOT DISTINCT WHERE NOT is_consolidated を新設。
  事前条件(currency NULL 0件・新キー重複0件)を満たさなければ例外で全体を取り消す。PostgreSQL 17.6。
- 現行コード(通貨をキーに含まない検索)のままでも失敗しない: 個別/合算とも「既存行があればUPDATE、
  無ければINSERT」で同じ(booking_id, agent_name)/(booking_id)に2行目を作らない。currencyは全書き込み経路で
  'JPY'/'USD'が必ず送られる(scripts/はinvoicesのstatus/agent_idのPATCHのみ)。
- 既存インデックス(JUN確認): invoices_pkey(id) / invoices_invoice_no_key UNIQUE(invoice_no) /
  invoices_agent_id_idx(agent_id) / invoices_one_consolidated_per_booking UNIQUE(booking_id) WHERE is_consolidated。

### 合算Invoiceが作れない不具合 — PR #209 マージ済み(main 4dfeb33)
- 原因: 合算Invoiceの番号が個別と同じ INV-<REF> で、invoices_invoice_no_key違反によりINSERT失敗
  (error_logs '合算Invoiceの自動更新' 35件、2026-09-01〜09-24。toast:falseで画面に出ていなかった)。
- 修正: 新規の合算番号を INV-<REF>-ALL / -ALL-USD、検索キーに currency 追加、再発行時は invoice_no を送らない
  (既存の合算2件の番号は不変)、失敗時はtoast表示。SQL要否: 不要。
- JUN実行結果: 35件は全件 invoice_no一意制約違反と確定。合算Invoiceが無い予約は23件(すべてJPY)。
  一括再発行はしない(次回その予約の個別Invoiceを発行・再発行した時に自動で作成される)。
- 合算Invoiceが無いことの影響(コード調査): 機能的な影響なし。
  - 入金消込の自動paid判定(saveBookingDetail)はInvoice1件ずつ判定するため、合算が無くても個別の判定は正常。
  - Invoice一覧・予約詳細の関連Invoice・ダッシュボード・入出金(RPCはbooking_salesベース)・粗利集計(bookingsベース)は
    invoicesの金額を合計していないため、合算の有無で数値は変わらない。影響は「合算請求書を表示・印刷できない」ことのみ。
  - 逆に「今後合算が作成された時」に起きること(バッチ1で扱う):
    (1) 合算は agent_id=null・agent_name=予約代表の請求先で作られるため、ダッシュボードの「Agentマスタ未紐付け」
        バナー(refreshAgentUnlinkedBanner)に請求書として数えられる(既存の合算2件も同様)。合算を除外するか要判断。
    (2) 支払い済みの予約で合算が後から作られると status='pending' のまま。予約詳細を保存した時の自動paid判定で
        初めてpaidになる(合算は予約全体の入金>=売上で判定)。

### データ修正(cost_added)の状況 — すべてJUNがSQL Editorで実行済み(2026-09-24)
- (b) 手配行13件(仕入明細17行)をcost_added=trueに更新。remaining=0を確認。
- (d) #782 3ca6764dは当日の保存で行が作り直されていたため除外し、7件をtrueに更新
  (#1120 8cefb89b / #1153 5b72eb33 / #1229 ee3cf08a, d50cc0ec / #534 7c32fe26, d63b94c9, c53533ae)。
  #782の新しい行(2c823229-…、チームラボボーダレス)も個別にtrueに更新。
- #1069(59674e70-…): 同名同日の手配行がチームラボ2行・トロッコ4行あり、仕入明細も同数。二重登録ではなく
  旧_remapArrangementSourceIdの「先頭に付け替わる」不具合(PR #208で修正済み)による取り違えだったため、削除はせず、
  仕入明細3行+1行のsource_idを2行目以降の手配行へ1対1で付け替え、付け替え先4行をtrueに更新。6行ともlinked_cost_rows=1を確認。
- #782 ホテルクラッド(4ad39f01-…): 仕入明細に行が無いのにcost_added=trueだったためfalseに戻した(単価確定後にJUNが追加)。
- (c) G1〜G4は、上記以外は未来ツアー分も含めて対応不要とJUNが判断。
- 注: booking_costsはreplace保存のたびに全行が作り直され、created_atが保存時刻になる(sort_order列も無い)。
  仕入明細の元の追加時刻はcreated_atでは分からない(audit_logsのinsert履歴が手がかり)。

### 未実行SQL・JUN確認待ち
- なし(2026-09-24時点)。フェーズ1報告の(a)(error_logsのcost_added更新失敗の件数)は未実行だが、(b)(d)の修正で実害は解消済み。

### 残タスク
- 【既存】予約詳細は一覧キャッシュ(allBookingsCache)の値で開くため、別の画面・他の人の変更が反映される前に保存すると、
  bookingsの列(status等)を古い値で上書きしうる(Invoice発行時のstatusはPR #211(旧#210)で対処済み。一般的な解決は保存前の最新値確認等)。
- 【既存不具合・本番でも発生】入出金管理でFROMだけ変えても集計が更新されないことがある(JUN確認、2026-09-24)。
  PR #211には含めない。原因調査から(onblur起点の集計・月別レポートがTO基準の年度であること等を確認する)。
- 【既存・紛らわしい】Invoice一覧の「売上」列に、請求書ごとの金額ではなく予約全体の合計(bookings.gross_sales)が表示される
  (filterInvoiceUnified の yen(row.gross_sales))。請求先が複数の予約では個別Invoiceの金額と一致しない。
- 【仕様として記録】USD請求書・USD合算は、USD発行(USD Invoice発行/USD合算発行)を押した時だけ更新される。JPYの発行・再発行では
  generateInvoice/upsertConsolidatedInvoiceが同じ通貨の行しか更新しないため、売上が変わってもUSD側の金額・状態は古いまま残る。
- Webからマスタ情報を取り込む機能: 設計はJUN確認済み(冒頭「5. Web取り込み機能」参照)。着手は作業順の5番目。
- フェーズ2 バッチ1: 【完了(2026-09-25)】コードPR #211・書き込みガードPR #212マージ済み、enable_rls_batch1.sql実行・確認済み。
  残り: scripts/fix_consolidated_invoice_agent_id.sql(合算Invoiceのagent_id埋め戻し、JUN実行待ち)。
  【決定(JUN、2026-09-25)】実行順は「画面の版による書き込みガードの本番反映 → 全員の再読み込み → 業務時間外に実行」。
  ガードはPR #212でmainへマージ済み(main 196fd16)。次は本番デプロイの確認 → 全員の再読み込み → SQL実行。
  (下記「画面の版による書き込みガード」「RLS有効化SQLの実行時の注意」参照)
- フェーズ2 バッチ2: business_partner_contacts, estimations, estimation_days + RPC search_business_partners。
  実装計画を報告済み(2026-09-25、未着手・JUN承認待ち)。下記「バッチ2 実装計画」参照。
- フェーズ2 バッチ3: arrangement_document系3件、tour_arrangement系/tour_*系6件、booking_guides,
  booking_water_items, bullet_train_arrangements, facility_operating_info, vendor_email_logs, error_logs
  (error_logsのINSERTもAPI化。未ログイン時の扱い・サイズ上限・連投対策の案を出す)

## 予約・手配の日付の前後チェック、Invoice発行の保存確認、driver_*の引き継ぎ(2026-09-25、PR #215 マージ済み(main a227222))
- 経緯: 別セッション(claude/blissful-rubin-5z8ftu、session_01TjKB…)が a を実装したところで停止。JUNの指示で以後はこのセッションだけで作業し、
  そのブランチ(6783159 / 2a35acb / 9e9d5cd / 753b1fa の4コミット。753b1fa以降の追加コミットは無し)をマージで取り込んだ。
- a(753b1fa、実装済み): isDateRangeReversed(開始,終了)。新規予約(saveBooking)・予約詳細の保存(saveBookingDetail)で OUT<IN なら
  「帰着日(OUT)が出発日(IN)より前になっています」とalertして保存しない(OUTが空欄・同日はOK)。#1275で発生。
- b【決定(JUN): 警告ではなく保存を止める】findArrangementDateRangeErrors: ホテル(check_in/check_out)・バス(start_date/end_date)の
  逆転行を「・ホテル 2行目(ホテル名): チェックアウト … が チェックイン … より前です」の形で全部列挙してalertし、最初のタブを開いて
  保存しない(bookingsの更新より前で止めるため、何も保存されない)。行番号は画面の表示順(並べ替え中はその順)。空欄・同日は止めない。
  既に逆転しているデータがある予約は、直すまで保存できない(scripts/investigate_arrangement_date_reversal.sql の1)2)で確認)。
- c: saveBookingDetail が true/false を返す(全部保存できた時だけtrue。日付の逆転・「明細が0件」等の確認でキャンセル・形式不正・
  通信エラー・食い違い検知・一部のタブの保存失敗はfalse)。issueInvoiceFromBookingDetail は false なら画面を開いたまま発行しない
  (「予約の保存が完了しなかったため、Invoiceは発行していません…」)。753b1faの発行ボタン側の日付の事前チェックは不要になったため削除。
  呼び出し元は3箇所だけ(保存ボタン2つ=戻り値を使わないので影響なし、Invoice発行ボタン6種=issueInvoiceFromBookingDetail)。
  一部のタブの保存失敗をfalseにしたため、例えば新幹線の保存だけ失敗しても発行はしない(予約情報・売上は保存済みの旨はalertで出る)。
- d: buildBusRows に driver_hotel_name/phone/address/check_in/check_out/amount の6列を追加(読み込んだ値をそのまま保存)。
  以前は全削除→再挿入(replace)でバスタブを保存するたびにNULLに戻っていた(データ消失)。driver_*だけの行も捨てない。
  「他のREF#からコピー」(ARR_COPY_CONFIG.bus)は driver_* を空欄にする(画面に見えない値を別の予約へ持ち込まない。以前も保存時に落ちていた)。
  AI読み取りの確認ダイアログ(saveBusConfirm)は従来どおり driver_* を行に入れない(新しく入る値は無い)。
  影響: 仮払い一覧の自動生成(generateLocalExpensesFromArrangements)は driver_hotel_amount>0 の行で「ドライバー宿泊費」の行を
  作るため、DBに値が残っている予約では、以前は一度バスを保存すると消えていたこの行が、今後は消えずに出続ける。
  driver_check_in/out の逆転: 画面に入力欄が無く直せないため、保存は止めない(チェック対象外)。案は報告参照。
- 古い画面(このPRより前のindex.html)は引き続き driver_* を落として保存する(既存の挙動。APP_VERSIONは上げていない)。
- 検証ハーネス(scratchpad、acornでindex.htmlの実関数を抽出しvmで実行): 27件すべて成功。
- マージ前の確認SQL(JUN実行、2026-09-25): 逆転しているホテル明細0件・バス明細0件。booking_buses 154行すべてで driver_* は空
  (reversed_driver_dates=0)。Preview status success を確認してマージ(実機確認は後日)。
- booking_busesの全列(JUN確認): id, booking_id, bus_company, bus_type, buses, start_date, end_date, amount, status, confirmation_no, memo,
  created_at, driver_hotel_name/phone/address, driver_check_in/out, driver_hotel_amount, payment_method, cost_added, created_by,
  updated_by, updated_at, sort_order。buildBusRows と照合し、保存で送っていないため消える列は無し(id は replace で振り直し、
  created_at は DB既定値、created_by/updated_by/updated_at はサーバー(stampIdentity/stampUpdatedAt)が付ける)。
  注: replace のたびに行が作り直されるため、created_at・created_by は「最後に保存した時刻・人」になる(元の作成日時・作成者は
  audit_logs でしか分からない。booking_costs と同じ既存の仕様)。
- SQL要否: 不要(コードのみ)。確認用の読み取り専用SQL: scripts/investigate_arrangement_date_reversal.sql(JUN実行待ち)。

## バッチ2(2026-09-29 着手・実装済み、未push・JUNのdiff確認待ち)
- 【緊急対応(2026-09-29、着手前に発覚)】estimation_fixed_rows に "Allow anon full access to estimation_fixed_rows"
  (ALL, roles={anon}, qual=true, with_check=true)が付いており、RLS(rowsecurity=true)が実質無効だった。テーブル全体では
  49件中34件がanonから読める状態(JUN確認)。GRANTの確認結果(JUN): anon/authenticatedともにREFERENCES, SELECT, TRIGGER,
  TRUNCATE(INSERT/UPDATE/DELETEは無し)。TRUNCATEはRLSポリシーの内容に関わらずテーブル全体を消せるため、実質最大の
  脅威はここだった。対応: scripts/emergency_fix_estimation_fixed_rows_anon_policy.sql(anonのINSERT/UPDATE/DELETE/
  TRUNCATE/REFERENCES/TRIGGERをREVOKE+読み取り専用ポリシーへの差し替え。JUN実行済みまたは実行予定)、
  scripts/investigate_dangerous_anon_policies.sql(同種のポリシーが他に無いかの監査、読み取り専用・未実行)。
  ローカルの疑似DBで実行結果を確認済み(実行後 anon は SELECT のみ・その他の権限は無し)。
  暫定の読み取り専用ポリシー(estimation_fixed_rows_temp_read_only)とそのSELECTのGRANTの削除(STEP 5)は、この
  ファイル単体では実行しない。バッチ2のコードがデプロイ・確認された後、scripts/enable_rls_batch2.sql(バッチ2の
  RLS有効化・REVOKE本体、これから作成)の中に含めて実行する(2026-09-29 JUN指示)。
- 【実装(2026-09-29)】置き換え対象(index.html、関数名で探す): estimations 7箇所(exportBookingArchive /
  exportFiscalYearArchive / deleteBookingData / loadEstimations / copyEstimation / openEstimationEditor /
  loadGuideAdvanceList)、estimation_days 4箇所(exportBookingArchive / exportFiscalYearArchive / openEstimationEditor /
  loadGuideAdvanceList)、estimation_fixed_rows 3箇所(exportBookingArchive / exportFiscalYearArchive /
  openEstimationEditor。緊急対応で読み取り専用ポリシーに差し替えたため今回まとめて対応)、business_partner_contacts 4箇所
  (loadRepresentativeContactsByPartnerIds / renderPartnerContactsList / loadBusinessPartnerContactsIndex /
  fetchRepresentativeContact)、RPC search_business_partners 1箇所(fetchAndRenderPartners)。計19箇所、すべて
  tableQueryAll/tableQueryAllIn/tableQueryMaybeSingle/rpcCallAll(既存の共通関数、新規実装なし)に置き換え。直接の
  sb.from/sb.rpc呼び出しは0件になったことをgrepで確認済み。
  - api/table-crud.js: estimations/estimation_days/estimation_fixed_rows/business_partner_contactsにreadable(query用の
    列・演算子ホワイトリスト)を追加。RPC_WHITELISTをparams宣言方式に汎用化(型: date/string/enum、必須/任意)し、
    search_business_partners(p_search任意・p_category任意でカテゴリ4種のみ)を追加。既存3本(入出金)の挙動は変更なし
    (ハーネスで確認)。
  - 空データで進む既存の危険(3件、修正済み): openEstimationEditorは見積もり・日程・固定費のいずれか1つでも取得に
    失敗したら編集画面を開かず一覧へ戻す(保存時のreplaceByKeyによる全削除を防ぐ) / fetchRepresentativeContactは
    取得失敗時にnullを返さず例外を投げる(saveRepresentativeContactが代表担当者を重複insertする不具合を防ぐ) /
    deleteBookingDataは紐付く見積もりの取得に失敗したら例外で削除処理全体を中止する(converted_booking_idが
    存在しない予約を指したまま残ることを防ぐ)。
  - 追加で見つけた同種の危険(未報告分、あわせて修正): loadEstimations(一覧)・fetchAndRenderPartners(取引先一覧)は
    取得失敗時に画面へエラー表示するのみに変更(以前は静かに0件のリストを表示していた)。deleteBookingData以外は
    読み取り専用画面のため、いずれもデータ破壊のリスクは元々無い。
  - 【PR #220 Preview指摘・修正済み(2026-09-29)】loadGuideAdvanceListを日付未指定のまま開くと
    「読み込みエラー: Bad Request」になる不具合。原因: 日付が空だと全予約(2000件規模)が対象になり、
    バッチ2の対象外(anon直接SELECTのまま)のtour_arrangements/guide_settlements/local_expensesへの
    .in()の値が数千件になって、Supabase側でURL長超過等により400になる。この巨大な絞り込み自体は
    main(#219時点)にも存在する既存の問題(コードで確認: 同じ.in()呼び出しが同じ形で存在)だが、
    main側はこの3テーブルの取得結果を一切エラーチェックせず(data:null→||[]で空扱い)そのまま
    進んでいたため、失敗しても気付かれずに(仮払額等が欠けたまま)表示されていた。今回のPRで追加した
    「取得失敗時に画面へエラー表示する」対応をこの3テーブルにもそのまま適用してしまったため、
    元々起きていた失敗がエラー画面として初めて可視化された(=このPRで新しく発生した不具合ではないが、
    見え方が変わったのはこのPRの変更が原因)。
    修正: バッチ2の対象外である3テーブル(tour_arrangements/guide_settlements/local_expenses)は、
    mainと同じ「取得失敗時は空として続行(エラーはlogErrorで記録するのみ、画面には出さない)」に戻した。
    バッチ2の対象であるestimations/estimation_daysは、200件チャンクのAPI経由のため同じ理由では
    失敗しにくく、従来どおり失敗時はエラー表示のままとした。
    恒久対応(この3テーブルもAPI経由の200件チャンクに migrate すれば同じ理由の失敗は防げる)は
    今回のPRの対象外とし、残課題に記録する(下記「残課題」参照。バッチ2の範囲を超える追加の
    テーブル移行のため、着手前にJUNへ確認する)。
    検証: scratchpadハーネスで、この3テーブルが失敗してもエラー非表示で続行すること、
    estimations/estimation_daysの失敗時は従来どおりエラー表示すること、正常系(予約0件)の3パターンを
    確認(6件成功)。asSbResultの誤用(supabase-jsのビルダーが解決する{data,error}をそのまま
    dataとして二重にラップしてしまっていた)にも気付き、素のsb.from()の{data,error}を直接destructureする
    形に直した(既存のasSbResultはtableQueryAll系専用のアダプタであり、生のsupabase-jsビルダーには
    使わない、という既存コードの一貫した使い方どおりに揃えた)。
  - 検証: scratchpadハーネスで実handler20件・index.htmlの実関数9件(fetchRepresentativeContact/saveRepresentativeContact
    の重複insert防止、loadEstimations/copyEstimation/fetchAndRenderPartnersの失敗時の挙動)がすべて成功。
    openEstimationEditor/deleteBookingData/loadGuideAdvanceListはDOM・副作用への依存が大きいため、コードレビューと
    構文チェックで確認(harness化は見送り)。
  - APP_VERSION / MIN_WRITE_APP_VERSION を 2026092901 に上げた(2026-09-29 JUN指摘への対応。バッチ2のRLS有効化後、
    古い画面はestimations/estimation_days/estimation_fixed_rows等をanon直接SELECTで読むため0件になる。特に
    見積もり編集画面(openEstimationEditor)は日程・固定費明細を0件のまま開いてしまい、保存するとreplaceByKeyで
    既存データが全削除される。このPRのコードはservice_role経由(query action)で読むためRLSの影響を受けないが、
    今回のデプロイより前に開かれたままの旧タブは影響を受け続ける。そうした旧タブからの保存を426で止めるための
    版上げ)。デプロイ後、開いたままの旧画面(2026092801以前)からの保存はすべて426 → 全員に再読み込みを依頼する。
  - 未実行: 緊急対応SQL2本(estimation_fixed_rowsは前述のとおりJUN実行済み/実行予定、投稿の監査SQLは未実行)。
    デプロイ・確認・全員の再読み込みの後、業務時間外に scripts/enable_rls_batch2.sql(未作成)を実行する
    (business_partner_contacts/estimations/estimation_days/estimation_fixed_rowsのRLS有効化+GRANT REVOKE、
    search_business_partners RPCのEXECUTE REVOKE、estimation_fixed_rowsの暫定ポリシーの削除(STEP 5)を含む)。
  - コミットは1本にまとめた(JUN報告の6分割案から簡略化。テーブルごとの依存が薄く、レビューは1回のPreviewで足りるため)。
    【JUN確認済み(2026-09-29)】今後、指示した分割方針を変える場合は事前にJUNへ相談すること。
- search_business_partnersはbusiness_partner_contactsをJOINするSECURITY INVOKERのRPCのため、contactsのREVOKE前にAPI経由化が必須。
- 【Preview実機確認の手順(期待値つき、2026-09-29)】openEstimationEditor/deleteBookingData/loadGuideAdvanceListはハーネス化
  していないため、以下をJUNに確認してもらう。テスト用予約は「TEST-BATCH2」を新規作成し、確認後に削除する
  (deleteBookingDataの確認にそのまま使う)。
  1. 見積もり一覧(見積もりページを開く) → 期待: 一覧が表示される(エラー表示にならない)
  2. 見積もりを1件新規作成(日程2行・固定費/入場料2行程度を入力) → 保存 → 一覧に戻る → 再度その見積もりを開く
     → 期待: 入力した日程・固定費がすべて表示される(消えていない)
  3. その見積もりを「コピー」 → 期待: タイトル末尾に「(コピー)」・日程と固定費がコピー元と同じ内容で複製される
  4. TEST-BATCH2の予約を作成し、その予約詳細から見積もりを新規作成して保存(予約に紐づく見積もりにする)
  5. 予約詳細を開き直す → 期待: 紐づく見積もりが表示される(予約データのアーカイブ出力に含まれるか、下記7で確認)
  6. ガイド仮払い一覧ページで、TEST-BATCH2を含む期間を指定 → 期待: 一覧が表示される(エラー表示にならない)。
     見積もりにガイド代(guide_fee等)を入れた日程がある場合、仮払い額に反映されることも確認
  7. 予約データのアーカイブ出力(deleteBookingData実行前のバックアップダウンロード)→ 期待: ダウンロードされたJSONに
     estimations(日程・固定費含む)が含まれる
  8. 取引先マスタ画面で、担当者が登録済みの取引先を開く → 期待: 担当者一覧が表示される
  9. 検索欄・カテゴリで絞り込み → 期待: 該当する取引先だけが表示される(空欄に戻すと全件に戻る)
  10. 取引先を1件編集し、担当者欄(担当者名・電話番号等)を変更して保存 → 期待: 保存が成功し、担当者一覧に反映される
  11. TEST-BATCH2の予約データを削除(deleteBookingData) → 期待: 削除前にバックアップがダウンロードされ、削除後に
     一覧からTEST-BATCH2が消える。手順4で作成した見積もり自体は削除されず、予約詳細画面の見積もり一覧には
     残るが「変換元の予約」欄は空になる(converted_booking_idの解除を確認。見積もり管理ページで確認)
  - 上記すべてで、ブラウザの開発者ツールのコンソールにエラーが出ていないことも確認する。
- business_partners / bookings / agents 等は今回のバッチ1〜3の一覧に無く、ブラウザから読めるまま(別バッチで扱う)。

## Web公開情報のマスタ取り込み(2026-09-25 調査・設計のみ報告、未着手・JUN判断待ち)
- 既存: business_partners(カテゴリはホテル/レストラン/バス・ハイヤー等/その他の4つ。観光施設専用カテゴリは無く「その他」)、
  住所・電話・FAX・メールあり。営業時間・定休日は facility_operating_info(施設名テキストで紐付け、既にextract-card.jsの
  mode:'facility-operating-info'でWeb検索(claude-sonnet-4-6 + web_search_20250305)して保存している)。公式URL・駐車場・
  団体料金・最寄駅・チェックイン時刻等の列は無い。予約側(booking_hotels等)はマスタと名前テキストでのみ紐付く。
- (解消済み)api/extract-card.js にログイン検証が無かった件は PR #213 で対応(partner-similarity・ai-inbox は PR #214)。
- 設計案・費用見込み・入力済み率SQLはチャットの報告を参照(判断待ち項目: 観光施設カテゴリの追加、新テーブル案、使うモデル)。

## バッチ1 再開用メモ(新しいセッションはここから読む)

対象: invoices / booking_costs / booking_sales / credit_card_statements のブラウザ直接SELECT(46箇所)と
RPC3本(get_payment_monthly_summary / search_payment_income / search_payment_outflow)をAPI経由化し、
その後RLS有効化+anon/authenticatedのGRANT全REVOKE+RPCのEXECUTE REVOKE。

### 作業の進め方(このプロジェクトで確立した運用)
- SQLはJUNがSupabase SQL Editorで実行する。ファイル名だけでなく本文にコードブロックで掲載し、1ブロック=1回の実行単位、
  各ブロックの前に「何を確認/変更するSQLか・期待される結果」を1行で書く。scripts/配下にもファイルとして保存する。
- 列名は推測しない。CREATE TABLEはリポジトリに無いテーブルが多い(invoices/booking_costs/手配5テーブル/bookings/audit_logs)ため、
  ALTER文とコード上の使用実績で確認し、不確かな列はinformation_schema.columnsの確認SQLを先に出す。
- 金銭テーブル・一括更新は: バックアップSELECT → 件数提示 → 同条件・件数一致チェック付き(不一致なら例外で取り消し)の
  UPDATE/DELETE → 実行後確認SELECT。WHERE句のidはJUNが実行したSELECT結果からのみ引用する。
- push前に必ずdiffを提示。検証ハーネス(scratchpadでindex.htmlの実関数を抽出してnode実行)と本体のcommit/pushは別工程として報告。
- 本番デプロイ完了はこのセッション環境から確認できない(vercel.appへの通信がネットワークポリシーで遮断)。PRのVercel Preview
  statusはGitHub経由で確認できるので、それを確認してからマージし、本番はJUNがVercel画面で確認する。
- 作業ブランチ: バッチ1は claude/blissful-rubin-5z8ftu / PR #211(2026-09-25〜。claude/keen-allen-9c46xj(PR #210)の全コミットの上に
  再発行時の状態判定の修正を1コミット追加し、mainあての新PRにした。PR #210はクローズ済み・ブランチは残してある)。
  その前は claude/keen-allen-9c46xj(2026-09-24〜。origin/mainから作り直し、未マージだった
  exciting-mccarthy-wi3dlaのSESSION_NOTES/SQLコミット2件をcherry-pickで載せ直した)。さらに前は claude/exciting-mccarthy-wi3dla。
  セッションごとにpush可能なブランチが指定されるため、新しいセッションでは指定ブランチに従う。PRがマージ済みなら origin/main から作り直して続ける。

### 実装状況(2026-09-24〜、PR #211 マージ済み(2026-09-25、main bbd5731)。旧PR #210(claude/keen-allen-9c46xj)はクローズ)
- 6コミット: API追加 / invoices / booking_costs / booking_sales / credit_card_statements / RPC。
  index.htmlの4テーブル直接SELECT 46箇所・RPC 3本の直接呼び出しは0件(grep確認済み)。
- API: /api/table-crud に query / queryBatch / rpc を追加(ログイン検証必須、ゲスト不可)。列・演算子は
  TABLE_CONFIG[table].readable。サーバー内で最初のページ200件→以降は平均行サイズから件数を決めて最大1,000件ずつ取得し、
  約3MB(予算を超えるページは含めず次回へ)/約5秒で打ち切ってnextOffset。予約詳細の売上・仕入・Invoiceは queryBatch で1リクエスト。
- 検証ハーネス(scratchpadで実handler+index.htmlの実関数を疑似PostgRESTに対して実行): 77件すべて成功。
- SQL(JUN実行待ち・いずれも未実行):
  - scripts/fix_consolidated_invoice_agent_id.sql: 既存の合算のagent_id埋め戻し(デプロイ後いつでも可)
  - scripts/investigate_batch1_table_sizes.sql: 全件取得画面の件数・サイズ確認(読み取り専用)
  - scripts/enable_rls_batch1.sql: RLS有効化+GRANT/EXECUTE REVOKE(デプロイ→実機確認の後)
- 次の手順: PRのVercel Preview確認 → マージ(済: PR #211、main bbd5731) → JUNが本番で実機確認 → enable_rls_batch1.sql 実行 → 再確認。
- PR #211 Preview確認(2026-09-25 JUN): 再発行時の状態判定の7手順すべて期待どおり(エラーなし)。
- RLS有効化SQLの実行時の注意(2026-09-25調査。旧コード=main 4dfeb33 以前のindex.html):
  - 旧コードは4テーブルをブラウザ(anon)から直接SELECTしている。SQL実行後(REVOKEによりpermission denied)、旧コードの多くの箇所は
    error を見ずに data を「0件」として扱う。そのため実行前に全員が本番をハードリロードし、旧コードの画面が残っていない状態にする。
  - 旧コードの画面が開いたまま実行された場合に既存データを壊す経路(調査結果):
    1. 予約詳細を開く(openBookingDetail): 売上・仕入が0件で表示される(エラー表示なし)。この状態で「保存」すると、
       bookings.gross_sales / gross_cost / deposit_amount が0で上書きされる(保存のたびに明細合計から無条件に計算して書くため。
       明細を触っていなくても起きる)。Invoice発行ボタン(issueInvoiceFromBookingDetail)も発行前に保存するため同じ。
    2. 同じ状態で売上・仕入に行を追加/編集して保存すると、replace(全削除→再挿入)で既存の明細行がすべて削除され、画面上の行だけになる。
       (最も重大。売上明細のpayments=入金記録も消える)
    3. 予約を旧コードで開いた後(読み込み成功後)にSQLが実行され、その後に保存した場合: 保存前の旧行の取得が失敗→[]扱いになり、
       remapCreditCardStatementSourceIds / remapSalesAgentIds が何もしない。仕入明細がreplaceで新IDになるため、消込済みの
       クレカ明細(matched_booking_cost_id)の紐付けが切れる。明細自体は正しく保存される。
    4. ガイド精算の伝票反映(reflectVoucherToCost): 仕入明細の追加はAPIで成功するが、gross_costの再計算で取得が失敗→0で上書き。
       予約詳細の請求書取込・行追加(bdCostItems基準)も、予約詳細が1.の状態ならgross_costを誤った値で上書きする。
    5. 手配タブ「仕入明細へ追加」(addArrRowToCostNow): 追加はAPIで成功するが、保存確認のSELECTが失敗して「保存を確認できません」
       となりボタンが「追加」に戻る → 再クリックで仕入明細が二重に追加される。
    6. アーカイブ・全件バックアップ・年度アーカイブ: 売上・仕入・Invoiceが空のZIPが「正常に」作られる(データは壊さないが、
       欠けたバックアップが残る)。
    安全に止まる経路: 予約削除前のバックアップ(エラーで削除中止)、通帳OCRの入金反映(エラー表示)、Invoice発行(既存行検索の
    エラーで中止)、請求書取込で他予約のgross_cost再計算(エラーならスキップ)、入金消込の自動paid判定・仮払金同期(何もしない)。
  - 【決定(JUN、2026-09-25)】「全員の再読み込み」だけに頼らず仕組みで防ぐ → 下記「画面の版による書き込みガード」を先に本番反映し、
    その後に全員の再読み込み → 業務時間外にSQL実行、の順で行う。
  - 実行タイミング: スタッフが操作していない時間帯(夜間・休日)に、全員のハードリロードを確認してから実行する。実行後もう一度
    全員にハードリロードを依頼する。万一1.〜5.が起きた可能性がある場合は audit_logs(bookings/booking_sales/booking_costsの更新)で
    実行時刻以降の保存を確認する。
- Preview実機確認(2026-09-24 JUN): 入出金管理以外は本番と一致。入出金管理のみ遅い(開く2回目 5.8秒 vs 本番1.1秒)+
  古い集計結果で上書きされる挙動があったため、同PRで修正(PR #210 に追加コミット):
  - 原因(コード構造): 修正前は「月別集計→明細」のAPI 2往復が直列、出金6,370件はサーバー内で200件プローブ+1,000件ずつ
    直列8回(各回で関数全体を再実行)= Supabase呼び出しが直列9段。本番(ブラウザ直接)は直列8回だが1回あたりが速い。
    Vercel関数→Supabaseの1回あたりの時間はPreviewの window.__tableCrudCallLog の sb合計ms/sb最大ms で実測する
    (vercel.jsonにregions指定なし=関数の既定リージョン。Supabaseと別リージョンなら1回あたりが遅い可能性)。
  - 対応: rpcBatch(月別集計・入金・出金を1リクエスト)、RPCは最初のページ(1,000件)で総件数を得て残りを並列取得
    (直列2段)、連番ガード(最新の集計だけ描画)、同条件の実行中集計への合流、window.__payLoadLog(集計のきっかけの記録)。
  - 集計のきっかけ(pay-from/pay-toのonblur)はこのPRで変更していない(mainと同一)。
- Previewで入出金をさらに確認(2026-09-24): Supabase 1回あたり490〜1,336ms(coldStartなし)→ Vercel関数(既定iad1)と
  Supabase(東京)のリージョン差と判断。vercel.json に regions ["hnd1"] を追加(Hobbyは1リージョン指定可・追加料金なしの見込み。
  公式ページは未確認のためJUNがBillingでHobbyを確認する)。FROM > TO の間は集計しないようにした。
- 【決定(JUN、2026-09-25)】合算Invoiceは、売上明細の請求先(agent)が2社以上の予約だけ作成・更新する。
  - 背景: #209以降、請求先1社の予約でも個別発行のたびに合算(-ALL)が作られ、同じ内容の請求書が一覧に2件並んだ(本番#877)。
  - 判定は upsertConsolidatedInvoice 内で、直前に取得した売上明細の請求先の種類数(distinctBookingAgents、空欄行は予約の
    請求先として数える)。取得失敗時は作らずエラー表示(空データで判断しない)。1社の予約に既にある合算は自動削除しない。
  - 手動の「JPY/USD合算発行」も同じ判定に揃えた(1社なら作らずに案内のalert、予約ステータスも変えない)。
  - 既存データ: scripts/investigate_single_agent_consolidated_invoices.sql(読み取り専用)でJUNが一覧を確認 → 削除SQLは別途。
- TEST-RLSでの書き込み確認(2026-09-25 JUN、Preview ff1c260): 1〜8すべて期待どおり。手順7(請求先を分けた後のSOTC分JPY発行)で
  既存のINV-TESTRLSがSOTC分に更新され番号は維持(個別の既存行検索キー=booking_id+agent_name+currencyに一致するため。
  「INV-TESTRLS-<識別子>が新規にできる」は誤った期待値だった)。
- 確認で見つかった気になる点A〜E(すべて既存の不具合。mainのコードでも同じ)と対応:
  - A/B 修正済み: USD請求書プレビューのTOTAL AMOUNT/Received deposit/Remaining balanceが二重換算($774.19→$4.995)、
    浮動小数の誤差で「$-0.00」。換算済み金額用のfmtConvertedで表示(-0は0に丸める)。
  - C 修正済み: 保存時の自動paid判定後も予約詳細の「関連Invoice」が開き直すまでPending → bdInvoicesCacheに反映。
    手順7直後のPendingは、再発行でpaidがpendingに戻る既存不具合(下記)が原因。
  - D 【決定(JUN、2026-09-25): 変更しない】プレビューのINVOICE No.欄は invoice_no から先頭の「INV-」を外して表示している
    (showInvoicePreviewのinvNoDisplay)。この表示は今のまま維持する。理由: 発行済みの請求書は「INV-」なしの番号で顧客に
    送付済みのため、表示を変えると顧客の手元の番号と一致しなくなる。DBのinvoice_noは従来どおり「INV-」付きのまま。
  - E 修正済み: Invoice発行でDBのbookings.statusをinvoicedにしても画面の予約キャッシュが古いまま → その後の予約詳細の保存
    (合算発行ボタン等は発行前に自動保存)でopenに上書き。発行時にキャッシュも更新(_setLocalBookingStatus)。
    ※予約詳細は一覧キャッシュの値で開くため、他の人が別の画面でステータスを変えた直後に保存すると古い値で上書きしうる
      一般的な問題は残る(残タスクに記録)。
- 追加の既存不具合も修正: 入金済み(paid)の請求書を再発行するとpendingに戻る → (ae4e7b7では既存行がpaidならpaidのまま
  にしたが、入金済みの後に売上が増えて再発行すると残額があるのにpaidのままになるため、下記「再発行時の状態の決め方」で置き換え)。
  新規予約でREF#が重複すると「保存に失敗しました」だけ → 事前確認で「REF# xxx は既に登録されています」、
  サーバーは一意制約違反を409 DUPLICATE_KEY+日本語で返す。

### 再発行時の状態(status)の決め方 — 【決定(JUN、2026-09-25)】PR #211(ee3a58e、keen-allen dceda91の上に1コミット)
- 発行・再発行(個別・合算とも)のたびに、保存時の自動paid判定と同じ条件で状態を決め直す(両方向):
  個別は「その請求先の入金合計>=売上合計(かつ入金>0)」、合算は予約全体。満たせばpaid、満たさなければpending。
  判定は発行時に取得した booking_sales(payments含む)で行う(decideInvoiceStatusOnIssue → invoiceShouldBePaid)。
- 新規発行(INSERT)にも同じ判定を使う(全額入金済みの予約で初めて発行した個別Invoiceもpaidで作成)。合算の新規作成は元々この判定。
- 例外: 請求先(agent_name)が無い個別Invoiceは判定できない(保存時の自動判定もスキップ=要手動確認)ため、既存がpaidならpaid維持、
  それ以外はpending。
- 新規発行にも同じ判定を使う・請求先なしの個別は既存状態を維持、の2点はJUN承認済み(2026-09-25)。
- 【決定(JUN、2026-09-25)】保存時の自動paid判定(saveBookingDetail)は pending→paid の一方向のまま維持する。
  入金を削除しても請求書はPaidのまま残るが、再発行で判定し直される。理由: 入金を売上明細に記録せずpaidにした過去の請求書が、
  保存だけでまとめてPendingに戻るのを防ぐため。
- 影響調査(両方向にしてよいか): 画面上にInvoiceのstatusを手動で変える操作は無い(失効モーダル askInvVoidChoice は呼び出し元0件、
  プレビューの保存は name_group等のみ)。statusが変わる経路は 保存時の自動paid判定/発行・再発行/scripts(restore_f12…はpendingに
  戻す一回限り)/SQL直接修正 だけ。「入金消込の手動操作」は booking_sales.payments の入力(予約詳細・通帳OCR反映等)であり
  invoices.statusは直接触らない。よって両方向判定で上書きされうるのは「SQLで手動でpaidにした(入金がpaymentsに記録されていない)
  請求書を再発行した場合」だけで、その場合はpendingに戻る(入金をpaymentsに記録すれば再発行・保存でpaidになる)。
  void/overdueの請求書も再発行すると判定結果(paid/pending)になる(従来もpendingに戻していた)。
- 検証ハーネス(scratchpad、index.htmlの実関数を疑似DBで実行): 29件成功。旧コード(dceda91)では9件失敗することを確認
  (「入金済み→売上増加→再発行でpending」(合算)、「入金済み→売上変わらず再発行でpaidのまま」(新規がpendingのため)等)。
- SQL要否: 不要(コードのみ)。

### 決定事項
- anon向けSELECTポリシーは作らない(ログインはapp_users独自方式でブラウザは常にanon。Supabase Auth使用0件確認済み)。
- 順序厳守: コードをデプロイ → JUNが実機確認 → その後にRLS/REVOKEのSQL(scripts/enable_rls_batch1.sql)を実行。
- invoicesの同一判定キー(JUNの業務判断: 同じ予約・同じ請求先でJPYとUSDを両方残すことがある):
  - 個別: booking_id + is_consolidated=false + agent_name + currency
  - 合算: booking_id + is_consolidated=true + currency(generateInvoiceが同じ通貨でupsertConsolidatedInvoiceを
    呼ぶ/「USD合算発行」ボタンがあるため、合算も通貨別に発行されうる)
  - 既存行検索で2件以上ヒットしたらエラー(既存の重複は0件を確認済み)。検索失敗時は例外でINSERTに進まない。
  - agent_nameがnullの検索は .eq ではなく is null にする(PostgRESTのeq.nullは一致しない)。
- 既存データ(2026-09 JUN実行): 個別・JPY 26件、合算・JPY 2件。USD・currency NULL・agent_name NULLは0件。
  audit_logsで通貨が書き換わったinvoices更新は0件(上書きで失われたInvoiceなし)。
  invoicesは api/table-crud.js で auditLog:true(少なくとも2026-08-28以降)。

### 画面の版による書き込みガード(2026-09-25、PR #212 マージ済み(main 196fd16))
- Preview確認(2026-09-25 JUN): 新しい画面の保存・仕入明細へ追加が成功、X-App-Versionヘッダーの付与、ヘッダー無しの書き込みは426、
  読み取りは200、すべてOK。テスト予約TEST-RLSは削除済み。
- 本番デプロイ完了はJUNがVercel画面で確認する(このセッションからは確認できない)。デプロイ後は、開いたままの旧画面(bbd5731以前)
  からの保存がすべて426になるため、全員に再読み込み(Ctrl+Shift+R)を依頼する。その後、業務時間外にenable_rls_batch1.sqlを実行する。
- 目的: 古い版のindex.htmlを開いたままのタブ(このアプリには版の確認・自動リロードが無かった)から、RLS有効化後に
  空データのまま保存・全削除→再挿入が走ってデータを壊すのを、APIの側で防ぐ。
- 画面: index.htmlの定数 APP_VERSION(YYYYMMDDNN、今回 2026092501)。window.fetchをラップし、同一オリジンの /api/ への
  全リクエストに X-App-Version ヘッダーを付ける(外部URL・Supabaseには付けない)。
- サーバー: api/lib/app-version.js の MIN_WRITE_APP_VERSION(2026092501)。api/table-crud.js は、APP_VERSION_EXEMPT_ACTIONS
  以外のaction(=書き込み系すべて)で、ヘッダー無し・形式不正・最低版未満を 426 {code:'APP_VERSION_OUTDATED'} で拒否する。
  ログイン検証より前に判定し、拒否時はSupabaseを一切呼ばない。対象外を列挙する方式なので、新しいactionは自動的にガード対象になる。
  - ガード対象(18): copyWithChildren, delete, deleteByBooking, deleteByField, deleteById, deleteByIds, heartbeat, insert,
    insertReturning, markCostAdded, release, replace, replaceByKey, save, updateById, updateByIds, updatePayments, upsertConfirm
  - 対象外(12): 読み取り専用 query/queryBatch/rpc/rpcBatch/auditHistory/list/listByField/list_active、
    guide.htmlのゲスト操作 guestInsert/guestUpdateById/guestUpsertConfirm、版の確認 appInfo
  - 読み取りを許可する理由: 書き込みを止めれば読み取りからデータは壊れない。逆に読み取りを拒否すると、旧コードは多くの箇所で
    エラーを見ずに0件として表示するため、データが消えたように見えて誤操作(別の場所への再入力等)を招く。
  - 旧エンドポイント(/api/booking-sales等、legacyTable)経由の書き込みも拒否される(統合前の古い画面からのもの)。
  - 別関数(ガード対象外): login / change-password / add-user / list-users(アカウント操作。業務データに触れない)、
    email-import(/api/email-import-insert・/api/email-attachment-upload。Outlook VBA・PowerShellから外部呼び出し)、
    extract-card / partner-similarity / ai-inbox(AI呼び出しのみ、DB書き込み無し)。parking-automationのスクリプトは
    APIを通らずservice_roleで直接接続するため影響なし。
- 版の上げ方: 通常のデプロイでは上げない(「新しい版があります」はデプロイIDで判定するため)。古い画面のまま書き込まれると
  壊れる変更をデプロイする時だけ、index.htmlのAPP_VERSIONを上げ、MIN_WRITE_APP_VERSIONも同じ値に上げる(同じPRで)。
  読み取り専用actionを追加する時は、index.htmlのTABLE_CRUD_IDEMPOTENT_READ_ACTIONSとAPP_VERSION_EXEMPT_ACTIONSの両方に追加する。
- 「新しい版があります」: table-crudの全応答に X-App-Deployment(VERCEL_DEPLOYMENT_ID等)/X-App-Min-Version を付ける。画面は
  最初に受け取ったデプロイIDを記録し、異なるIDを受け取ったら画面下部に黄色の帯。426を受け取った・最低版が自分より新しい場合は
  赤の帯(保存できない旨)。確認は通常のAPI応答+10分ごと(表示中のみ)+タブに戻った時(1分以上空いた場合)の appInfo
  (ログイン不要・Supabaseに触れない)。自動リロードはしない(帯の「再読み込み」ボタンは既存のbeforeunload確認が効く)。
  デプロイIDの環境変数が取れない場合は判定しない(誤表示しない)。
- 旧コード(4dfeb33以前・bbd5731)の画面からの挙動(コードパスで確認): 旧コードはヘッダーを送らないため書き込みは全て426。
  旧tableCrudApiCallは Error(サーバーのerror文言) を投げる。
  - 経路1〜3(予約詳細の保存): 最初の書き込みが bookings.updateById → 「保存に失敗しました: 画面が古い版のため保存できません…」の
    alertでreturn。売上・仕入のreplaceまで進まない(明細の全削除は起きない)。Invoice発行ボタンも保存失敗→発行のinsert/updateも426→
    「Invoice発行に失敗しました: …」。
  - 経路4(伝票反映・請求書取込・行追加): 最初の書き込みが booking_costs.insert → 「反映に失敗しました/保存エラー: …」でreturn。
    gross_costの更新まで進まない。
  - 経路5(仕入明細へ追加): insertが426 → エラー表示、ボタンは「追加」のまま。再クリックしても426(二重登録は起きない)。
  - 通帳OCRの入金反映: 「失敗: …」表示。編集中表示(heartbeat): console.warnのみ(他の人に「編集中」が出なくなるだけ)。
  - 残る点: 経路6(アーカイブ・バックアップ)は読み取りのみのため止まらない(RLS後の旧画面では空のZIPになる。データは壊れない)。
    旧コードの予約削除は、Storage(guide-receipts)のレシート画像削除をブラウザから直接行った後にAPIの削除に進むため、
    画像だけ消えて削除は426で止まる可能性がある(admin@kictravel.jpのみ・3段階の確認あり。anonのStorage削除権限は未確認)。
    旧コードのaccess_logs/error_logsへの直接INSERT(ログ)は影響なし。
- 検証ハーネス(scratchpad): サーバー側106件(実handler+疑似Supabase。版なし/古い版/形式不正/正しい版/新しい版 × 書き込み8種・
  読み取り3種・ゲスト、旧エンドポイント、appInfo、応答ヘッダー、401との順序)、画面側24件(新index.htmlのfetchラッパー・
  新しい版の検知、旧コード4dfeb33のtableCrudApiCallを新handlerに対して実行)、すべて成功。index.htmlのscript構文チェックOK。
- SQL要否: 不要(コードのみ)。

### invoice_noの一意制約(判断済み: (A))
- invoices_invoice_no_key UNIQUE(invoice_no) がある。一方invoice_noは「INV-<REF数字>(+請求先識別子)」の固定番号で
  通貨を含まない。このため:
  1. 通貨込みキーにしても、同じ予約・同じ請求先のUSD Invoiceは同じinvoice_noになり、INSERTが一意制約違反で失敗する。
  2. 【既存の不具合】請求先が1つの予約では、個別Invoiceと合算Invoiceのinvoice_noがどちらも INV-<REF> になり、
     合算InvoiceのINSERTが一意制約違反で失敗している(generateInvoice内でlogError toast:false のため画面に出ない。
     合算が2件しか無いのはこのためと思われる)。確認SQL:
       select count(*), min(created_at), max(created_at) from public.error_logs
       where page_or_function = '合算Invoiceの自動更新';
- 選択肢(要判断): (A) 番号体系を変える(USDは末尾に -USD、合算は -ALL 等)/(B) invoice_noの一意制約を
  (invoice_no, currency, is_consolidated) の複合一意に変える(印刷上は同じ番号の請求書が複数存在しうる)。
- 【決定(JUN、2026-09-24): (A) 番号体系を変える】invoices_invoice_no_key UNIQUE(invoice_no)は変更しない。
  - JPYの個別Invoice: 現行どおり INV-<REF>(請求先が複数なら INV-<REF>-<請求先識別子>)。変更なし
  - USDの個別Invoice: 末尾に -USD(INV-<REF>-USD、請求先識別子がある場合はその後ろ: INV-<REF>-<識別子>-USD)
  - 合算Invoice: 末尾に -ALL(INV-<REF>-ALL)。USDの合算は -ALL-USD(INV-<REF>-ALL-USD)
  - 既に発行済みのInvoiceのinvoice_noは絶対に変更しない。再発行(既存行のUPDATE)時もinvoice_noは既存値を維持する
    (現行コードはUPDATE時にinvoice_noを毎回上書きしているため、updateByIdのfieldsからinvoice_noを外す)
  - 進捗: 合算Invoice(upsertConsolidatedInvoice)は PR #209 で対応済み(-ALL/-ALL-USD、検索キーにcurrency、
    UPDATE時はinvoice_noを送らない、失敗時toast)。
  - バッチ1で残る作業(generateInvoice): USDは -USD を付与、既存行検索キーに currency を追加
    (booking_id + is_consolidated=false + agent_name + currency。agent_nameがnullなら is null)、
    UPDATE時はinvoice_noを送らない、2件以上ヒットでエラー中止、検索失敗時はINSERTに進まない。
  - DB側は実行済み: currency NOT NULL、invoices_one_consolidated_per_booking_currency (booking_id, currency) WHERE is_consolidated、
    invoices_one_individual_per_booking_agent_currency (booking_id, agent_name, currency) NULLS NOT DISTINCT WHERE NOT is_consolidated。
    invoices_invoice_no_key UNIQUE(invoice_no)は維持。

### 実装計画(報告・承認済みの内容)
- api/table-crud.js に読み取り専用 action を追加(Vercel関数は増やさない):
  - query: ログイン検証必須(verifySessionToken、ゲストactionには入れない)。TABLE_CONFIGに
    readable: { filterFields, orderFields, ops } を追加し列・演算子をホワイトリスト化。
    演算子は eq/in/is null/not null/ilike を基本に、46箇所の既存クエリで必要なもの(gte/lte/neq/or等)があれば
    列ごとに明示して追加。ilikeはユーザー入力の % と _ をエスケープ。
  - 1,000件上限対策: サーバー内でPostgRESTを1,000件ずつRange取得し、累積レスポンスサイズ約3MBで打ち切って
    nextOffsetを返す(件数ではなくサイズ)。並び順の最後に必ずidを付ける。クライアント側tableQueryAll()が
    取り切るまでループ。途中1ページでも失敗したら全体エラー(部分結果を返さない)。count:trueで件数のみ。
  - in条件の分割(200件ずつ)は1予約〜数十件規模の箇所と年度アーカイブに使う。exportFullBackupは全予約idのin分割ではなく、
    テーブル全体をqueryのページングで取得する。
  - 【変更(JUN、2026-09-24)】exportFiscalYearArchiveは「全体取得→クライアントで絞る」ではなく、年度の予約idを
    200件ずつに分けたin条件で取得する(将来データが増えても、負荷を年度分のデータ量に比例させるため)。
  - ホワイトリスト(JUN承認済み): select は * か識別子のカンマ列。eqにnullは不可(is nullを明示)。inは1回200件まで。
    limit 1〜1000、count:true。ilikeContains(サーバー側で%と_をエスケープして前後に%)。gte/lte/neq/orは入れない。
    列・演算子は api/table-crud.js の TABLE_CONFIG.readable 参照。
  - addArrRowToCostNowの保存確認SELECTはmemoがnullの時 is null で検索する(従来の.eq(null)は一致しない不具合を兼ねて修正)。
  - TABLE_CRUD_IDEMPOTENT_READ_ACTIONS に query を追加(読み取り専用のため)。
  - rpc: ホワイトリストの3本だけをservice_roleで呼ぶ。引数検証(日付YYYY-MM-DD、検索語は文字列・長さ上限)、
    集合を返す2本はGET+Rangeでページング。SECURITY DEFINER化はしない。移行後に anon, authenticated, public から
    EXECUTEをREVOKE(関数は既定でPUBLICにEXECUTEが付くため public も必須)。
  - 呼び出し元がindex.html以外(guide.html/scripts/ps1/VBA/email-automation)に無いことをgrepで確認してからREVOKE。
- 空データで進まない対策(必須): saveBookingDetailの旧costs/旧salesは書き込み前にAPIで取得し失敗なら保存中止。
  remapCreditCardStatementSourceIds / remapSalesAgentIds はfreshの取得失敗時に付け替えをしない。
  backupBookingDataBeforeDeleteは1テーブルでも取得失敗なら削除中止。ハーネスで失敗/0件/正常の3状態を検証。
- 【決定(a)(JUN、2026-09-24)】入金消込の自動paid判定: 現行の動きでOK。請求先ごとに「その請求先の入金合計>=売上合計」なら、
  その請求先のpending Invoiceを通貨に関係なく(JPY/USDとも)全部paidにする(合算は予約全体で判定)。
  JPY/USDは同じ請求の通貨違いであり、判定は請求先単位の入金と売上で行うため。
- 【決定(b)(JUN、2026-09-24)】Agentマスタ未紐付けバナー: 合算Invoiceをバナー対象から外すのではなく、合算にもagent_idを入れる。
  - 合算の作成・更新時(upsertConsolidatedInvoice)に、予約(bookings)のagent_idを合算Invoiceのagent_idに設定する。
    予約のagent_idがnullならnullのまま(その場合はバナーに出るのが正しい)。
  - 既存の合算のagent_idを予約のagent_idで埋めるSQL(条件ベース: is_consolidated=true かつ agent_id null かつ
    予約のagent_idがnot null。バックアップSELECT→件数ガード付きUPDATE→確認SELECT)を用意し、JUNが実行する。
    #209以降に合算が増えている可能性があるためid固定にしない。
  - 支払い済み予約で後から合算が作られた場合にpendingのまま残る件: 合算の作成直後に、既存の自動paid判定と同じ条件
    (予約全体の入金合計>=売上合計)で状態を決める(予約詳細を保存し直さなくても正しい状態になるように)。
  - いずれもバッチ1のinvoicesコミットに含める。
- コミットは「API追加」「invoices」「booking_costs」「booking_sales」「credit_card_statements」「RPC」に分ける(1PR)。
- 各バッチ完了報告: 変更箇所一覧(旧行番号→新実装)、grepで直接アクセス0件の証拠、scripts/enable_rls_batch1.sql
  (RLS有効化+残GRANTのREVOKE+RPC EXECUTE REVOKE+確認クエリ)、実機確認チェックリスト、SQL要否。
- 置き換え対象の呼び出し箇所(2026-09-24時点の行番号。以後の変更でずれるため関数名で探すこと):
  refreshAgentUnlinkedBanner / addArrRowToCostNow(保存確認SELECT) / loadSalesItemNameFreqCache /
  applyDashboardBankbookEntry / openBookingDetail / exportBookingArchive / exportFullBackup /
  exportFiscalYearArchive / backupBookingDataBeforeDelete / syncAdvancePaymentsFromCosts / reflectVoucherToCost /
  appendEmailExcerptAsDraftRow / remapCreditCardStatementSourceIds / remapSalesAgentIds / saveBookingDetail /
  findCcMatchCandidates / renderUnreimbursedPersonalAdvanceBanner / loadCreditCardStatements /
  openCcPaymentMigrationPreview / openCcMatchModal / searchCcManualMatch / mergeRowsByBookingId /
  loadInvoicePage / generateInvoice / upsertConsolidatedInvoice / showInvoicePreview、RPCは入出金画面。
  確認: grep -n "from('invoices')\|from('booking_costs')\|from('booking_sales')\|from('credit_card_statements')" index.html
- 既存の1,000件切り捨て不具合(API化で解消予定): loadSalesItemNameFreqCache / loadInvoicePage /
  loadCreditCardStatements / renderUnreimbursedPersonalAdvanceBanner / exportFullBackup / exportFiscalYearArchive。
