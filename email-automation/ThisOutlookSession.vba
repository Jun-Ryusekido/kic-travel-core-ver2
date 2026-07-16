Private WithEvents olApp As Outlook.Application

Private Sub Application_Startup()
    ' NOTE: never show MsgBox or any dialog here - it blocks unattended runs.
    ' Scheduled catch-up is handled by catchup-missed-mail.ps1 (Task Scheduler),
    ' so CatchUpMissedMail is NOT called here anymore.
    ' olApp must still be set: it powers olApp_NewMailEx (real-time import).
    Set olApp = Application
End Sub

Function GetKICInboxFolder() As Outlook.Folder
    Dim ns As Outlook.NameSpace
    Dim st As Outlook.Store
    Dim targetStore As Outlook.Store

    Set ns = Application.GetNamespace("MAPI")

    For Each st In ns.Stores
        If InStr(1, st.DisplayName, "jr@kictravel.jp", vbTextCompare) > 0 Then
            Set targetStore = st
            Exit For
        End If
    Next st

    If targetStore Is Nothing Then
        Set GetKICInboxFolder = ns.GetDefaultFolder(olFolderInbox)
    Else
        Set GetKICInboxFolder = targetStore.GetDefaultFolder(olFolderInbox)
    End If
End Function

' 事前に、lastCheck以降で既にemail_import_queueに存在する「sender|received_at」の組み合わせを
' Collectionに読み込んでおく（1回のGETリクエストのみ）
Function LoadExistingKeys(lastCheck As Date, apiKey As String) As Object
    Dim http As Object
    Dim url As String
    Dim dict As Object
    Set dict = CreateObject("Scripting.Dictionary")

    Dim lastCheckStr As String
    lastCheckStr = Format(lastCheck, "yyyy-mm-ddThh:mm:ss") & "+09:00"

    On Error GoTo ErrHandler

    url = "https://nzdygjlnzvtdezslnuoy.supabase.co/rest/v1/email_import_queue" & _
          "?select=sender,received_at" & _
          "&received_at=gte." & UrlEncode(lastCheckStr)

    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "GET", url, False
    http.setRequestHeader "apikey", apiKey
    http.setRequestHeader "Authorization", "Bearer " & apiKey
    http.Send

    If http.Status = 200 Then
        Dim jsonText As String
        jsonText = http.responseText
        ' 簡易パース："sender":"xxx","received_at":"yyy" のペアを正規表現無しで拾う
        Dim parts() As String
        parts = Split(jsonText, "{")
        Dim i As Long
        For i = 1 To UBound(parts)
            Dim seg As String
            seg = parts(i)
            Dim senderVal As String, receivedVal As String
            senderVal = ExtractJsonValue(seg, "sender")
            receivedVal = ExtractJsonValue(seg, "received_at")
            If senderVal <> "" And receivedVal <> "" Then
                Dim key As String
                key = senderVal & "|" & receivedVal
                If Not dict.Exists(key) Then dict.Add key, True
            End If
        Next i
    Else
        Debug.Print "既存データ取得失敗 ステータス:" & http.Status
    End If

    Set LoadExistingKeys = dict
    Exit Function

ErrHandler:
    Debug.Print "既存データ取得エラー: " & Err.Description
    Set LoadExistingKeys = dict
End Function

' JSON文字列の断片から、指定したキーの値だけを簡易的に取り出す
Function ExtractJsonValue(seg As String, keyName As String) As String
    Dim searchStr As String
    searchStr = """" & keyName & """:"""
    Dim p As Long
    p = InStr(seg, searchStr)
    If p = 0 Then
        ExtractJsonValue = ""
        Exit Function
    End If
    Dim startPos As Long
    startPos = p + Len(searchStr)
    Dim endPos As Long
    endPos = InStr(startPos, seg, """")
    If endPos = 0 Then
        ExtractJsonValue = ""
        Exit Function
    End If
    ExtractJsonValue = Mid(seg, startPos, endPos - startPos)
End Function

