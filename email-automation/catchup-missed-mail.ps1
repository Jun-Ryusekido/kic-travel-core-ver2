# KIC Travel Core - Outlook email catch-up (scheduled).
# Replaces the old VBS + "/autorun" approach, which never worked:
#   - /autorun was removed from Outlook after 2003 and silently does nothing on
#     Office16; it just launched a second Outlook window.
#   - the VBA Application_Startup path was blocked by a leftover MsgBox.
# This script attaches to the ALREADY-RUNNING Outlook via COM when possible.
# Only when Outlook is not running does it start a new instance, and in that
# case it runs a send/receive (SyncObjects) and waits for SyncEnd before
# processing, so a freshly-started instance never processes a stale inbox.
#
# LastCheck policy (stored where the VBA macros keep it, so both stay in sync:
# HKCU:\Software\VB and VBA Program Settings\KICImport\Settings\LastCheck):
#   - saved as the max ReceivedTime among processed mails (sent or confirmed
#     already-present), never as Now
#   - not saved at all if any batch failed or nothing was processed
# so a failed or half-synced run can never create a permanent gap.
#
# All comments ASCII-only to avoid code-page issues across hosts.

$ErrorActionPreference = 'Stop'

$SUPABASE_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co'
$API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56ZHlnamxuenZ0ZGV6c2xudW95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwODY0NzcsImV4cCI6MjA5NjY2MjQ3N30.eE0lAuWzf-NFHcNNcU1Lk-ubs7K6rKpaMVMoBfML_Aw'
$TARGET_MAILBOX = 'jr@kictravel.jp'
$REG_PATH = 'HKCU:\Software\VB and VBA Program Settings\KICImport\Settings'
$BATCH_SIZE = 200
$SYNC_TIMEOUT_SEC = 180

$logPath = Join-Path $PSScriptRoot 'catchup-log.txt'
function Write-Log([string]$msg){
  $line = ('{0} - {1}' -f (Get-Date -Format 'yyyy/MM/dd HH:mm:ss'), $msg)
  Add-Content -Path $logPath -Value $line -Encoding UTF8
}

