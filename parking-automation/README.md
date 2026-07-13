# parking-automation

駐車場予約サイトの予約を自動化するスクリプト群です。Playwright(chromium)を使用します。

- **新大阪駅バス駐車場**（revn.jrbusparkingyoyaku.jp） / 設定: `config.json`
- **名古屋 大型車両夜間宿泊予約システム**（midori.ccx.mobi/Parking、名城公園正門前駐車場・若宮大通公園白川前駐車場） / 設定: `nagoya-config.json`
- **京都テルサ 大型バス駐車場**（reserva.be/kyototerrsaparking） / 設定: `.env`

## セットアップ（初回のみ）

```
cd parking-automation
npm install
npx playwright install chromium
```

## 設定ファイル (config.json)

`config.json` は **gitで管理されません**（`.gitignore` に `parking-automation/config.json` を追加済み）。
このリポジトリを新しく取得した環境では、以下の内容で `parking-automation/config.json` を自分で作成してください。

```json
{
  "loginId": "実際のログインID",
  "loginPassword": "実際のパスワード",
  "reservations": [
    {
      "refNumber": "782",
      "facilityArea": "JR新大阪駅前",
      "startDateTime": "2026-09-27T18:40:00",
      "endDateTime": "2026-09-27T19:40:00",
      "advanceDays": 30,
      "carNumber": "0000",
      "remarks": "未定",
      "paymentMethod": "現地支払",
      "status": "pending"
    }
  ]
}
```

- `loginId` / `loginPassword`: 予約サイトのログイン情報。**チャットや他人に共有しないこと。**
- `reservations`: 予約したい件数分、配列に追加する（1台＝1件。サイト側の仕様で一括登録はできないため、1件ずつ処理されます）。
- `advanceDays`: 予約解禁日（`startDateTime`の日付からの遡り日数）。サイトは「1か月（30日）前から予約可能」。
- `status`: `pending`（未処理） / `completed`（予約完了） / `failed`（予約失敗）。スクリプトが自動的に更新します。

## 実行方法

### 本番実行（解禁日になった対象のみ処理）

```
node book-parking.js
```

`(startDateTimeの日付 - advanceDays)` が実行日（JST基準）と一致する `status: "pending"` の予約だけを処理します。対象がなければ何もせず終了します。

### テスト実行（日付条件を無視して今すぐ処理）

```
node book-parking-test.js
```

`status: "pending"` の予約を、日付条件を無視して今すぐ全件処理します。動作確認専用です。

### Web画面からの「今すぐ予約」を処理する

```
node book-parking-now.js
```

KIC Travel Core（index.html）の「🅿️ 駐車場 今すぐ予約」モーダルから登録された、Supabaseの
`parking_reservations` テーブルの `status = "即時実行待ち"` レコードを取得し、その場で処理します。
Web画面（Vercel）からは直接Playwrightを実行できないため、この画面はSupabaseへの登録のみを行い、
実際の予約実行はこのスクリプトをJUNさんのPCで手動実行することで行います。処理結果（成功/失敗、
エラー内容、スクリーンショットのパス）は同レコードに書き戻され、Web画面側でも確認できます。

事前に一度だけ、Supabase側で `parking_reservations` テーブルを作成しておく必要があります
（SQLは本READMEの末尾を参照）。`facility_type`（`shinosaka`/`nagoya`）によって、新大阪・名古屋
どちらの自動化処理を使うかを自動的に振り分けます。

---

## 名古屋 大型車両夜間宿泊予約システム（名城公園/若宮大通公園）

### 設定ファイル (nagoya-config.json)

`nagoya-config.json` も **gitで管理されません**（`.gitignore` に追加済み）。新しい環境では以下の内容で
自分で作成してください。

