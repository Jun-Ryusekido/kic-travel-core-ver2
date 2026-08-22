# KIC_Clear_Email_HtmlBody タスクをWindowsタスクスケジューラに登録するスクリプト
# (scripts/register_backup_daily_task.ps1と同じ方式)。
# GUIでの手動登録は不要。PowerShellで実行するだけで登録が完了する:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register_clear_email_html_body_task.ps1
#
# 事前準備(初回のみ、必須):
#   1) SUPABASE_SERVICE_ROLE_KEYをこのPCのユーザー環境変数として永続化する
#      (scripts/clear_old_email_import_html_body.jsはservice_role keyが無いと動作しない。
#       email_import_queueはscripts/lock_down_email_import_queue_writes.sqlによりanon/
#       authenticatedからの書き込みが剥奪済みのため、公開anonキーでは更新できない)。
#      PowerShellで一度だけ実行する(値は他のドキュメントに書かれている実際のキーに置き換える):
#        setx SUPABASE_SERVICE_ROLE_KEY "実際のservice_role key"
#      setxで設定した環境変数はレジストリに永続化されるため、タスクスケジューラが
#      起動する新しいプロセスにも(ログイン中のシェルの再起動無しに)引き継がれる
#      (email-automation/catchup-missed-mail.ps1のEMAIL_IMPORT_API_KEYと同じ方式)。
#   2) node.exe がこのPCのPATHに通っていること(通常のNode.jsインストールで自動的に追加される)。
#
# トリガー: 毎月1日の03:00(業務時間外)。ログオン時トリガーは付けない
#   (月次実行のため、その日にPCが起動していなければ翌回起動時までスキップされるだけで
#    実害が小さく、日次バックアップのような即時性は不要なため)。
# 実行内容: scripts\clear_old_email_import_html_body.js を --apply --yes で実行する
#   (事前レポート・確認プロンプトは対話実行時のみ必要なため、スケジュール実行では
#    --yesで確認プロンプトをスキップする。ただし対象件数・削減サイズのレポート自体は
#    毎回ログに出力される。既定の30日はスクリプト側の既定値をそのまま使う)。
# 既に同名タスクがあれば上書き登録する。

$TaskName = 'KIC_Clear_Email_HtmlBody'
$ScriptPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\clear_old_email_import_html_body.js'
if (-not (Test-Path $ScriptPath)) { throw "スクリプトが見つかりません: $ScriptPath" }

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'node.exe が見つかりません。Node.jsをインストールしてPATHを通してから再実行してください。' }

$userId = "$env:USERDOMAIN\$env:USERNAME"
$workDir = Split-Path $ScriptPath -Parent | Split-Path -Parent

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>KIC Travel Core: email_import_queueの古いhtml_body(取り込み済み・30日以上経過分)を月次でNULLクリアする(容量削減)</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T03:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByMonth>
        <DaysOfMonth>
          <Day>1</Day>
        </DaysOfMonth>
        <Months>
          <January /><February /><March /><April /><May /><June />
          <July /><August /><September /><October /><November /><December />
        </Months>
      </ScheduleByMonth>
    </CalendarTrigger>
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
      <Command>$($nodeCmd.Source)</Command>
      <Arguments>"$ScriptPath" --apply --yes</Arguments>
      <WorkingDirectory>$workDir</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$xmlPath = Join-Path $env:TEMP 'kic_clear_email_html_body_task.xml'
$xml | Out-File -FilePath $xmlPath -Encoding unicode

schtasks /create /tn $TaskName /xml $xmlPath /f
if ($LASTEXITCODE -ne 0) { throw "schtasksによるタスク登録に失敗しました (exit=$LASTEXITCODE)" }
Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue

Write-Output "タスク '$TaskName' を登録しました。"
Write-Output '注意: SUPABASE_SERVICE_ROLE_KEYがユーザー環境変数として設定されていない場合、タスクは失敗します(上記「事前準備」参照)。'
schtasks /query /tn $TaskName /v /fo LIST | Select-String -Pattern 'Task To Run|Schedule Type|Start Time|Status|Logon Mode'
