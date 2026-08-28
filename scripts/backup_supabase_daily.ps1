# KIC Travel Core - Supabase daily full-table backup script.
#
# 毎時バックアップ(backup_supabase.ps1 / タスクKIC_Supabase_Backup / C:\KIC_Backup / 7日保持)とは
# 別系統の「日次・2箇所保存」バックアップ。Windowsタスクスケジューラの
# KIC_Supabase_Backup_Daily タスク(毎日12:00＋ログオン時)から起動される想定。
#
# 動作:
#   - 全テーブルをJSONとCSVの両形式で取得し、kic_backup_YYYY-MM-DD.zip を作成
#   - 保存先はローカル($LocalBackupDir)とNAS($NasBackupDir)の2箇所
#   - 同日分のZIPが既にローカルにあれば再取得せずスキップ(ログオン時トリガーは
#     「12:00にPCが起動していなかった日の取りこぼし補填」として機能する)。
#     ただしNAS側にコピーが無ければ(前回NAS未接続だった等)コピーだけ追加で行う
#   - NASに到達できない場合はローカルのみ保存し、ログに警告を残して正常終了する
#   - 保持期間を過ぎた古いZIPは自動削除(ローカル30日 / NAS 90日)

# ===== Config =====
$SupabaseUrl  = 'https://nzdygjlnzvtdezslnuoy.supabase.co'
# バックアップ対象のうちerror_logs/guide_bank_accounts/app_users/parking_reservations等は
# セキュリティ強化の一環でanon(publishable)キーからのSELECTを意図的に遮断済み
# (scripts/lock_down_*.sql参照)であり、anonキーでは全テーブルを読めない。バックアップは
# 信頼されたこのPC上でのみ動く管理者用スクリプトのため、RLS/GRANTを問わず全テーブルを
# 読めるservice_roleキーを使う。anonキーへのフォールバックは絶対に行わない
# (静かにanonへ戻ると、一部テーブルが欠けたバックアップが「正常終了」してしまうため)。
$SupabaseKey  = $env:SUPABASE_SERVICE_ROLE_KEY
if ([string]::IsNullOrWhiteSpace($SupabaseKey)) {
  Write-Error 'SUPABASE_SERVICE_ROLE_KEY環境変数が設定されていません。setxコマンドで永続化してから再実行してください(詳細はscripts/backup_supabase_daily.ps1冒頭のコメント、またはこのタスクのPR説明を参照)。anonキーへのフォールバックは行わず、ここで処理を中断します。'
  exit 1
}
$LocalBackupDir = 'C:\Users\jryus\Documents\KIC_Backup'
$NasBackupDir   = '\\LS220D8CB\kic_date\KIC TRAVEL CORE SYSTEM\Supabase_Backup'
$LocalRetentionDays = 30
$NasRetentionDays   = 90

# 全テーブル一覧(index.html / guide.html / api / email-automation / parking-automation を
# 横断して sb.from()/rest/v1 参照を洗い出したもの)。テーブルを新設したらここに追加すること。
$Tables = @(
  'access_logs',
  'agent_info',
  'agents',
  'app_users',
  'arrangement_documents',
  'arrangement_document_days',
  'arrangement_document_notes',
  'booking_buses',
  'booking_costs',
  'booking_edit_presence',
  'booking_facilities',
  'booking_guides',
  'booking_hotels',
  'booking_restaurants',
  'booking_sales',
  'booking_water_items',
  'bookings',
  'bullet_train_arrangements',
  'business_partner_contacts',
  'business_partners',
  'card_holders',
  'credit_card_statements',
  'email_import_queue',
  'error_logs',
  'estimation_booking_reflections',
  'estimation_days',
  'estimation_fit_items',
  'estimation_fixed_rows',
  'estimations',
  'facility_operating_info',
  'guide_bank_accounts',
  'guide_settlement_items',
  'guide_settlements',
  'guides',
  'invoices',
  'learned_mappings',
  'local_expenses',
  'parking_reservations',
  'partner_merge_pending',
  'payments',
  'suppliers',
  'tour_arrangement_days',
  'tour_arrangement_headers',
  'tour_arrangement_notes',
  'tour_arrangements',
  'tour_day_itinerary',
  'tour_guides',
  'vendor_email_logs'
)

# ===== Prepare =====
if (-not (Test-Path $LocalBackupDir)) {
  New-Item -ItemType Directory -Force -Path $LocalBackupDir | Out-Null
}
$logFile = Join-Path $LocalBackupDir 'backup_daily_log.txt'
function Write-Log {
  param([string]$msg)
  $line = "[$( (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') )] $msg"
  Write-Output $line
  Add-Content -Path $logFile -Value $line -Encoding utf8
}

$today   = (Get-Date).ToString('yyyy-MM-dd')
$zipName = "kic_backup_$today.zip"
$localZip = Join-Path $LocalBackupDir $zipName

# NASへのコピー(到達不能なら警告のみで続行)
function Copy-ToNas {
  param([string]$sourceZip)
  try {
    if (-not (Test-Path $NasBackupDir)) {
      New-Item -ItemType Directory -Force -Path $NasBackupDir -ErrorAction Stop | Out-Null
    }
    $nasZip = Join-Path $NasBackupDir (Split-Path $sourceZip -Leaf)
    Copy-Item -Path $sourceZip -Destination $nasZip -Force -ErrorAction Stop
    Write-Log "NAS copy OK: $nasZip"
    return $true
  } catch {
    Write-Log "WARNING: NAS copy failed (NAS未接続の可能性。ローカルのみ保存): $($_.Exception.Message)"
    return $false
  }
}

