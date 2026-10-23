# SESSION_NOTES

## 変更履歴(audit_logs)へのマイナンバー平文保存を塞ぐ(2026-10-21。PR作成済み・**マージはJUN承認待ち**)
- 実装: TABLE_CONFIG.guides に `auditRedactFields:['my_number']`。api/lib/audit-redact.js の redactAuditPair を (a) writeAuditLogs(保存時) と (b) doAuditHistory(返却時) で使用。
  値は保存・返却せず「(マイナンバー・値は非保存)」に置換。値が変わった更新は after 側を「(…・変更あり)」にして変更を判別可能に。空は空のまま。既存 audit_logs の行は書き換えない(返却時にマスクするので過去の平文もAPIからは見えない)。
- 検証: scripts/test_audit_redact.js(本物の table-crud.js handler を疑似Supabase+合成データで実行)17/17成功。修正前の table-crud.js では同じテストが5件失敗(平文保存・平文返却を検出)。実DB・本番には触れていない。
- 他テーブルのマイナンバー/個人番号項目: リポジトリ全体をgrep(index.html は null バイトを含むため grep -a)。my_number は guides のみ(index.html のガイド編集/照会/保存、api/extract-card.js は「マイナンバーは抽出しない」指示のみ)。パスポート/national_id 等の列も無し。対象追加なし。
- audit_logs の RLS/GRANT: リポジトリ内に CREATE TABLE/GRANT/ポリシー定義は無い(SESSION_NOTES.md:650 にも「audit_logs のCREATE TABLEはリポジトリに無い」)。SESSION_NOTES.md:457 に「audit_logs はRLS有効化済み(A区分)」の記述と investigate_batch4_readable_tables.sql の分類があるのみで、実際の状態は**未確認**。確認用の読み取り専用SQLを scripts/investigate_guide_audit_logs.sql の (c) に用意(JUNが実行)。
- 同SQLの (a) マイナンバー入りの audit_logs 行の件数、(b) SAHDEV VIJAY KUMAR の bank_info 変更履歴 も用意(未実行。列名は table-crud.js の writeAuditLogs/doAuditHistory から確認)。
- 未対応(スコープ外): ガイド一覧のブラウザ直接読み取り(`sb.from('guides').select('*')`)で全ロールに my_number が渡る点と、auditHistory のロール判定なし(マスクにより guides では値は返らない)。
### 残タスク
- JUNさん: 本番ガイド管理で照会・コピー・マイナンバー表示切替・編集画面コピーの画面確認(ハードリロード。PR #234 はマージ済みだがデプロイ完了は未確認)。
- JUNさん: investigate_guide_audit_logs.sql (b) で銀行口座二重入力の経緯確認 / (c) で audit_logs のRLS・権限確認 / (a) で既存 audit_logs の平文マイナンバー件数確認。
- 既存 audit_logs の平文マイナンバーの処理方針の決定(CLAUDE.md の手順: バックアップ→件数確認→承認→実行→再SELECT検証。今回は書き換えていない)。
- マイナンバー閲覧権限(現状ロール制御なし)の方針決定。

## ガイド管理: 照会画面・コピーボタン(2026-10-21。PR #234 を main にマージ済み)
- 内容: 一覧に「照会」ボタン、読み取り専用の照会モーダル(13項目・空欄は「-」・編集ボタン)、照会/編集画面の各項目のコピーボタン、マイナンバーは伏せ字+「表示/隠す」(コピーは伏せ字のままでも実値)。変更は index.html のみ。SQL不要。
- 確認できたこと: ローカルChromium+合成データで表示・各コピー・マイナンバー切替・375px横スクロールなし。
- 確認できていないこと: **本番での動作**(この環境から vercel.app に到達できずデプロイ完了も未確認。JUNさんの実機確認待ち。マージ後は main のマージコミット 542cebf)。
- デプロイ方式: .github/ と .vercel/ は無く、vercel.json は静的ビルド+APIのルート定義のみ。PRのチェックに "Vercel Preview Comments" が出るため Vercel の Git 連携は確認できたが、「main マージで本番自動デプロイ」の設定自体はリポジトリ内に無く(Vercelダッシュボード側)、本セッションでは未確認。過去のノートの記述(本番=main、Instant Rollback)と整合。
### 調査(コードのみ。変更なし・DB値は読んでいない)
- 銀行口座欄の二重入力: 通帳OCR(processGuideBankFile, index.html)は「欄が空のときだけ」代入(追記しない)。bank_info を書く経路は saveGuide とこのOCRのみ(index.html/api を grep)。よって**コード上はOCRで二重になる経路を特定できなかった**。可能性: 手入力/貼り付け、過去データ(移行・SQL・旧コード)。当該ガイドの audit_logs(変更履歴)の before/after で入った時期を見れば切り分け可能(要JUN確認)。
- 変更履歴とマイナンバー: guides は auditLog:true。doUpdateById/insert/delete が行全体(select=*)を before_data/after_data に保存するため、**my_number も平文で audit_logs に保存される**(table-crud.js:1088-1111, 757-775)。除外・伏せ字処理は無い。閲覧API auditHistory は有効なログインセッションのみ要求しロール判定なし(table-crud.js:1734-1740)。画面の「変更履歴」ボタンは bookings と credit_card_statements のみ(openAuditHistory呼び出し3箇所)で guides には無いが、APIは table=guides でも応答する。audit_logs テーブルのRLS/GRANTは未確認。
- 対策案(未実装): (1) writeAuditLogs 前に TABLE_CONFIG の auditRedactFields:['my_number'] で値を「(変更あり)」等に置換、(2) doAuditHistory 側でも同様にマスク、(3) 既存の audit_logs 内の my_number はバックアップ→件数確認→承認→更新→再SELECT検証の手順で処理(CLAUDE.md規定)。
### 残タスク
- JUNさん: 本番ガイド管理で照会・コピー・マイナンバー表示切替・編集画面コピーを実機確認(ハードリロード)。
- 銀行口座二重入力の原因切り分け(上記)。修正案: OCR側は現状で追記しないため変更不要の可能性が高く、先に原因データの経緯を確認。
- マイナンバーの閲覧権限(現状ロール制御なし)と audit_logs への平文保存の対応方針の決定。

## 仮払い一覧表: 観光施設の人数が数量に反映されない件(2026-10-01 調査。**修正なし・JUN確認待ち**。マージ・SQL・データ書き換えなし)
- ブランチ: claude/fix-facility-qty-local-expense(origin/main d326a3c から。claude/jolly-bohr-wsq2w8・claude/magical-ride-6phzj3 には触れていない)。コード変更は無し。
### 1. 反映コードの特定(origin/main d326a3c の index.html)
- 観光施設(booking_facilities)→ 仮払い一覧表(local_expenses)の生成: `generateLocalExpensesFromArrangements`(index.html:9112)。施設の行は :9225-9229
  `mk(f.date||fallbackDate, expenseType, f.facility_name||'観光施設', 'ゲスト', f.amount, f.payment_method||'', false)`(施設名に「駐車場/パーキング/parking」を含めば駐車場代、他は入場料 :9203,9227)。**f.pax(人数)は渡していない**。
- 行の組み立て `mk`(:9176-9189): `unit_price: displayAmount, qty: 1, amount: displayAmount`。つまり**全手配タブ共通で qty は常に1、unit_price=amount=行の金額**。観光施設に限らず、ホテル・バス・レストラン・水・新幹線も同じ(レストランの人数も反映されない)。
  これが症状(数量1・金額¥620/¥800)の直接の原因。人数26は qty にも金額にも使われない。
- 保存時の変換 `buildLocalExpenseRows`(:9338-9351): qty は isLocalExpenseQtyUndetermined(it) なら null、それ以外は `Number(it.qty)||1`、amount は `Number(it.amount)||0`。
- 重複防止(:9249-9254): 「内容」列が同じ既存行があれば再生成しても追加されない(**既存の仮払い行は再生成では直らない**。直すには行の削除→再生成か手編集が必要。本件ではデータに触れていない)。
### 仮払いに入る支払方法の条件(コード確認。変更なし)
- 唯一の条件は `mk` の :9178: `displayAmount = (skipPaymentFilter || payment_method==='現地払い') ? rawAmount : 0`。
  **「現地払い」だけが金額を計上し、それ以外(事前決済・請求書払い・全旅クーポン・無料(FREE)・クレジットカード(法人)・クレジットカード(個人・要精算)・未設定)は行は作るが金額0円**
  (行ごと除外はしない。「現地で現金を払う必要が無いことが一目で分かるように」というコメント :9170-9175)。レストランの「現金払い」だけは :9088 で「現地払い」に変換される。
  ガイドへの仮払金・追加仮払金(guide_settlements)は skipPaymentFilter=true で常に計上(:9244-9247)。
  → 全旅クーポンが仮払いに反映されない(金額0)のは仕様どおり。事前決済・請求書払い・クレジット(法人/個人)も同じ扱い(金額0)で、コード上は一律。クレジットは名義人欄(CC_PAYMENT_METHODS :6645)があるだけで仮払い生成の除外条件には現れない。
### 2. 観光施設の「金額」は単価か合計か — **コードだけでは断定できない(修正せず確認待ち)**
- 「合計」を示唆するコード: 観光施設タブの合計は `bdFacilityItems.reduce((s,it)=>s+Number(it.amount||0),0)` = **金額の単純合計**(:17281, :17304, :13354。ホテル/バス/レストラン/水も同形)。人数を掛ける処理は手配タブのどこにも無い。
  画面の列名も単に「金額」(人数列とは独立)。仮払い一覧表(mk)も amount をそのまま unit_price と amount に入れる。
- 「単価」を示唆するもの(コード外): 実データの値。予約台帳 #1138 の観光施設は 人数26/東大寺 ¥800・人数26/金閣寺 ¥500・人数24/梅田スカイビル ¥1,800 など、**一般的な1人あたりの入場料と一致する額**(例: 東大寺大仏殿の拝観料)。
  26名分の合計なら ¥20,800 等になるはずで、¥800 は1人あたり単価と読める。ただしこれはコードではなく世間の料金感からの推測。
- 決め手になる出力が無い: 手配一覧PDF(printArrangementSummaryList :26168-)は施設の人数だけを印字し金額は出さない。arrangement_excel.js に施設の金額は無い。AI読み取り(api/extract-card.js :780,:799,:815)の指示は
  「pax(人数・数値), amount(金額・数値・円)」のみで、単価か合計かの定義が無い。仕入明細へ追加(addArrRowToCostNow :6813-)は金額0で作るため意味を持たない。
- よって**意味の確定はJUNの確認が必要**。確認事項: 「観光施設タブの金額欄には、(A) 1人あたりの単価 を入れているか、(B) 人数を掛けた合計 を入れているか」。
### 確認後の最小修正案(未実施)
- (A) 単価の場合: 観光施設の行だけ `qty = f.pax`(人数が0・未入力なら従来どおり1か「数量未確定(要確認)」)、`unit_price = 現地払いの金額`、`amount = unit_price × qty`。
  あわせて観光施設タブの合計(:17281,:17304,:13354)を Σ(金額×人数) にするか、ラベルを「単価合計」等に直すかを別途決める(¥3,960 は単価の単純合計のため、合計として見ると誤り)。ホテル・レストラン等には波及させない(JUN指示の範囲外)。
- (B) 合計の場合: 現状の生成(qty 1・金額=合計)は整合しているので修正は不要。数量に人数を見せたいだけなら unit_price = amount÷pax・qty = pax(割り切れない場合の丸めの扱いが要判断)。
- どちらでも: 状態管理は足さない、既存の仮払い行は書き換えない、全旅クーポン等の金額0の仕様は変えない。検証は合成データで generateLocalExpensesFromArrangements を実際に呼ぶ(ハーネス)+JUNの実機確認(#1138 を使うなら、既存行の削除→再生成が必要な点に注意)。

## 仮払い一覧表: 観光施設の人数反映を修正(2026-10-01 JUN確定仕様。マージ・SQL・データ書き換えなし)
- 【確定仕様(JUN)】観光施設タブの「金額」は**1人あたりの単価**。仮払い一覧表へ反映するとき 数量=人数(pax)、単価=観光施設タブの金額、金額=単価×数量(例: 宮島フェリー・厳島神社 人数26・金額620・現地払い → 数量26・単価620・金額16,120)。
  現地払い以外(全旅クーポン等)は従来どおり金額0・変更なし。人数が空・0は従来どおり数量1。修正対象は観光施設の行だけ(レストラン等の他タブは変えない)。
- 実装(index.html、ブランチ claude/fix-facility-qty-local-expense、`generateLocalExpensesFromArrangements`): `mk` に任意の第9引数 `qtyOverride` を追加(:9176付近)。
  「金額を計上する行」(skipPaymentFilter または現地払い)で qtyOverride>0 のときだけ qty=qtyOverride、amount=Math.round(単価×qty)(仮払い一覧表の手入力時 :8954-8960 と同じ round(単価×数量))。それ以外は qty=1・amount=行の金額で従来どおり。
  観光施設の呼び出し(:9225付近)だけが `facPax>0 ? facPax : 1` を渡す。他タブ(バス・ホテル・レストラン・水・新幹線・ガイド仮払金)の呼び出しは無変更。状態管理は追加していない。+13/-5行。
  判断: 現地払い以外の観光施設行は「変更しない」の指示どおり数量1・金額0のまま(人数を数量には入れない)。駐車場(施設名に駐車場/Parking を含む行=費用種類「駐車場代」)も観光施設の行なので同じ規則(人数2・単価1,000 → 数量2・金額2,000)。
- 検証(本物の index.html を Chromium で実行、合成データ、疑似Supabase): **16/16 成功**(修正前=origin/main は同じテストで 11/16。失敗した5件は不具合そのもの)。
  確認した項目: 人数26・金額620・現地払い → 数量26・単価620・金額16,120(画面の仮払い一覧表の入力欄にも 620 / 26 と表示、保存用の行 buildLocalExpenseRows も同じ値)/ 人数26・金額800 → 20,800 /
  全旅クーポン → 金額0・数量1 /事前決済・無料(FREE) → 金額0 / 人数0・人数空欄(現地払い) → 数量1・金額=単価 / 駐車場(人数2) → 数量2・金額2,000 /
  レストラン(人数10・金額1,500)は従来どおり数量1・金額1,500、ホテルも不変 / 2回目の生成で同じ内容の行は増えない / 既存の旧行(数量1・¥800)は再生成しても追加も更新もされない。
  できていないこと: 実DB・実ログイン・実データ(#1138)での確認。**この変更は未デプロイ(PRなし=Previewなし、未マージ)なので、本番 https://kic-travel-core-ver2.vercel.app では確認できない**(下記手順はデプロイ後)。
### 2. 観光施設タブの合計表示との食い違い — **要判断(未修正。案のみ)**
- 現状の合計: `bd-facilities-total` は **金額の単純合計**(index.html:17289 renderFacilityTable、:13362 の2箇所。表示のみで他に参照なし)。#1138 では ¥3,960。
- 食い違い: 金額=単価の確定により、この合計は「単価の合計」で、仮払い一覧表の入場料の合計(単価×人数)とは一致しなくなる(例: 620・800 の2行だけでタブ合計 ¥1,420、仮払い側 ¥36,920)。
  ラベルが「観光施設合計」のままだと、費用の合計に見えて紛らわしい。ホテル・バス・レストラン・水のタブ合計は金額の単純合計のまま(それらの金額は合計として運用されている前提=今回の対象外)。
- 案(JUNのご判断): (a) 観光施設タブ合計を Σ(金額×人数。人数0・空は×1) に変え、ラベルを「観光施設合計(金額×人数)」にする(仮払い側と一致) / (b) 合計は変えずラベルだけ「観光施設 単価合計」に変える /
  (c) このまま(食い違いを承知)。変更は :17289 と :13362 の2箇所+ラベル(index.html:2866)のみ。推奨は (a)。**指示どおり未修正。**
### 4. 既存の仮払い行の直し方(画面操作。JUNさん向け。データはこちらでは書き換えていない)
- 既存の仮払い行(以前の生成で 数量1・単価=金額 のもの)は、「内容」が同じだと再生成しても追加されない(重複防止 index.html:9249-9254)。直す方法は2つ。
  **方法A: 削除して再生成(推奨。観光施設の行が多い場合)** ※デプロイ後に実施
  1. https://kic-travel-core-ver2.vercel.app を開き、予約台帳(Booking List)で対象の予約(例 #1138)を開く。
  2. 「仮払い一覧表」の見出しをクリックして開く。
  3. 観光施設から作られた行(費用種類=入場料 または 駐車場代 の行)の右端「×」を押し、確認ダイアログ(日付・種類・内容が表示される)で「OK」。手で書き換えた行や、観光施設以外の行(ホテル代・食事代等)は消さない。
  4. 「＋ 手配内容から概算行を生成」を押す。確認ダイアログの一覧に、削除した施設が新しい金額(単価×人数)で出る。「OK」。(「よく使う項目」は既に追加済みなら増えない)
  5. 数量=人数・単価=金額・金額=単価×数量になっていることを確認する。全旅クーポン等の行は金額0のまま。
  6. 右上の「保存」を押す(押さないと画面を閉じたときに反映されない)。
  **方法B: 行ごとに手で直す(少数の場合)**: 該当行の「数量」を人数に書き換える(金額は 単価×数量 に自動更新される)。単価がもし合計額で入っていたら単価も直す。最後に「保存」。
- 注意: 方法Aで削除した行に手で入れた内容(日付や備考の修正)は失われる。観光施設タブの人数が0・空の施設は数量1で生成される(人数を入れてから再生成する)。
### 3. JUNさんが確認する手順(デプロイ後。この環境ではブラウザ拡張が未接続・本番に未デプロイのため未実施)
- **【確認はまずこの Preview で(PR #221。マージ前)】https://kic-travel-core-ver2-git-claude-267881-jun-ryusekido-s-projects.vercel.app** (Vercel 状態 Ready、2026-10-01 5:26 UTC 発行。PR: https://github.com/Jun-Ryusekido/kic-travel-core-ver2/pull/221 。Preview は本番DBに接続するのでテスト予約を使うこと。この環境からは vercel.app へ到達できず、Preview の中身は私は未確認)
- URL: https://kic-travel-core-ver2.vercel.app (本番。マージ・デプロイ後)。PRを作ればPreview URLが発行される(Previewは本番DBに接続するのでテスト予約を使う)。
1. テスト予約を作り、観光施設タブに 人数26・金額620・現地払い / 人数26・金額800・全旅クーポン / 人数0・金額500・現地払い の3行を入れる。
2. 「仮払い一覧表」→「＋ 手配内容から概算行を生成」→ 確認ダイアログの一覧: 1行目 ¥16,120、2行目 ¥0、3行目 ¥500 になること。OK を押す。
3. 一覧表の各行: 1行目 単価620・数量26・金額16,120、2行目 単価0・数量1・金額0(クーポン)、3行目 単価500・数量1・金額500。「仮払い合計」が行の合計と一致する。
4. 「保存」→ 閉じて開き直しても同じ値。印刷(仮払い一覧表)でも数量・単価・金額が一致する。
5. 観光施設タブの合計(¥1,920 のはず=620+800+500。金額の単純合計のまま。上の「2.」の判断待ち)を見て、仮払い側との差が許容できるか確認する。

## 観光施設タブの合計を「金額×人数」に変更(案(a)。2026-10-01 JUN確定。マージ・SQL・データ書き換えなし)
- 実装(index.html、ブランチ claude/fix-facility-qty-local-expense): 新関数 `calcFacilitiesTotal(items)` = Σ round(金額 × 人数)(人数が空・0は1人。1行ごとに Math.round してから合計=仮払い側 mk と同じ規則)。
  `updateFacilitiesTotal()` で合計表示だけを更新。呼び出し箇所: facilityAmountCalc(金額欄の編集時、旧:13362)、renderFacilityTable(再描画時、旧:17289)、人数欄の onchange(新規。人数を変えても合計が更新される。表は再描画しない)。
  ラベル(:2866): 「観光施設合計(金額×人数)」。+17/-4行。**合計の表示(bd-facilities-total)は設定のみで他から読み取られていない**ことを再確認(index.html 全体・他ファイルとも参照なし)。
- 検証(本物の index.html を Chromium で実行、合成データ): **24/24 成功**。前回16項目のうち15項目はそのまま成功、残る1項目(参考: タブ合計は単純合計のまま)は仕様変更で期待値が変わるため新しい期待値に置き換えた(人数26・金額620と800だけ → ¥36,920)。
  追加確認: 人数0・空の行は金額×1(16,120+500+300=¥16,920)/ 小数は四捨五入(333.5×3 → ¥1,001)/ ラベル / 人数欄(26→10)と金額欄(800→1,000)に change イベントを発火して合計が更新される(¥27,000 → ¥32,200)/ 人数欄の編集で表が再描画されない。
  できていないこと: 実DB・実ログイン・実データ(#1138)での確認(未デプロイ・PRなし。確認手順は下記)。
### 仮払い側の合計との関係 — **一致しない場合がある(要判断。コードは変更していない)**
- 仮払い一覧表は「現地払い」以外の行の金額を0にする(index.html:9178 の mk)。タブ合計は支払方法を問わず全行の 金額×人数 を合計するため、現地払い以外の行がある予約では**タブ合計 > 仮払い側の観光施設合計**になる。
  合成データでの実測: タブ合計 ¥97,920 / 仮払い側 ¥39,720 / 差 ¥58,200(= 全旅クーポン 26名×¥1,500 + 事前決済 24名×¥800 の分)。現地払い分だけで見ると両者は一致(¥39,720)。全行が現地払いなら一致する。
  実データ(予約台帳 #1138 のスクリーンショット)でも、梅田スカイビル(24名・¥1,800)など全旅クーポンの行があり、合計は一致しないと見込まれる。
- どちらを合計に含めるべきか(案。JUNのご判断): 
  (1) **推奨: タブ合計は全支払方法のまま(手配した観光施設の費用総額)にして、横に内訳「(うち現地払い ¥X)」を併記する**。¥X は仮払い側の観光施設合計と一致し、クーポン・事前決済分も見えて、差の理由が画面で分かる。
  (2) タブ合計を現地払いの行だけにする: 仮払い側と常に一致するが、クーポン・事前決済・請求書払いの費用がタブ合計から消える(手配上の費用が見えなくなる)。
  (3) このまま(全行合計のみ・内訳なし): 差の理由が画面から分からず、現地払い以外の行がある予約では仮払い側と食い違って見える。
  指示どおり、(1)〜(3) のいずれも実装していない(止まる)。(1) を選ぶ場合の変更は calcFacilitiesTotal に「現地払いのみ」の引数を足して updateFacilitiesTotal と renderFacilityTable の表示を2値にする程度(+数行)。
### JUNさんが確認する手順(デプロイ後。この環境では未デプロイ・ブラウザ拡張未接続のため未実施)
- **【確認はまずこの Preview で(PR #221。マージ前)】https://kic-travel-core-ver2-git-claude-267881-jun-ryusekido-s-projects.vercel.app** (Vercel 状態 Ready、2026-10-01 5:26 UTC 発行。PR: https://github.com/Jun-Ryusekido/kic-travel-core-ver2/pull/221 。Preview は本番DBに接続するのでテスト予約を使うこと。この環境からは vercel.app へ到達できず、Preview の中身は私は未確認)
- URL: https://kic-travel-core-ver2.vercel.app (本番。マージ・デプロイ後)。PRを作ればPreview URLが発行される(Previewは本番DBに接続するのでテスト予約を使う)。
1. テスト予約の「観光施設・バス駐車場等」タブに 人数26・金額620・現地払い / 人数26・金額800・現地払い の2行だけを入れる → 表の下のラベルが「観光施設合計(金額×人数): ¥36,920」になる。
2. 人数欄を 26→10 に変える → 合計がその場で ¥27,000 に変わる(入力欄のフォーカスが外れない)。金額欄を変えても同様。
3. 人数0(または空)・金額500の行を足す → 合計に ¥500 が加わる(人数1として計算)。
4. 「仮払い一覧表」→「＋ 手配内容から概算行を生成」→ 観光施設の行の金額合計が、上の合計(現地払い分)と一致する。全旅クーポンの行を足すと、タブ合計は増え、仮払い側は増えない(上の「関係」のとおり。表示の扱いは JUN 判断待ち)。

## 観光施設タブの合計に「(うち現地払い ¥X)」を併記(案(1)。2026-10-01 JUN確定。マージ・SQL・データ書き換えなし)
- 【確定仕様(JUN)】タブ合計は「金額×人数」の全支払方法の合計のまま。横に「(うち現地払い ¥X)」を併記(X=支払方法が「現地払い」の行だけの 金額×人数 の合計=仮払い一覧表の観光施設の合計と一致)。現地払い0件なら ¥0。人数空・0は人数1、小数は四捨五入(計算規則は変更なし)。
- 実装(index.html、ブランチ claude/fix-facility-qty-local-expense。+19/-10行):
  - `calcFacilitiesTotal(items)` は `{all, local}` を返す(all=全行、local=isLocalPaymentMethod の行だけ。どちらも 1行ごとに Math.round してから合計)。
  - `updateFacilitiesTotal()` が2つの表示(`#bd-facilities-total`=全体、新設 `#bd-facilities-total-local`=「(うち現地払い ¥X)」)を更新。呼び出し元: facilityAmountCalc(金額欄)、renderFacilityTable(再描画)、人数欄の onchange、
    **支払方法欄の onchange(今回追加。以前は支払方法を変えても合計が更新されない漏れがあった)**。いずれも表全体は再描画しない(入力欄のフォーカスを保つ)。
  - 支払方法の漏れ確認: 観光施設の支払方法を書き換えるのは支払方法のプルダウンだけ(他の `payment_method =` はホテルの :13202 `isDriverLodging` のみで観光施設とは無関係)。AI読み取り・コピー・行追加は renderFacilityTable を通るため併記も更新される。
  - **現地払いの判定の共通化**: `isLocalPaymentMethod(pm){ return pm === '現地払い'; }`(index.html:6654、ARRANGEMENT_PAYMENT_METHODS の直下)を新設し、仮払い側 `generateLocalExpensesFromArrangements` の mk(`counted = skipPaymentFilter || isLocalPaymentMethod(payment_method)`、:9184)と
    `calcFacilitiesTotal` の両方で使う。条件を二重に書かない。変更は小さい(mk の1行置換+関数1つ)ので共通化した。
    注意: claude/jolly-bohr-wsq2w8 には別目的の `isLocalPayPaymentMethod`(現地払いの「追加」ボタンのグレー表示用)があり、同じ判定が2つの名前で存在する。両ブランチを取り込む際は、どちらかに寄せて重複を解消すること。
- 検証(本物の index.html を Chromium で実行、合成データ): **36/36 成功**。前回の24項目はすべて成功(うち2項目は calcFacilitiesTotal が数値→{all, local} になったため呼び出しを `.all` に調整しただけで検証内容は同じ。「ラベル」の項目の表示文字列は併記が付いた形に変わった)。
  追加12項目: 既存データで 全体 ¥97,920 /(うち現地払い ¥39,720)の表示と形 / 併記 ¥39,720 = 仮払い一覧表で生成した観光施設の行の金額合計 / 支払方法を 全旅クーポン→現地払い に変更(change イベント発火)で併記 ¥78,720・全体不変・表は再描画されない /
  その状態で仮払い側を再生成しても ¥78,720 で一致 / 現地払い→事前決済 で ¥39,720 に戻る / 全行が現地払いなら 併記=全体 ¥97,920 / 現地払い0件で ¥0 / 明細0件で 全体 ¥0・併記 ¥0 / 人数欄(26→10)と金額欄(620→1,000)の変更で併記も更新。
  できていないこと: 実DB・実ログイン・実データ(#1138)での確認(未デプロイ・PRなし)。
### JUNさんが確認する手順(デプロイ後。URL: https://kic-travel-core-ver2.vercel.app 。PRを作ればPreview URLが発行される。Previewは本番DBに接続するのでテスト予約を使う)
- **【確認はまずこの Preview で(PR #221。マージ前)】https://kic-travel-core-ver2-git-claude-267881-jun-ryusekido-s-projects.vercel.app** (Vercel 状態 Ready、2026-10-01 5:26 UTC 発行。PR: https://github.com/Jun-Ryusekido/kic-travel-core-ver2/pull/221 。Preview は本番DBに接続するのでテスト予約を使うこと。この環境からは vercel.app へ到達できず、Preview の中身は私は未確認)
1. テスト予約の「観光施設・バス駐車場等」タブに 26名・¥620・現地払い / 26名・¥800・全旅クーポン の2行を入れる → 「観光施設合計(金額×人数): ¥36,920 (うち現地払い ¥16,120)」。
2. 2行目の支払方法を「現地払い」に変える → 「(うち現地払い ¥36,920)」に変わる(全体は ¥36,920 のまま)。「全旅クーポン」に戻すと ¥16,120 に戻る。
3. 「仮払い一覧表」→「＋ 手配内容から概算行を生成」→ 観光施設の行の金額合計が、併記の ¥ と一致する。
4. 現地払いの行が無い予約では「(うち現地払い ¥0)」と表示される。

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
- 【実装(2026-09-28、ブランチ claude/magical-ride-6phzj3、未push・JUNのdiff確認待ち)】最初の段階のうち印刷以外:
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
    「移動」で観光施設タブの該当行へ移動・強調。キャンセルの行は対象外。
  - バックアップ(scripts/backup_supabase.ps1・backup_supabase_daily.ps1)の対象に新テーブル2つを追加(service_roleで読むため読める)。
  - 検証(scratchpadのハーネス、index.htmlの実関数をvmで実行): 54件成功(正規化がSQLの alias_key と一致、照合の順番・班の印・曖昧な
    「含む」、名前の統一(確認・キャンセル・備考・二重付与なし)、重複チェック、ファイナルチェック、5分キャッシュ)。実handlerで14件成功
    (新テーブルの書き込み・スタンプ・監査ログ・query のホワイトリスト、古い版(2026092502)からの書き込みは426)。
    Chromium で取引先マスタの欄・ファイナルチェックを 375px/1280px で表示し、横スクロールなし・ボタンの潰れなしを確認。
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

## バッチ2 実装状況(2026-10-07): コード置き換え済み(PR作成)・REVOKE用SQLは作成のみで未実行
- 16箇所(estimations 7 / estimation_days 4 / business_partner_contacts 4 / RPC search_business_partners 1)をAPI経由化。
  加えて copyEstimation の子行取得(estimation_days)も置き換え(計画に無かった1箇所)。
- 取得失敗を空データ扱いにしていた箇所を例外・中止に変更: openEstimationEditor(編集画面を開かない) / fetchRepresentativeContact
  (nullを返さず例外=代表担当者の重複insert防止、openPartnerEditorで警告して中止) / deleteBookingData(取得失敗は削除失敗として中断) /
  loadEstimations(0件表示・キャッシュしない) / アーカイブ出力2種(見積もり・日程の取得失敗は出力中止) / loadGuideAdvanceList(失敗結果はキャッシュしない) /
  copyEstimation(子行取得失敗でコピー中止)。
- API: estimations / estimation_days / business_partner_contacts に readable を追加、RPC_WHITELISTに search_business_partners(kind:'partners')。
- REVOKE用SQL: scripts/enable_rls_batch2.sql(未実行)。順序: PRマージ → 本番デプロイ → JUNが実機確認 → SQL実行 → 再確認。
- 実機確認チェックリスト: 取引先マスタ一覧(検索・カテゴリ絞り込み)/ 取引先の詳細(担当者一覧)・編集(担当者の保存で重複しない)/
  見積もり一覧・開く・コピー / ガイド仮払い一覧 / 予約アーカイブ出力 / 帳票(担当者名の表示)。

## (旧)バッチ2 実装計画(2026-09-25報告)
- 置き換え対象(index.html、関数名で探す): estimations 7箇所(exportBookingArchive / exportFiscalYearArchive / deleteBookingData /
  loadEstimations / copyEstimation / openEstimationEditor / loadGuideAdvanceList)、estimation_days 4箇所(exportBookingArchive /
  exportFiscalYearArchive / openEstimationEditor / loadGuideAdvanceList)、business_partner_contacts 4箇所
  (loadRepresentativeContactsByPartnerIds / renderPartnerContactsList / loadBusinessPartnerContactsIndex / fetchRepresentativeContact)、
  RPC search_business_partners 1箇所(fetchAndRenderPartners)。計16箇所。
- 空データで進む既存の危険(必ず直す): openEstimationEditorで日程(estimation_days)の取得失敗が0件扱い→そのまま保存すると
  replaceByKeyで日程が全削除される / fetchRepresentativeContactが取得失敗でnull→saveRepresentativeContactが代表担当者を
  重複insert / deleteBookingDataで紐付く見積もりの取得失敗→converted_booking_idの解除をせずに削除へ進む。
- search_business_partnersはbusiness_partner_contactsをJOINするSECURITY INVOKERのRPCのため、contactsのREVOKE前にAPI経由化が必須。
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

---

## 調査: 新幹線CSV取込で「NO」が「手配OK」になる不具合（調査のみ・未修正）

### 結論
原因は `btCsvStatusToDb`（index.html:25640-25646）の**デフォルト戻り値が「手配OK」**であること。
`OK`/`手配OK`→手配OK、`NG`/`キャンセル`→キャンセル 以外は何でも（`NO`・空欄・`回答待ち`・`未予約`・`Reply`等も）「手配OK」になる。
CSVの「ステータス」列の読み違い（ヘッダ側/明細側の取り違え）ではない。

### 1. 取込関数と列マッピング
- 予約詳細タブ: `onBdBulletCsvFileSelected` :18664（VIEW形式。`parseViewCsv` :25566 → `bdBulletTrainItems` に追加。DB保存はモーダルの保存時）。status は :18713 で `btCsvStatusToDb(d['ステータス']||'')`。
- サイドバー: `triggerBtCsvImport` :1984 → `onBtCsvFileSelected` :25648 → プレビュー :25749 → `importBtCsv` :25784（:25813で `btCsvStatusToDb`）→ `bulletTrainArrangementsApiCall('insert')`。
- 旧フラット形式フォールバック :18733-18795: `status: get(iStatus) || '回答待ち'` と**生の文字列を無検証で保存**（別系統の問題）。
- 列対応: 列車乗車日→ride_date / 列車名→train_name / 列車番号→train_number / 出発駅・出発時間・到着駅・到着時間→departure_*/arrival_*（0847→08:47）/ 乗車人数大人・小人→pax_adult/child / 無賃→pax_free / 列車割引率→discount_rate / **ステータス→status（btCsvStatusToDb経由）** / memo=''。

### 2. 「ステータス」列の扱い
`parseViewCsv` はグループヘッダ行の「ステータス」(`(V) Reply / 回答`)を `block.header`、明細行の「ステータス」を `detail` に別オブジェクトで格納。取り違えなし。明細側のみを使用。デフォルト値の問題。

### 3. 変換表（現状）
| CSV値 | 現状のUI表示 | 備考 |
|---|---|---|
| OK / 手配OK | 手配OK | 正 |
| NG / キャンセル | キャンセル | NGは「NG回答」の方が自然な可能性 |
| **NO** | **手配OK** | **マッピング無し→デフォルトへ（不具合）** |
| 空欄 | 手配OK | 本来は未予約が安全 |
| 回答待ち/未予約/Reply/Pending/FNL等 | 手配OK | すべて手配OKに化ける |
UI側選択肢: 未予約/回答待ち/手配OK/FNL済/NG回答/キャンセル（:18593。「問い合わせ中」は新幹線タブには無い）。

### 4. 再現結果（実index.html + Chromium、Shift-JIS 2行CSV）
`onBdBulletCsvFileSelected` に のぞみ5号(京都0847→広島1027, NO)・のぞみ52号(広島1803→新大阪1928, OK)・グループヘッダ「(V) Reply / 回答」のCSVを投入 → 両行とも「手配OK」。サイドバー側（parseViewCsv+btCsvStatusToDb）も NO=>手配OK。**再現した**。時刻・駅名等は正しく取り込まれる。

### 5. 修正案（JUN確認後に実施。未実装）
- A（推奨）: `btCsvStatusToDb` を厳格化: OK/手配OK→手配OK、NO/NG→NG回答（要確認: NGは現状キャンセル。NO・NGの扱い）、キャンセル→キャンセル、FNL→FNL済、回答待ち/未予約はそのまま、**空欄・未知の値→未予約（手配OKにしない）**。
- B: 未知の値の行は取込プレビュー(確認ダイアログ/モーダル)で警告表示。
- C: 旧フラットCSV経路も許可リスト(未予約/回答待ち/手配OK/FNL済/NG回答/キャンセル)で検証、外れは未予約。
- 確認事項: 「NO」「NG」を「NG回答」にするか「キャンセル」にするか（JUNさん判断）。
- 既に誤って「手配OK」で保存済みのデータ（#1149等）は本調査では未変更。修正後に画面上で手動修正、またはSELECTで対象特定→承認→更新（CLAUDE.mdの4ステップ）が必要。

### 6. 他の手配タブ
ホテル/バス/レストラン/観光施設/水/ガイド タブにCSV取込は無い（AI「読み取り」＝Excel/PDF/画像のみ）。同種のデフォルト「手配OK」変換は無し。各タブのロード時デフォルト（`status||'回答待ち'`/`'問い合わせ中'`）は空値のみ対象で、問題なし。同様のCSV取込は新幹線のみ。

### 手動確認手順（JUN）
修正後: https://kic-travel-core-ver2.vercel.app（Previewを使う場合はPR URL）→ 予約台帳 #1149 → 新幹線タブ → 「CSV取込」で GroupTour 3.csv を選択 → のぞみ5号がNG回答(or合意した値)・52号が手配OK になること。

---

## 修正: 新幹線CSV取込のステータス変換（JUNさん確定仕様で実装済み・ブランチ claude/investigate-bt-csv-status）

### 変更（index.html のみ・2箇所）
1. `btCsvStatusToDb`（:25640付近）: NFKC正規化+trim+大文字化で判定。OK/手配OK→手配OK、NO/NG/NG回答→NG回答、キャンセル→キャンセル、FNL/FNL済→FNL済、回答待ち/問い合わせ中→問い合わせ中、未予約→未予約、**空欄・未知→未予約**（旧: 手配OK）。呼び出し元3箇所(:18713/:25749/:25813)は無変更。
2. 旧フラット形式(:18782)の `status: get(iStatus) || '回答待ち'` → `btCsvStatusToDb(get(iStatus))`（従来は生文字列を無検証保存。空欄は従来「回答待ち」→今回仕様で「未予約」）。

### 検証（実index.html + Chromium、Shift-JIS CSV。修正前=main、修正後を同一テストで比較）
- 今回CSV: 修正前 NO→手配OK/OK→手配OK（再現）。修正後 5号=NG回答、52号=手配OK（予約詳細タブ・サイドバー importBtCsv の送信payload の両方）。
- 値マトリクス(空,XYZ,NG,FNL,回答待ち,キャンセル,no, " Ｎｏ ",ＯＫ,問い合わせ中,未予約,NG回答,FNL済) → 未予約,未予約,NG回答,FNL済,問い合わせ中,キャンセル,NG回答,NG回答,手配OK,問い合わせ中,未予約,NG回答,FNL済。予約詳細・サイドバーとも同一。
- 旧フラット形式(NO,OK,空,XYZ,回答待ち,FNL,NG,キャンセル) → NG回答,手配OK,未予約,未予約,問い合わせ中,FNL済,NG回答,キャンセル（修正前は生文字列'NO'/'XYZ'等がそのまま入っていた）。
- 時刻(0847→08:47)・駅名・人数(大人/小人/無賃)・日付・金額・備考は修正前後で同一。

### btCsvStatusToDb の呼び出し元（grep全件）
:18713(予約詳細VIEW形式)、:25749(サイドバー確認プレビュー)、:25813(サイドバー importBtCsv)、+今回追加 :18782(旧フラット)。:18649はコメントのみ。他に取込経路なし。

### 「NG回答」行の扱い（コード確認。修正はしていない）
- **手配確定状況(`VENDOR_EMAIL_SOURCES` :6135)**: ホテル・バスのみ。新幹線は対象外→影響なし。
- **手配一覧PDF(`printArrangementSummaryList` :26366)**: 新幹線は全行を出力、ステータスは文字列で出すだけ。NG回答/キャンセル行も手配OK行と同様に載る（ステータス欄の文字が違うだけ。他セクションも同様）。
- **仮払い概算行生成(:9248)**: 新幹線は status を見ず全行を `mk()` に渡す→NG回答/キャンセル行も概算行になる（今までもキャンセルは同様。他の手配タブも status で除外していない）。
- 新幹線の一覧/モーダルの色分けは共通 `statusBg/Fg` で、NG回答=オレンジ、手配OK=緑で区別される。
- **気づき**: 新幹線タブのドロップダウン(:18593 と モーダル :2036)の選択肢は「回答待ち」で「問い合わせ中」が無い（他タブは問い合わせ中）。確定仕様で CSV の回答待ち→問い合わせ中 になるため、取込行は「問い合わせ中」(琥珀色表示は同じ)になるが、ドロップダウンに該当項目が無く、手動追加行(既定「回答待ち」)と表記が混在する。
- **案（未実装・要確認）**: (a) 新幹線タブの選択肢/既定を「問い合わせ中」に揃える（既存DBの「回答待ち」行の表記が混在するため、データ移行が要るならSQL別途）、(b) 手配一覧PDFと仮払い概算行生成で NG回答/キャンセル行を除外または注記、(c) 現状維持。

### 手動確認手順（JUN）
Preview/本番にデプロイ後 https://kic-travel-core-ver2.vercel.app → ハードリロード → 予約台帳 #1149 → 新幹線タブ → CSV取込で GroupTour 3.csv → のぞみ5号=NG回答（オレンジ）、のぞみ52号=手配OK（緑）→ 内容確認後に保存。保存済みの #1149 のデータは本作業では未変更。SQL要否: なし。

---

## PR #223（新幹線CSV取込ステータス修正）とPreview・過去データ調査

- PR: https://github.com/Jun-Ryusekido/kic-travel-core-ver2/pull/223 （claude/investigate-bt-csv-status → main。未マージ。作成前にopen PR一覧を確認: head同一のPRは無し。#222/#220/#144 はopenのまま）
- 差分: index.html(+10/-5)とSESSION_NOTES.mdのみ。SQL文なし。

### 【手動確認手順の冒頭】まずこの Preview で（マージ前）
**https://kic-travel-core-ver2-git-claude-695dfa-jun-ryusekido-s-projects.vercel.app**
（Vercel 状態 Ready、2026-10-01 11:21 UTC 発行、コミット 2d86521。Claudeの実行環境からはプロキシ403で到達できず、画面は未確認。URLはVercelボットのPRコメントから取得）
手順: Previewを開く(ログイン)→ハードリロード→予約台帳 #1149 → 新幹線タブ → CSV取込で GroupTour 3.csv → のぞみ5号=NG回答(オレンジ)、52号=手配OK(緑)→ 保存はテスト用の予約で（#1149の既存データを変えたくない場合は取込後に保存せず閉じる）。

### 過去に誤って「手配OK」になった行の調査（コード側のみ。DBは未接触）
※ この依頼(git log -S / テーブル定義 / audit_logs / 読み取りSQL)はPR依頼メッセージで初めて確認でき、それ以前の会話には見当たらない。以下は今回実施分。
1. git log -S: `function btCsvStatusToDb` と `return '手配OK'` は、このリポジトリで追える最古のコミット b0e19fa(2026-09-08、#169)に既に存在。履歴がそこから始まっておりいつ入ったかは不明。つまり少なくとも2026-09-08以降、CSV取込でNO・空欄・未知値・回答待ち等は「手配OK」になっていた。NGは「キャンセル」。旧フラット形式は別で、生文字列がそのまま入っていた(NO等)。
2. テーブル/設定: `bullet_train_arrangements`(api/table-crud.js:469)。actions=replaceByKey/updateById/insertReturning/deleteById/insert/deleteByField、`auditLog:true`。CSV由来を示す列(取込元フラグ)は無く、CSV取込行を列だけで特定することはできない。CREATE TABLE文はリポジトリに無し(statusは自由文字列)。
3. audit_logs: 書き込みはAPI経由でベストエフォート(:739)。取込(insert)・予約詳細の一括保存(replaceByKey)・手動編集は履歴に残る可能性があるが、**実際に残っているかはDBを見ないと不明**。replaceByKeyは「内容が完全一致する行は消し込み」(:782)のため、CSV取込直後の保存で履歴が出ないケースもある。
4. 読み取り専用SQL案（**Claudeは未実行。JUNさんがSupabase SQL Editorで実行。SELECTのみ**）:
```sql
-- (a) 手配OKの新幹線行の件数と予約別内訳(取込時期の目安: created_atを確認)
select booking_ref, count(*) as n, min(created_at) as first_at, max(created_at) as last_at
from public.bullet_train_arrangements where status = '手配OK'
group by booking_ref order by max(created_at) desc limit 100;
-- (b) #1149の新幹線行(CSVの正しい値と見比べる)
select id, ride_date, train_name, train_number, departure_station, departure_time,
       arrival_station, arrival_time, status, amount, memo, created_at, updated_at
from public.bullet_train_arrangements where booking_ref = '#1149' order by ride_date, departure_time;
-- (c) 該当テーブルの変更履歴(列名はaudit_logsの実定義に合わせて要調整。まず select * ... limit 5 で列を確認)
select * from public.audit_logs where table_name = 'bullet_train_arrangements' order by created_at desc limit 50;
```
5. 注意: 誤って手配OKになったかどうかは、元のCSVのステータス(NO)と照合しないと判別できない(DB側にはCSVの元値が残らない)。(a)の行は「CSV取込行+手動で手配OKにした行」の混在で、全部が誤りとは限らない。修正(UPDATE)する場合はCLAUDE.mdの4ステップ(バックアップ→件数確認→承認→再SELECT検証)で、対象idは直前のSELECT結果から引用すること。

---

## 取引先マスタ「照会」モーダルにコピーボタンを追加（ブランチ claude/partner-inquiry-copy-buttons・index.htmlのみ・SQLなし）

### 実装箇所（origin/main 3c4585a 時点）
- 照会モーダル組み立て: `showPartnerDetail` index.html:27474（項目行 :27502付近）、担当者一覧は `renderPartnerContactsList` :27532（担当者行 :27543付近）。モーダルHTML :31068（`pt-detail-modal`）。
- 一覧の📋: `filterPartners`内の `copyBtn`（:27417、PCテーブル+スマホカード）と Agent一覧 :29164。コピー本体は `copyPartnerField` :28270（`.copy-icon-btn` CSS :269-271）。通知は「ボタンが✓に1.5秒変わる」方式（既存）。トースト関数は赤いエラートースト（:3819）のみで成功通知用の仕組みは無いため、この既存の✓表示を踏襲。
### 変更
- 共通化: `partnerCopyBtnHtml(val)` を新設し、一覧2か所の `copyBtn` もこれを参照（挙動同一）。
- `copyPartnerField`: `navigator.clipboard`が無い/失敗時は `copyTextFallback`（textarea+execCommand('copy')）へ。両方失敗時のみ従来のalert。※一覧・Agent一覧の📋にも効く。
- 照会モーダル: 会社名/会社名（英語）/携帯/住所の値の横に📋。担当者一覧は氏名（contact_personのみ。役職は含めない）・電話（携帯、無ければ部署直通）・メール。空の値、氏名が空（「（名前未登録）」表示）の担当者には氏名ボタンなし。
### 検証（実index.html+Chromium+合成データ）
各ボタンで正しい文字列がクリップボードに入る（改行入り住所・`<b>`・`+`含む）、✓表示→1.5秒後に📋へ復帰、空社(p2)は会社名のみ、名前未登録の担当者に氏名ボタンなし、複数担当者OK、clipboard未提供/reject時もフォールバックでコピー成功、375px幅で横スクロールなし、編集モーダル・追加・閉じる・削除のonclick不変、pageerror 0。
### 競合試算（読み取り）
#222・#144とはindex.htmlで競合なし。#220はindex.htmlは自動マージ可（renderPartnerContactsList内の取得部分をAPI化、こちらは行描画部分のみ）。競合はSESSION_NOTES.mdのみ（#220は既存の競合）。
### JUNさん確認手順
PR: https://github.com/Jun-Ryusekido/kic-travel-core-ver2/pull/224 （未マージ）。**Preview: https://kic-travel-core-ver2-git-claude-303839-jun-ryusekido-s-projects.vercel.app** （Vercel Ready、2026-10-03 06:44 UTC、コミット 28f4cbc。Claude環境からは到達不可で画面は未確認）→ログイン→ 取引先マスタ → サナム山中湖の「照会」→ 各📋を押して✓になり、メモ帳等に貼り付けて内容を確認（会社名・英語名・携帯・住所・担当者の氏名/電話/メール）。担当者の「編集」「削除」「＋担当者を追加」が従来どおり動くこと、スマホ幅（375px）で横スクロールしないこと。実データでの確認は未実施。

---

## ツアー運行カレンダーの初期表示月が9月のままになる不具合の修正（ブランチ claude/tour-calendar-initial-month・index.htmlのみ・SQLなし）

### 原因（コードで確認）
`initTourCalendar`（index.html:26848、月セレクト #tc-ym は :1461）に、既定月を**固定値 `preferredDefault = '2026-09'`** にする処理があった（旧:26860付近）。選択肢（今月-2〜+12ヶ月）に2026-09が含まれる間はずっと9月が選ばれ、含まれなくなって初めて今月になる設計だった。加えて `if(!sel.options.length)` で**選択肢の生成が初回の1回だけ**だったため、画面を開いたままの古い状態（選んだ月・選択肢の範囲）が開き直しても残った。localStorage等の保存は無い（呼び出しは go('tour-calendar') :4235 のみ）。年月は `new Date()` のローカル時刻で、日本時間(JST)とは限らない問題もあった。
### 修正
`initTourCalendar` が呼ばれるたびに、日本時間の今月（既存と同じ `toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'})`）を基準に選択肢（-2〜+12ヶ月）を作り直し、今月を選択状態にする。画面を開いている間の月選択は維持、開き直すと今月に戻る。他の関数・UIは無変更。
### 検証（実index.html+Chromium、システム時刻・TZを固定。修正前=origin/main と同条件で比較）
- JST 2026-10-05: 修正前=2026-09 / 修正後=2026-10（ブラウザTZがAsia/Tokyo・America/Los_Angelesの両方で）。
- JST 2026-10-01 00:30（UTC 9/30 15:30）: 修正後=2026-10（TZ=UTC・Los_Angeles・Tokyoのすべて）。修正前=2026-09。
- JST 2026-09-30 23:30: 修正後=2026-09（TZ=Tokyo、Auckland（ローカルは10/1 03:30）とも）。
- JST 2027-01-02（年またぎ）: 2027-01。
- 月を手動で2026-12に変更→描画され、他画面へ移動して戻ると今月(2026-10)に戻る。修正前は2026-12のまま残った。
- 10月のカレンダーは32列(レーン列+31日)で、合成のホテル手配が描画される。JSエラー0。
### 同種の問題の洗い出し（grep。今回は修正せず、報告のみ）
| 画面/処理 | 場所 | 初期値 | 評価 |
|---|---|---|---|
| **レストラン重複確認**（rc-ym） | `initRestaurantConflicts` :16786 | 固定 `'2026-09'` + 初回のみ生成 | **同一バグ。要修正** |
| ホテル手配マトリクス（hm-matrix-ym） | `initHmMatrix` :26743 | 今月、開くたび再生成 | 今月になる。ブラウザのローカル時刻でJST固定ではない（日本国内では問題なし） |
| ガイド仮払い一覧（ga-from/ga-to） | `setGuideAdvanceRangeDefault` :21453 | `toISOString()`(UTC)の今日〜+60日 | JSTの0〜9時台は**前日**が入る（UTCずれ） |
| 見積もり 新規の日付 / コピー時の作成日 | :11967 / :11895 | `toISOString()` | 同上（JST 0〜9時台は前日） |
| Invoice 発行日 | :30367 / :30494（`generateInvoice`/`upsertConsolidatedInvoice`） | `toISOString()` の日付 | 同上。**請求書の発行日が前日になりうる（要確認・優先度高め）** |
| 会計年度（currentFiscalYear）/ 支払画面の年度 | :3773 / :22076 | ローカル日付。年度セレクトは初回のみ生成 | 日本国内では問題なし（3月境界でも開き直しで古い選択肢が残りうるが軽微） |
| 手配確定状況・観光地予約管理・ガイド精算一覧・ダッシュボード | — | 月/日付の固定初期値は無し（grepで固定値・UTC由来の初期値は見つからず） | 該当なし |
※ 上記の「要修正」「UTCずれ」はJUNさんの指示後に別PRで対応（今回の修正には含めていない）。
### 競合試算（読み取り）
#222: index.html競合なし。#220: index.htmlは自動マージ可、SESSION_NOTES.mdのみ競合（従来どおり）。#144: 履歴が無関係（unrelated histories）で、コミット4f77353のindex.html差分は今のmainにも当たらない（従来から。この変更とは無関係）。
### JUNさん確認手順
PR: https://github.com/Jun-Ryusekido/kic-travel-core-ver2/pull/225 （未マージ）。**Preview: https://kic-travel-core-ver2-git-claude-b33b5d-jun-ryusekido-s-projects.vercel.app** （Vercel Ready、2026-10-05 10:13 UTC、コミット 7d0ff8b。Claude環境からは到達不可で画面は未確認）にログイン → サイドバー「ツアー運行カレンダー」 → 月が「2026年10月」になっていること。月を別の月に変えて表示が切り替わること。別画面へ移動して戻ると今月に戻ること。本番(https://kic-travel-core-ver2.vercel.app)での確認は未実施（マージ後に同じ手順で）。

---

## 予約の進捗判定（ステッパー/進捗ドット）— 指示1 調査完了（コード未変更）

### 確定した事実（実コードで確認）
- 詳細: index.html `openBookingDetail`(:9413)。モーダル「予約台帳」。売上/仕入/請求書は `tableQueryBatch` 経由(API)、hotels/buses/手配書ヘッダーは `sb.from()` 直接。
- 一覧: `loadBookingListGeneric`(:4545) → `fetchBookingsListLight`(:4290) が bookings を軽量列で全件取得し `bookingsListCache`(5分TTL)に保持。ダッシュボード(db)と予約一覧(bl)が共用。
- 入金は **payments テーブルではない**。`booking_sales.payments` は jsonb 配列 `[{date,amount,bank,remark}]`。入金合計=全売上行の payments[].amount の合計(`salesPaymentsTotal` :7232 / 詳細KPI `bd-sum-paid`)。売上合計は `booking_sales.amount` の合計。
- invoices.status = 'pending' / 'paid' / 'void'（コード・SQLコメントで確認）。invoicesは `readable`(booking_id eq/in)でAPI経由のみ。
- 手配ステータス値: 未予約 / 問い合わせ中 / 手配OK / FNL済 / NG回答 / 予約不要 / キャンセル(施設)。ホテル/バスの選択肢は VENDOR_EMAIL_STATUS_OPTIONS=未予約,問い合わせ中,手配OK,FNL済,NG回答,キャンセル(+旧「確定」「回答待ち」が色分け関数に残存)。
- estimations: `converted_booking_id`(予約への紐付け)、`is_template` はあるが、**「確定済み」を表す列はコード/SQL上見つからない**。
- 書類: `tour_arrangement_headers`(booking_id 1:1, 共通ドラフト) と `arrangement_documents`(ガイド別手配書, booking_id)。「手配一覧表を作成した」ことを示す専用フラグは未発見。
- bookings.status は既に open/pending/confirmed/finalized/invoiced/paid/settlement/closed/cancelled (STATUS_ORDER :7083) を持つ。

### 実装上の制約（要判断）
- booking_sales / invoices は RLS有効でAPI(`query`)のみ。`booking_id in` は1回200件まで、全件取得用のfilterなし取得は不可 → 1000件超の一覧には「進捗集計用の読み取り専用action」を api/table-crud.js に新設するのが現実的(DBスキーマ変更なし)。
- booking_hotels/booking_buses は一覧側で既に anon `sb.from()` 直接select(:27213)。

### 未実施
- 実データでのドライラン: この環境にSupabase認証情報なし(env/ .env 無し)。Claude in Chrome 接続も無し。

---

## 予約進捗判定 — ドライラン用スクリプト完成（画面は未実装・JUNさんのドライラン結果待ち）

### 確定したこと
- ブランチ: claude/epic-goodall-ysy4ll は origin/main(7764fe3)を含む（`git merge-base --is-ancestor` で確認）。
- 判定の純粋関数: `public/js/booking-progress.js`（UMD。ブラウザは `window.BookingProgress`、Nodeは require）。`vercel.json` へのルート追加は未実施（画面実装時に追加。image-compress.js と同じ方式）。
- ドライラン: `scripts/progress_dryrun.js`（GETのみ。出力 scripts/data/progress_dryrun_summary.json）。全テーブル1000行ずつページング、`count=exact` と取得件数が不一致なら集計を出さず exit 2。
- ルール（調査報告+JUN回答どおり）: 見積=紐付き見積あり→完了/なし→対象外「見積なし」。書類=常に対象外「記録なし」。cancelled予約=全段階対象外・要確認なし。手配=NG/キャンセル→要確認、問い合わせ中→進行中、全件OK→完了、全件未予約/0件→未着手、**一部OKで残りが未予約のみ→進行中（指示に明記なしのため私の補足。要確認）**。入金は1円未満の差を等しいとみなす。**売上がマイナス(<-1円)→要確認(sales_negative)も私の補足**。
- 「手配一覧表PDF」(`printArrangementSummaryList` index.html:26258) は画面メモリ上の bdHotelItems/bdBusItems/bdFacilityItems/bdRestaurantItems/bdBulletTrainItems と business_partners を読んで印刷するだけで、**作成記録をDBに残さない**。→ 書類は判定不能のまま。候補: tour_arrangement_headers の有無 / arrangement_documents の有無（statusは draft/final）。件数はドライラン出力に含む。
- 検証: 純粋関数の単体テスト(境界・小数・旧値・cancelled)OK。モックサーバー(2300予約でページング)でスクリプト動作OK、count不一致時は集計を出さず中止、GET以外のリクエスト0件。

### 残タスク
1. JUNさんがドライラン実行 → 結果(summary JSON)を貼る。参考値(入金超過≒56・売上0円入金あり≒30)と大きくずれたら実装に進まず原因調査。
2. 結果確認後に実装: api/table-crud.js に進捗集計の読み取り専用action新設（予約ごとの売上合計/入金合計/有効請求書件数のみ。既存の認証を通す。5分TTL）、詳細ステッパー、一覧ドット・要確認チップ・横断検索、「対象外」(灰色の丸に—)表示。vercel.jsonにルート追加。
3. 実データでの画面確認手順はJUNさん環境向けに最後に提示。

---

## 予約進捗（ステッパー・一覧ドット・要確認チップ）— 実装完了（PR未作成・mainへ未反映）

### JUNさんの判断（反映済み）
- ドライランは実施せず、SQLで入金判定を検証済み（売上明細あり652件: 完了36/進行中16/なし519/超過26/売上0円で入金あり30。超過26+0円30=56が10/6点検値と一致）。判定条件はそのまま採用。
- `scripts/progress_dryrun.js` と .gitignore追記は削除（PRに含めない）。`public/js/booking-progress.js` は実装で使用。
- 売上明細が1行も無い予約: 入金=未着手「売上未入力」（要確認にしない）。見積=あり→完了/なし→対象外「見積なし」。書類=常に対象外「記録なし」。cancelled=全段階対象外。

### 実装内容
- `public/js/booking-progress.js`: 判定の純粋関数（UMD）。理由に badge(一覧用)/message(詳細の帯用)を追加。`hideAmounts`（財務サマリーを見られないロール向けに金額を伏せる）。単体テスト `scripts/test_booking_progress.js`。
- `api/table-crud.js`: 読み取り専用 action `progressSummary`。booking_sales/invoices/booking_hotels/booking_buses/estimations を1000行ずつページング(count=exact照合、不一致なら500で集計を返さない)し、予約単位の合計のみ返す（売上行数・売上合計・入金合計・有効請求書数・手配ステータス別件数・見積有無。明細/個人名/取引先名は返さない）。ログインセッション検証は他actionと同じ（ゲスト不可）。service_roleキーはレスポンスに出ない。APP_VERSION_EXEMPT(読み取り専用)に追加。
- `index.html`: 一覧に「進捗」(5つのドット)・「要確認」(バッジ)列、「すべて/要確認 N件」チップ（ダッシュボードと Booking List の両方。共通の filterBookingListGeneric）。進捗の集計は一覧取得と並行して1リクエスト・5分TTL、関連テーブルへの書き込み(tableCrudApiCall)で破棄。詳細モーダル最上部にステッパー+要確認の理由帯（丸/ボタンで該当節へジャンプ）。詳細は画面上の最新データ(売上・入金・手配・請求書キャッシュ)から計算し、編集に追従。
- `vercel.json`: `/js/booking-progress.js` のルート追加。
- 副次修正: `scrollBdModalToSection` を、固定ヘッダー下端基準(`scrollBdModalToElement`)に変更（スマホ幅で見出しがヘッダーに数px潜る問題）。既存の scrollTo:'sales' 遷移にも効く。
- 検索: 既存の検索が既に REF#・Agent・Tour Code・Tour Name を横断していたため拡張なし。

### 検証（Playwright+合成データ2300予約、実クリック）
- 一覧: チップ件数=独立計算と一致(683)、チップクリックで絞り込み、検索（REF#/Agent/Tour Code/Tour Name）、条件クリアでチップ解除、1000件超でも初回描画0.2秒/再描画約30ms、375px・1280pxで横スクロールなし、集計の遅延中は「読み込み中…」（絞り込みは取得後）、取得失敗時は一覧は表示され「取得失敗」。
- 詳細: 順調/入金超過/手配途中/中止/売上なし/NG+キャンセル+売上0円入金 の6種で期待どおりの状態・理由帯。丸のクリックと帯のボタンでジャンプ（PC/375px、見出しがヘッダー下に表示）。入金・ホテルステータスの編集にステッパーが追従。375pxで説明の重なりなし。staffロールは金額を伏せる。
- API: モックでページング(2600予約・13リクエスト・応答約177KB)、GETのみ、401（トークン無し/不正）、件数不一致で500・集計なし。

### 残タスク / 注意
- 実データ(本番Preview)での確認はJUNさん。
- 書類の判定（手配一覧表の作成記録が無い）は未対応。候補: arrangement_documents(draft/final)・tour_arrangement_headers。
- SQL変更なし（スキーマ・RLS・GRANT変更なし）。

---

## 進捗ステッパー — ebc84c5 後の修正（権限・通信量・プレビュー確認準備）

### 修正1: 金額の権限制御（サーバー側）
- 確認: `api/table-crud.js` には role/email で金額を制限するコードが無く（email制限は ACCOUNTING_EMAILS等の別機能のみ）、既存の `query`/`queryBatch` は booking_sales(amount,payments)・invoices を**ログイン済みの全ロールに全列**返す。金額の非表示は index.html のUI制御(`canViewFinancials`相当)のみという既存設計。→ 今回の progressSummary だけがサーバー側で制限する（既存actionの設計変更はしていない）。
- progressSummary: 判定を純粋関数(`public/js/booking-progress.js`)でサーバー計算。閲覧可=role==='admin' または email==='kanri@kictravel.jp'（クライアントの canViewFinancials と同基準、署名済みトークンの値）。権限なし=金額を含まない文言(hideAmounts)。売上合計・入金合計の数値は誰にも返さない。レスポンス形式: 中止={c:1}、その他={st:[[状態,説明]×5],rs:[[段階,コード,バッジ,理由]]}。データなし予約はクライアントが同じ純粋関数で既定値を算出。
- 純粋関数の読み込みは動的import（失敗しても他のactionに影響しない）。vercel.json の api ビルドに includeFiles を追加。
- 注意: 予約詳細を開くと売上・入金は既存 queryBatch で取得される（既存設計のまま）。詳細の金額を権限なしロールに完全に隠すには既存action側の設計変更が必要（未実施・要判断）。
### 修正2: 通信量
- 取得列を最小化（idはselectしない。bookingsは status=cancelled のidのみ）。サーバー側5分キャッシュ(globalThis.__progressRawCache、権限と無関係な集計元データ。ロール別変換はキャッシュ後)。関連テーブル(booking_sales/invoices/booking_hotels/booking_buses/estimations/bookings)への書き込み成功で同一インスタンスのキャッシュを破棄。
- 1回あたりSupabaseから読む量（現実的な合成データ: 予約1,300・売上2,300・請求1,500・ホテル3,000・バス1,000・見積300で実測）: 約825KB（sales 413KB / ホテル 227KB / 請求書 107KB / バス 77KB / 見積 19KB / 中止予約 2KB）。クライアントへの応答は約0.2MB(gzip前)。
- 概算（50人×営業8h×5分ごと=96回/日/人=4,800回/日、22営業日）: キャッシュ無し 4,800×22×0.825MB≒85GB/月。サーバーキャッシュ有り: 1インスタンスが5分に1回=96回/日×22日×0.825MB≒1.7GB/月（インスタンス数×1〜3で1.7〜5GB/月）。Free枠5GBに対し余裕が小さい → DB側で集計するRPC/ビュー（SQL必要、1回あたり約0.1MBに削減見込み）を提案（未実施・要承認）。
### 修正3/確認準備
- Preview の接続先: index.html と api/*.js が本番SupabaseのURLをハードコード、VERCEL_ENVによる切替なし → **Previewは本番DBに接続**。確認は読み取り（見る・移動する）のみ。
### 副次修正の確認
- scrollBdModalToSection の呼び出し元は openBookingDetail 内の1箇所（opts.scrollTo==='sales'）のみ。入口は Invoice画面の行クリック と Agent未紐付けモーダルの請求書行。旧コードでは見出しが固定ヘッダーに約10px隠れていた(PC/375px)が、修正後は見える。
### 検証（Playwright+ダミー2,300予約）
- 入金額を実際の入力欄に打ち込み(500,000→300,000→900,000)、ステッパーが 完了/進行中/要確認(帯の文言も変化)に変わることを確認。ホテルのステータスを実際のドロップダウンで変更し、手配が 進行中→完了→要確認 に変わることを確認。
- サーバー: admin/kanri=金額つき、staff/view=金額なし（レスポンス中に金額の数字が無いことを確認）、状態は全ロール同一、キャッシュ再利用、書き込みで破棄・無関係テーブルの書き込みでは破棄しない、401。
### 残タスク
- PR作成・プレビューでの実データ確認（読み取りのみ）。egress対策のRPC化の可否。詳細画面の金額の権限（既存action）の扱い。書類判定は対象外のまま。
## ホテル行の「区分(ゲスト/ドライバー)」選択欄を画面から削除（ブランチ claude/charming-keller-f6lvzg・index.htmlのみ・SQLなし）

### 確定内容
- 予約詳細→手配管理→ホテルタブの各行から、区分の `<select class="hotel-lodging-sel">` と専用CSS、見出し「ホテル名 / 区分」→「ホテル名」だけを削除。他の入力欄は変更なし。
- データ列 `booking_hotels.lodging_for`('guest'既定/'driver')と内部処理は変更なし。保存は `buildHotelRows` が `normalizeLodgingFor(it.lodging_for)` を使うため、既存行の値は維持され、新規行(`addHotelRow`)は 'guest'。
- 既存のドライバー行のDRVバッジ・備考プレースホルダは残した（表示のみ）。

### lodging_for の使用箇所（コードで全件確認。APIフォルダ・scripts内のJS・他HTMLでは未使用）
- 画面: 保存/読込(mapHotelDbRow/buildHotelRows)、REF#コピー、手配確認の催促除外(:6188)、仕入明細へ追加の対象外(:6781,:6833)、仮払い自動生成(区分D)(:9234)、手配書の表示(:9340,:26473)、ホテル選択肢(:19326)、到着ホテル照合(:19474)、重複確認(:23080)、ホテル予約管理(:25327)
- SQL: scripts/add_lodging_for_to_booking_hotels.sql（列・CHECK制約・RPC2本でguestのみ対象）
- これらは値を読むだけで、選択欄の有無に依存しない → 壊れない。

### 残タスク・注意
- **画面からドライバー区分に変更できなくなった**（既存のドライバー行の区分は維持される）。新規にドライバー宿泊を登録する手段が必要なら別途検討。
- `setHotelLodgingFor`（index.html）は呼び出し元が無くなった（内部処理は変更しない指示のため残置）。不要なら別PRで削除。
- 既存データにドライバー行が何件あるかは、DBを読んでいないため不明（確認SQL: `select lodging_for, count(*) from public.booking_hotels group by 1`）。
- 本番(Vercel)での目視は未実施。

---

## PR #236（ホテル区分の選択欄削除）マージ保留 — 追加確認の結果（コードのみ・DB未参照・SQLなし）

### マージ保留の理由
区分(booking_hotels.lodging_for)は画面の飾りではなく処理に使われている。選択欄を消すと、**新規にドライバー宿泊を登録する手段と、誤ってdriverにした行をguestに戻す手段が無くなる**。JUNさんが本番で driver の件数を確認し（`select lodging_for, count(*) from public.booking_hotels group by 1;`）、0件ならマージ可、1件以上なら代替手段（例: 選択欄を残す／別の入口を用意する）を決める。決まるまでマージしない。

### 保存処理（実コードの追跡）
保存ボタン(:15979 等) → `saveHotelItems`(:13390) → `buildHotelRows`(:13341) → `bookingHotelsApiCall('replace')` → api/table-crud.js `doReplace`。
`lodging_for` は **画面のselectの値ではなく、メモリ上の `bdHotelItems[].lodging_for` を `normalizeLodgingFor` に通して送る**（:13357）。読込は `mapHotelDbRow`(:13331)で DB値→`bdHotelItems`。DOMのselectを読む箇所は無い。
スタブ(Chromium+Supabaseスタブ、実index.html)での再現: 読込行[guest, driver]を画面でホテル名編集→新規行追加→OCR形の行(lodging_for無し)→REF#コピー形の行(driver)を保存すると、送信rowsは
[ゲストH:guest, DRV宿(変更):**driver**, 新規H:guest, OCR行:guest, コピー元:driver]。既存driver行はguestに書き換わらない。選択欄は0個。

### 'driver' 行の扱い（関数名・行番号）
| 処理 | 関数 / 行 | driver行の扱い |
|---|---|---|
| 手配確定状況の催促 | fetchVendorEmailCandidates :6188-6190 | 対象外 |
| 仕入明細へ追加ボタン | arrCostCheckboxHtml :6779 | 押すと理由表示のみ（追加不可） |
| 仕入明細へ追加（実行） | addArrRowToCostNow :6831 | alertして中止 |
| 仮払い一覧の自動生成 | generateLocalExpensesFromArrangements :9233 | 区分「D（ドライバー）」で出す |
| 日付チェックのエラー文 | findArrangementDateRangeErrors :9338 | 「・ドライバー宿泊」を付記（表示のみ） |
| 手配書の日別ホテル選択肢 | renderArrDayList :19321 | 【DRV】を付記 |
| 手配書の貼り付け解析・到着ホテル照合 | parseArrDayPasteText :19469 | driver行は照合対象外 |
| 重複確認 | hmFetchExistingForDupCheck :23075 | guestのみ取得（driverは対象外） |
| ホテル予約管理 | loadHotelManagement :25322 | guestのみ表示 |
| 手配一覧の印刷 | printArrangementSummaryList :26468 | 「(ドライバー宿泊)」を付記 |
| REF#からコピー | ARR_COPY_CONFIG.hotel :13083 | lodging_forをそのままコピー |
| ホテルDB側 | scripts/add_lodging_for_to_booking_hotels.sql | 列(NOT NULL 既定guest)・CHECK制約・RPC2本はguestのみ |

### 新規にドライバー宿泊を登録する手段（選択欄削除後）
| 経路 | lodging_for に入る値 |
|---|---|
| 行追加(addHotelRow :13316) | 'guest' 固定 |
| メール・テキスト読み取り(:20696 付近、再利用行は Object.assign で既存値を維持) | 未指定→保存時 'guest'。既存の空行を再利用した場合は、その行の既存値 |
| Excel/PDF/Word読み取り(:20617) | 未指定→'guest' |
| 画像・カメラ読み取り | 同上（読取結果の形は同じ関数。lodging_forを持たない）→'guest' |
| 空行(メール抜粋 :15977) | 未指定→'guest' |
| REF#コピー(:13083) | コピー元の値を引き継ぐ（コピー元がdriverならdriver） |
→ **削除後、新規にdriverにする手段は無い**（REF#コピーでコピー元の値を引き継ぐ場合のみ）。誤ってdriverになった既存行を**guestに戻す手段も無い**（画面に入口が無い。SQL直接修正のみ）。

### 残タスク
- JUNさん: 上記SELECTでdriver件数を確認 → 0ならマージ可、1件以上なら代替方式を決定。
- 未確認: 本番(Vercel)の実画面・実保存、実データのdriver件数。

---

## PR #236（ホテル区分の選択欄削除）マージ完了の記録（SESSION_NOTESのみ・SQLなし）

### 確定内容
- 2026-10-21 PR #236 をマージコミット方式でマージ（main先頭 694924c）。
- 経緯: JUNさんが本番DBで確認した結果、`booking_hotels.lodging_for` は **guest 313件・driver 0件**。ドライバー区分は実運用で使われていないと確認できたため、マージ保留（ドライバー区分の扱い未決のため）を解除してマージした。
- ホテル行の区分の選択欄・専用CSS・見出し「/ 区分」を削除。**ドライバー関連の処理（催促除外・仕入明細へ追加の対象外・仮払い自動生成の区分D・手配書の【DRV】表示・重複確認/ホテル予約管理のguest絞り込み・DRVバッジ・`setHotelLodgingFor`・列`lodging_for`とSQL）は未使用のまま残してある**（変更していない）。
- 他PRへの影響（マージ直後にローカルで試算）: #235 は競合なし。#233 は SESSION_NOTES.md のみ競合（末尾追記同士の従来どおりの競合。index.htmlは自動マージ可）。マージ・解消は未実施。

### 残タスク
- 本番(https://kic-travel-core-ver2.vercel.app/)での画面確認（予約詳細→手配管理→ホテルタブに区分欄が無いこと、行の幅・並びが崩れないこと、既存行の保存）: **未確認**。
- ドライバー関連コードの整理（上記の未使用処理を削除するか、将来の利用に備えて残すか）を行うかどうかをJUNさんが決める。行う場合は別PR（lodging_for列・RPC・SQLの扱いも含めて要検討）。
- #233 の SESSION_NOTES.md 競合の解消（#233 側で main を取り込む）。

### PR #235 マージ・#233 保留・残タスク（2026-10-21追記）
- **#235（変更履歴にマイナンバーの値を保存・返却しない）をマージコミット方式でマージ**。main先頭: `a0878bb`（Merge pull request #235）。マージ後のmainで `api/table-crud.js` の構文チェックOK、`scripts/test_audit_redact.js` は **17件成功 / 0件失敗**。
- **#233（予約の進捗ステッパー・一覧の進捗ドット・要確認チップ）は未マージ**。動作確認のため保留中。
- 残タスク:
  1. 本番での画面確認: ホテルタブに区分欄が無いこと・既存行の保存（#236）。**未確認**
  2. 本番でのマイナンバー履歴マスクの確認（変更履歴モーダルで my_number が値として見えないこと）。**未確認**
  3. audit_logs の RLS/GRANT の実状態の確認（`scripts/investigate_guide_audit_logs.sql`をJUNさんがSQLエディタで実行）。**未確認**
  4. 既存の audit_logs にある平文マイナンバーの処理方針の決定（API返却はマスク済みだが、DB上の既存行は書き換えていない）。**未決**
  5. ドライバー関連コード（`setHotelLodgingFor`・DRVバッジ・`lodging_for`列/SQL等。実データはdriver 0件）を整理するかどうかの決定。**未決**

---

## ダッシュボードに「ホーム」ボタンを追加（見え方だけ・追加のみ・index.htmlのみ・SQLなし・未マージ）

### 確定内容
- ダッシュボードの「到着日アラート」カードの直後（検索・絞り込みカードの前）に「ホーム」カードを追加。既存の表示・位置は変更なし（既存行の変更・削除は0行。`</body>`直前に`<style>`と`<script>`を1ブロック追加しただけ）。
- メニュー定義はサイドバー(`#sidebar`、静的HTML)が唯一の正。ボタンはその項目(`.sb-sec`/`.sb-item`)を読んで生成し、押すと対応するサイドバー項目の`click()`を呼ぶだけ。遷移先・権限(`admin-only`/`accounting-only`等)・メール受信箱の停止(`EMAIL_INBOX_SUSPENDED`)はサイドバーと完全に同じ動き。サイドバーの表示切替(`style`)をMutationObserverで追って作り直す。
- ボタンは3段（アイコン／日本語名／小さく英語名）。名前はサイドバーの文字そのまま（英語名の先頭の区切り「/ 」だけ除く。英語名が無い項目=Booking List・Invoice・GROSS / 粗利は日本語名の段のみ）。グループ見出しはサイドバーの表記（英語はCSSで大文字表示）。グループは見出しで折りたたみ（初期は全て開、状態は保存しない）。375pxは2列、PCは`auto-fill`。
- 追加する場合の定数: `HOME_BUTTONS_ENABLED`（初期値 true）。false にするとカード自体が作られず従来と同じ画面。
- 数字のカードは作っていない（#233の「要確認」の件数と定義がずれるのを避けるため）。

### 元に戻す方法
1. 定数 `HOME_BUTTONS_ENABLED` を false にする（index.html末尾付近の1行）。
2. このPRを閉じる（マージ前）。
3. マージ後は、このコミットをrevertする（変更は1コミット・index.htmlとSESSION_NOTES.mdのみ）。

### 残タスク
- 第二段階でサイドバーを細くする場合は、アイコンだけにせず、文字付きに開閉できる形にする。
- 数字のカード（到着8日以内・要確認・未確定の手配）は、#233 のマージ後に、同じ定義で作る。到着日アラートは `renderDbArrivalAlert`（`bookingsListCache`から、in_dateが今日以降・cancelled/closed除外・90日以内を6段階(8/14/21/30/60/90日)に分ける）、#233の「要確認」は `progressSummary`（サーバー集計の理由）で、定義が別。
- 本番(Vercel)での実画面確認（PC・スマホ）。**未確認**。

### PR #238 修正（2026-10-22）
- 「ダッシュボード」ボタンをホームカードから除外（ダッシュボード自身へ移るボタンは不要）。サイドバー側は変更なし。実DOMで、管理者 サイドバー24/ホーム23、スタッフ 18/17。
- 「メール受信箱」ボタン: `EMAIL_INBOX_SUSPENDED` が true の間、グレー（破線枠・薄い文字）＋小さく「停止中」。押した時の動きはサイドバーと同じ（停止の案内が出る）。false にすると通常表示に戻り、押すと通常の受信箱（`renderEmailInboxList`）が呼ばれる（実クリックで確認）。
- 他の停止フラグ: index.html・guide.html・api/・scripts/・public/ を検索したが、`EMAIL_INBOX_SUSPENDED` 以外に機能停止用のフラグは無い（`disabled=`は保存中のボタン無効化で別物）。
- 位置の測定（ホームカードあり/なし、PC 1280×800・スマホ 375×812）: ホームカードが全グループ開の初期表示だと、予約一覧の最初の行は全ケースで画面外（例: PC管理者・アラートあり 689px→1412px、スマホ管理者・アラートあり 536px→1885px）。全グループを閉じた状態（見出しだけ）なら、アラートが無ければPC・スマホとも最初の行は画面内、アラートが出ているとPC/スマホ管理者は画面外（スマホスタッフは画面内）。初期表示を閉じるかは JUN さんの判断（折りたたみ状態の保存は作らない方針）。
- プレビューが接続するDB: フロント(index.html:3283)もAPI(api/*.js)も同じSupabaseプロジェクト1つのURLが固定。本番と分けた環境は無い → プレビューも本番DB。プレビューでの確認は「見る・ボタンを押して移動する」だけ。保存・編集・削除はしない。

### 残タスク（追加）
- 誤って作った `claude/home-buttons-dashboard`（`214007d`、PRなし）の削除: `git push --delete` がプロキシ切断で失敗（2回）。GitHubのブランチ一覧から手動削除してもらう。
- ホームカードの初期表示を「全グループ閉じる」にするかの判断（JUNさん）。
- 本番(Vercel)での実画面確認（ホーム・遷移・停止中表示・スマホ幅）。

### PR #238 修正2（2026-10-22）: ホームカードの初期表示を「全グループ閉じた状態」に
- 判断（JUNさん）: 全部開いた状態では、予約一覧の最初の行がPC・スマホ全8通りで画面外に出るため、初期表示は閉じた状態にする。開閉の状態は保存しない（localStorage等なし）。開くたびに閉じた状態から始まる。
- 見出しの並べ方を測って決めた（実装前の測定。CSSを仮に当てて測定）: 最初の行が画面内に入った数は、見出し縦5行=5通り、横1行=6通り → 横1行を採用。見出しは枠つきのピル（右向き▸、開くと下向き▾・青色）を横に並べ、幅が足りなければ折り返す。開いたグループのボタンは見出しの下に出し、複数開いても分かるようグループ名を小さく添える。
- 実装後の実測（初期=閉じた状態そのまま。最初の行の位置／画面内か）: PC 1280×800 = アラートあり管理者 797px(外・下端830)、スタッフ 721px(内)、アラートなし管理者 546px(内)・スタッフ 470px(内)。スマホ 375×812 = アラートあり管理者 707px(外・下端815。上端は見えるが下端が3px画面外)、スタッフ 604px(内)、アラートなし管理者 456px(内)・スタッフ 353px(内)。画面内=6/8。横スクロールなし。
- 実クリック確認: 管理者23・スタッフ17ボタンを、グループを開いて実マウスで全部押し、サイドバーと同じ呼び出しになった。メール受信箱は停止中表示（グレー+「停止中」）、押すと停止の案内。`EMAIL_INBOX_SUSPENDED=false`では通常表示に戻り通常の受信箱が呼ばれる。`HOME_BUTTONS_ENABLED=false`では、ダッシュボードのDOMと主要カードの位置が main と同一。
- サイドバーのコードは変更していない。DB・SQLなし。

### 残タスク（更新）
- 誤ブランチ `claude/home-buttons-dashboard` の削除（JUNさんがGitHubの画面から）。
- 本番(Vercel)での実画面確認（ホーム・閉じた状態・開閉・遷移・停止中表示・スマホ幅）。
- スマホ・アラートあり・管理者では最初の行の下端が3px画面外（上端は見える）。気になる場合はカードの余白を詰める案を検討。

---

## PR #233（進捗ステッパー等）: キャッシュと権限の組み合わせ・通信量・編集中記録の確認（2026-10-22・コード変更なし・#233へのpushなし）

### 確認1: キャッシュとロール（実ハンドラーを呼んで確認）
- キャッシュ(`globalThis.__progressRawCache`)に入るのは、ロールに依存しない集計の元データ（予約ごとの売上行数・売上合計・入金合計・請求書数・手配状態別件数・見積有無・中止id。文言は含まない）。ロールごとの出力への変換はキャッシュの後(`doProgressSummary`)。キー構造はロール別に分かれていない（全ロール共通の1つ）。
- 順序A(admin→staff→view→kanri): 1回目だけSupabase取得(+13回)、以降は cached=true・取得+0。staff/viewのレスポンスに金額の文字列(生の額・カンマ付き)なし。admin/kanriは「超過 265,433円」「入金 1,500,000円が売上合計 1,234,567円を超えています」等の金額入り。
- 順序B(staff→admin): staffが先にキャッシュを作っても、adminには金額入り、staffには金額なしで返った。
- 結論: 問題なし。修正なし。

### 確認2: 通信量（実データの行数: sales 2,865・payments計23,150B・invoices 44・hotels 319・buses 165・estimations 0・cancelled 65・bookings全件1,390）
- 1回あたり ≈ 売上 2,865×84B+23,150B ＋ 請求書 44×71B ＋ ホテル 319×76B ＋ バス 165×77B ＋ 見積 0 ＋ 中止 65×46B ≈ 306,875B ≈ 0.29MB（約0.3MB）。Supabaseへのリクエストは8回(売上3ページ+他5)。
- キャッシュ: サーバー関数のメモリ(globalThis)・有効期限5分・関連6テーブルへの書き込み成功で、そのインスタンスのキャッシュだけ破棄。インスタンスが複数並ぶと共有されず、別インスタンスは最大5分古い。
- DB側集計(RPC)は未実装・案のみ（報告に記載）。

### 確認3: 編集中の記録（コードで確認）
- 予約を開く→`startBdPresenceHeartbeat`: `booking_edit_presence`に(予約, ユーザー)の1行をupsert。以後240秒ごと。5分間無操作でハートビート停止。
- 「閉じる」→`closeBookingDetail`→`stopBdPresenceHeartbeat`→`release`: 自分の行をDELETE。失敗しても閉じる操作は妨げない。
- タブを閉じた場合: pagehide/unload/sendBeaconなし → 行は残る。他の人の画面には、最後のハートビートから5分(`PRESENCE_STALE_MS`)を過ぎると「編集中」として出なくなる。行そのものは自動では消えず、同じ人が同じ予約を開き直す(上書き)か、閉じるボタンのreleaseで消える。
- アクセスログ: 予約を開くだけでは書かれない。書かれるのは、メニューでの画面移動（ダッシュボード以外。`ページ遷移`）と、予約の保存(`予約編集`)。※前回の報告「予約を開くとアクセスログが自動で書かれる」は誤りだったので訂正。

### 確認4: Preview環境の環境変数が無い場合
- `SUPABASE_SERVICE_ROLE_KEY`が無いと、ログインAPI自体が500「サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません」で、ダッシュボードまで進めない。ログインできていれば、キーは設定されている。
- ログインできるのに一覧の進捗の丸が灰色のまま・チップが「要確認(取得失敗)」なら、キー以外（includeFiles未反映、集計の件数不一致など）。原因文言はエラーログ画面(管理者)の「予約の進捗集計の読み込み」に残る。

### 残タスク
- 実データでのプレビュー確認（JUNさん）。
- RPCによるDB側集計に切り替えるかどうかの判断。
- 本番/プレビューでキャッシュが複数インスタンスでどれだけ効くか（Vercelの設定。未確認）。

---

## 「ホーム」を最初の画面にする(第1段階): 手順0 調査(2026-10-22・読み取りのみ・コード変更なし)

### 土台
- PR #238(ダッシュボードにホームボタン・HOME_BUTTONS_ENABLED)は **未マージ**(open)。ブランチ `claude/charming-keller-f6lvzg` を、この環境のブランチ `claude/trusting-franklin-rxs5ss` に取り込んだ(fast-forward、d7fe9fb)。
- PR #233(進捗ステッパー等)との試しマージ: **競合なし**(自動マージ成功。試しマージは取り消し済み)。

### 1. 最初の画面が決まる場所
- ログイン成功時 `doLogin()` の末尾 `go('dashboard')`、再読み込み時 `restoreSession()` の `go('dashboard')`(index.html 3926行・4176行付近)。どちらも固定で `'dashboard'`。
- `let currentPageId='dashboard'`(3410行)、サイドバーの初期 active もダッシュボード(1193行)。
- URLハッシュ・`history.pushState`・`popstate`・`hashchange` は **一切使っていない**。再読み込みは常にダッシュボード(15分以内のセッション復元時)。ブラウザの戻るボタンは画面遷移に効かない。
- `go(id)`: 未保存確認(手配確定状況)→権限チェック→`.page`を全部非表示→`#pg-<id>`を表示→サイドバーactive付け替え→タイトル更新→画面ごとのデータ読込。`#pg-<id>`が無いidは何もしない。`pageNames`にidを足す必要あり。
- ダッシュボード以外の遷移は `logAction('ページ遷移')` が書かれる(アクセスログ)。

### 2. アラート3種類
- **対応が必要な予約**: `booking_facilities`(対応期限日あり)を全件取得→`fetchAllFacilityDeadlineItems()`(5分TTL `facilityDeadlineItemsCache`)→`buildFacilityDeadlineResult(allItems,7)`。未完了(`!deadline_completed`)・予約がcancelled/closedでない・施設status≠キャンセル。区分は `FACILITY_DEADLINE_TIERS`(日数≤0 / =1 / 2〜3 / 4〜7)。**件数は「予約」ではなく booking_facilities の行(ToDo)数**。結合に `allBookingsCache`(`fetchAllBookings` = bookings全列)を使う。
- **到着日アラート**: `bookingsListCache`(`fetchBookingsListLight`、5分TTL)から、in_date≥今日・cancelled/closed以外・90日以内を、8/14/21/30/60/90日のティアに分ける(`renderDbArrivalAlert`)。件数は予約単位。
- **Agent未紐付け**: `bookings`(agent_nameあり・agent_id null)+`invoices`(同条件)を取得(`refreshAgentUnlinkedBanner`、5分TTL `_agentUnlinkedCache`)。名前が空/'0'は除外。件数は「予約N件・請求書M件」。
- 再利用可否: **新しいAPIは不要**。ホームから同じ関数(`fetchBookingsListLight`/`prefetchFacilityDeadlineAllItems`/`refreshAgentUnlinkedBanner`/`refreshGlobalDeadlineBanner`)を呼べば、同じ5分TTLキャッシュを共有する。ただし今は `loadBookingListGeneric('db')`(ダッシュボード表示時)がこれらを呼んでおり、ホームが最初の画面になると、**ホーム側でこの取得の呼び出しを引き継ぐ必要がある**(取得量は今と同じ。ダッシュボードを後で開いても、TTL内ならキャッシュで再取得なし)。
- 既存の描画関数は表示先のid(`db-todo-summary`・`db-arrival-alert`)と開閉状態(`dbTodoOpenTiers`等)が固定。ホームの右欄には、表示先を引数にする最小の変更か、ホーム側の薄い描画(`todoRow`・ティア定義は再利用)が必要。

### 3. 「期限当日・超過 73件」と「#1118 ×3」
- 画面の「N件」は **booking_facilities の行数**(`b.items.length`)。代表REF#の3件も `items.slice(0,3)` の各行の予約番号をそのまま並べる(重複除去なし)。→ 1つの予約に期限超過の施設明細が複数あると、同じ予約番号が並び、件数も予約数より多くなる。**#1118 は、期限超過・未完了の施設明細が少なくとも3行ある**ことを示す(原因は重複バグではなく「件=施設明細の数」という数え方)。
- 73件の内訳(行数/重複除いた予約数)は、実データを見ていないため未確認。下記SQLをJUNさんが実行して確認する(読み取り専用)。
- 定義は変更しない。導入するバッジ(作業画面の「要対応 N」)は予約番号の重複を除く。

### 4. スマホ幅(375px)の今のナビ
- `@media(max-width:760px)`: サイドバーは `left:-210px` の画面外ドロワー。トップバーの☰で `.open` を切替え(`go()` 実行時にも閉じる)。背景のオーバーレイは無い。
- トップバーは `flex-wrap`・高さ自動、`.ver-badge`と`.tb-label`は非表示。
- 下部固定バーは `#db-mobile-bottombar`(ダッシュボードの検索・絞り込み)のみ。他に `#cc-ocr-save-bar`(クレカ明細OCR画面)、`#pt-batch-bar`/`#pt-save-bar`(取引先マスタ)が下部固定。→ 下に固定バーを増やさないほうがよい。
- 注意: `#db-filter-card`等のsticky(`top:50px`)は、50pxのトップバーの下に付く前提。上の移動バーをstickyで足すと位置が重なる(下記の確認事項)。
- 画面上部の赤/黄の固定バナー `#global-deadline-banner`(対応が必要な予約N件)と、期限前日の通知・緊急モーダルも既にある(`refreshGlobalDeadlineBanner`)。今回は変更しない。

### 確認事項(実装前にJUNさんへ)
1. 移動バーを sticky にすると既存の `top:50px` の固定カードと重なる。→ 案A: 移動バーはスクロールで流れる(固定しない) / 案B: トップバーの中に入れる。
2. 作業画面のバッジ「要対応 N」: 期限切れ(5分)後は、メモリ上の古い値のまま表示(新規取得なし)で良いか。それとも開いたときだけ同じ取得関数を呼ぶか。
3. N の「予約件数の重複除外」: 赤2種類を合わせた後で重複除外(同じ予約が両方に該当したら1件)で良いか。
4. 再読み込み時も常にホームから始まる(今のダッシュボードと同じ動き)で良いか。

### 残タスク
- 実装(A〜D)・検証・プレビュー確認はJUNさんの確認後。

---

## 「ホーム」を最初の画面にする(第1段階): 実装(2026-10-22)

### 確定内容
- 定数 `HOME_SCREEN_ENABLED`(メインscript、`currentPageId` の直後)。false で最初の画面は従来どおりダッシュボード、ホーム画面・移動バーは作られない(`HOME_BUTTONS_ENABLED` とは別・独立)。
- 最初の画面: `doLogin()`/`restoreSession()` が `go(initialPageId())`(true=home)。再読み込みは常にホームから。URLハッシュ等は従来どおり使わない。
- ホーム画面 `#pg-home`: 検索ボックス(REF#/Agent/Tour名/Tour Code。`filterBookingListGeneric` と同じ対象・判定、先頭20件)、左=ボタン(#238の生成処理 `hbFillHomeButtons` を再利用。全グループ開き・ダッシュボード含む・メール受信箱は「停止中」)、右=アラート欄。サイドバー先頭に「ホーム」項目を1つ追加(定数オフでは非表示)。
- 右欄の順序: 期限当日・超過(赤)→到着8日(赤)→期限前日/3日/7日→到着14日(黄)→21/30/60/90日(灰)→Agent未紐付け(灰)。期限の区分は主な数字=予約の件数(booking_idの重複除く)「N予約」+小さく「対応事項 M件」。到着日は従来どおり「N件」、Agent未紐付けは従来どおり「予約N件・請求書M件」。押すと既存の一覧表示(明細ごと)がその場で開く。
- 移動バー: ホーム以外の画面の既存トップバー内に「ホーム/Booking List/手配確定状況/ホテル予約管理」+右端に「要対応 N」。760px以下は「ホーム」と「要対応」だけ(バーは折り返さない・☰は残す)。バッジを押すと右から同じアラート欄が開く(閉じるボタン付き、z-index 90=モーダル(100)より下)。
- N = 赤2種類(期限当日・超過、到着8日以内)の予約件数。期限当日・超過は booking_id、到着は予約id で、合わせたあと重複を除く。
- スマホのホーム: 右欄は出さず、上に「要対応 N」の1行バッジ(押すと同じ欄が開く)→ボタン2列。
- データ: ダッシュボードと同じ取得関数・5分キャッシュを使う(ホームが `loadBookingListGeneric('db')` の取得を引き継ぐ)。新しいAPI・取得・保存(localStorage等)・DB変更なし。バッジは5分を過ぎても古い値のまま表示し、バッジを押して欄を開いたときだけ既存の取得関数を呼ぶ(5分以内なら取得なし)。
- ホームへの移動はアクセスログに記録しない(go()の条件に `id!=='home'`)。

### 変更した既存の行(index.html)
- `doLogin`/`restoreSession`: `go('dashboard')` → `go(initialPageId())`
- `pageNames`: 先頭に `home:'ホーム'`、`NEW_BOOKING_BTN_VISIBLE_PAGES` に `'home'`(ホームにも「+ New Booking」を出す)
- `go()`: ログ条件に `&& id!=='home'`、`homeOnGo(id)` の呼び出し1行を追加
- `renderDbArrivalAlert`: 区分分けを `computeDbArrivalBuckets()` に切り出し(計算内容は不変)、引数 `target` を追加(省略時は従来と同じ)
- `renderDbTodoSummaryFromCache`: 引数 `target` を追加(省略時は従来と同じ)、末尾に `homeOnTodoRendered()` 通知
- `renderDashboardTodoSummary`: 0件時の早期returnに通知1つ追加
- PR #238のブロック: CSSセレクタ `#db-home-card` → `.hb-scope`、生成処理を `fill()` に分離して `window.hbFillHomeButtons` として公開(`HOME_BUTTONS_ENABLED` の早期returnは公開の後ろへ移動)

### 検証(Playwright・同梱Chromium・ダミーデータ・Supabaseはスタブ)
- 管理者/スタッフ × PC1280/スマホ375: 88項目すべて合格。ボタン数 管理者24(23+ダッシュボード)・スタッフ18(17+ダッシュボード)、全ボタンがサイドバーと同じ遷移、375pxで横スクロールなし・ボタン2列・1行バッジ、右から開く欄、JSエラー0。
- ダミーの「期限当日・超過」: 明細5行・予約3件(#1118が3行)→右欄は「3予約/対応事項 5件」、バッジ N=3(赤2種を単純合算なら7)。
- 定数オフ: ダッシュボードのDOM(361要素)・数字・文言・カード位置・取得回数が変更前と同一。
- 取得回数(ホーム⇄ダッシュボード⇄ホーム…): 最初のホーム表示で Supabase直接4+API2、以降の行き来は増加0。Booking Listへの移動だけアクセスログ1件(ホームは記録なし)。

### 重なる箇所(整理は後で決める)
- 画面上部の赤/黄の固定バナー「対応が必要な予約がN件あります(うち緊急M件)」(施設明細の行数)と、ホーム右欄・バッジ(予約件数)は同じ内容を別の数え方で出す。
- 期限が近いときのログイン後の緊急モーダル・ブラウザ通知(1日1回)も重なる。
- ダッシュボード自体のアラート(今のまま)。

### 残タスク
- プレビューでの実画面確認(JUNさん。見る・ボタンで移動するだけ)。
- ダッシュボードのアラートの扱い、上部の固定バナーとの整理(別途決定)。第2段階(サイドバーを隠す)は未着手。
- #238 を先にマージするか、このPRだけをマージするかはJUNさんが決める。

---

## 「ホーム=ダッシュボードの代わり」+「サイドバーを基本は閉じる」: 手順0 調査(2026-10-22・読み取りのみ・コード変更なし)

### 1. ダッシュボード(#pg-dashboard)の全機能と、ホーム/Booking Listとの対応
| 機能 | ホーム | Booking List | 備考 |
|---|---|---|---|
| 通帳OCR(経理のみ・カメラ/ギャラリー/Excel・Word/貼り付け・銀行選択・結果の反映) | ない | ない | **ダッシュボードだけ**。`.accounting-only`(=`isAccountingUser()`: admin ロール、または admin@/kanri@kictravel.jp)。関数は `toggleDashboardBankbookOcr` 等(8548〜8990行)で、データは `bookingsListCache` のみ参照・書き込みは `bookingSalesApiCall('updatePayments')`。他画面に同等機能なし |
| 対応が必要な予約(4区分・明細・選択チェックボックス・操作バー・すべて表示) | ある(右欄。数え方が「N予約+対応事項M件」で違う) | ない | 選択・一括操作はホーム右欄からも同じに動く(ローカル検証: 選択→操作バー表示→確認ダイアログ→updateById→選択解除、ダッシュボード側にも同期) |
| Agentマスタ未紐付け | ある(右欄の1行。0件でも行を出す) | ない | ダッシュボードは0件ならカードごと非表示。一覧モーダルは同じ |
| 到着日アラート(8/14/21/30/60/90日) | ある(右欄。同じ描画処理) | ない | 同じ |
| ホームボタンカード(#238) | ある(ホーム左のボタン群に置き換わる) | ない | |
| 検索・絞り込み(検索/出発日From・To/Status/条件クリア/件数) | 検索だけ(日付・Statusなし。判定は同じ) | ある(同じ。+「このステータスを除く」) | ダッシュボード側に「除く」は無い |
| 予約一覧(同じ列・並べ替え・ページ送り・日付注記) | ない | ある(同じ処理 `loadBookingListGeneric/filterBookingListGeneric`、prefixだけ違う。並べ替え・ページの状態は別々) | |
| 一覧の進捗ドット・要確認チップ(PR #233) | ない | ある | #233は未マージだが、dbとblの両方に同じ変更が入る(prefix共通) |
| スマホの下部固定バー(「検索・絞り込み」シート+「＋ New Booking」)・「結果を見る(N件)」・絞り込み中ドット | ない | ない(検索カードを通常表示。New Bookingは上のバーの＋) | **ダッシュボードだけ**(UIの形)。機能自体(検索・絞り込み)はBooking Listにある |

- 「ダッシュボードにだけある機能」: ①通帳OCR(経理のみ)、②スマホ用の下部固定バーの検索シート方式(機能はBooking Listに同等あり)。
- 選択チェックボックス付き一覧がホーム右欄から開く場合の動き: ダッシュボードと同じに動く(上記)。

### 2. ダッシュボードへ移動・戻る処理の呼び出し箇所
- PR #239 で変えた分: `initialPageId()`(doLogin/restoreSessionから。ホームへ)、`go()` のログ条件(`id!=='home'`)、`pageNames.home`、`NEW_BOOKING_BTN_VISIBLE_PAGES` に home。
- まだ残っている分:
  1. サイドバー項目 `data-pg="dashboard" onclick="go('dashboard')"`(1194行)
  2. 対応リストページの「← ダッシュボードに戻る」ボタン `go('dashboard')`(5220行付近)
  3. 赤い固定バナーのトグル `toggleGlobalDeadlineBannerNav`: todoページ表示中のクリックで `go('dashboard')`(5302行付近)
  4. `go()` 内の `if(id==='dashboard') loadBookingListGeneric('db')`(4246行)
  5. #238のホームカード(ダッシュボード内)と、ホームボタン生成の `includeDashboard`(ダッシュボードのサイドバー項目が非表示なら自動的に出なくなる)
  6. コメントのみ: applyLoggedInUI(3962〜3965行)、loadBookingListGeneric(4574行)
- 提案: `go()` の先頭に「`id==='dashboard'` かつ `HOME_SCREEN_ENABLED` なら `id='home'`」の1行を足せば、2・3・(1が残っても)すべてホームへ向く。サイドバー項目は定数オンのとき非表示にする。

### 3. サイドバーを基本は閉じる(PC幅)
- 今: `.sb` は `position:sticky;height:100vh`(200px・`.app{display:flex}`)。760px以下は `.sb{position:fixed;left:-210px}` + `.open` で開くドロワー(☰=`.menu-btn`、`go()` が `open` を外す)。☰はPCでは `display:none`。
- 案: 定数オンのとき `body` にクラスを付け、PC幅(761px〜)で上のモバイル用ルールと同じ「固定・画面外・`.open`で表示」にする。☰は既存の `.menu-btn`(トップバー左端)をPCでも表示し、「すべての画面」の文字を添える(スマホは今のまま「☰」だけ)。開いたあと `go()` が閉じる(既存)。固定バナー表示中はサイドバーの上端をバナーの下にずらす。
- 大きさの目安: 追加のみで約30行(CSS約12行・JS約18行)。既存行の変更は0〜1行。
- 崩れの確認(試作CSSを注入して実測): 7画面(ホーム/Booking List/ツアー運行カレンダー/ホテル/取引先/New Booking/対応リスト)で、閉じた状態は content が左端0・幅1280(今は左200・幅1080)、横スクロールなし(scrollWidth=clientWidth)、固定トップバーの幅もページ幅と一致、検索カードのsticky位置(102px)は不変。`.sb` に依存する左オフセット・幅計算は他に無い。開いた状態は上に重なる(押し下げない)ので、開閉でコンテンツの配置は動かない。
- 注意: ログアウト・パスワード変更はサイドバーの下部にあるため、☰を押さないと見えなくなる。

### 4. ダッシュボードにだけある機能をホームに移す案
- 通帳OCR: 案A(推奨)=既存の通帳OCRカードのDOMをホームへ移動(IDそのまま・関数変更なし)し、ホームのボタン「📷 通帳OCR」で開閉。ボタンとカードは `isAccountingUser()` の人だけに表示(今と同じ判定・`.accounting-only`)。案B=別の画面にする(関数・ID整理が必要で大きい)。
- 下部固定バーの検索シート: 移さない案(Booking Listで代替)を推奨。移す場合はホームの検索を拡張する必要があり、変更が大きい。

### 確認事項
1. 通帳OCRの置き場所(案A/案B)。
2. スマホの下部固定バー(検索・絞り込みシート)は、ホームに移さず廃止(Booking Listで代替)でよいか。
3. 対応リストページの「← ダッシュボードに戻る」を「← ホームに戻る」に変えてよいか(遷移先はどちらにしてもホーム)。
4. PCで開いたサイドバーの外側(暗い背景)をクリックしたら閉じる背景を足してよいか(スマホは今のまま背景なし)。

---

## 「ホーム=ダッシュボードの代わり」+「サイドバーを基本は閉じる」: 実装(2026-10-22・PR #239に追加コミット)

### JUNさんの回答(調査への「はい」=推奨案どおり)
通帳OCR=案A(カードをホームへ移動+ホームのボタン)、スマホの下部固定バー=ホームに移さず廃止(Booking Listで代替。ダッシュボード自体を使わなくなるため到達しない)、対応リストの戻るボタン=「← ホームに戻る」、PCのサイドバーに外側クリックで閉じる背景を追加。

### 内容(すべて HOME_SCREEN_ENABLED=true のときだけ。false で従来のダッシュボード入口・サイドバーに戻る)
- `go()` の先頭: `id==='dashboard'` ならホームへ(サイドバー・対応リストの戻るボタン・赤バナー・その他すべて)。ダッシュボードのコード・DOMは削除せず残す(到達しない)。サイドバーの「ダッシュボード」項目は非表示、ホームのボタンからも消える。
- 通帳OCR: `#pg-dashboard` 内のカード(`.accounting-only`)をDOMごとホームへ移動(ID・関数は変更なし)。ホームの左のボタン群の先頭に「経理 ACCOUNTING」の「📷 通帳OCR」ボタン(`isAccountingUser()` の人だけ=admin ロール・admin@/kanri@)。押すとカードが開閉(閉じている間はカードを出さない)。
- サイドバー: PC幅(761px〜)で `.sb` を固定・画面外・`.open` で重ねて開く方式に。上のバーの既存☰(`.menu-btn`)をPCでも表示し「すべての画面」を添える。開くと暗い背景(PCのみ・クリックで閉じる)。固定バナー表示中は上端をバナーの下へ。スマホ(760px以下)は従来どおり(背景なし・文字なし)。開閉状態は保存しない(開くたび閉じた状態から)。画面を移動すると既存の `go()` が閉じる。
- 対応リストページの「← ダッシュボードに戻る」→ オン時は「← ホームに戻る」。

### 変更した既存の行(index.html)
- `go()`: 先頭に2行追加(`id==='dashboard'`→`home`)
- 対応リストの戻るボタン1行: 文言を定数で切替
- (追加のみ: ホームのブロックにCSS・JS)

### 検証(Playwright・ダミーデータ・Supabaseスタブ。管理者/スタッフ/経理スタッフ × PC1280/スマホ375)
- 旧テスト(ホーム画面・移動バー・アラート・全ボタン遷移・横スクロール)80項目+新規46項目、すべて合格・JSエラー0。
- サイドバー: 最初は閉じている/☰で開閉/PCは背景クリックで閉じる/移動後は閉じる/スマホは従来どおり。閉じた状態のホーム・上のバー・右欄は崩れない(横スクロールなし、PCの content は左端0)。
- 通帳OCR: 管理者・経理(kanri@)にだけボタン表示、スタッフは非表示(カードも出ない)。ボタンで開閉・銀行選択(6件)・375pxで横スクロールなし。
- `go('dashboard')`・赤バナー(対応リスト表示中)・対応リストの戻るボタン: すべてホームへ(ダッシュボードは表示されない)。
- 定数オフ: ダッシュボードが最初の画面、サイドバーはPCで開いたまま(sticky)・「ダッシュボード」項目あり・☰はPCで非表示、通帳OCRはダッシュボードに残る、#pg-dashboard のDOM要素数361で変更前と同一。
- 取得回数(ホーム⇄「ダッシュボード」⇄ホーム): 最初のホーム表示でSupabase直接4+API2、以降の行き来は増加0。ホームはアクセスログに記録されない。

---

## ホームを見つけやすくする + 日本語・英語併記 + バッジ名の整理(2026-10-23・見え方・文字だけ)

### 前提
- PR #233 は main にマージ済み(c736899)。最新の main から、環境指定のブランチ名 `claude/trusting-franklin-rxs5ss` を作り直して作業(古い71aa497の履歴は積まない)。

### 内容(HOME_SCREEN_ENABLED オンのときだけ。オフで従来の表示)
- 上のバーの一番左に「🏠 ホーム / Home」(青の塗りつぶし)。☰より左。全画面・スマホ(760px以下)でも一番左に残る。ホーム画面では「押された状態」(濃い青・押し込み表示・`aria-current=page`)。
- 日本語を大きく・英語を小さくの2段(`.hn-ja`/`.hn-en`): 上のバーの「ホーム / Home」「Booking List」(サイドバーに英語名なしのため1段)「手配確定状況 / Arrangement Status」「ホテル予約管理 / Hotels」(英語名はサイドバーの `.sb-en` から読み取り)、☰「すべての画面 / All Pages」(PCのみ文字あり。スマホは☰だけ)、ホーム画面の見出し「ホーム / Home」、右の欄・右から開く欄の見出し「要対応・アラート / Alerts」。
- 名前の変更(文字だけ。数え方・押したときの動きは変更なし):
  - Booking Listのチップ「要確認 N件」→「進捗に問題 N件 / Progress Issues」(取得失敗・読み込み中の表示も同じ名前に。オフのときは従来の「要確認 N件」)
  - 上のバーのバッジ「要対応 N」→「期限・到着 N / Deadlines」(ホームのスマホ1行バッジも同じ)
  - 赤/黄の固定バナー「対応が必要な予約が○件」・一覧の「要確認」列の見出しは変更しない。
- 中間幅(761〜1100px)は、はみ出し防止のため、よく使う3画面のボタンを隠す(ホーム・☰・バッジは残る)。
- PCのバーの高さは50pxのまま(2段にしても収まるため、`top:50px` の固定位置・`reserved = 50 + ...` の計算は変更不要)。

### 名前に関する全検索結果(「要確認」「要対応」)
- 変更した: チップ(index.html 5715〜5716行付近の3表示: 件数/取得失敗/読み込み中)、バッジ(上のバー・ホームのスマホ1行バッジ・読み込み中の「…」)。
- 変更しない(同じ意味ではない/指示で除外): 一覧の「要確認」列の見出し(4556・5578行)、`BookingProgress.STATE_LABELS.alert='要確認'` と、金額を伏せるロールの段階の文言「要確認」(public/js/booking-progress.js 30/101/105/113行。丸のツールチップ・ステッパーの状態名)、ファイナルチェックの「要確認」見出し・候補(要確認)・メール一覧の「要確認」バッジ等(別機能)、ホームの右の欄の見出し「要対応・アラート」(指示で維持)、ステータス色のコメント(3544〜3545行)。
- 上のバーが出ない画面: ログイン画面、モーダル(27個。上のバーの上に重なる)、印刷プレビューの別ウィンドウ(window.open/document.write)、`guide.html`(別アプリ)。全画面表示のモードは無い。変更はしていない。
- 日本語・英語の併記がまだ無い主な画面(上のバーのタイトル): 日本語のみ=ツアー運行カレンダー・見積もり・ガイド精算一覧・ガイド管理・入出金管理・クレジットカード明細・アカウント管理・アクセスログ・エラーログ・カード名義人管理・取引先マスタ・取引先マスタ(Agent)・新幹線手配・請求書読み取り・メール受信箱・観光地予約管理・対応が必要な予約・手配確定状況・レストラン重複確認・ホテル予約管理。英語のみ=New Booking・Booking List・Invoice。GROSS / 粗利管理は併記済み。
- 気づいた点(変更なし): スマホ(375px)では、上のバーのホームボタン追加で画面名が短く切れる(例「Book…」)。画面名は各画面の見出しにも出ている。

### 検証(Playwright・ダミーデータ・進捗の集計は本物のサーバー処理)
- 管理者/スタッフ × PC1280×800/スマホ375×812: 63項目すべて合格・JSエラー0。全作業画面(サイドバーの全項目+ホーム)でホームボタンが一番左・「ホーム Home」・併記の文字が切れない・横スクロールなし。スマホは「ホーム」「☰」「期限・到着」が1行(バー高さ66px以下)。ホームボタンで実クリックでホームへ。古い名前(要確認 N件/要対応 N)が画面に無い。数字は従来どおり(バッジ3・チップ1)、「進捗に問題」を押す絞り込みも従来どおり。PCで固定の検索カードがバーと重ならない。中間幅(1024/820/768)でも横スクロールなし。
- 定数オフ: 最初の画面・バーの文字/DOM数/高さ・チップ文言が、変更前の定数オフと同一。
- スクリーンショット(scratchpad/shots): before_*(変更前)・after_*(変更後)・off_*(定数オフ)。

---

## ホーム画面の重複解消 + 対応が必要な予約の一覧で完了済みを折りたたむ + ユーザーメニュー(ログアウト)(2026-10-23・見え方だけ)

### 前提
- PR #240 は main にマージ済み(06964a2)。最新の main から、新しいブランチ `claude/home-todo-completed-fold` を作って作業(古い `claude/trusting-franklin-rxs5ss` は再利用しない。環境の指定名ではなく、JUNさんの指示で新しい名前にした)。

### 1. ホーム画面の青い「ホーム / Home」ボタンを非表示
- `body:not(.home-nav-on) #home-nav-home{display:none}`(ホーム画面だけ非表示。他の全画面では一番左に出る)。ホーム画面では☰の右に見出し「ホーム / Home」が並ぶ。HOME_SCREEN_ENABLED オフではボタン自体が作られない。

### 2. 「対応が必要な予約」の一覧(pg-todo)で完了済みを隠す
- 「すべて表示（全N件）」で開く一覧は **対応リストページ `#pg-todo`(renderTodoPageFromCache)の1か所だけ**。入口はすべて `go('todo')`: ホーム右欄(PC)・上のバッジから開く右の欄・ホームのスマホ1行バッジの欄(いずれも `renderAlertsInto` の「対応事項をすべて表示」)、ダッシュボードの「すべて表示」ボタン(`renderDbTodoSummaryFromCache`。ダッシュボードはホームへ向くため通常は到達しない)、赤/黄の固定バナー(`toggleGlobalDeadlineBannerNav`)、緊急モーダルの「一覧で確認する」。同じ処理を共有しているので、1か所の変更で全入口にそろう。完了済みの行が出るのはこのページだけ(ホーム右欄・ダッシュボードの区分別の一覧は未完了のみ)。
- `TODO_HIDE_COMPLETED`(初期値 true)。オン: 初めは未完了の行だけ(対応期限日の古い順)、見出し「未完了 N件（M予約）／ 完了済み K件」(Mはbooking_idの重複を除く)、下に折りたたみ「▼ 完了済み K件を表示 / Show Completed」(押すと開く/「隠す / Hide Completed」)。開閉は保存しない(別の画面へ移動すると閉じる=`go()`でリセット)。「✓ 完了」「完了を取り消す」「✕ 削除」は完了済みの折りたたみの中だけ(ボタンの処理は変更なし)。選択→まとめて操作は従来どおり。
- 表の見た目(オンのときだけ): 列幅 4/7/30/27/11/11/10%(ツアー名43%・施設名20%だった)、「残り」を右寄せ、完了済みの表は最後の列を広く(25%)。オフは今までの列幅・中央寄せ・完了済みが混ざる。
- 変更した既存の行: `TODO_TABLE_COLGROUP_HTML`/`TODO_TABLE_THEAD_HTML` の定義(フラグで切替)、`todoRow` の「残り」セルの寄せ、`go()` に `todoCompletedOpen=false` の1行、`renderTodoPageFromCache` に分岐を追加。

### 3. 調査(読み取りのみ): 対応期限日はどこで決まるか
- **コード上は、すべて人が入力する値**。自動計算(利用日から施設ごとの規則で算出)・取込み処理で付ける処理は、index.html・api/・scripts/・email-automation/・parking-automation/・arrangement_excel.js のどこにも無い(`deadline_date` の代入箇所を全検索)。
  - 入力場所: 予約詳細の「観光施設・バス駐車場等」表の「期限日」の日付欄(17695行付近 `onchange="bdFacilityItems[i].deadline_date=this.value"`)。新しい行の初期値は空(16313・17946行付近)。保存は `sanitizeDateField(it.deadline_date)`(17997行付近)。
  - 一括変更: 対応リストの「対応期限日を変更」(選択した行に同じ日付を設定。`runTodoDeadlineChange`)。
  - コピー: 「REF#からコピー」(`ARR_COPY_CONFIG.fac`)は、コピー元の `date`(利用日)と `deadline_date` を**そのまま**コピーする(日付をずらさない)。
  - 完了: 期限日がある行を保存するとき、ステータスが手配OK/FNL済/予約不要なら自動で完了扱いにする処理がある(17983行付近の `autoComplete`。期限日の値は変えない)。
- 結論: 「箱根ロープウェイ(往復)は利用日のちょうど1年前、スカイツリー・箱根海賊船は約6か月前」という違いは、**コードの規則ではなく、入力されたデータ(担当者の手入力、またはREF#からのコピー・一括変更の結果)による**。施設ごとの規則を持つマスタ列・計算は無い(business_partners 側にも期限日用の列は見つからなかった)。
- 実データで確認するための読み取り専用SQL(SELECTのみ。SupabaseのSQL Editorに貼って実行):
  1. 施設ごとの「利用日−対応期限日」の日数の種類と件数(施設ごとに1つの日数なら規則的な運用、ばらつくなら手入力):
```sql
select facility_name,
       count(*) as 件数,
       min(date::date - deadline_date::date) as 最小日数,
       max(date::date - deadline_date::date) as 最大日数,
       count(distinct (date::date - deadline_date::date)) as 日数の種類
from booking_facilities
where deadline_date is not null and date is not null
group by facility_name
order by 件数 desc
limit 50;
```
  2. 3施設の中身(予約番号つき):
```sql
select b.ref_no, f.facility_name, f.date, f.deadline_date,
       (f.date::date - f.deadline_date::date) as 何日前, f.status, f.deadline_completed
from booking_facilities f
left join bookings b on b.id = f.booking_id
where f.deadline_date is not null
  and (f.facility_name ilike '%ロープウェイ%' or f.facility_name ilike '%スカイツリー%' or f.facility_name ilike '%海賊船%')
order by f.facility_name, f.date
limit 100;
```
  3. ちょうど1年前(365/366日前)になっている行の一覧:
```sql
select b.ref_no, f.facility_name, f.date, f.deadline_date, (f.date::date - f.deadline_date::date) as 何日前
from booking_facilities f
left join bookings b on b.id = f.booking_id
where f.deadline_date is not null and f.date is not null
  and (f.date::date - f.deadline_date::date) in (365, 366)
order by f.date
limit 100;
```

### 4. ユーザーのアイコンとメニュー(ログアウト)(JUNさんの追加依頼)
- 調査: ログアウトは、サイドバー最下部 `.sb-user` 内の `<div class="sb-logout" onclick="doLogout()">`。`doLogout()`(ログ記録・currentUser=null・`clearSession()`・ログイン画面表示)。ユーザー名・ロールは同じ最下部の `#sb-avatar`/`#sb-uname`/`#sb-urole`(`applyLoggedInUI` が設定)。サイドバーを閉じて普段見えなくなったもの: 上部=ロゴ「✈ KIC Travel Core」「Ver 2.0 · INBOUND」、下部=アバター・ユーザー名・ロール・「🔑 パスワード変更」・「ログアウト」(今回は、ログアウトとユーザー名だけ上のバーへ。ロゴ・パスワード変更は未対応=別途決める)。
- 実装: 上のバーの右端(最右)にユーザーのアイコン(イニシャルの丸)。押すと小メニュー「ユーザー名（ロール）」「ログアウト / Logout」(2段)。外を押す/Esc/画面移動/リサイズで閉じる(保存しない)。`homeLogout()` は閉じてから既存の `doLogout()` をそのまま呼ぶ。サイドバーのログアウトは残している。HOME_SCREEN_ENABLED オフでは出ない。
- スマホ375px: アイコンのみ。☰・ホーム/Home・期限・到着 N/Deadlines・アイコン(と、管理者の📦・＋)が1行に収まった(バッジは数字だけにしなくて済んだ)。ただし画面名は短く切れる(「B.」程度。ホームでは見出しがあるため問題なし)。
- **発見した不具合(main 06964a2 に存在)**: PCでサイドバーを開いた状態でサイドバー内の「ログアウト」を押すと、`.open` が外れないため、暗い背景(`#home-sb-backdrop`)がログイン画面の上に残り、ログイン入力欄が押せなくなる(再読み込みするまで)。ログイン画面に戻った時に、開いた欄・背景・メニューを閉じる処理(`#screen-app` の表示監視)を足して解消した。

---

## Booking List を「今後」と「過去」に分け、今後の一覧に手配の問題だけを出す(2026-10-23・見え方・並べ方だけ)

### 前提(①)
- PR #241 は main にマージ済み(b7c1451)。main のデプロイは success(Ready)。サイドバーを開いてログアウトすると暗い背景が残る不具合は、本番で直った。
- 新しいブランチ `claude/booking-list-tabs` を、最新の main(b7c1451)から作成。

### 内容
- 定数 `BOOKING_LIST_TABS_ENABLED`(初期値 true)。`BL_TABS_ACTIVE = BOOKING_LIST_TABS_ENABLED && HOME_SCREEN_ENABLED`。オフ(どちらでも)で従来の一覧(タブなし・「進捗に問題 N件」のチップ・進捗列は全予約)に戻る。対象は Booking List(prefix `bl`)だけ。ダッシュボード(`db`)の動きは変えない。
- タブ「今後 N / Upcoming」「過去 N / Past」「すべて N / All」(日本語を大きく・英語を小さく)。初めは「今後」。状態は保存しない(`loadBookingListGeneric('bl')` が開くたびに「今後」へ)。件数は、日付(出発日FROM/TO)・STATUS で絞った結果に対する件数(検索中は検索語で絞った結果)。
- 定義(実コード `blBookingCategory`): 基準日=帰着日(Out)、空なら出発日(In)。今日は日本時間(`todayJst()`=`toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'})`)。`cancelled`(`normalizeStatus`で大文字小文字を区別しない)は「今後」「過去」に含めない。今後=基準日≥今日、過去=基準日<今日、「すべて」=従来と同じ全件(cancelled含む)。**Out も In も空の予約は「今後」「過去」のどちらにも入らず、「すべて」だけに出る**。日付・STATUS の絞り込みはタブと AND。
- 検索語が入ると、タブに関係なく全予約から探す(実質「すべて」。cancelledも探せる)。一覧の上に「🔍 全ての予約から検索中 / Searching All」。タブのボタンは無効表示。検索を消すと元のタブに戻る。ホームの検索ボックスは、一覧へ移動せずホーム内に結果を出す方式で、もともと全予約から探す(今回は変更なし)。
- 「今後」のタブだけ: 「進捗」の列(丸5つ。入金の丸も従来どおり)と、「手配の問題 / Arrangement」の列(旧「要確認」列。手配の段階=ホテル・バスのNG回答・キャンセルの理由だけ。入金超過・売上0円で入金あり・売上マイナスは出さない)、チップ「手配に問題 N件 / Arrangement Issues」(N=手配の問題がある「今後」の予約数。`hasArrangementProblem`=進捗結果の reasons のうち stage='arrangement')。「過去」「すべて」(検索中を含む)は、進捗列・手配の問題列・チップを出さず、従来の列幅(進捗列の追加前)で表示。
- 変更していない: `public/js/booking-progress.js`・`api/table-crud.js progressSummary`(入金の判定)、予約詳細のステッパー(入金の丸も出す)、「期限・到着 N / Deadlines」バッジ、ホームの右の欄、到着日アラート、対応が必要な予約の計算、赤/黄の固定バナー。

### 影響範囲(他の機能と共有している処理)
- `filterBookingListGeneric`(bl/db共用): タブの絞り込み・件数・列の出し分けを `blTabActive('bl')` のときだけ実行。`db` と定数オフは従来のまま。
- `renderListHeader`(共用): 同じく `bl` のタブ有効時だけ列を切替(「手配の問題 / Arrangement」の見出し、進捗列なしの列幅)。
- `updateProgressChips`(共用): `bl` のタブ有効時だけ、「今後」以外は空、チップ名を「手配に問題 / Arrangement Issues」に。
- `progressAttentionHtml(b, arrOnly)`(新しい省略可の引数。省略時は従来と同じ)。
- `loadBookingListGeneric`(共用): `bl` のタブ有効時にタブを「今後」へ戻す1行を追加。
- `listState.bl` に `tab` を追加。HTMLは `#bl-tabs`・`#bl-search-note` を追加。CSS `.bl-tab`/`.bl-tabs` を追加。

### 調査: 「今後」を埋める可能性(出発日が極端に先の予約)
- 実データは見られないため、読み取り専用SELECTを用意した(チャット本文に掲載)。

### 検証(Playwright・ダミーデータ・進捗の集計は本物のサーバー処理)
- ダミー12件(今後6=帰着日が空・出発日が空・帰着日が今日・2031年先の予約を含む/過去3/cancelled2/日付なし1)。管理者/スタッフ × PC1280/スマホ375で72項目合格(タブの件数・一覧が期待値と一致、検索、STATUS・日付とのAND、開き直しで「今後」、定数オフ2種)。

### 追加(PR #242への小さな修正)
- Booking Listのタブ有効時(`BL_TABS_ACTIVE`)、チップ行の「すべて」を出さない(タブの「すべて」と紛らわしいため)。「手配に問題 N件 / Arrangement Issues」のチップはスイッチ(押すと絞り込み、もう一度押すと解除。押されている間は濃い赤 `.pg-chip-on`・`aria-pressed`)。タブを切り替えると解除、検索中・過去・すべてはチップなし。`BOOKING_LIST_TABS_ENABLED` オフで従来の「すべて」+「進捗に問題 N件」に戻る。
- 検証: 管理者/スタッフ × PC1280/スマホ375 で96項目合格(押す・もう一度押して解除・タブ切替・検索中・定数オフ)。

---

## ユーザーメニューを押すものだと分かるようにする(2026-10-23・見え方だけ)
- PR #242 はマージ済み(04940ac)。main のデプロイは success(Ready)。最新の main から新しいブランチ `claude/user-menu-affordance` で作業(別のPR)。
- PC幅(761px〜): 上のバー右端の丸(イニシャル)の右に小さな▾を付け、丸と▾を1つのボタン(`#home-user-btn` の中の `.hu-ini` と `.hu-caret`)にした。どちらを押してもメニューが開く。`title`/`aria-label`=「ユーザーメニュー / User Menu」。マウスを乗せると青く塗りつぶす。スマホ幅(760px以下)は丸だけ(▾は `display:none`、ボタン幅34px)。メニューの中身・ログアウト(`homeLogout`→既存の `doLogout()`)は変更なし。HOME_SCREEN_ENABLED オフでは出ない。
- 検証(Playwright・ダミーデータ): 管理者/スタッフ × PC1280/スマホ375で35項目合格(▾の有無、丸・▾のどちらでも開く、メニューの中身、ログアウト→ログイン画面・保存されたログイン情報が消える、スマホ1行、重ならない、横スクロールなし、定数オフ)。既存のユーザーメニュー検査43項目も合格。

---

## アラートの対象から箱根ロープウェイを外す(2026-10-23・見え方・数え方だけ。データは変更しない)
- JUNさんの決定: 箱根ロープウェイは、予約はあった方がいいが緊急ではないため、「対応が必要な予約」のアラートから外す。調査結果: 箱根ロープウェイ(往復)の対応期限日は全21件が利用日のちょうど365日前(人の入力)で、利用日が2027年の予約が「期限超過200日以上」として赤く並んでいた。
- 定数 `TODO_EXCLUDED_FACILITIES`(初期値 `['箱根ロープウェイ']`)。施設名にこの文字列が含まれていれば除外(NFKCにそろえて比較。「箱根ロープウェイ（往復）」「箱根ロープウェイ 往復」などにも当てはまる)。`[]` にすると今までの表示に戻る。他の施設は配列に名前を足す(画面からの設定は無い)。
- 実装は `fetchAllFacilityDeadlineItems()` の絞り込み(取消・キャンセル施設の除外と同じ箇所)に1行。**アラートの元データを読む箇所は、この1か所だけ**(`booking_facilities` の期限日の取得は他に無い)。次の全表示が、同じ読み込み・同じキャッシュ(`facilityDeadlineItemsCache`)から作られるため、1か所でそろう: ホームの右の欄(`buildFacilityDeadlineResult(facilityDeadlineItemsCache,7)`)、上のバーの「期限・到着 N」と右から開く欄(同じ)、赤/黄の固定バナー・緊急モーダル・ブラウザ通知(`refreshGlobalDeadlineBanner(prefetched)`)、対応リストページ(`renderTodoPage`、完了済みの折りたたみの中も)、ダッシュボード(`renderDashboardTodoSummary`、非表示だがコードは残っている)。到着日アラートは別(予約の到着日から数える。変更なし)。
- データは変更しない: `booking_facilities` の行・対応期限日・完了のチェックは触らない。予約詳細の「観光施設・バス駐車場等」の表や観光地予約管理には、今までどおり出る。
- 検証(Playwright・ダミーデータ・ロープウェイ3行を追加=期限超過(-200日)・3日後・完了済み、予約1件を追加): 管理者/スタッフ × PC1280/スマホ375で45項目合格。除外の前後(ダミー): 右の欄の期限当日・超過 4予約/6件 → 3予約/5件、期限3日以内 2予約/2件 → 1予約/1件、バッジ「期限・到着」4 → 3、バナー「10件（うち緊急7件）」→「8件（うち緊急6件）」、対応リスト「未完了 10件（6予約）／ 完了済み 2件」→「未完了 8件（5予約）／ 完了済み 1件」。右の欄・上のバーの欄・バッジ・バナー・対応リスト・緊急モーダルがすべて同じ数字。まとめて操作は従来どおり。定数 `[]` で今までの数字に戻る。ダッシュボード側(HOME_SCREEN_ENABLED オフの表示)も同じ(5件/6件、全8件/全10件)。
- 本番での確認(JUNさん): ホームの右の欄の「期限当日・超過」の「N予約」「対応事項 M件」が、マージ前より減る(箱根ロープウェイの分)。赤/黄の固定バナーの件数も同じ分だけ減る。
## PC幅の上のバーに「ログアウト」のボタンを直接出す(2026-10-23・見え方だけ)
- PR #243 はマージ済み(a408527)。最新の main から新しいブランチ `claude/topbar-logout-button`。
- PC幅(761px〜): 上のバー右端(バックアップ・New Booking・「期限・到着 N」の右)に、「ユーザー名（ロール）」(`.hu-name`)と、赤い枠の「ログアウト / Logout」ボタン(`.hu-logout`、2段)を直接出す(`#home-user-inline`)。丸(`#home-user-btn`)はPC幅では出さない(二重にしない)。
- ログアウトを押すと、すぐログアウトせず確認ダイアログ「ログアウトしますか？ / Log out?」(「いいえ / No」「はい / Yes」。初めのフォーカスは「いいえ」。Esc・背景クリックで閉じる)。「はい」で今までの `doLogout()` を呼ぶ(`homeConfirmLogout`)。ログイン画面に戻った時は、確認・メニュー・右の欄も閉じる(`#screen-app` の表示監視)。
- スマホ幅(760px以下): 従来どおり丸→メニュー(ユーザー名（ロール）・ログアウト)。このメニューのログアウトにも同じ確認を出す(`homeLogout` → `homeAskLogout`)。サイドバー内のログアウトは変更なし(確認なし)。HOME_SCREEN_ENABLED オフでは出ない。
- 狭いPC幅の調整: 1400px以下は「KIC Ver 2.0」を隠す、1100px以下は名前の文字を隠す(ボタンは残す。名前は title)、900px以下は「バックアップ」「New Booking」の文字を隠す、761〜768px も折り返さない(`flex-wrap:nowrap`)。
- 検証(Playwright・ダミーデータ): 管理者/スタッフ × PC1280/スマホ375、中間幅(1101/1024/900/820/768/761)で42項目合格(表示・重ならない・1行・横スクロールなし、確認→いいえ/Esc/はい、ログイン画面で入力欄が押せる、再読み込みで自動ログインしない、サイドバー内ログアウトは確認なし、定数オフ)。

---

## 幅が狭いPCでも、上のバーのユーザー名を隠さない(2026-10-23・見え方だけ)
- 背景: 同じパソコンを複数の人が使うため、誰でログインしているかが常に見えている必要がある(JUNさんの回答)。PR #244 で、1100px以下は名前の文字を隠していたのをやめた。
- PC幅(761px以上): 「ユーザー名（ロール）」(`.hu-name`)は、どの幅でも隠さない。幅の上限(`max-width`: 〜1100px=150px、〜900px=120px、それ以上=170px)を決め、長いときは「…」で切る。全体(名前とロール)は title で見える。
- 幅が狭くなったときに省く順番: 1.「KIC Ver 2.0」(1400px以下)→ 2.「バックアップ」「New Booking」の文字(1100px以下。アイコンだけ。title は既存)→ 3.「ログアウト / Logout」の文字(900px以下。赤い枠の ⏻ アイコンだけ・title「ログアウト / Logout」)。名前とログアウトのボタンは、761px以上のどの幅でも必ず出る。スマホ幅(760px以下)・ログアウトの確認・`HOME_SCREEN_ENABLED` オフは変更なし。
- ログイン保持(15分で自動復元)は変更なし。
- 検証(Playwright・ダミーデータ・長い名前=日本語19字): 管理者/スタッフ × 1920/1400/1280/1100/1024/900/820/768/761px で92項目合格(名前とログアウトが出る、折り返さず・重ならず・横スクロールなし、長い名前は「…」で切れ title に全体、省く順番、ログアウト→確認→いいえ/はい)。
