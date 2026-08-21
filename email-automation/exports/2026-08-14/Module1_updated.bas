Attribute VB_Name = "Module1"
' このファイルはShift-JIS(CP932)エンコーディングです。UTF-8への変換・保存は行わないこと。
' 2026-08-14: SendMailItemToKICQueueを、Supabaseへのanonキー直接POSTから
' /api/email-import-insert.js(共有シークレット x-import-key 認証)経由へ切り替えた。
' html_body(ThisOutlookSession.StripEmbeddedImages適用後)・attachments
' (UploadAttachmentsAndGetJsonの戻り値)も新しいペイロードに含める。
Sub SendToKICImportQueue()
    Dim objMail As Outlook.mailItem
    Dim objSelection As Outlook.Selection

    On Error Resume Next
    Set objSelection = Application.ActiveExplorer.Selection
    If objSelection.Count = 0 Then
        MsgBox "メールを1件選択（または開いた状態に）してから実行してください。", vbExclamation
        Exit Sub
    End If
    Set objMail = objSelection.Item(1)
    On Error GoTo 0

    If objMail Is Nothing Then
        MsgBox "メールアイテムを取得できませんでした。", vbExclamation
        Exit Sub
    End If

    Dim result As Boolean
    result = SendMailItemToKICQueue(objMail)

    If result Then
        MsgBox "KIC Travel Coreへの取り込みキューに送信しました。" & vbCrLf & "システム側の「メール受信箱」で取り込んでください。", vbInformation
    Else
        MsgBox "送信されなかった、または送信に失敗しました。詳細はイミディエイトウィンドウを確認してください。", vbCritical
    End If
End Sub

' ===== 実際の送信処理本体（手動・自動どちらからも呼ばれる） =====
' 重複チェック付き：送信者＋受信日時の組み合わせが既に存在する場合は送信をスキップする
' 2026-08-14：本体の送信先を /api/email-import-insert.js（x-import-keyヘッダーによる
' 共有シークレット認証、service_role経由でSupabaseへ書き込み）に統一した。
' email_import_queueへのanon直接INSERTは既に権限剥奪済み(scripts/lock_down_
' email_import_queue_writes.sql)のため、この変更前の実装(旧Supabase直接POST)は
' 実際には失敗していた可能性が高い。
' 2026-08-21：重複チェック(IsDuplicateInQueue)・添付ファイルのSupabase Storageアップロード
' (UploadAttachmentsAndGetJson/UploadFileToStorage)も、anonキーの直接使用をやめ、同じ
' x-import-key共有シークレット(importApiKey)経由に統一した(前者は/api/email-import-insert.js
' のcheckDuplicateアクション、後者は新設の/api/email-attachment-upload.js)。これにより
' このファイル内にanonキー・service_roleキーのいずれも直書きされない状態になった。
Function SendMailItemToKICQueue(objMail As Outlook.mailItem) As Boolean
    Dim http As Object
    Dim shell As Object
    Dim url As String
    Dim importApiKey As String
    Dim jsonBody As String
    Dim receivedAtStr As String
    Dim htmlBody As String
    Dim attachmentsJson As String

    On Error GoTo ErrHandler

    ' ----- /api/email-import-insert.js 用の共有シークレットをレジストリから読み取る -----
    ' catchup-missed-mail.ps1と全く同じレジストリキー・値名を使うことで、鍵を二重管理せず
    ' 共有する(HKEY_CURRENT_USER\Software\VB and VBA Program Settings\KICImport\Settings\
    ' ImportApiKey。ps1側の $REG_PATH と同一)。
    Set shell = CreateObject("WScript.Shell")
    On Error Resume Next
    importApiKey = shell.RegRead("HKEY_CURRENT_USER\Software\VB and VBA Program Settings\KICImport\Settings\ImportApiKey")
    On Error GoTo ErrHandler
    If Len(importApiKey) = 0 Then
        Debug.Print "KIC送信エラー: ImportApiKeyがレジストリに未設定です(HKCU\Software\VB and VBA Program Settings\KICImport\Settings\ImportApiKey)。catchup-missed-mail.ps1のセットアップ手順に従い先に設定してください。"
        SendMailItemToKICQueue = False
        Exit Function
    End If

    receivedAtStr = Format(objMail.ReceivedTime, "yyyy-mm-ddThh:mm:ss") & "+09:00"

    ' ----- 重複チェック -----
    If IsDuplicateInQueue(objMail.SenderEmailAddress, receivedAtStr, importApiKey) Then
        Debug.Print "重複のためスキップ: " & objMail.Subject
        SendMailItemToKICQueue = False
        Exit Function
    End If

    url = "https://kic-travel-core-ver2.vercel.app/api/email-import-insert"

    ' ----- html_body(HTML本文)の取得。ThisOutlookSession.MailToJsonObjectと同じロジック -----
    htmlBody = ""
    On Error Resume Next
    htmlBody = objMail.HTMLBody
    On Error GoTo ErrHandler
    htmlBody = ThisOutlookSession.StripEmbeddedImages(htmlBody)
    If Len(htmlBody) > 50000 Then htmlBody = Left(htmlBody, 50000)

    If objMail.Attachments.Count > 0 Then
        attachmentsJson = UploadAttachmentsAndGetJson(objMail, importApiKey)
    Else
        attachmentsJson = "[]"
    End If

    ' /api/email-import-insert.jsは { "rows": [ {...}, ... ] } の形を要求する
    ' (1件のみの送信でもrows配列でラップする必要がある)。
    jsonBody = "{""rows"":[{" & _
               """subject"":" & JsonEscape(objMail.Subject) & _
               ",""body"":" & JsonEscape(objMail.Body) & _
               ",""sender"":" & JsonEscape(objMail.SenderEmailAddress) & _
               ",""received_at"":" & JsonEscape(receivedAtStr) & _
               ",""html_body"":" & JsonEscape(htmlBody) & _
               ",""attachments"":" & attachmentsJson & _
               "}]}"

    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "POST", url, False
    http.setRequestHeader "x-import-key", importApiKey
    http.setRequestHeader "Content-Type", "application/json"
    http.Send jsonBody

    If http.Status = 200 Or http.Status = 201 Then
        SendMailItemToKICQueue = True
    Else
        Debug.Print "KIC送信失敗 ステータス:" & http.Status & " / " & http.responseText
        SendMailItemToKICQueue = False
    End If
    Exit Function

ErrHandler:
    Debug.Print "KIC送信エラー: " & Err.Description
    SendMailItemToKICQueue = False
End Function

' 送信者＋受信日時の組み合わせが既にテーブルに存在するか確認する。以前はanonキーで
' Supabaseへ直接GETしていたが、他のVBA→Supabase書き込み経路と同じくx-import-key経由の
' /api/email-import-insert.js(action:"checkDuplicate")に統一した(2026-08-21)。
Function IsDuplicateInQueue(senderAddr As String, receivedAtStr As String, importApiKey As String) As Boolean
    Dim http As Object
    Dim url As String
    Dim jsonBody As String

    On Error GoTo ErrHandler

    url = "https://kic-travel-core-ver2.vercel.app/api/email-import-insert"
    jsonBody = "{""action"":""checkDuplicate"",""sender"":" & JsonEscape(senderAddr) & _
               ",""receivedAt"":" & JsonEscape(receivedAtStr) & "}"

    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "POST", url, False
    http.setRequestHeader "x-import-key", importApiKey
    http.setRequestHeader "Content-Type", "application/json"
    http.Send jsonBody

    If http.Status = 200 Then
        ' 簡易パーサー: レスポンスJSONに "duplicate":true が含まれるかだけを見る
        ' (このファイルは他のJSON応答も同様にパーサーを使わず簡易的に扱っている)
        IsDuplicateInQueue = (InStr(http.responseText, """duplicate"":true") > 0)
    Else
        ' 確認に失敗した場合は「重複なし」として扱う（送信自体は継続する）
        Debug.Print "重複チェック失敗 ステータス:" & http.Status & " / " & http.responseText
        IsDuplicateInQueue = False
    End If
    Exit Function

