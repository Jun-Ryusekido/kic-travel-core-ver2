VERSION 1.0 CLASS
BEGIN
  MultiUse = -1  'True
END
Attribute VB_Name = "ThisOutlookSession"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = True
Function MailToJsonObject(objMail As Object) As String
    Dim htmlBody As String
    htmlBody = ""
    On Error Resume Next
    htmlBody = objMail.htmlBody
    On Error GoTo 0
    htmlBody = StripEmbeddedImages(htmlBody)
    If Len(htmlBody) > 50000 Then htmlBody = Left(htmlBody, 50000)

    MailToJsonObject = "{""subject"":" & JsonEscape(objMail.Subject) & _
               ",""body"":" & JsonEscape(objMail.Body) & _
               ",""html_body"":" & JsonEscape(htmlBody) & _
               ",""sender"":" & JsonEscape(objMail.SenderEmailAddress) & _
               ",""received_at"":" & JsonEscape(Format(objMail.ReceivedTime, "yyyy-mm-ddThh:mm:ss") & "+09:00") & "}"
End Function

' HTML本文に埋め込まれた画像(data:base64...)は色情報の判定には不要で、
' ペイロードを不必要に肥大化させるだけなので、送信前に除去する。
Function StripEmbeddedImages(html As String) As String
    Dim re As Object
    On Error Resume Next
    Set re = CreateObject("VBScript.RegExp")
    If re Is Nothing Then
        StripEmbeddedImages = html
        Exit Function
    End If
    On Error GoTo 0
    re.Global = True
    re.IgnoreCase = True
    re.Pattern = "<img[^>]*src\s*=\s*[""']data:[^""']*[""'][^>]*>"
    StripEmbeddedImages = re.Replace(html, "")
End Function

