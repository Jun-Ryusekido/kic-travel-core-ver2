# セッション調査メモ(Invoice住所欄空欄 / Invoice発行ユニーク制約違反)

作成日: 2026-09-03 (JST)。修正はまだ行っていない。全て**実際のコード確認**と**本番Supabaseへの実クエリ**(anonキー経由REST API、読み取りのみ)に基づく。書き込み(INSERT/UPDATE/DELETE)は一切行っていない。

## 背景・報告された事象

1. **Invoice住所欄が空欄になる不具合**: Agentマスタ「Kulin Kumar Holidays Pvt Ltd」に住所が登録済みだが、Invoice(INVOICE No. 1069)のプレビューで住所欄が「住所を入力...」のプレースホルダーのまま空欄。
2. **Invoice発行時のユニーク制約違反**: Invoice一覧の「JPY発行」ボタン押下で `duplicate key value violates unique constraint "invoices_invoice_no_key"` エラー。

---

## 調査1: Invoice住所欄が空欄になる不具合 — 確定した原因

### 実際に確認したコード
`index.html` の `showInvoicePreview()` 関数、28028〜28043行目:
```js
const billToName = inv.agent_name || booking.agent_name || '';
let agentAddress = '';
if(inv.agent_id){
  const {data: agentRow} = await sb.from('agents').select('address').eq('id', inv.agent_id).maybeSingle();
  if(agentRow) agentAddress = agentRow.address || '';
}else if(billToName){
  const {data: agentRows} = await sb.from('agents').select('address')
    .eq('company_name', billToName).or('is_deleted.is.null,is_deleted.eq.false');
  if(agentRows && agentRows.length===1) agentAddress = agentRows[0].address || '';
}
const displayAddress = (inv.address!=null && inv.address!=='') ? inv.address : agentAddress;
```
`inv.agent_id` があればID一意取得、無ければ `company_name` の**完全一致**でフォールバック。

### 実際に実行したクエリと結果
```
GET /rest/v1/agents?company_name=ilike.*kulin*&select=id,company_name,address,is_deleted
→ [{"id":"29ce0b44-1b81-4911-a01d-4b46b5c6e741",
    "company_name":"Kulin Kumar Holidays Pvt. LTD",
    "address":"G-48 Kulin Kumar Holidays Pvt. LTD The Plaza, 55 NS Patkar Marg, Gamdevi,
               Next to Dharam Palace, Mumbai, MH 400007. India.",
    "is_deleted":false}]

GET /rest/v1/invoices?invoice_no=ilike.*1069*&select=id,invoice_no,agent_id,agent_name,address,booking_id
→ [{"invoice_no":"INV-1069","agent_id":null,
    "agent_name":"Kulin Kumar Holidays Pvt Ltd","address":null,
    "booking_id":"59674e70-3721-4458-8002-c3d60595d43d"}]

GET /rest/v1/bookings?id=eq.59674e70-...&select=id,ref_no,agent_name
→ {"ref_no":"#1069","agent_name":"Kulin Kumar Holidays Pvt. LTD"}
```

### 確定した原因
- `invoices.agent_id` が **null**(そもそも一度も設定されていない。「ズレている」のではなく未設定)。
- フォールバックの `company_name` 完全一致検索が、invoice側の保存値 `"Kulin Kumar Holidays Pvt Ltd"`(ピリオドなし・Ltd)と、agentsマスタの `"Kulin Kumar Holidays Pvt. LTD"`(ピリオドあり・LTD)の**表記差**で不一致 → 0件ヒット → `agentAddress` が空文字のまま。
- ※ご報告いただいた「51/A, J.S.S. Rord...」という住所と、実際にDBに入っている住所(「G-48 ... The Plaza ...」)は文面が異なる。理由は不明(現況の実データを報告するのみ)。

---

## 調査2: Invoice発行時のユニーク制約違反 — 確定した原因

