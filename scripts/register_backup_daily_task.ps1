# KIC_Supabase_Backup_Daily タスクをWindowsタスクスケジューラに登録するスクリプト。
# GUIでの手動登録は不要。PowerShellで実行するだけで登録が完了する:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register_backup_daily_task.ps1
#
# トリガー: 毎日12:00 ＋ ユーザーログオン時 (StartWhenAvailable=true のため、
# 12:00にPCがスリープ/電源断でも次に起動したタイミングで実行される)。
# 実行内容: リポジトリ内の scripts\backup_supabase_daily.ps1 を直接起動する
# (コピーを作らないため、git pullでスクリプトを更新すればタスク側も自動で最新になる)。
# 既に同名タスクがあれば上書き登録する。
#
# 既存の毎時タスク(KIC_Supabase_Backup)には手を付けない(別系統として並行運用)。

$TaskName = 'KIC_Supabase_Backup_Daily'
$ScriptPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\backup_supabase_daily.ps1'
if (-not (Test-Path $ScriptPath)) { throw "バックアップスクリプトが見つかりません: $ScriptPath" }

$userId = "$env:USERDOMAIN\$env:USERNAME"

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>KIC Travel Core: Supabase全テーブルの日次バックアップ(JSON+CSVをZIP化し、ローカルとNASの2箇所へ保存)</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T12:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$userId</UserId>
      <Delay>PT2M</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$userId</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$ScriptPath"</Arguments>
    </Exec>
  </Actions>
</Task>
"@

$xmlPath = Join-Path $env:TEMP 'kic_supabase_backup_daily_task.xml'
$xml | Out-File -FilePath $xmlPath -Encoding unicode

schtasks /create /tn $TaskName /xml $xmlPath /f
if ($LASTEXITCODE -ne 0) { throw "schtasksによるタスク登録に失敗しました (exit=$LASTEXITCODE)" }
Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue

Write-Output "タスク '$TaskName' を登録しました。"
schtasks /query /tn $TaskName /v /fo LIST | Select-String -Pattern 'Task To Run|Schedule Type|Start Time|Status|Logon Mode'
