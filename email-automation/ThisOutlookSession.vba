実機エクスポート(2026/08/14)に基づく正確な記録

■このファイルについて
このファイルはVBAコードではありません。以前このファイルには「ThisOutlookSession」の
実装として、Application_Startup・GetKICInboxFolder・olApp_NewMailEx等の関数を含む
VBAコードが置かれていましたが、これは実機の内容と一致しない「空想の再構築ファイル」
であることが2026/08/14のセッションで判明しました（実機エクスポートと突き合わせた結果、
該当する関数は実機のThisOutlookSessionには一つも存在しません）。今後、このファイルを
実装コードとして参照・信用しないでください。

実機の正確なコードは、2026/08/14にJUNさんの実機からエクスポートされた以下の2ファイルが
唯一の正しい情報源です：
  - email-automation/exports/2026-08-14/ThisOutlookSession.cls
  - email-automation/exports/2026-08-14/Module1_updated.bas
    （Module1_updated.basは、送信先をSupabase直接POSTから/api/email-import-insert.js
    経由に切り替えた更新版。切り替え前のオリジナル版は
    2026/08/14セッションのチャット履歴に全文が貼付されている）

■実機の正確なモジュール構成
実機のOutlook VBAプロジェクトは、想定と異なり以下の2モジュール構成です。
「送信処理の本体」はThisOutlookSessionではなくModule1側にあります。

【ThisOutlookSession（クラスモジュール、VB_PredeclaredId=True）】
  関数はこの2つのみ：

  1. MailToJsonObject(objMail As Object) As String
     メール1件(objMail)から、subject・body・html_body・sender・received_atを含む
     JSON文字列を組み立てて返す関数。HTTP送信は一切行わない。
     html_bodyはobjMail.htmlBodyを取得し、StripEmbeddedImagesで埋め込み画像
     (data:base64の<img>タグ)を除去した上で、50,000文字を超える場合は切り詰める。
     ★2026/08/14時点で判明した重要な事実：この関数はModule1.bas・
     catchup-missed-mail.ps1のどちらからも呼ばれておらず、宙に浮いた未使用関数
     だった（grepで確認済み。catchup-missed-mail.ps1はOutlook COM経由での
     MailToJsonObject呼び出しを一切行わず、PowerShell側で独自にペイロードを
     組み立てていた）。

  2. StripEmbeddedImages(html As String) As String
     HTML本文に埋め込まれた画像(<img src="data:...">)を正規表現(VBScript.RegExp)
     で除去する。MailToJsonObjectから呼ばれる他、VB_PredeclaredId=Trueのため
     Module1側からも ThisOutlookSession.StripEmbeddedImages(html) の形で
     呼び出し可能（2026/08/14の変更でModule1.basのSendMailItemToKICQueueから
     実際に呼び出すようにした）。

  Application_Startup・GetKICInboxFolder・olApp_NewMailEx等、以前このファイルに
  記載されていた関数は実機には存在しません。