### 実際に確認したコード
- `generateInvoice()`(index.html 27773〜27851行): `invoice_no` は連番max+1ではなく、`booking.ref_no` から数字だけ抽出した固定形式(`INV-{refNum}`、複数請求先時のみ `-XX` サフィックス)。
- 既存Invoiceの有無判定(27832-27833行、UPDATE/INSERT分岐):
  ```js
  const {data: existingInv} = await sb.from('invoices').select('id')
    .eq('booking_id', bookingId).eq('is_consolidated', false).eq('agent_name', targetAgentName).maybeSingle();
  ```
- `renderInvoiceActions()`(6761-6798行): 予約詳細モーダルの「JPY Invoice発行」ボタンは、**そのbooking/agentに既にInvoiceがあるかどうかに関わらず常に表示される**(Invoice一覧側の「未発行」判定とは独立)。請求先1件のときは `agentFilter` を渡さず、`generateInvoice()`内で `targetAgentName = booking.agent_name`(現在値)にフォールバックする。

### 実際に実行したクエリと結果
```
GET /rest/v1/bookings?id=eq.59674e70-...&select=id,ref_no,agent_name
→ {"ref_no":"#1069","agent_name":"Kulin Kumar Holidays Pvt. LTD"}   ← 現在の予約側(ピリオドあり)

GET /rest/v1/invoices?booking_id=eq.59674e70-...&select=id,invoice_no,agent_name,status
→ {"invoice_no":"INV-1069","agent_name":"Kulin Kumar Holidays Pvt Ltd","status":"pending"}  ← 既存Invoice保存値(ピリオドなし)

GET /rest/v1/booking_sales?booking_id=eq.59674e70-...&select=id,item_name,agent_name,amount
→ 2行とも agent_name:null → getDistinctSalesAgents()はbooking.agent_name(現在値)にフォールバック
  → agents.length===1 → agentFilter無しの単純な「JPY Invoice発行」ボタンが表示される経路を実際に確認
```

### 確定した原因
1. `booking.agent_name` が後から編集され(「Kulin Kumar Holidays Pvt Ltd」→「Kulin Kumar Holidays Pvt. LTD」)、既存invoiceの保存値と表記が食い違った。
2. 予約詳細モーダルの「JPY Invoice発行」ボタンは常時表示されるため、既にInvoiceがある予約でも再度押せる。
3. 既存Invoice有無判定が `agent_name` の完全一致に依存しており、上記の表記差で0件ヒット → INSERT分岐へ進む。
4. `invoice_no` はagent_nameと無関係に`ref_no`だけから再計算されるため、既存レコードと同じ `INV-1069` が生成され、PostgreSQLのユニーク制約 `invoices_invoice_no_key` に違反した。
5. 全予約1363件のref_no数字抽出値の突合を実施し、**ref_no側の衝突(別予約が同じ番号を生成するケース)は0件**であることを確認済み。今回のケースはref_no重複ではなく、agent_name表記ズレが原因と特定できる。

---

## 調査A: agentsマスタの重複実態(全135件、実クエリ)

`GET /rest/v1/agents?select=id,company_name,is_deleted,address` で全135件取得し、company_nameを正規化(trim・小文字化・ピリオド/カンマ除去・連続空白統一)してグループ化。

**正規化後に2件以上になるグループ: 2件**

| グループ(正規化後) | id | company_name(原文) | is_deleted | address有無 | bookings.agent_name一致件数 | invoices.agent_name一致件数 | invoices.agent_id一致件数 |
|---|---|---|---|---|---|---|---|
| kesari tours pvt ltd | 1888961e-e30d-40c5-8610-d3e1c58a6ecb | Kesari Tours Pvt. Ltd. | **true** | なし | 292 | 2 | 0 |
| kesari tours pvt ltd | 91c6208b-f483-42ee-8cac-ba8f1116f043 | Kesari Tours Pvt. Ltd. | false | あり | 292 | 2 | 0 |
| m/s sotc travel ltd | 016d6c76-e687-4ba1-baec-6c176218ad55 | M/S. SOTC TRAVEL LTD. | false | あり | 1 | 1 | 1 |
| m/s sotc travel ltd | 15aa9c0d-39f4-4984-a312-517b73e3fce8 | M/S. SOTC TRAVEL LTD. | **false** | あり | 1 | 1 | 0 |

