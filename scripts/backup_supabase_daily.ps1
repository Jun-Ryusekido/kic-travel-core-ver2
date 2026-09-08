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
#
# 差分バックアップ(2026-09-07追加、email_import_queue専用):
#   email_import_queueは1万件超・1行あたりの本文が大きく、egress(データ転送量)の
#   大半を占めていたため($CreatedAtDiffTablesに列挙したテーブルのみ)、前回成功時刻
#   (状態ファイル)以降にcreated_atされた行だけを取得する。それ以外のテーブルは
#   従来通り全件取得。
#   backup_supabase.ps1の$DiffTables(updated_at基準)とは別の仕組みであることに注意。
#   email_import_queueはimported/ignored/is_excluded等のフラグが後から更新されうるが、
#   created_at基準の差分では「作成後に状態が変わった既存行」は再取得されない
#   (=その日以降のバックアップ内容は作成時点の状態のまま古くなる)。これは許容する
#   トレードオフとして採用した(状態が確定した行は定期的にemail_import_queue_archiveへ
#   移動されるため、その時点の最終状態はアーカイブ側のバックアップで捕捉される)。
#   状態ファイル: scripts/data/backup_daily_last_success.json (テーブルごとに個別の時刻)。
#   このファイルは.gitignore対象(scripts/data/*)のため、リポジトリにはコミットされない。
#
# 差分バックアップ(2026-09-08追加、updated_at基準): booking_costs/booking_buses/
#   booking_restaurantsは行数が多く更新頻度も高いため($UpdatedAtDiffTablesに列挙した
#   テーブルのみ)、backup_supabase.ps1の$DiffTablesと全く同じ考え方で、前回成功時刻
#   (状態ファイル、上記と同じ$StateFileを共有)以降にupdated_atが更新された行だけを
#   取得する。3テーブルともTABLE_CONFIG(api/table-crud.js)でstampUpdatedAt: trueが
#   設定済み・書き込みが全てtable-crud.js経由であることを確認済み。
#   毎時バックアップと異なり1日1回(未実行日の補填含む)しか走らないため、当日分の
#   JSON/CSVには「前回の日次バックアップ成功時刻以降に更新された行」のみが入り、
#   更新されていない既存行は含まれない点に注意(=1日分のzip単体は当該3テーブルの
#   全件スナップショットにはならない。全件が必要な場合は該当日以前のzipも合わせて
#   参照する必要がある。ローカル30日/NAS90日の保持期間内は復元可能)。
# -StateFileOverrideは検証専用のパラメータ。Windowsタスクスケジューラからの通常実行では
# 指定せず、既定値(scripts/data/backup_daily_last_success.json)を使う。
param(
  [string]$StateFileOverride
)

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
$StateFile = if ($StateFileOverride) { $StateFileOverride } else { Join-Path $PSScriptRoot 'data\backup_daily_last_success.json' }

# created_at基準の差分取得の対象(スクリプト冒頭コメント参照)。他のテーブルを追加する
# 場合は、created_at列が存在すること、かつ「作成後に状態が変わらない」または「状態変化を
# 追跡しなくても許容できる」テーブルであることを確認してから追加すること。
$CreatedAtDiffTables = @(
  'email_import_queue'
)

# updated_at基準の差分取得の対象(スクリプト冒頭コメント参照)。backup_supabase.ps1の
# $DiffTablesと同じ基準・同じ制約(updated_at列あり+書き込みが全てtable-crud.js経由で
# あることを確認済み)。他のテーブルを追加する場合も同様に確認してから追加すること。
$UpdatedAtDiffTables = @(
  'booking_costs',
  'booking_buses',
  'booking_restaurants'
)