```json
{
  "loginId": "実際のログインID",
  "loginPassword": "実際のパスワード",
  "testSingleDate": "2026-08-25",
  "defaultPlan": {
    "primaryFacility": "名城公園　正門前駐車場",
    "fallbackFacility": "若宮大通公園 白川前駐車場",
    "vehiclesPerDay": 2,
    "checkInTime": "21:00",
    "checkOutTime": "09:00",
    "vehicleType": "大型",
    "busCompanyName": "KICトラベル",
    "driverName": "未定",
    "driverHotelName": "コートヤードバイマリオット名古屋",
    "contactPhone": "03-6869-5550",
    "applicantName": "リュウセキドウ",
    "carNumber": "0000"
  },
  "monthOverrides": {}
}
```

- `defaultPlan`: 毎月の月次バッチで使う既定値。`monthOverrides["2026-10"]` のように月ごとの上書きを
  追加していける（拡張が必要な月だけ追加すればよい。指定しない項目は`defaultPlan`の値のまま）。
- `primaryFacility` が満車（記号が「Ｘ」）または予約不可の日は、自動的に `fallbackFacility` に
  切り替えて予約を試みる。
- `testSingleDate`: `book-nagoya-parking-monthly-test.js` で使う、動作確認用の1日だけの対象日。

### 実行方法

#### 動作確認（1日・1台だけ処理）

```
node book-nagoya-parking-monthly-test.js
```

`testSingleDate` に指定した日付・`defaultPlan`の内容で1台だけ予約します。**実際に予約枠を1件
確定させます。** 本番の月次バッチを初めて使う前に、まずこちらで一連の流れが正しく動作することを
確認してください。

#### 本番実行（毎月1日 00:00に実行する想定）

```
node book-nagoya-parking-monthly.js
```

実行時点から2ヶ月先の月の全日程について、それぞれ `vehiclesPerDay` 台分の予約を試みます。1日ぶんの
入力欄はサイト側の仕様で1画面に最大3台まで同時入力できるため、`vehiclesPerDay`が3以下であれば
1日1回のフォーム送信で完結します（4台以上を指定するとエラーになります）。途中の日で失敗しても
処理は止めず、次の日へ進みます。最後に成功/失敗の一覧を `logs/nagoya-monthly-summary-{日時}.log`
に保存します。

Windowsタスクスケジューラ等で「毎月1日 00:00」に `node book-nagoya-parking-monthly.js` を実行する
よう登録することで、月次のまとめ予約を自動化できます（タスクスケジューラの登録自体は本スクリプトの
範囲外です）。

---

## 京都テルサ 大型バス駐車場（RESERVA / reserva.be/kyototerrsaparking）

### 設定 (.env)

ログイン情報は `config.json`/`nagoya-config.json` とは異なり、`.env` ファイル（**gitで管理されません**）
から読み込みます。`parking-automation/.env.example` を参考に、同じ場所に `.env` を作成してください。

```
KYOTO_TERRSA_LOGIN_ID=実際のログインID(メールアドレス)
KYOTO_TERRSA_PASSWORD=実際のパスワード
```

### 実行方法

```
node parking-kyoto-terrsa.js --date 2026-10-14
node parking-kyoto-terrsa.js --date 2026-10-14 --vehicles 2
node parking-kyoto-terrsa.js --date 2026-10-14 --vehicles 2 --wait-until-available
```

`--date` に指定した日（1泊、18時〜翌朝8時の「大型バス　夜間駐車」枠）を予約します。利用団体は
`KIC0000`、バス会社名は `KICトラベル` で固定です。

- `--vehicles N`: N台分を同一ブラウザセッション内で連続予約します（省略時は1台）。
  このサイトの予約フォームには「台数」を指定する項目が無く（「オプション」欄の
  「夜間予約マイクロ・小型バス（車種変更）」は車種変更用の別項目で、台数指定ではないことを実際の
  画面で確認済み）、1回の予約操作につき1台分しか確保できません。そのため`--vehicles`で指定した
  台数分、ログインしたまま予約フローを繰り返します。2台目以降は「既に同じ日時で予約しています。
  さらに同じ日時に別予約を追加しますか。」という確認モーダルが割り込むことを確認済みで、
  自動的に「予約を進める」を選んで続行します。1台失敗しても残りの台数の処理は続けます。