※「Kesari Tours Pvt. Ltd.」は一方が `is_deleted=true` のため実運用上は実質1件相当。
※「M/S. SOTC TRAVEL LTD.」は**両方とも `is_deleted=false`(生きたレコードが完全に同名で2件)**。コード側コメント(28024-28027行)に「REF#962で同名『M/S. SOTC TRAVEL LTD.』が担当者違いで2件登録されており、company_name一致だと.maybeSingle()がエラーになり住所が取得できていなかった」とあり、この既知の重複と一致する実データを確認できた。

**Kulin Kumarを含む会社名: 1件のみ**(重複なし)
```
{"id":"29ce0b44-...","company_name":"Kulin Kumar Holidays Pvt. LTD","is_deleted":false,
 "address":"G-48 Kulin Kumar Holidays Pvt. LTD The Plaza, ..."}
```
→ 調査1の原因はagentsマスタ側の重複ではなく、invoice/booking側との表記ズレのみ。

---

## 調査B: agent_id未設定の実態(実クエリ)

- **invoices**: 全14件中、`agent_id` が null = **12件**(non-null 2件はINV-967-TC/INV-967-SO)
- **bookings**: `agent_id` カラムは存在する。全1363件中、null = **293件**、non-null = **1070件**
  (`Prefer: count=exact` で個別に検証: `agent_id=is.null` → `content-range: 0-0/293`、`agent_id=not.is.null` → `content-range: 0-0/1070`。293+1070=1363で一致確認)

### agent_id=nullの12件のinvoiceを、agent_nameで正規化突合
- **一意に1件のagentへ紐づくもの: 9件**(うち完全一致8件、正規化のみ一致=表記ズレ1件[INV-1069])
- **複数のagent候補に当たるもの: 2件**
  - INV-728, INV-782: いずれも `agent_name="Kesari Tours Pvt. Ltd."` → 上記の重複agent(2件)両方にヒット
- **どのagentにも当たらないもの: 1件**
  - INV-1188: `agent_name="Shanzad International"` → agentsマスタに該当なし(未登録またはマスタ未整備)

---

## 調査C: 表記ゆれの実態(実クエリ)

正規化ルール: trim → 小文字化 → `.`/`,` 除去 → 連続空白(全角空白・NBSP含む)を単一半角スペースに統一。

### bookings.agent_name (空でない1167件)
- agents.company_nameと**完全一致**: 904件
- **正規化すれば一致**(表記ゆれ): **153件**
- 正規化しても一致しない(マスタに無い等): 110件

代表的なズレ例(実データ、(booking側, agent側)):
```
('Kulin Kumar Holidays Pvt Ltd', 'Kulin Kumar Holidays Pvt. LTD')          ← ピリオド有無・大文字小文字
('SUN TOURIISM INTERNATIONALL　PVT.LTD.', 'SUN　TOURIISM　INTERNATIONALL　PVT.LTD.')  ← 全角スペースの数
('Akbar Holidays Pvt Ltd.', 'Akbar Holidays Pvt. Ltd.')                    ← ピリオド位置
('TRAVEL　EASY　HOLIDAY', 'TRAVEL EASY HOLIDAY')                            ← 全角/半角スペース
('Evergreen Global Holidays Pvt Ltd', 'Evergreen Global Holidays\xa0Pvt\xa0Ltd')  ← NBSP混入
```

### invoices.agent_name (空でない14件)
- 完全一致: 12件
- 正規化すれば一致: 1件(INV-1069、上記と同じKulin Kumarのケース)
- 正規化しても一致しない: 1件(INV-1188、Shanzad International。マスタ自体に無い)

---

## 調査D: 名前文字列でのID非経由照合ロジックの全箇所(コード実確認)

`index.html` を `grep` で全文検索(`\.eq\('company_name'`, `\.eq\('agent_name'`, `_name===`, `_name ===` 等)し、該当箇所を精査。**他にコードファイルは無い**(単一ファイルSPA構成)。

