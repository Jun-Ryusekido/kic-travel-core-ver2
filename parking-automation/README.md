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

- **ログイン後にのみ表示される「予約登録フォーム」（車両ナンバー・備考欄・支払い方法などの入力画面）は、実際にログインした状態で確認できていません。** ログイン前のトップページ・ログイン画面・カレンダー画面（空き状況の閲覧）は実際にブラウザで開いて構造を確認済みですが、認証が必要なページはサイト構造を直接確認できなかったため、JUNさんから伝えられた画面上の文言（「内容確認へ進む」「現地支払」「予約を登録する」等）をそのままテキスト一致で探すようにしています。初回の実データでの動作確認時に、この部分でエラーになる場合は、実際の画面のHTML構造を教えていただければ `lib/booking-flow.js` の `fillReservationForm` 関数を調整します。
- 車番未定時の仮予約（"0000"）までを自動化の範囲とし、車番確定後の変更は対象外です（サイト側の運用ルール通り、手動で「予約履歴」から変更してください）。
- 1台ごとに個別予約が必要なため、`reservations` 配列に複数件ある場合は1件ずつ順番に処理します。