- `--wait-until-available`: 予約受付開始チェックを通過していても、その時点でカレンダー上に
  対象日がまだ選択可能になっていない場合、2.5秒間隔（最大20分）でリトライしながら選択可能になるのを
  待ってから予約を開始します（回線負荷を抑えるため間隔は2〜3秒程度にしています）。深夜0:00の新規解禁日を
  狙う場合、23:59台に起動しておけばこのオプションで解禁直後に自動的に予約が始まります。
- 予約受付開始（利用日の3ヶ月前00:00、サイト上の表記に基づく）より前の日付を指定し、かつ
  `--wait-until-available` も付けていない場合は、ブラウザを起動せずにエラーメッセージを表示して
  終了します。**実際に確認したところ、サイトのカレンダーは現時点でそれより短い範囲（確認時点で
  約1ヶ月半程度先まで）しか日付を選択可能にしていませんでした。** 3ヶ月前チェックを通過しても、
  その時点でカレンダー上に当該日が表示・選択できない場合は「対象日は選択できません」という
  エラーで失敗します（`--wait-until-available`を使えばこの状態でも解禁を待って自動続行できます）。
- 各ステップ（日付選択後・時間枠確定後・入力後・確認画面・完了画面）でスクリーンショットを
  `logs/kyoto-terrsa-{日付またはdate-vN}-{ステップ}-{日時秒}.png` に保存します。失敗時は
  `logs/kyoto-terrsa-{日付}-v{台目}-error-{タイムスタンプ}.png` も保存されます。
- 実行結果（成功/失敗、確認番号、エラー内容）は台数分それぞれSupabaseの`parking_reservations`
  テーブルに `facility_type: "kyoto_terrsa"` として記録します（`ref_no`は2台以上の場合
  `KYOTO-{日付}-{台目}`、1台のみの場合は`KYOTO-{日付}`。`extra`列に利用団体・バス会社名・
  台目番号・合計台数を保持）。

### 既知の制約・注意点

- ログイン画面(id-sso.reserva.be)はCloudflareのボット対策(Turnstile)があり、**headless:trueだと
  検証ページで止まってしまうことを確認済みです。** そのため本スクリプトは常にheadless:falseで
  動作します（`parking-kyoto-terrsa.js`冒頭の`HEADLESS`は変更しないでください）。
- 確認画面の利用規約チェックボックス（`#agree_terms`）は、Playwrightの通常の`click()`だと
  チェック状態が変化しないことを確認済みです（ラベルが利用規約リンクも内包する構造のため
  クリック座標がリンク側に解釈されてしまうと推測）。`page.evaluate`で直接`.click()`を発火させる
  方式で確実にチェックしています。
- 実際に2026-08-14, 2026-08-20（各1台）で実予約を実行し、予約番号が発行され「予約完了」画面が
  表示されることを確認済みです。同一セッション内でログインから完了まで連続実行するよう最適化した
  結果、1台あたりの所要時間は10〜15秒程度でした。