### Agent(取引先)関連 — DB照合・保存判定ロジック(5箇所)

| # | 行番号 | 関数 | 処理内容 | agent_idフォールバック |
|---|---|---|---|---|
| 1 | 28034 | `showInvoicePreview` | Invoice住所欄の取得(agents.company_name完全一致) | あり(agent_id優先、無ければcompany_name一致) |
| 2 | 27833 | `generateInvoice` | 既存Invoiceの有無判定(agent_name完全一致) | **なし**(agent_idではなくagent_name文字列のみで判定) |
| 3 | 26989 | `resolveAgentIdForSave` | 予約保存時、agent_idを引き継ぐか判定(company_name完全一致) | — (この関数自体がagent_id決定ロジック。自由入力扱いになるとnull化する原因) |
| 4 | 19219 | `saveBookingDetail` | 上記`resolveAgentIdForSave`の呼び出し元(agent_name変更有無の判定) | 3.を参照 |
| 5 | 27675 | `salesItemBelongsToAgent` | 売上明細行が指定請求先に属するか判定(完全一致 `a === agentFilter`) | なし |

今回発覚した**調査1(住所取得)・調査2(既存Invoice判定)以外に、同じ表記ゆれで壊れうる箇所が3箇所**(3.4.は保存時のagent_id決定ロジックで、これがbookings.agent_id null 293件の主因と考えられる。5.は請求先ごとの金額集計に影響しうる)。

補足: `agentInvoiceCode`/`buildAgentInvoiceSuffixes`(27731-27760行付近)はInvoice番号の接尾辞(`-TC`等)を会社名から機械的に生成するロジックで、表記が違っても同じコードになるよう法人格サフィックス等を除去する正規化を既に内蔵している(が、DB照合には使われていない)。

### Agent以外の名前文字列照合(在メモリ配列内、DB照合ではない)

| 行番号 | 対象 | 処理内容 | 備考 |
|---|---|---|---|
| 17890 | ホテル名 | 行程貼り付け解析で、末尾地点名とbdHotelItems内のhotel_nameを照合しhotel_booking_idを自動リンク | 完全一致に加え`includes()`による部分一致フォールバック**あり**(既に緩和済み) |
| 17934,17966 | ホテル名 | AI読み取り確認画面のマージ処理でhotel_name+check_in+check_outの複合キー一致判定 | 同一セッション内の配列同士の突合(DB非依存) |
| 17940,17942,17970 | レストラン名 | 同上、restaurant_name+date+meal_type | 同上 |
| 17972 | 施設名 | 同上、facility_name+date | 同上 |
| 17974 | 品名(水) | 同上、item_name+date | 同上 |
| 24750,24799 | ホテル名 | ホテル管理カレンダーでhotelManagementCacheをhotel_name完全一致でグルーピング表示 | DB照合ではなく表示用グルーピング |
| 9634,9841,9845,9846 | ガイド名 | ガイド精算で明細行をguide_name完全一致で担当ガイドごとに振り分け | 同一予約内の配列同士の突合 |

これらは**DBへ`.eq()`で問い合わせる照合ではなく、既に取得済みの配列同士をメモリ上で突合する処理**であり、Agent関連の5箇所(異なるテーブル・異なる入力タイミングの文字列を照合する)より一般に発生条件が限定的(同一セッション・同一予約内のデータ同士の比較のため、表記が食い違う機会が少ない)。ただし理論上は同じ脆弱性パターン。

---

## 修正フェーズ(2026-09-03、Step1/Step2実施済み)

### Step 1: SOTC重複Agent統合 — 完了
- 提案・承認・実行(JUNがSupabase SQL Editorで実行)・実クエリ検証まで完了。
- 実行SQL: `scripts/merge_sotc_duplicate_agent.sql`(ブランチ`claude/merge-sotc-duplicate-agent`にコミット・push済み、PR未作成)
- 内容:
  1. booking `#870`(id=9d841ca2-...)のagent_idを`15aa9c0d-...`→`016d6c76-...`(正レコード、Binita Lama)へ付け替え
  2. `016d6c76-...`のcontact_person3にNarmada Muthu Thanuの連絡先を追加登録(contact_person2は上書きせず、空きスロットのcontact_person3を使用)
  3. `15aa9c0d-...`(Narmada側)を`is_deleted=true`で論理削除