' Outlook起動時に、前回チェック時刻より新しい未処理メールをまとめて送信する
' 日付でフィルタしてから処理するので、受信トレイの総件数に関わらず高速
' 事前に既存レコードを取得し、重複するものはスキップする
Sub CatchUpMissedMail()
    ' Manual catch-up (scheduled runs use catchup-missed-mail.ps1 instead).
    ' LastCheck policy: save the max ReceivedTime among processed mails,
    ' and only when every batch was sent successfully.
    Dim inboxFolder As Outlook.Folder
    Dim itm As Object
    Dim lastCheck As Date
    Dim lastCheckStr As String
    Dim apiKey As String

    apiKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56ZHlnamxuenZ0ZGV6c2xudW95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwODY0NzcsImV4cCI6MjA5NjY2MjQ3N30.eE0lAuWzf-NFHcNNcU1Lk-ubs7K6rKpaMVMoBfML_Aw"

    On Error Resume Next
    Set inboxFolder = GetKICInboxFolder()
    On Error GoTo 0

    If inboxFolder Is Nothing Then
        Debug.Print "CatchUpMissedMail: could not resolve inbox folder."
        Exit Sub
    End If

    lastCheckStr = GetSetting("KICImport", "Settings", "LastCheck", "")
    If lastCheckStr = "" Then
        lastCheck = DateSerial(2026, 5, 1)
    Else
        On Error Resume Next
        lastCheck = CDate(lastCheckStr)
        On Error GoTo 0
        If lastCheck = 0 Then lastCheck = DateSerial(2026, 5, 1)
    End If

    Debug.Print "CatchUpMissedMail: start. lastCheck=" & lastCheck

    Dim filterStr As String
    filterStr = "[ReceivedTime] > '" & Format(lastCheck, "mm/dd/yyyy hh:mm AM/PM") & "'"

    Dim items As Outlook.items
    On Error Resume Next
    Set items = inboxFolder.items.Restrict(filterStr)
    On Error GoTo 0

    If items Is Nothing Then
        Debug.Print "CatchUpMissedMail: Restrict failed."
        Exit Sub
    End If

    Dim existingKeys As Object
    Set existingKeys = LoadExistingKeys(lastCheck, apiKey)

    Dim jsonArray As String
    Dim itemCountInBatch As Long
    Dim batchNum As Long
    Dim totalSent As Long
    Dim totalSkipped As Long
    Dim BATCH_SIZE As Long
    Dim maxReceived As Date
    Dim anyBatchFailed As Boolean
    BATCH_SIZE = 200

    jsonArray = "["
    itemCountInBatch = 0
    batchNum = 0
    totalSent = 0
    totalSkipped = 0
    maxReceived = 0
    anyBatchFailed = False

    Dim i As Long
    For i = 1 To items.Count
        On Error Resume Next
        Set itm = items(i)
        On Error GoTo 0

        If Not itm Is Nothing Then
            If itm.Class = olMail Then
                If itm.ReceivedTime > maxReceived Then maxReceived = itm.ReceivedTime
                Dim receivedAtStr As String
                receivedAtStr = Format(itm.ReceivedTime, "yyyy-mm-ddThh:mm:ss") & "+09:00"
                Dim keyCheck As String
                keyCheck = itm.SenderEmailAddress & "|" & receivedAtStr

                If existingKeys.Exists(keyCheck) Then
                    totalSkipped = totalSkipped + 1
                Else
                    If itemCountInBatch > 0 Then jsonArray = jsonArray & ","
                    jsonArray = jsonArray & MailToJsonObject(itm)
                    itemCountInBatch = itemCountInBatch + 1
                    existingKeys.Add keyCheck, True
                End If
            End If
        End If
        Set itm = Nothing

        If itemCountInBatch >= BATCH_SIZE Then
            jsonArray = jsonArray & "]"
            batchNum = batchNum + 1
            If SendBatchToKICQueue(jsonArray) Then
                totalSent = totalSent + itemCountInBatch
            Else
                anyBatchFailed = True
                Debug.Print "CatchUpMissedMail: batch " & batchNum & " failed"
            End If
            jsonArray = "["
            itemCountInBatch = 0
            DoEvents
        End If
    Next i

    If itemCountInBatch > 0 Then
        jsonArray = jsonArray & "]"
        batchNum = batchNum + 1
        If SendBatchToKICQueue(jsonArray) Then
            totalSent = totalSent + itemCountInBatch
        Else
            anyBatchFailed = True
            Debug.Print "CatchUpMissedMail: batch " & batchNum & " failed"
        End If
    End If

    If maxReceived > DateSerial(1900, 1, 1) And Not anyBatchFailed Then
        SaveSetting "KICImport", "Settings", "LastCheck", Format(maxReceived, "yyyy-mm-dd hh:mm:ss")
        Debug.Print "CatchUpMissedMail: LastCheck updated to " & Format(maxReceived, "yyyy-mm-dd hh:mm:ss")
    ElseIf anyBatchFailed Then
        Debug.Print "CatchUpMissedMail: batch failure - LastCheck NOT updated"
    End If

    Debug.Print "CatchUpMissedMail: done. sent=" & totalSent & " skipped=" & totalSkipped
