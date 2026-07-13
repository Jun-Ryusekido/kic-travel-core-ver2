# parking-automation

駐車場予約サイトの予約を自動化するスクリプト群です。Playwright(chromium)を使用します。

- **新大阪駅バス駐車場**（revn.jrbusparkingyoyaku.jp） / 設定: `config.json`
- **名古屋 大型車両夜間宿泊予約システム**（midori.ccx.mobi/Parking、名城公園正門前駐車場・若宮大通公園白川前駐車場） / 設定: `nagoya-config.json`

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

に変更してください。

## ログ・スクリーンショット

`logs/` フォルダに保存されます（このフォルダもgit管理外です）。

- `reservation-{REF#}-{日時}.png` / `nagoya-{日付}-{日時}.png`: 予約完了画面のスクリーンショット
- `error-{日付}.log` / `nagoya-error-{日付}.log`: エラー発生時の内容
- `nagoya-monthly-summary-{日時}.log`: 月次バッチの成功/失敗一覧

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