function Get-JstString([datetime]$dt){
  # machine runs in JST; ReceivedTime is local time
  return $dt.ToString('yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture) + '+09:00'
}

try{
  # ---- 1. attach to running Outlook, or start a new one ----
  $outlook = $null
  $startedByScript = $false
  try{
    $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
    Write-Log 'Attached to existing Outlook process.'
  }catch{
    $outlook = New-Object -ComObject Outlook.Application
    $startedByScript = $true
    Write-Log 'No running Outlook found - started a new instance.'
  }
  $ns = $outlook.GetNamespace('MAPI')

  # ---- 3. resolve the target inbox (needed before sync so we can watch it) ----
  $inbox = $null
  foreach($store in $ns.Stores){
    if($store.DisplayName -like ('*' + $TARGET_MAILBOX + '*')){
      $inbox = $store.GetDefaultFolder(6)  # olFolderInbox
      break
    }
  }
  if($null -eq $inbox){ $inbox = $ns.GetDefaultFolder(6) }
  Write-Log ('Inbox: ' + $inbox.FolderPath)

  # ---- 2. if we started Outlook ourselves, run send/receive and wait ----
  # The SyncObject.SyncEnd event cannot be hooked from PowerShell (COM source
  # interface is not exposed to Register-ObjectEvent), so instead we Start() the
  # sync and then wait until the inbox item count has stopped changing for a few
  # consecutive polls (settled), or until SYNC_TIMEOUT_SEC elapses.
  if($startedByScript){
    Start-Sleep -Seconds 5   # let MAPI logon settle
    try{
      $syncObjects = $ns.SyncObjects
      if($syncObjects.Count -ge 1){ $syncObjects.Item(1).Start() }
    }catch{
      Write-Log ('WARNING: could not start send/receive (' + $_.Exception.Message + ') - relying on Outlook auto-sync.')
    }
    $waited = 0
    $stableCount = 0
    $prevCount = -1
    while($waited -lt $SYNC_TIMEOUT_SEC){
      Start-Sleep -Seconds 3
      $waited += 3
      $cur = $inbox.Items.Count
      if($cur -eq $prevCount){ $stableCount++ } else { $stableCount = 0 }
      $prevCount = $cur
      # require at least ~15s elapsed and 3 stable polls (9s) before declaring done
      if($waited -ge 15 -and $stableCount -ge 3){ break }
    }
    Write-Log ("Send/receive settled after {0}s (inbox items={1})." -f $waited, $prevCount)
  }

  # ---- 4. read LastCheck ----
  $lastCheck = Get-Date '2026-05-01'
  try{
    $v = (Get-ItemProperty -Path $REG_PATH -ErrorAction Stop).LastCheck
    if($v){ $lastCheck = [datetime]::Parse($v) }
  }catch{}
  Write-Log ('LastCheck = ' + $lastCheck.ToString('yyyy-MM-dd HH:mm:ss'))

  # ---- 5. restrict inbox to mails newer than LastCheck ----
  $filter = "[ReceivedTime] > '" + $lastCheck.ToString('MM/dd/yyyy hh:mm tt', [Globalization.CultureInfo]::InvariantCulture) + "'"
  $items = $inbox.Items.Restrict($filter)
  Write-Log ('Mails newer than LastCheck: ' + $items.Count)

  if($items.Count -eq 0){
    Write-Log 'RESULT: nothing to process. LastCheck unchanged.'
    if($startedByScript){ $outlook.Quit() }
    exit 0
  }

  # ---- 6. load existing sender|received_at keys from the queue (dedupe) ----
  # received_at is timestamptz and comes back as +00:00; normalize to the same
  # +09:00 string we build locally so the comparison actually works.
  $existing = @{}
  try{
    $gteParam = [uri]::EscapeDataString((Get-JstString $lastCheck))
    $url = "$SUPABASE_URL/rest/v1/email_import_queue?select=sender,received_at&received_at=gte.$gteParam"
    $headers = @{ apikey = $API_KEY; Authorization = "Bearer $API_KEY" }
    $rows = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
    foreach($r in $rows){
      $dto = [DateTimeOffset]::Parse($r.received_at)
      $key = $r.sender + '|' + (Get-JstString $dto.ToOffset([TimeSpan]::FromHours(9)).DateTime)
      $existing[$key] = $true
    }
    Write-Log ('Existing queue keys since LastCheck: ' + $existing.Count)
  }catch{
    Write-Log ('WARNING: failed to load existing keys (' + $_.Exception.Message + ') - duplicates may be sent, they are deduped in the UI.')
  }

  # ---- 7. collect new mails ----
  $toSend = New-Object System.Collections.ArrayList
  $totalSkipped = 0
  $maxReceived = [datetime]::MinValue
  for($i = 1; $i -le $items.Count; $i++){
    $itm = $items.Item($i)
    if($itm.Class -ne 43){ continue }   # 43 = olMail
    $received = $itm.ReceivedTime
    if($received -gt $maxReceived){ $maxReceived = $received }
    $receivedStr = Get-JstString $received
    $key = $itm.SenderEmailAddress + '|' + $receivedStr
    if($existing.ContainsKey($key)){
      $totalSkipped++
      continue
    }
    $existing[$key] = $true   # also dedupe within this run
    [void]$toSend.Add(@{
      subject     = [string]$itm.Subject
      body        = [string]$itm.Body
      sender      = [string]$itm.SenderEmailAddress
      received_at = $receivedStr
    })
  }

  # ---- 8. send in batches ----
  $totalSent = 0
  $anyBatchFailed = $false
  for($ofs = 0; $ofs -lt $toSend.Count; $ofs += $BATCH_SIZE){
    $chunk = $toSend[$ofs..([Math]::Min($ofs+$BATCH_SIZE, $toSend.Count)-1)]
    $json = ConvertTo-Json -InputObject @($chunk) -Depth 4 -Compress
    try{
      $headers = @{ apikey = $API_KEY; Authorization = "Bearer $API_KEY"; Prefer = 'return=minimal' }
      Invoke-RestMethod -Uri "$SUPABASE_URL/rest/v1/email_import_queue" -Method Post -Headers $headers `
        -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) | Out-Null
      $totalSent += $chunk.Count
    }catch{
      $anyBatchFailed = $true
      Write-Log ('ERROR: batch starting at ' + $ofs + ' failed: ' + $_.Exception.Message)
    }
  }

  # ---- 9. update LastCheck only on full success, to max processed ReceivedTime ----
  $processedAny = ($totalSent -gt 0 -or $totalSkipped -gt 0)
  if($processedAny -and -not $anyBatchFailed -and $maxReceived -gt [datetime]::MinValue){
    $newVal = $maxReceived.ToString('yyyy-MM-dd HH:mm:ss')
    if(-not (Test-Path $REG_PATH)){ New-Item -Path $REG_PATH -Force | Out-Null }
    Set-ItemProperty -Path $REG_PATH -Name 'LastCheck' -Value $newVal
    Write-Log ("RESULT: sent=$totalSent skipped(existing)=$totalSkipped -> LastCheck updated to $newVal")
  }elseif($anyBatchFailed){
    Write-Log ("RESULT: sent=$totalSent skipped(existing)=$totalSkipped - batch failure, LastCheck NOT updated (will retry next run)")
  }else{
    Write-Log ("RESULT: sent=$totalSent skipped(existing)=$totalSkipped - LastCheck unchanged")
  }

  if($startedByScript){
    $outlook.Quit()
    Write-Log 'Closed the Outlook instance this script started.'
  }
}catch{
  Write-Log ('FATAL: ' + $_.Exception.Message)
  exit 1
}
