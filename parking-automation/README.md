# parking-automation

新大阪駅バス駐車場（revn.jrbusparkingyoyaku.jp）の予約を自動化するスクリプトです。Playwright(chromium)を使用します。

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
（SQLは本READMEの末尾を参照）。

## headless（画面表示）の切り替え

`book-parking.js` と `book-parking-test.js` の冒頭に

```js
const HEADLESS = false;
```

があります。**最初は `false` のまま実行し、実際にブラウザの画面が開いて操作される様子を目視確認してください。**

動作確認が取れたら、無人実行（cron等でのスケジュール実行）のために、両ファイルのこの行を

```js
const HEADLESS = true;
```

に変更してください。

## ログ・スクリーンショット

`logs/` フォルダに保存されます（このフォルダもgit管理外です）。

- `reservation-{REF#}-{日時}.png`: 予約完了画面のスクリーンショット
- `error-{日付}.log`: エラー発生時の内容

## 既知の制約・注意点

- 予約登録フォーム（車両ナンバー・備考欄・利用終了日時・支払い方法）は、実際にログインした状態でHTML構造を確認済みです（テーブル(表)レイアウトで正式な`<label for>`が無いため、`lib/booking-flow.js`の`fillByLabel`は行(`tr`)構造ベースで、支払い方法は`label.cmn-radio`ベースで要素を特定しています）。日をまたぐ「宿泊」パターン（利用開始日と終了日が別日）にも対応済みです。ただし利用終了日時の「分」はサイト側が0/20/40分単位のみ選択可能なため、指定した分数はこの3択に切り下げられます（例: 08:30指定 → 08:20で登録）。
- 車番未定時の仮予約（"0000"）までを自動化の範囲とし、車番確定後の変更は対象外です（サイト側の運用ルール通り、手動で「予約履歴」から変更してください）。
- 1台ごとに個別予約が必要なため、`reservations` 配列に複数件ある場合は1件ずつ順番に処理します。

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

（既存の他テーブルと同様、クライアント側はpublishable/anonキーで直接読み書きするためRLSは無効化しています。）