- 検証結果(実クエリ、全て確認OK): booking #870のagent_id付け替え済み / contact_person3登録内容正しい・contact_person2無傷 / 15aa9c0dのis_deleted=true・deleted_at・deleted_by記録済み

### Step 2: agent_idバックフィル — 完了
- 実行SQL: `scripts/backfill_agent_id_step2.sql`(ブランチ`claude/backfill-agent-id`にコミット・push済み、PR未作成)
- 内容:
  1. invoices 11件・bookings 3件に、agent_name正規化突合で一意特定できたagent_idをbackfill
  2. INV-1188「Shanzad International」を`status='void'`で失効(invoicesにis_deleted列は無いため、既存の「失効」状態を代用ソフトデリートとして使用)。正しい社名は「Sanzad International LLP」(hなし)と判明、マスタ登録・再紐付けはJUNが別途手動実施予定。bookings側の同名5件(スペル違いで正規化一致せず)は今回対象外。
  3. INV-1299「RES AN EVE」は未紐付けのまま据え置き(今回対象外)
  4. bookingsの残りノーヒット290件(空欄196・"0"表記59・実名ありだがマスタ未登録35)は今回対象外、手を付けていない
- 検証結果(実クエリ):
  - invoices.agent_id null: 13件→**4件**(11件backfill成功。残る4件の内訳: RES AN EVE[意図通り未紐付け]・Shanzad International[void化済み、意図通り]・TravelMaze[Step2作業中に新規発行]・Aurora Travel Tours Pvt Ltd[同、新規発行]。後者2件は今回の対象外の新規データで異常ではない)
  - bookings.agent_id null: 293件→**289件**(3件backfill成功。差分1件は作業期間中の通常操作によるものと推測、異常ではない)

## Step 3: コード修正 — 実装完了(2026-09-03、ブランチ`claude/agent-id-canonical-lookup`)
方針: 「agent_idを唯一の照合キーとし、文字列比較はagent_id不在時の正規化フォールバックに限定する」。対象は調査Dで洗い出したAgent関連5箇所 + 追加スコープ(下記)。

### 追加スコープ(着手後にJUNの指示で追加): Invoice発行時のagent_id書き込み
Step2実行中に新規発行されたINV-1381・INV-363が両方とも`agent_id: null`だったことから発覚。`generateInvoice()`のコードを実測確認した結果、`agentId`は`booking_sales`行自身の`agent_id`(按分モーダルでマスタ選択した場合のみ設定される)からしか取得しておらず、`booking.agent_id`へのフォールバックも正規化マスタ突合も一切行っていないことを確認(=推測ではなく実コード確認により原因を特定)。これがbookings側のフォールバックとは独立した、もう一つのagent_id null発生源だった。

