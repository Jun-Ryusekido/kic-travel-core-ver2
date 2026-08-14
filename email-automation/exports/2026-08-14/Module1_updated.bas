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
' 2026-08-14以降：本体の送信先は /api/email-import-insert.js（x-import-keyヘッダーによる
' 共有シークレット認証、service_role経由でSupabaseへ書き込み）に統一した。
' email_import_queueへのanon直接INSERTは既に権限剥奪済み(scripts/lock_down_
' email_import_queue_writes.sql)のため、この変更前の実装(旧Supabase直接POST)は
' 実際には失敗していた可能性が高い。
' 重複チェック(IsDuplicateInQueue)・添付ファイルのSupabase Storageアップロード
' (UploadAttachmentsAndGetJson/UploadFileToStorage)は、いずれもINSERTではなく
' 読み取り専用SELECTまたはStorageバケットへの直接アップロードのため、今回もanonキー
' (下記apiKey)のまま変更していない。
Function SendMailItemToKICQueue(objMail As Outlook.mailItem) As Boolean
    Dim http As Object
    Dim shell As Object
    Dim url As String
    Dim apiKey As String
    Dim importApiKey As String
    Dim jsonBody As String
    Dim receivedAtStr As String
    Dim htmlBody As String
    Dim attachmentsJson As String

    On Error GoTo ErrHandler

    apiKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56ZHlnamxuenZ0ZGV6c2xudW95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwODY0NzcsImV4cCI6MjA5NjY2MjQ3N30.eE0lAuWzf-NFHcNNcU1Lk-ubs7K6rKpaMVMoBfML_Aw" ' anon公開鍵（IsDuplicateInQueue・添付アップロード専用。email_import_queueへのINSERTには使わない）

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
    If IsDuplicateInQueue(objMail.SenderEmailAddress, receivedAtStr, apiKey) Then
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
        attachmentsJson = UploadAttachmentsAndGetJson(objMail, apiKey)
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

' 送信者＋受信日時の組み合わせが既にテーブルに存在するか確認する
Function IsDuplicateInQueue(senderAddr As String, receivedAtStr As String, apiKey As String) As Boolean
    Dim http As Object
    Dim url As String

    On Error GoTo ErrHandler

    url = "https://nzdygjlnzvtdezslnuoy.supabase.co/rest/v1/email_import_queue" & _
          "?select=id" & _
          "&sender=eq." & UrlEncode(senderAddr) & _
          "&received_at=eq." & UrlEncode(receivedAtStr)

    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "GET", url, False
    http.setRequestHeader "apikey", apiKey
    http.setRequestHeader "Authorization", "Bearer " & apiKey
    http.Send

    If http.Status = 200 Then
        ' レスポンスが "[]" なら重複なし、それ以外（何か件数がある）なら重複あり
        IsDuplicateInQueue = (Trim(http.responseText) <> "[]")
    Else
        ' 確認に失敗した場合は「重複なし」として扱う（送信自体は継続する）
        Debug.Print "重複チェック失敗 ステータス:" & http.Status
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

' メールの添付ファイルをSupabase Storageにアップロードし、
' [{"filename":"xxx","url":"yyy"}, ...] という形式のJSON文字列を返す
Function UploadAttachmentsAndGetJson(objMail As Outlook.mailItem, apiKey As String) As String
    Dim att As Outlook.Attachment
    Dim jsonArr As String
    Dim isFirst As Boolean
    Dim tempPath As String
    Dim safeFileName As String
    Dim storagePath As String
    Dim uploadUrl As String
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

            Dim result As Boolean
            result = UploadFileToStorage(tempPath, storagePath, apiKey)

            If result Then
                publicUrl = "https://nzdygjlnzvtdezslnuoy.supabase.co/storage/v1/object/public/email-attachments/" & UrlEncode(storagePath)
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

' ファイルをSupabase Storageにバイナリアップロードする
Function UploadFileToStorage(localPath As String, storagePath As String, apiKey As String) As Boolean
    Dim http As Object
    Dim url As String
    Dim stream As Object

    On Error GoTo ErrHandler

    url = "https://nzdygjlnzvtdezslnuoy.supabase.co/storage/v1/object/email-attachments/" & UrlEncode(storagePath)

    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 1 ' バイナリモード
    stream.Open
    stream.LoadFromFile localPath

    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "POST", url, False
    http.setRequestHeader "apikey", apiKey
    http.setRequestHeader "Authorization", "Bearer " & apiKey
    http.setRequestHeader "Content-Type", "application/octet-stream"
    http.Send stream.Read

    stream.Close

    If http.Status = 200 Or http.Status = 201 Then
        UploadFileToStorage = True
    Else
        Debug.Print "ストレージアップロード失敗 ステータス:" & http.Status & " / " & http.responseText
        UploadFileToStorage = False
    End If
    Exit Function

ErrHandler:
    Debug.Print "ストレージアップロードエラー: " & Err.Description
    UploadFileToStorage = False
End Function