- 2台目以降の予約時、「既に同じ日時で予約しています。さらに同じ日時に別予約を追加しますか。」
  という確認モーダル（`<div id="modal_alert" class="modal full duplicated">`）が表示されます。
  「予約を進める」ボタンは`<button>`や`<a>`ではなく`<input type="button" class="continue_btn"
  value="予約を進める">`であることを実際のDOMで確認済みで、`querySelectorAll('button, a')`
  では検出できず（この不一致が最初の実装バグの原因でした）、`input[type="button"]`も含めて
  検索するよう修正しています。また、1台目の完了時（モーダルが出ずそのまま完了画面へ遷移する場合）に
  `page.evaluate`の実行コンテキストが破棄されてエラーになることがあったため、そのケースは
  「モーダルなし」として正常に処理されるようにしています。
  モーダル検出は「完了する」クリック後に固定sleepを挟まず、150ms間隔で
  「モーダルが出たか／そのまま完了画面へ遷移したか」を1本のポーリングでレースさせる方式にしており
  （`waitForModalOrCompletion`）、状態が変わった瞬間に次の操作へ進むため待ち時間を最小限にしています。
  2026-08-31で実際に2台連続予約（1台目→モーダル検出→「予約を進める」→2台目完了）が成功し、
  1台目8.6秒・2台目9.6秒（モーダル対応込み）・ログイン込み合計22.2秒で完了することを確認済みです。
  なお、駐車場全体の受付台数は6台のため、既に他の予約で埋まっている日は2台目以降が
  「対象日は選択できません」で失敗することがあります（バグではなく満車によるもの。実際に
  2026-08-14, 08-20, 08-28, 08-29, 08-30ではこの理由で2台目が失敗しました）。

## headless（画面表示）の切り替え

`book-parking.js` / `book-parking-test.js` / `book-parking-now.js` /
`book-nagoya-parking-monthly.js` / `book-nagoya-parking-monthly-test.js` の冒頭に

```js
const HEADLESS = false;
```

があります。**最初は `false` のまま実行し、実際にブラウザの画面が開いて操作される様子を目視確認してください。**

動作確認が取れたら、無人実行（タスクスケジューラ等でのスケジュール実行）のために、該当ファイルのこの行を

```js
const HEADLESS = true;
```

に変更してください。**`parking-kyoto-terrsa.js` / `parking-kyoto-terrsa-midnight.js` のみ例外です。**
CloudflareのTurnstile検証を通過するためheadless:trueでは動作しないため、常に`HEADLESS = false`のまま
無人実行はできません（Windowsタスクスケジューラ等で無人実行する場合も、画面付きセッションで実行する
必要があります）。

## ログ・スクリーンショット

`logs/` フォルダに保存されます（このフォルダもgit管理外です）。

- `reservation-{REF#}-{日時}.png` / `nagoya-{日付}-{日時}.png` / `kyoto-terrsa-{日付またはdate-vN}-{ステップ}-{日時秒}.png`: 予約完了画面等のスクリーンショット
- `error-{日付}.log` / `nagoya-error-{日付}.log` / `kyoto-terrsa-error-{日付}.log`: エラー発生時の内容
- `nagoya-monthly-summary-{日時}.log` / `kyoto-terrsa-midnight-summary-{タイムスタンプ}.log`: バッチ・深夜自動実行の成功/失敗一覧

## 京都テルサ：深夜0:00の新規解禁日を狙った自動予約（parking-kyoto-terrsa-midnight.js）

新しい日程が予約受付開始になる瞬間（サイト表記上は「利用日の3ヶ月前の00:00」）を狙って、
2台分を自動予約するための専用スクリプトです。`parking-kyoto-terrsa.js`とロジックの大部分
（ログイン・日程選択・入力・確認・完了・重複予約モーダル対応）を共有していますが、
解禁待ちリトライと対象日の自動判定を主目的として分離しています。

```
node parking-kyoto-terrsa-midnight.js
node parking-kyoto-terrsa-midnight.js --date 2026-10-14
node parking-kyoto-terrsa-midnight.js --vehicles 1
node parking-kyoto-terrsa-midnight.js --dry-run
```

- `--date` を省略した場合、「実行日の翌日の3ヶ月後」を対象日として自動計算します
  （例: 実行日が2026-07-13なら、翌日2026-07-14の3ヶ月後＝2026-10-14。これは
  「本日の深夜0:00に新しく解禁される日」の理論値です。ただし実際のカレンダーの解禁挙動が
  この通りとは限らないため、確実性を重視する場合は`--date`で明示指定してください）。