End Sub

Function MailToJsonObject(objMail As Object) As String
    MailToJsonObject = "{""subject"":" & JsonEscape(objMail.Subject) & _
               ",""body"":" & JsonEscape(objMail.Body) & _
               ",""sender"":" & JsonEscape(objMail.SenderEmailAddress) & _
               ",""received_at"":" & JsonEscape(Format(objMail.ReceivedTime, "yyyy-mm-ddThh:mm:ss") & "+09:00") & "}"
End Function

Function SendBatchToKICQueue(jsonArray As String) As Boolean
    Dim http As Object
    Dim url As String
    Dim apiKey As String

    On Error GoTo ErrHandler

    apiKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56ZHlnamxuenZ0ZGV6c2xudW95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwODY0NzcsImV4cCI6MjA5NjY2MjQ3N30.eE0lAuWzf-NFHcNNcU1Lk-ubs7K6rKpaMVMoBfML_Aw" ' ← 既存の本物のキーのまま
    url = "https://nzdygjlnzvtdezslnuoy.supabase.co/rest/v1/email_import_queue"

    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "POST", url, False
    http.setRequestHeader "apikey", apiKey
    http.setRequestHeader "Authorization", "Bearer " & apiKey
    http.setRequestHeader "Content-Type", "application/json"
    http.setRequestHeader "Prefer", "return=minimal"
    http.Send jsonArray

    If http.Status = 201 Or http.Status = 200 Then
        SendBatchToKICQueue = True
    Else
        Debug.Print "バッチ送信失敗 ステータス:" & http.Status & " / " & http.responseText
        SendBatchToKICQueue = False
    End If
    Exit Function

ErrHandler:
    Debug.Print "バッチ送信エラー: " & Err.Description
    SendBatchToKICQueue = False
End Function

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

Private Sub olApp_NewMailEx(ByVal EntryIDCollection As String)
    Dim ns As Outlook.NameSpace
    Dim mailItem As Object
    Dim ids() As String
    Dim i As Long
    Dim ok As Boolean

    Set ns = Application.GetNamespace("MAPI")
    ids = Split(EntryIDCollection, ",")

    For i = LBound(ids) To UBound(ids)
        On Error Resume Next
        Set mailItem = ns.GetItemFromID(ids(i))
        On Error GoTo 0

        If Not mailItem Is Nothing Then
            If mailItem.Class = olMail Then
                ok = SendMailItemToKICQueue(mailItem)
                If ok Then
                    ' Save the mail's own ReceivedTime (not Now) so that a gap can
                    ' never be created between LastCheck and unprocessed mails.
                    Dim lastCheckStr As String
                    Dim curLast As Date
                    lastCheckStr = GetSetting("KICImport", "Settings", "LastCheck", "")
                    curLast = 0
                    On Error Resume Next
                    If lastCheckStr <> "" Then curLast = CDate(lastCheckStr)
                    On Error GoTo 0
                    If mailItem.ReceivedTime > curLast Then
                        SaveSetting "KICImport", "Settings", "LastCheck", Format(mailItem.ReceivedTime, "yyyy-mm-dd hh:mm:ss")
                    End If
                Else
                    Debug.Print "auto-send skipped or failed: " & mailItem.Subject
                End If
            End If
        End If
        Set mailItem = Nothing
    Next i
End Sub
