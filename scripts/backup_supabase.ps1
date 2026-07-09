# KIC Travel Core - Supabase full-table backup script.
# Intended to be triggered hourly by Windows Task Scheduler.
# The script checks whether the current time is within 10:00-22:00 and exits
# immediately if not, so the scheduled task itself can just run every hour.

# ===== Config =====
$SupabaseUrl = 'https://nzdygjlnzvtdezslnuoy.supabase.co'
$SupabaseKey = 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB'
$BackupRoot  = 'C:\KIC_Backup'
$RetentionDays = 7

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
  'access_logs'
)

# ===== Time window check (only run between 10:00 and 22:00) =====
$now = Get-Date
if ($now.Hour -lt 10 -or $now.Hour -ge 22) {
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

Write-Log "===== Backup started: $timestamp ====="

# ===== Fetch every table with pagination and save as JSON =====
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
      $resp = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get -ErrorAction Stop
      $count = @($resp).Count
      if ($count -gt 0) { $allRows += $resp }
      if ($count -lt $pageSize) { break }
      $offset += $pageSize
    }
    $json = $allRows | ConvertTo-Json -Depth 20 -Compress
    if ([string]::IsNullOrEmpty($json)) { $json = '[]' }
    Set-Content -Path (Join-Path $workDir "$table.json") -Value $json -Encoding utf8
    Write-Log "  OK: $table (rows: $($allRows.Count))"
  } catch {
    $hadError = $true
    Write-Log "  ERROR: failed to fetch $table -- $($_.Exception.Message)"
    Set-Content -Path (Join-Path $workDir "$table.ERROR.txt") -Value $_.Exception.Message -Encoding utf8
  }
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