- 2.5秒間隔・最大10分でカレンダーをリトライし、対象日が選択可能になり次第すぐに`--vehicles`
  （既定2台）分の予約を連続実行します。10分経っても解禁されない場合はエラーとして
  `logs/kyoto-terrsa-error-{日付}.log`に記録し、プロセスを終了します（成功/失敗いずれの場合も
  最後に必ず`logs/kyoto-terrsa-midnight-summary-{タイムスタンプ}.log`に結果をまとめて保存します）。
- `--dry-run` を付けると、ログインとカレンダーの空き状況チェックのみ行い、予約は一切実行せず
  終了します。動作確認や、対象日の自動判定結果を事前に確認したい場合に使用してください。
- タスクスケジューラ等の無人実行を想定し、成功・失敗・予期しない例外いずれの場合も
  必ずプロセスが終了するようにしています（15分の安全装置タイマーも別途設けており、
  万一ハングした場合でも強制終了します）。
- Windowsタスクスケジューラで、対象日の解禁が見込まれる日の23:59頃に起動するよう
  登録することを想定しています（タスクスケジューラへの登録自体は本スクリプトの範囲外です）。

## 既知の制約・注意点

- 新大阪の予約登録フォーム（車両ナンバー・備考欄・利用終了日時・支払い方法）は、実際にログインした状態でHTML構造を確認済みです（テーブル(表)レイアウトで正式な`<label for>`が無いため、`lib/booking-flow.js`の`fillByLabel`は行(`tr`)構造ベースで、支払い方法は`label.cmn-radio`ベースで要素を特定しています）。日をまたぐ「宿泊」パターン（利用開始日と終了日が別日）にも対応済みです。ただし利用終了日時の「分」はサイト側が0/20/40分単位のみ選択可能なため、指定した分数はこの3択に切り下げられます（例: 08:30指定 → 08:20で登録）。
- 新大阪は車番未定時の仮予約（"0000"）までを自動化の範囲とし、車番確定後の変更は対象外です（サイト側の運用ルール通り、手動で「予約履歴」から変更してください）。
- 新大阪は1台ごとに個別予約が必要なため、`reservations` 配列に複数件ある場合は1件ずつ順番に処理します。
- 名古屋は1日あたり最大3台まで1画面でまとめて入力・送信できることを確認済みです（`lib/nagoya-booking-flow.js`）。カレンダーの月移動はページ遷移ではなくAjaxのため、`goToMonth`はリンクのクリック後に`#caltitle`の表示が変わるまで待機する実装にしています。

## Supabase側の事前準備（parking_reservationsテーブル）

Web画面の「今すぐ予約」機能を使う場合、SupabaseのSQL Editorで一度だけ以下を実行してテーブルを作成してください（このスクリプト自身はSupabaseへのDDL実行権限を持たないpublishable keyしか使わないため、テーブル作成はSupabase側で手動で行う必要があります）。

```sql
create table if not exists parking_reservations (
  id bigint generated always as identity primary key,
  ref_no text,
  facility_area text not null default 'JR新大阪駅前',
  start_datetime timestamp not null,
  end_datetime timestamp not null,
  car_number text,
  remarks text,
  payment_method text not null default '現地支払',
  status text not null default '即時実行待ち',
  result_message text,
  screenshot_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table parking_reservations disable row level security;
```

名古屋（大型車両夜間宿泊予約システム）対応のため、以下2列を追加しています（既存の新大阪分のデータには影響しません）。

```sql
alter table parking_reservations add column if not exists facility_type text not null default 'shinosaka';
alter table parking_reservations add column if not exists extra jsonb;
```

- `facility_type`: `'shinosaka'`（新大阪駅バス駐車場）/ `'nagoya'`（名古屋）。`book-parking-now.js`はこの値でどちらの自動化処理を使うか振り分けます。
- `extra`: 名古屋分の追加項目（`bus_company_name`/`driver_name`/`driver_hotel_name`/`contact_phone`/`applicant_name`）をJSONBで保持します。新大阪分では未使用（null）です。

（既存の他テーブルと同様、クライアント側はpublishable/anonキーで直接読み書きするためRLSは無効化しています。）
