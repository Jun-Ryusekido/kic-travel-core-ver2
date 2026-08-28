# KIC Travel Core - Supabase full-table backup script.
# Intended to be triggered hourly by Windows Task Scheduler.
# The script checks whether the current time is within 10:00-22:00 and exits
# immediately if not, so the scheduled task itself can just run every hour.
#
# 差分バックアップ(2026-08-01追加):
#   $DiffTables に列挙したテーブルのみ、前回成功時刻(状態ファイル)以降に
#   updated_at が更新された行だけを取得する。それ以外のテーブルは従来通り全件取得。
#   対象は「updated_at列が存在し、かつ書き込み経路が全てtable-crud.js
#   (service_role専用API)経由であることを確認済み」のテーブルに限定すること
#   (直接anon書き込みが残っていると、updated_atが更新されずに差分から漏れる行が
#   発生しうるため。実際にemail_import_queueで発見済み)。
#   状態ファイル: scripts/data/backup_last_success.json (テーブルごとに個別の時刻)。
#   このファイルは.gitignore対象(scripts/data/*)のため、リポジトリにはコミットされない。
#
# -BackupRootOverride/-StateFileOverride/-SkipTimeWindowCheckは検証専用のパラメータ。
# Windowsタスクスケジューラからの通常実行では指定せず、既定値(本番の C:\KIC_Backup 等)を使う。
param(
  [string]$BackupRootOverride,
  [string]$StateFileOverride,
  [switch]$SkipTimeWindowCheck
)

# ===== Config =====
$SupabaseUrl = 'https://nzdygjlnzvtdezslnuoy.supabase.co'
# バックアップ対象のうちerror_logs/guide_bank_accounts/app_users/parking_reservations等は
# セキュリティ強化の一環でanon(publishable)キーからのSELECTを意図的に遮断済み
# (scripts/lock_down_*.sql参照)であり、anonキーでは全テーブルを読めない。バックアップは
# 信頼されたこのPC上でのみ動く管理者用スクリプトのため、RLS/GRANTを問わず全テーブルを
# 読めるservice_roleキーを使う。anonキーへのフォールバックは絶対に行わない
# (静かにanonへ戻ると、一部テーブルが欠けたバックアップが「正常終了」してしまうため)。
$SupabaseKey = $env:SUPABASE_SERVICE_ROLE_KEY
if ([string]::IsNullOrWhiteSpace($SupabaseKey)) {
  Write-Error 'SUPABASE_SERVICE_ROLE_KEY環境変数が設定されていません。setxコマンドで永続化してから再実行してください(詳細はscripts/backup_supabase_daily.ps1冒頭のコメント、またはこのタスクのPR説明を参照)。anonキーへのフォールバックは行わず、ここで処理を中断します。'
  exit 1
}
$BackupRoot  = if ($BackupRootOverride) { $BackupRootOverride } else { 'C:\KIC_Backup' }
$RetentionDays = 7
$StateFile = if ($StateFileOverride) { $StateFileOverride } else { Join-Path $PSScriptRoot 'data\backup_last_success.json' }

$Tables = @(
  'bookings',
  'booking_sales',
  'booking_costs',
  'booking_hotels',
  'booking_buses',
  'booking_restaurants',
  'booking_facilities',
  'guide_settlements',
  'guide_settlement_items',
  'guides',
  'suppliers',
  'business_partners',
  'local_expenses',
  'bullet_train_arrangements',
  'app_users',
  'invoices',
  'tour_arrangements',
  'tour_arrangement_days',
  'estimations',
  'access_logs',
  'agents',
  'business_partner_contacts',
  'card_holders',
  'credit_card_statements',
  'error_logs',
  'facility_operating_info',
  'guide_bank_accounts',
  'learned_mappings',
  'partner_merge_pending',
  'vendor_email_logs',
  'booking_edit_presence',
  'payments'
)

