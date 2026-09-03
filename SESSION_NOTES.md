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

## 未修正であることの確認
本調査では読み取り専用のGETリクエストのみ実行し、Supabaseへの書き込み(POST/PATCH/DELETE)、`index.html`の編集、いずれも行っていない。`git status`はクリーン(本ファイルの追加のみ)。
