# CLAUDE.md

このファイルは、このリポジトリで作業する際に守るべきルールを記載する。

## テーブルのモバイル対応（標準パターン）

複数列のテーブル/グリッドを新規に追加する場合は、**必ず**共通コンポーネントの
`confirm-table` パターンを使い、768px未満でカード形式の縦積みに切り替えること
（運用者はスマホ中心。横スクロールが必要な画面を作らない）。

使い方（CSSは `index.html` の `@media(max-width:768px)` ブロックに定義済み）:

1. `<table class="confirm-table">` を付ける
2. 各 `<td>` に `data-label="列名"` を付ける（カード表示時のラベルになる）
3. チェックボックス・削除ボタン等ラベル不要のtdは data-label を付けない
4. セクション見出し行（colspanの帯）は `<tr class="section-row">` を付ける
5. tbody内にソート用ヘッダ行を持つ場合は `<tr class="cost-sort-row">` で モバイル時非表示

例外パターン（既存画面で使用中。新規では原則confirm-tableを使う）:
- `bl-table` + nth-child非表示: ダッシュボード/予約一覧（重要列のみ残す方式）
- `pt-desktop-only`/`pt-mobile-only`: 取引先マスタ（専用カードUI）
- `bt-desktop-only`/`bt-mobile-only`: 新幹線手配（専用カードUI）
- 印刷用プレビュー（Invoice/手配書/精算書等）: A4レイアウト再現のためカード化しない。
  `.tbl-wrap`（overflow-x:auto）で囲み、ページ全体の横スクロールは発生させないこと

変更後は Chrome DevTools のiPhone SE幅(375px)で対象画面に横スクロールが
発生しないことを確認すること。

## ミールバウチャーテンプレートの変更ルール

`index.html` の `_buildVoucherHtml` / `generateMealVoucher` （ミールバウチャーPDF生成ロジック）
にレイアウト・座標・フォントスタイルに関わる変更を加える場合は、**必ず**以下を実行し、
全項目が一致することを確認してから完了報告すること。

```bash
python scripts/verify_voucher_layout.py
```

このスクリプトは、現在のテンプレートから実際にテストデータでPDFを生成し、
確定サンプル（`public/meal_voucher_sample.pdf`）から抽出したベースライン
（`voucher_layout_baseline.json`）と座標(top/left、許容誤差0.6mm)・
フォントスタイル(font-weight)を自動比較し、加えてラベル文字に罫線が重なって
意図しない下線に見えてしまう不具合がないかもチェックする。

不一致が出た場合は、それが以下のいずれかであることを確認すること:

1. **本当のレイアウト回帰** → テンプレートを修正して再実行し、一致させる。
2. **意図的な仕様変更に伴う正当な差分**（例: 手書き記入方式化による数値欄の
   空欄化・幅の変化など）→ `scripts/extract_voucher_baseline.py` 内で
   `skip_left_check_reason` 等により理由を明記した上でベースラインを更新し、
   `python scripts/extract_voucher_baseline.py` を再実行して
   `voucher_layout_baseline.json` を再生成する。

ベースライン自体（サンプルの解析結果）を作り直す必要がある場合のみ、
以下を実行する（通常は再実行不要。サンプルPDFが差し替わった場合等に限る）:

```bash
python scripts/extract_voucher_baseline.py
```

### 前提

- Python 3 + `pdfplumber`（`pip install pdfplumber`）
- Node.js（`_buildVoucherHtml` のソースをそのまま実行するため）
- Google ChromeまたはEdge（headlessでPDF印刷するため。既定パスが見つからない場合は
  環境変数 `CHROME_PATH` で実行ファイルのパスを指定する）
