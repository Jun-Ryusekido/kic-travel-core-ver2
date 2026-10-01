# SESSION_NOTES

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

## PR #221 を main にマージ(2026-10-01。JUNの指示。SQL実行なし・データ書き換えなし)
- マージ: **コミット 7c60475**(`Merge pull request #221 from Jun-Ryusekido/claude/fix-facility-qty-local-expense`)、**2026-10-01 05:35:17 UTC(日本時間 14:35)**。方法=通常のマージコミット(リポジトリの既定。過去の #219 等と同じ)。
  マージ内容: head da1f931(8コミット)、変更は index.html(コード)と SESSION_NOTES.md のみ(+153/-11)。SQLなし。マージ元ブランチ(base)は d326a3c のまま動いていなかった。
- マージ前の確認(いずれも満たしていた): mergeable_state=clean / draft でない / チェック「Vercel Preview Comments」= success / Vercel の最新コメントは Ready(Preview: https://kic-travel-core-ver2-git-claude-267881-jun-ryusekido-s-projects.vercel.app 、head da1f931)/ ステータス「Vercel」= success(Deployment has completed)。head の SHA を固定してマージ(意図しないコミットの混入なし)。
- **本番デプロイの完了は、この環境からは確認できない**: 本番 https://kic-travel-core-ver2.vercel.app への接続はプロキシに 403 で遮断され、GitHub から取れるのは PR の head(da1f931)のステータスまで(main のコミット 7c60475 のデプロイ状態は取得手段が無い)。
  なお main の内容は head da1f931 と同一(base が動いていないため、マージコミットの木は同じ)で、その Preview は成功している。**JUNが Vercel の Deployments(Production、コミット 7c60475)で Ready を確認し、画面の「観光施設合計(金額×人数)」の表示で反映を確認すること。**
- 戻す場合: GitHub の PR #221 ページの「Revert」ボタン(revert の PR が作られる。コマンドなら `git revert -m 1 7c60475`)。revert は index.html の表示・生成ロジックを元に戻すだけ(DB・既存の仮払い行は触らない)。
### 本番での動作確認(JUNさん用。順に実行。URL: https://kic-travel-core-ver2.vercel.app 。本番DBなのでテスト予約を使い、確認後に削除する)
1. ブラウザを強制再読み込み(Ctrl+Shift+R)。予約台帳(Booking List)でテスト予約を作る(または既存のテスト予約を開く)。
2. 観光施設タブ(「観光施設・バス駐車場等」)に 26名・¥620・現地払い / 26名・¥800・全旅クーポン の2行を入れる → 表の下に「観光施設合計(金額×人数): ¥36,920 (うち現地払い ¥16,120)」。
3. 2行目の支払方法を「現地払い」に変える → 「(うち現地払い ¥36,920)」(全体は ¥36,920 のまま)。「全旅クーポン」に戻すと ¥16,120 に戻る。人数欄・金額欄を変えても、その場で合計が変わる(入力欄のフォーカスが外れない)。
4. 「仮払い一覧表」の見出しを開き「＋ 手配内容から概算行を生成」→ 確認ダイアログで 1行目 ¥16,120(数量26・単価620)、2行目 ¥0(全旅クーポン)を確認して OK → 一覧の観光施設の行の金額合計が、手順2の「(うち現地払い ¥X)」と一致すること。右上の「保存」。
5. 人数が空・0 の現地払いの行は数量1で生成される(従来どおり)。レストラン・ホテル等の行の数量は 1 のまま(変更なし)。
6. 既存の予約(#1138 など)の仮払い行を直す場合: 観光施設由来の行(入場料/駐車場代)の右端「×」で削除 → 「＋ 手配内容から概算行を生成」→「保存」。手で書き換えた行は消えるので注意。確認後、テスト予約は削除する。
### 残り・注意
- **PR #220(claude/magical-ride-6phzj3)は、main(7c60475)との手元の試算で SESSION_NOTES.md が競合する**(index.html は自動で統合できる。GitHub の mergeable は再計算中=unknown)。#220 側のブランチを main に追従させる(SESSION_NOTES.md の競合を解消)必要がある。別セッションのブランチなので、このセッションでは触っていない。
- claude/jolly-bohr-wsq2w8 の `isLocalPayPaymentMethod`(現地払いの「追加」ボタンのグレー化)と、main に入った `isLocalPaymentMethod`(同じ判定の別名)の統合が必要(そのブランチを main に入れるとき)。
- 本番デプロイ・実機確認の結果は未確認(上記)。RLS/REVOKE のSQLは今回も一切実行していない。

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

## バッチ2 実装計画(2026-09-25報告、未着手)
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
