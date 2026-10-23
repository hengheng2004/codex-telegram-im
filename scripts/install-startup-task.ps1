[CmdletBinding()]
param([string]$TaskName = 'Codex Telegram')

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$hiddenLauncher = Join-Path $PSScriptRoot 'run-relay-hidden.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $hiddenLauncher -PathType Leaf)) {
    throw "Hidden relay launcher is missing: $hiddenLauncher"
}

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if (-not $existingTask -or $existingTask.State -ne 'Running') { break }
        Start-Sleep -Milliseconds 100
    }
    if ($existingTask -and $existingTask.State -eq 'Running') {
        throw "Scheduled task '$TaskName' did not stop before reinstall."
    }
}

$action = New-ScheduledTaskAction -Execute $wscript -Argument "//B //NoLogo `"$hiddenLauncher`"" -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Personal Codex to Telegram relay' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Scheduled task '$TaskName' installed and started."
