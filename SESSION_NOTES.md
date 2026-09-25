# SESSION_NOTES

## RLS対応(Supabase警告 rls_disabled_in_public、2026-09〜)

最終形: 対象テーブルへのブラウザ直接アクセスを0にし、ログイン検証つきAPI(service_role)経由に統一
→ RLS有効化(ポリシーなし) → anon/authenticatedのGRANTを全REVOKE。
anon向けSELECTポリシー案は不採用(ログインはapp_users独自方式でブラウザは常にanonのため、
公開anon keyで誰でも読める状態が続く)。フロントでのSupabase Auth使用は0件を確認済み。

### 完了テーブル(RLS有効化済み・JUNがSQL Editorで実行)
- guide_bank_accounts, app_users, audit_logs, email_import_queue_archive, estimation_day_fixed_items(A区分5件)

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
- Webからマスタ情報を取り込む機能: JUNが調査・設計を依頼済み(2026-09-25時点、このセッションでは依頼内容を受け取っておらず未報告。
  対象マスタ・取り込み元を確認してから調査・設計を報告する)。
- フェーズ2 バッチ1: コードはPR #211でmainへマージ済み。残りは enable_rls_batch1.sql の実行。
  【決定(JUN、2026-09-25)】実行順は「画面の版による書き込みガードの本番反映 → 全員の再読み込み → 業務時間外に実行」。
  ガードはPR #212でmainへマージ済み(main 196fd16)。次は本番デプロイの確認 → 全員の再読み込み → SQL実行。
  (下記「画面の版による書き込みガード」「RLS有効化SQLの実行時の注意」参照)
- フェーズ2 バッチ2: business_partner_contacts, estimations, estimation_days
- フェーズ2 バッチ3: arrangement_document系3件、tour_arrangement系/tour_*系6件、booking_guides,
  booking_water_items, bullet_train_arrangements, facility_operating_info, vendor_email_logs, error_logs
  (error_logsのINSERTもAPI化。未ログイン時の扱い・サイズ上限・連投対策の案を出す)

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