【Module1（標準モジュール）】
  実際の送信処理はすべてこちらに実装されています：

  1. SendToKICImportQueue()
     Outlookのリボン等から手動実行されるSub。選択中のメール1件を取得し、
     SendMailItemToKICQueueを呼んで結果をMsgBoxで表示する（「手動送信ボタン」の実体）。

  2. SendMailItemToKICQueue(objMail As Outlook.mailItem) As Boolean
     実際の送信処理本体。手動(SendToKICImportQueue)からのみ呼ばれる
     （catchup-missed-mail.ps1からは呼ばれない。自動取り込みはps1側が独自に
     HTTP送信まで完結させている）。
     2026/08/14時点のオリジナル版は、email_import_queueへSupabase anonキーで
     直接POSTしていた（html_bodyは含まず、subject/body/sender/received_at/
     attachmentsのみ）。同日中に、送信先を/api/email-import-insert.js
     （x-import-keyヘッダーによる共有シークレット認証）経由に切り替え、
     html_body（StripEmbeddedImages適用・50,000文字上限）も含めるよう更新した。
     2026/08/21：内部で呼ぶIsDuplicateInQueue/UploadAttachmentsAndGetJsonへ渡す
     引数も、anonキー(apiKey)からimportApiKeyに置き換えた（詳細は下記3・6参照）。
     （詳細はModule1_updated.bas参照）。

  3. IsDuplicateInQueue(senderAddr, receivedAtStr, importApiKey) As Boolean
     送信者＋受信日時の組み合わせが既にemail_import_queueに存在するか確認する。
     2026/08/14時点はSupabase anonキーでのGET(SELECT)直接問い合わせだったが、
     2026/08/21に/api/email-import-insert.jsの新設アクション(action:"checkDuplicate"、
     x-import-keyヘッダー認証・service_role経由)へ切り替えた。読み取り専用のため
     書き込みリスクは元々無かったが、VBAソースにanonキーを残さないための対応。

  4. JsonEscape(s As String) As String
     文字列をJSON文字列リテラルとしてエスケープする（バックスラッシュ・
     ダブルクォート・改行・タブ）。

  5. UrlEncode(s As String) As String
     クエリパラメータ用の簡易URLエンコード。2026/08/21のStorage直接POST廃止に
     伴い、Storageパスの組み立てには使わなくなった（用途は残存するため関数自体は維持）。

  6. ExtractJsonStringField(json As String, fieldName As String) As String 【2026/08/21新設】
     単純なJSON文字列から"fieldName":"value"形式の値だけを取り出す簡易パーサー。
     UploadFileToStorageが/api/email-attachment-upload.jsの応答からpublicUrlを
     取り出すために使う（このファイル群は他のJSON応答も同様にパーサーを使わず
     簡易的に扱っているため同じ方針。ネストしたJSON・エスケープされたダブル
     クォートを含む値には対応しない）。

  7. Base64EncodeBytes(bytes() As Byte) As String 【2026/08/21新設】
     VBAには標準のBase64エンコード関数が無いため、MSXML2.DOMDocumentの
     bin.base64型ノードを利用する定番の手法でエンコードする。添付ファイルの
     中身を/api/email-attachment-upload.jsへJSONで送るために使う。

  8. UploadAttachmentsAndGetJson(objMail, importApiKey) As String
     メールの添付ファイル(埋め込み画像を除く)をSupabase Storageの
     email-attachmentsバケットへアップロードし、[{"filename":...,"url":...}, ...]
     形式のJSON文字列を返す。2026/08/14時点はスコープ外・anonキーのまま維持していたが、
     2026/08/21にUploadFileToStorage経由でx-import-key方式へ切り替えた。

  9. UploadFileToStorage(localPath, storagePath, importApiKey) As String 【2026/08/21更新】
     1ファイルをSupabase Storageへアップロードする（8から呼ばれる）。
     2026/08/14時点はanonキーでSupabase Storage APIへ直接バイナリPOSTしていたが、
     2026/08/21に新設の/api/email-attachment-upload.js（x-import-keyヘッダー認証、
     service_role経由）へ切り替えた。ファイル内容をBase64EncodeBytesでBase64化し
     JSONで送信する方式に変わったため、戻り値もBoolean(成功/失敗)から、実際に
     保存されたファイルの公開URL(String。失敗時は空文字)に変更した。
     ファイルサイズが約3MBを超える場合は、アップロード自体を試みずスキップする
     （Base64化による約1.33倍の膨張とVercelのリクエストボディ上限を考慮した事前チェック）。

■このファイルの位置づけ
上記の通り、このファイルは実装コードの代替ではなく、実機の構造を正確に記録した
ドキュメントです。実際のコードを確認・変更する場合は、必ず
email-automation/exports/2026-08-14/ 配下の実機エクスポートファイル
（Shift-JIS/CP932エンコーディング。UTF-8への変換・保存は行わないこと）を参照してください。