### 実装内容(index.html、コミット前にPlaywrightで7シナリオ実機的に検証済み)
1. `normalizeAgentName(s)`(共通正規化関数)・`findAgentIdByNormalizedName(name)`(agentsCacheとの一意突合)を新設(agentsCache定義の近く)。trim→小文字化→`.`/`,`除去→連続空白(全角スペース・NBSP含む)を単一スペースに圧縮→再trim。5箇所全てこれを共用。
2. `resolveAgentIdForSave`: 候補選択idと現在値の完全一致で決まらない場合、`findAgentIdByNormalizedName`で正規化フォールバックを試みる。それでも決まらなければ`showErrorToast`で「取引先「◯◯」が取引先マスタと紐付いていません」を表示した上でnullを返す(黙ってnullを保存しない)。呼び出し元の`saveBookingDetail`(19426行)・新規予約作成(19795行)は関数シグネチャ変更なしでこの修正の恩恵を受ける。
3. `generateInvoice`:
   - `agentId`未決定(salesRows側にagent_id無し)の場合、①`booking.agent_id`(請求先が単一の予約、または複数請求先でも予約代表名と今回の請求先名が正規化一致する場合のみ採用)→②`findAgentIdByNormalizedName(targetAgentName)`の順でフォールバック。どちらも決まらなければ`agent_id: null`のまま発行し、`showErrorToast`で「Invoice「◯◯」の請求先「◯◯」が取引先マスタと紐付いていません」を表示。
   - 既存Invoice判定: `agent_name`完全一致ではなく、請求先が1つの予約は`booking_id`+`is_consolidated:false`のみで判定(表記ゆれで既存行を見失わない=元のREF#967重複バグの直接修正)、複数請求先の予約のみ`agent_id`(未決定ならagent_nameへフォールバック)で絞り込む。
4. `showInvoicePreview`の住所取得: `company_name`完全一致が0件の場合のみ、全件取得して`normalizeAgentName`で正規化フォールバック突合(元のINV-1069住所空欄バグの直接修正)。
5. `salesItemBelongsToAgent`: 完全一致で決まらない場合のみ`normalizeAgentName`でフォールバック比較。
6. スコープ外(変更なし): ホテル/レストラン/ガイド名のセッション内配列突合。

### 検証(Playwright、`/tmp/.../scratchpad/step3_agent_id_test.js`)
1. `normalizeAgentName`/`findAgentIdByNormalizedName`: 表記ゆれ正規化・一意ヒット・複数ヒット時null・0件null・空文字null、全て期待通り。
2. `resolveAgentIdForSave`: 正規化フォールバックでの解決・未紐付けはnull、期待通り。
3. `salesItemBelongsToAgent`: 完全一致・正規化一致・フィルタ無し・不一致、全て期待通り。
4. `generateInvoice`: booking.agent_idからのフォールバックでagent_idが新規Invoiceに書き込まれることを確認(INV-1381/INV-363相当のシナリオ)。
5. `generateInvoice`: booking.agent_idもnullで会社名表記ゆれのケースでも、正規化マスタ突合でagent_idが決まることを確認。
6. `generateInvoice`: どちらの手段でも決まらない場合、agent_id: nullのまま発行され、かつ警告トーストが表示されることを確認。
7. `showInvoicePreview`: agent_id無し・company_name表記ゆれのケースでも住所欄が正しく取得できることを確認(INV-1069相当のシナリオ、元バグの再現・修正確認)。

構文チェック(`<script>`ブロック抽出→`new Function()`)もエラー0件で通過。

### Step 3完了後の残作業(重要、忘れないこと)
**INV-1381・INV-363(および今後Step 3マージまでに発行されたagent_id null分)のagent_idバックフィルSQLを、Step 3マージ後にStep 2と同じ形式(scripts/*.sql作成→commit・push→JUNがSupabase SQL Editorで実行→実クエリで検証)で作成する。** Step 3のコード修正がマージされる前に発行された分は今回の修正の対象外(修正後の新規発行分からのみagent_idが書き込まれる)なので、既存の null 分は別途バックフィルが必要。

## Step 4(Step3完了後、未着手)
1. INV-1069で住所表示・JPY発行(重複エラーにならず既存Invoice更新になること)を実機確認
2. 表記ゆれのあるbooking(調査Cの110件から1件)で保存→agent_id決定の挙動を確認
3. 新規Invoice発行→`invoices.agent_id`が設定されていることを確認(追加スコープの検証項目)
4. diff全体を提示

## 別タスク(Step1〜4完了後に着手予定、未着手)
取引先(Agent)の複数担当者管理: 現状は固定カラム(contact_person/2/3の3枠、うち3枠目は今回Narmadaで使用済みのため実質空きなし)。担当者を何人でも追加できる仕組み(例: agent_contacts子テーブル+編集モーダルUI)の設計案を提案予定(実装はまだ行わない、設計案の承認待ちから)。

## 未修正であることの確認(Step1/Step2実施前の記述、参考として残す)
Step1/Step2はJUNの承認・実行を経て上記の通り実施済み。それ以外(Step3のコード修正含む)は本ファイル更新時点でまだ未着手。