# 差分取得の対象(updated_at列あり + 書き込み経路が全てtable-crud.js経由であることを
# 確認済みのテーブルのみ)。他のテーブルを追加する場合は、書き込み箇所を全て洗い出して
# 直接anon書き込みが残っていないことを必ず確認してから追加すること。
# booking_costsは2026-08-01にupdated_at列を追加(scripts/add_updated_at_to_booking_costs.sql、
# 本番実行済み)し、table-crud.js側もstampUpdatedAt:trueを設定済み。毎時バックアップ対象で
# 最大の行数(約18,000件)のため、差分化による転送量削減の効果が最も大きい。
$DiffTables = @(
  'bookings',
  'booking_buses',
  'booking_restaurants',
  'booking_costs'
)

# ===== Time window check (only run between 10:00 and 22:00) =====
$now = Get-Date
if (-not $SkipTimeWindowCheck -and ($now.Hour -lt 10 -or $now.Hour -ge 22)) {
  Write-Output "[$now] Outside backup window (10:00-22:00). Skipping."
  exit 0
}

# ===== Prepare folders =====
if (-not (Test-Path $BackupRoot)) {
  New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
}
$timestamp = $now.ToString('yyyy-MM-dd_HH-mm')
$workDir = Join-Path $BackupRoot "_work_$timestamp"
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

$logFile = Join-Path $BackupRoot 'backup_log.txt'
function Write-Log {
  param([string]$msg)
  $line = "[$( (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') )] $msg"
  Write-Output $line
  Add-Content -Path $logFile -Value $line -Encoding utf8
}

# ===== 差分バックアップの状態ファイル読み込み =====
# ファイルが存在しない、または壊れて読み込めない場合は空のハッシュテーブルを返す。
# これにより「stateが無い/壊れている」場合は全ての差分対象テーブルが
# 「前回時刻なし」扱いになり、自動的に全件取得(初回相当)にフォールバックする。
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
    # Write-Log(Write-Output経由)をそのまま呼ぶと、この関数のパイプライン出力に
    # ログの文字列が混入し、戻り値が「文字列+ハッシュテーブルの配列」になってしまう
    # (呼び出し元の$state.ContainsKey()が壊れる実際のバグとして発見)。
    # Out-Nullで確実に握りつぶし、この関数の戻り値には@{}のみが乗るようにする。
    Write-Log "WARNING: state file corrupt/unreadable ($StateFile) -- $($_.Exception.Message). Falling back to full fetch for all diff tables this run." | Out-Null
    return @{}
  }
}
$state = Get-BackupState -path $StateFile
$newState = $state.Clone()

Write-Log "===== Backup started: $timestamp ====="

# ===== Fetch a table's rows, optionally filtered to updated_at >= $sinceTimestamp =====
function Fetch-TableRows {
  param([string]$table, [string]$sinceTimestamp, [hashtable]$headers)
  $allRows = @()
  $pageSize = 1000
  $offset = 0
  while ($true) {
    if ($sinceTimestamp) {
      $encoded = [uri]::EscapeDataString($sinceTimestamp)
      $uri = "$SupabaseUrl/rest/v1/$table" + "?select=*&updated_at=gte.$encoded&order=updated_at.asc,id.asc&limit=$pageSize&offset=$offset"
    } else {
      $uri = "$SupabaseUrl/rest/v1/$table" + "?select=*&order=id&limit=$pageSize&offset=$offset"
    }
    $resp = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get -ErrorAction Stop
    $count = @($resp).Count
    if ($count -gt 0) { $allRows += @($resp) }
    if ($count -lt $pageSize) { break }
    $offset += $pageSize
  }
  # PowerShellは要素数1の配列をreturn時にスカラー値へ自動展開してしまうため(呼び出し元の
  # $allRows.Countやconvertto-jsonでの配列/オブジェクトの区別が壊れる)、@()で強制的に
  # 配列のまま返す。0件・1件・複数件のいずれでも呼び出し元は必ず配列を受け取る。
  return ,@($allRows)
}