# ===== 同日分が既に存在する場合: 再取得せずNASコピーの補填のみ =====
if (Test-Path $localZip) {
  Write-Log "===== Daily backup: $zipName already exists locally. Skipping re-fetch. ====="
  $nasZip = Join-Path $NasBackupDir $zipName
  $nasHasCopy = $false
  try { $nasHasCopy = Test-Path $nasZip } catch { $nasHasCopy = $false }
  if (-not $nasHasCopy) {
    Write-Log 'NAS copy missing for today. Attempting copy...'
    Copy-ToNas -sourceZip $localZip | Out-Null
  }
  exit 0
}

Write-Log "===== Daily backup started: $today ====="

$workDir = Join-Path $LocalBackupDir "_work_daily_$today"
if (Test-Path $workDir) { Remove-Item -Recurse -Force $workDir }
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

# CSV用: ネストしたオブジェクト/配列の列(jsonb等)はJSON文字列に変換してから出力する
function Flatten-RowForCsv {
  param($row)
  $flat = [ordered]@{}
  foreach ($p in $row.PSObject.Properties) {
    $v = $p.Value
    if ($null -eq $v) {
      $flat[$p.Name] = ''
    } elseif ($v -is [System.Array] -or $v -is [System.Management.Automation.PSCustomObject]) {
      $flat[$p.Name] = ($v | ConvertTo-Json -Depth 20 -Compress)
    } else {
      $flat[$p.Name] = $v
    }
  }
  [PSCustomObject]$flat
}

# ===== Fetch every table (JSON + CSV) =====
$hadError = $false
$headers = @{
  'apikey'        = $SupabaseKey
  'Authorization' = "Bearer $SupabaseKey"
}
foreach ($table in $Tables) {
  try {
    $allRows = @()
    $pageSize = 1000
    $offset = 0
    while ($true) {
      $uri = "$SupabaseUrl/rest/v1/$table" + "?select=*&order=id&limit=$pageSize&offset=$offset"
      try {
        $resp = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get -ErrorAction Stop
      } catch {
        # id列が無いテーブル等でorder=idが失敗する場合に備え、order無しで再試行する
        $uri2 = "$SupabaseUrl/rest/v1/$table" + "?select=*&limit=$pageSize&offset=$offset"
        $resp = Invoke-RestMethod -Uri $uri2 -Headers $headers -Method Get -ErrorAction Stop
      }
      $count = @($resp).Count
      if ($count -gt 0) { $allRows += $resp }
      if ($count -lt $pageSize) { break }
      $offset += $pageSize
    }

    # JSON
    $json = $allRows | ConvertTo-Json -Depth 20 -Compress
    if ([string]::IsNullOrEmpty($json)) { $json = '[]' }
    Set-Content -Path (Join-Path $workDir "$table.json") -Value $json -Encoding utf8

    # CSV (Excel互換のためBOM付きUTF-8)
    $csvPath = Join-Path $workDir "$table.csv"
    if ($allRows.Count -gt 0) {
      $flatRows = $allRows | ForEach-Object { Flatten-RowForCsv $_ }
      $flatRows | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
    } else {
      Set-Content -Path $csvPath -Value '' -Encoding utf8
    }

    Write-Log "  OK: $table (rows: $($allRows.Count))"
  } catch {
    $hadError = $true
    Write-Log "  ERROR: failed to fetch $table -- $($_.Exception.Message)"
    Set-Content -Path (Join-Path $workDir "$table.ERROR.txt") -Value $_.Exception.Message -Encoding utf8
  }
}

# ===== Zip =====
try {
  if (Test-Path $localZip) { Remove-Item $localZip -Force }
  Compress-Archive -Path (Join-Path $workDir '*') -DestinationPath $localZip -CompressionLevel Optimal
  Write-Log "ZIP created: $localZip"
} catch {
  Write-Log "ERROR: failed to create ZIP -- $($_.Exception.Message)"
  $hadError = $true
}
Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue

# ===== NASへコピー =====
if (Test-Path $localZip) {
  Copy-ToNas -sourceZip $localZip | Out-Null
}

# ===== Retention =====
$localCutoff = (Get-Date).AddDays(-$LocalRetentionDays)
Get-ChildItem -Path $LocalBackupDir -Filter 'kic_backup_*.zip' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt $localCutoff } | ForEach-Object {
    Write-Log "Deleting old local backup: $($_.Name)"
    Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
  }
try {
  $nasCutoff = (Get-Date).AddDays(-$NasRetentionDays)
  Get-ChildItem -Path $NasBackupDir -Filter 'kic_backup_*.zip' -ErrorAction Stop |
    Where-Object { $_.LastWriteTime -lt $nasCutoff } | ForEach-Object {
      Write-Log "Deleting old NAS backup: $($_.Name)"
      Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    }
} catch {
  # NAS未接続時は保持期間処理もスキップ(次回接続時に整理される)
}

if ($hadError) {
  Write-Log '===== Daily backup finished WITH ERRORS ====='
  exit 1
} else {
  Write-Log '===== Daily backup finished OK ====='
  exit 0
}