ErrHandler:
    Debug.Print "重複チェックエラー: " & Err.Description
    IsDuplicateInQueue = False
End Function

Function JsonEscape(s As String) As String
    Dim r As String
    r = s
    r = Replace(r, "\", "\\")
    r = Replace(r, """", "\""")
    r = Replace(r, vbCrLf, "\n")
    r = Replace(r, vbCr, "\n")
    r = Replace(r, vbLf, "\n")
    r = Replace(r, vbTab, "\t")
    JsonEscape = """" & r & """"
End Function

' URLエンコード（クエリパラメータ・ストレージパス等、英数字以外を想定した簡易版）
Function UrlEncode(s As String) As String
    Dim i As Long
    Dim c As String
    Dim result As String
    result = ""
    For i = 1 To Len(s)
        c = Mid(s, i, 1)
        Select Case c
            Case "A" To "Z", "a" To "z", "0" To "9", "-", "_", ".", "~"
                result = result & c
            Case Else
                result = result & "%" & Right("0" & Hex(Asc(c)), 2)
        End Select
    Next i
    UrlEncode = result
End Function

' 単純なJSON文字列から "fieldName":"value" 形式の値だけを取り出す簡易パーサー。
' このファイルは他のJSON応答も同様にパーサーを使わず簡易的に扱っているため同じ方針を
' 踏襲する(ネストしたJSON・エスケープされたダブルクォートを含む値には対応しない。
' publicUrl等、この用途で実際に返る値はいずれも単純な文字列のため問題ない)。
Function ExtractJsonStringField(json As String, fieldName As String) As String
    Dim marker As String
    Dim valStart As Long, valEnd As Long
    marker = """" & fieldName & """:"""
    valStart = InStr(json, marker)
    If valStart = 0 Then
        ExtractJsonStringField = ""
        Exit Function
    End If
    valStart = valStart + Len(marker)
    valEnd = InStr(valStart, json, """")
    If valEnd = 0 Then
        ExtractJsonStringField = ""
        Exit Function
    End If
    ExtractJsonStringField = Mid(json, valStart, valEnd - valStart)
End Function

' VBAには標準のBase64エンコード関数が無いため、MSXML2.DOMDocumentのbin.base64型ノードを
' 利用する定番の手法でエンコードする(Windows標準搭載のMSXMLで動作し、追加のライブラリ
' 参照登録は不要)。/api/email-attachment-upload.jsへ添付ファイルの中身を送るために使う。
Function Base64EncodeBytes(bytes() As Byte) As String
    Dim objXML As Object
    Dim objNode As Object
    Set objXML = CreateObject("MSXML2.DOMDocument")
    Set objNode = objXML.createElement("b64")
    objNode.DataType = "bin.base64"
    objNode.nodeTypedValue = bytes
    Base64EncodeBytes = objNode.Text
    Set objNode = Nothing
    Set objXML = Nothing
End Function

' メールの添付ファイルをSupabase Storageにアップロードし、
' [{"filename":"xxx","url":"yyy"}, ...] という形式のJSON文字列を返す
Function UploadAttachmentsAndGetJson(objMail As Outlook.mailItem, importApiKey As String) As String
    Dim att As Outlook.Attachment
    Dim jsonArr As String
    Dim isFirst As Boolean
    Dim tempPath As String
    Dim safeFileName As String
    Dim storagePath As String
    Dim publicUrl As String

    jsonArr = "["
    isFirst = True

    For Each att In objMail.Attachments
        ' 埋め込み画像（署名の画像など）は除外
        If att.Type <> olEmbeddeditem Then
            On Error Resume Next
            tempPath = Environ("TEMP") & "\" & att.FileName
            att.SaveAsFile tempPath

            safeFileName = Format(Now, "yyyymmddhhmmss") & "_" & att.FileName
            storagePath = safeFileName

            publicUrl = UploadFileToStorage(tempPath, storagePath, importApiKey)

            If Len(publicUrl) > 0 Then
                If Not isFirst Then jsonArr = jsonArr & ","
                jsonArr = jsonArr & "{""filename"":" & JsonEscape(att.FileName) & ",""url"":" & JsonEscape(publicUrl) & "}"
                isFirst = False
            Else
                Debug.Print "添付ファイルのアップロードに失敗: " & att.FileName
            End If

            ' 一時ファイルを削除
            If Dir(tempPath) <> "" Then Kill tempPath
            On Error GoTo 0
        End If
    Next att

    jsonArr = jsonArr & "]"
    UploadAttachmentsAndGetJson = jsonArr
End Function

' ファイル1件あたりのサイズ上限(バイト)。/api/email-attachment-upload.js側の上限(15MB)より
' 手前で、かつBase64化による約1.33倍の膨張後もVercelのリクエストボディ上限(約4.5MB)に
' 収まるよう、実ファイルで約3MBを上限として事前チェックする(サーバー側の413を待たず、
' ここで分かりやすいログを出してこの添付だけスキップする)。
Const MAX_ATTACHMENT_BYTES As Long = 3 * 1024 * 1024

' ファイルをSupabase Storageにアップロードする。以前はanonキーでSupabase Storage APIへ
' 直接POSTしていたが、他のVBA→Supabase書き込み経路と同じくx-import-key経由の
' service_role backedエンドポイント(/api/email-attachment-upload)に統一した(2026-08-21)。
' ファイル内容をBase64化してJSONで送信する方式に変わったため、返り値もBoolean(成功/失敗)
' ではなく、実際に保存されたファイルの公開URL(String。失敗時は空文字)に変更した。
Function UploadFileToStorage(localPath As String, storagePath As String, importApiKey As String) As String
    Dim http As Object
    Dim url As String
    Dim stream As Object
    Dim fileBytes() As Byte
    Dim base64Content As String
    Dim jsonBody As String

    On Error GoTo ErrHandler

    If FileLen(localPath) > MAX_ATTACHMENT_BYTES Then
        Debug.Print "ストレージアップロードをスキップ(サイズ上限" & (MAX_ATTACHMENT_BYTES \ 1024 \ 1024) & "MB超過): " & localPath
        UploadFileToStorage = ""
        Exit Function
    End If

    url = "https://kic-travel-core-ver2.vercel.app/api/email-attachment-upload"

    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 1 ' バイナリモード
    stream.Open
    stream.LoadFromFile localPath
    fileBytes = stream.Read
    stream.Close

    base64Content = Base64EncodeBytes(fileBytes)

    jsonBody = "{""storagePath"":" & JsonEscape(storagePath) & _
               ",""contentBase64"":""" & base64Content & """}"

    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "POST", url, False
    http.setRequestHeader "x-import-key", importApiKey
    http.setRequestHeader "Content-Type", "application/json"
    http.Send jsonBody

    If http.Status = 200 Or http.Status = 201 Then
        UploadFileToStorage = ExtractJsonStringField(http.responseText, "publicUrl")
    Else
        Debug.Print "ストレージアップロード失敗 ステータス:" & http.Status & " / " & http.responseText
        UploadFileToStorage = ""
    End If
    Exit Function

ErrHandler:
    Debug.Print "ストレージアップロードエラー: " & Err.Description
    UploadFileToStorage = ""
End Function