# ===== Fetch every table with pagination and save as JSON =====
$hadError = $false
$headers = @{
  'apikey'        = $SupabaseKey
  'Authorization' = "Bearer $SupabaseKey"
}
foreach ($table in $Tables) {
  $isDiff = $DiffTables -contains $table
  $prevTime = $null
  if ($isDiff -and $state.ContainsKey($table)) { $prevTime = $state[$table] }
  # 取得開始「前」の時刻を次回の基準時刻にする(取得中に発生した更新を取りこぼさないため。
  # 取得後の時刻を基準にすると、取得中に更新された行が次回にも今回にも含まれず
  # 消えてしまう可能性がある。開始前時刻を使えば、その場合でも次回に再取得されるだけで
  # 済み、安全側に倒れる)。
  $runStart = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  try {
    if ($isDiff) {
      # Fetch-TableRowsは ,@($allRows) で単一のパイプラインオブジェクトとして配列を
      # 返しているため、ここで@()を重ねて二重にラップしない(二重ラップすると
      # 「配列を1個だけ含む配列」になり、件数(.Count)が常に1になってしまう)。
      $allRows = Fetch-TableRows -table $table -sinceTimestamp $prevTime -headers $headers
      $modeLabel = if ($prevTime) { "diff since $prevTime" } else { "diff (初回:全件)" }
    } else {
      $allRows = Fetch-TableRows -table $table -sinceTimestamp $null -headers $headers
      $modeLabel = 'full'
    }
    # ConvertTo-Jsonにパイプ(|)で配列を渡すと、要素数によって出力形式が変わってしまう
    # (0件→空文字列、1件→配列でなく単一オブジェクト、2件以上→正しく配列)というPowerShellの
    # 既知の挙動があるため、必ず-InputObjectで渡して0/1/複数件のいずれも確実に配列
    # ([]/[{...}]/[{...},{...}])として出力する。
    $json = ConvertTo-Json -InputObject $allRows -Depth 20 -Compress
    Set-Content -Path (Join-Path $workDir "$table.json") -Value $json -Encoding utf8
    Write-Log "  OK($modeLabel): $table (rows: $($allRows.Count))"
    # 成功した場合のみ状態を更新する(失敗した場合は前回時刻のまま維持し、
    # 次回実行時に同じ範囲を再取得できるようにする=データ欠損防止)。
    if ($isDiff) { $newState[$table] = $runStart }
  } catch {
    $hadError = $true
    Write-Log "  ERROR: failed to fetch $table -- $($_.Exception.Message)"
    Set-Content -Path (Join-Path $workDir "$table.ERROR.txt") -Value $_.Exception.Message -Encoding utf8
    # $isDiffの場合、$newStateには何もしない(既にCloneしたstateの値が保持されている
    # =前回成功時刻のまま。今回が初回でprevTimeが無かった場合はそのまま無しの状態を維持)。
  }
}

# ===== 差分バックアップの状態ファイルを保存 =====
try {
  $stateDir = Split-Path $StateFile -Parent
  if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }
  ($newState | ConvertTo-Json) | Set-Content -Path $StateFile -Encoding utf8
} catch {
  Write-Log "WARNING: failed to save state file ($StateFile) -- $($_.Exception.Message)"
}

# ===== Zip it up =====
$zipPath = Join-Path $BackupRoot "backup_$timestamp.zip"
try {
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path (Join-Path $workDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Log "ZIP created: $zipPath"
} catch {
  Write-Log "ERROR: failed to create ZIP -- $($_.Exception.Message)"
  $hadError = $true
}

# Remove the temporary work folder
Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue

# ===== Delete backups older than $RetentionDays days =====
$cutoff = $now.AddDays(-$RetentionDays)
Get-ChildItem -Path $BackupRoot -Filter 'backup_*.zip' | Where-Object { $_.LastWriteTime -lt $cutoff } | ForEach-Object {
  Write-Log "Deleting old backup: $($_.Name)"
  Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
}

if ($hadError) {
  Write-Log "===== Backup finished WITH ERRORS ====="
} else {
  Write-Log "===== Backup finished OK ====="
}