# 全テーブル一覧(index.html / guide.html / api / email-automation / parking-automation を
# 横断して sb.from()/rest/v1 参照を洗い出したもの)。テーブルを新設したらここに追加すること。
# 2026-09-07: agent_info/payments/suppliersはコード参照0件・TABLE_CONFIG未登録の
# 旧システムの名残(agent_infoはagentsテーブルへ機能移管済み、paymentsは入出金管理の
# 旧実装、suppliersはbusiness_partnersへ完全移行済み)と判明したため、バックアップ後に
# DROP TABLEで削除し、ここからも除外した。
# 2026-09-08: partner_merge_pending(名刺スキャン自動マージの「保留」機能用テーブル)も
# 同様にコード参照0件の孤児テーブルと判明したため、scripts/drop_partner_merge_pending.sql
# でDROP TABLEし、ここからも除外した(保留機能自体はPR #121で完全削除済み)。
# 2026-09-07: email_import_queue_archive(email_import_queueの解決済み・30日以上前の
# 行を移動する退避テーブル)は意図的にここへ含めない。egress削減が目的で新設した
# テーブルであり、移動時点までの内容は移動元email_import_queueの日次バックアップ
# (このzip)に既に含まれているため、退避後にあらためて毎日バックアップし直す必要が
# 薄いと判断した。万一将来的に必要になった場合は、頻度を落として(例: 月次)別途
# バックアップする運用を検討すること。
$Tables = @(
  'access_logs',
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

# ===== 差分バックアップの状態ファイル読み込み(created_at/updated_at共通) =====
# ファイルが存在しない、または壊れて読み込めない場合は空のハッシュテーブルを返す。
# これにより「stateが無い/壊れている」場合は$CreatedAtDiffTables/$UpdatedAtDiffTablesの
# 対象テーブルが「前回時刻なし」扱いになり、自動的に全件取得(初回相当)にフォールバックする
# (backup_supabase.ps1のGet-BackupStateと同じ考え方)。
function Get-BackupState {
  param([string]$path)
  if (-not (Test-Path $path)) { return @{} }
  try {
    $raw = Get-Content -Path $path -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) { return @{} }
    $obj = $raw | ConvertFrom-Json -ErrorAction Stop
    $result = @{}
    foreach ($p in $obj.PSObject.Properties) { $result[$p.Name] = $p.Value }
    return $result
  } catch {
    Write-Log "WARNING: state file corrupt/unreadable ($StateFile) -- $($_.Exception.Message). Falling back to full fetch for all created_at-diff tables this run." | Out-Null
    return @{}
  }
}
$state = Get-BackupState -path $StateFile
$newState = $state.Clone()

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
  $isCreatedAtDiff = $CreatedAtDiffTables -contains $table
  $isUpdatedAtDiff = $UpdatedAtDiffTables -contains $table
  $diffColumn = if ($isCreatedAtDiff) { 'created_at' } elseif ($isUpdatedAtDiff) { 'updated_at' } else { $null }
  $prevTime = $null
  if ($diffColumn -and $state.ContainsKey($table)) { $prevTime = $state[$table] }
  # 取得開始「前」の時刻を次回の基準時刻にする(取得中に作成/更新された行を取りこぼさないため。
  # backup_supabase.ps1の$DiffTablesと同じ考え方)。
  $runStart = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  try {
    $allRows = @()
    $pageSize = 1000
    $offset = 0
    while ($true) {
      if ($diffColumn -and $prevTime) {
        $encoded = [uri]::EscapeDataString($prevTime)
        $uri = "$SupabaseUrl/rest/v1/$table" + "?select=*&$diffColumn=gte.$encoded&order=$diffColumn.asc,id.asc&limit=$pageSize&offset=$offset"
      } else {
        $uri = "$SupabaseUrl/rest/v1/$table" + "?select=*&order=id&limit=$pageSize&offset=$offset"
      }
      try {
        $resp = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get -ErrorAction Stop
      } catch {
        # id列が無いテーブル等でorder=idが失敗する場合に備え、order無しで再試行する
        # (差分取得の場合は$diffColumn.ascのみを維持し、offsetでページングする)
        $uri2 = if ($diffColumn -and $prevTime) {
          "$SupabaseUrl/rest/v1/$table" + "?select=*&$diffColumn=gte.$encoded&order=$diffColumn.asc&limit=$pageSize&offset=$offset"
        } else {
          "$SupabaseUrl/rest/v1/$table" + "?select=*&limit=$pageSize&offset=$offset"
        }
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

    $modeLabel = if ($diffColumn) { if ($prevTime) { "$diffColumn diff since $prevTime" } else { "$diffColumn diff (初回:全件)" } } else { 'full' }
    Write-Log "  OK($modeLabel): $table (rows: $($allRows.Count))"
    # 成功した場合のみ状態を更新する(失敗した場合は前回時刻のまま維持し、
    # 次回実行時に同じ範囲を再取得できるようにする=データ欠損防止)。
    if ($diffColumn) { $newState[$table] = $runStart }
  } catch {
    $hadError = $true
    Write-Log "  ERROR: failed to fetch $table -- $($_.Exception.Message)"
    Set-Content -Path (Join-Path $workDir "$table.ERROR.txt") -Value $_.Exception.Message -Encoding utf8
    # $diffColumnの場合、$newStateには何もしない(既にCloneしたstateの値が保持される
    # =前回成功時刻のまま。今回が初回でprevTimeが無かった場合はそのまま無しの状態を維持)。
  }
}

# ===== 差分バックアップの状態ファイルを保存(created_at/updated_at共通) =====
try {
  $stateDir = Split-Path $StateFile -Parent
  if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }
  ($newState | ConvertTo-Json) | Set-Content -Path $StateFile -Encoding utf8
} catch {
  Write-Log "WARNING: failed to save state file ($StateFile) -- $($_.Exception.Message)"
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
