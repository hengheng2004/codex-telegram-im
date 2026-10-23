[CmdletBinding()]
param(
    [string]$BotToken,
    [string]$ChatId,
    [string]$UserId,
    [string]$Workspace,
    [ValidateSet('read-only', 'workspace-write', 'danger-full-access')]
    [string]$Sandbox = 'read-only',
    [switch]$SkipMcp,
    [switch]$InstallStartupTask
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js 20 or newer is required: https://nodejs.org/'
}
if ([int](node -p "process.versions.node.split('.')[0]") -lt 20) {
    throw 'Node.js 20 or newer is required.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'npm is required.'
}

npm ci
& (Join-Path $PSScriptRoot 'install-skill.ps1')

if (-not $BotToken) {
    $secureToken = Read-Host 'Telegram bot token from @BotFather' -AsSecureString
    $BotToken = [System.Net.NetworkCredential]::new('', $secureToken).Password
}
if (-not $BotToken) { throw 'A Telegram bot token is required.' }

if (-not $ChatId) {
    Write-Host 'Send a message in the private Codex forum group (or directly to the bot), then press Enter here.'
    Read-Host | Out-Null
    $updates = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$BotToken/getUpdates" -ContentType 'application/json' -Body '{"timeout":0,"allowed_updates":["message"]}'
    $messages = @($updates.result | ForEach-Object { $_.message } | Where-Object { $_.chat -and $_.from })
    if ($messages.Count -eq 0) { throw 'No message found. Send a message to the bot or in the Codex group and run the installer again.' }
    $chats = @($messages | ForEach-Object { $_.chat } | Sort-Object id -Unique)
    if ($chats.Count -eq 1) {
        $ChatId = [string]$chats[0].id
    } else {
        $chats | Format-Table id, type, title, first_name, last_name, username
        $ChatId = Read-Host 'Your numeric chat ID'
    }
    if (-not $UserId) {
        $matchingMessage = $messages | Where-Object { [string]$_.chat.id -eq [string]$ChatId } | Select-Object -Last 1
        if ($matchingMessage) { $UserId = [string]$matchingMessage.from.id }
    }
}
if (-not $UserId -and -not $ChatId.StartsWith('-')) { $UserId = $ChatId }
if (-not $UserId) { $UserId = Read-Host 'Your numeric Telegram user ID' }
if (-not $UserId) { throw 'A Telegram user ID is required.' }

if (-not $Workspace) {
    $defaultWorkspace = Split-Path -Parent $RepoRoot
    $Workspace = Read-Host "Default folder for unbound Telegram topics [$defaultWorkspace]"
    if (-not $Workspace) { $Workspace = $defaultWorkspace }
}
$Workspace = [System.IO.Path]::GetFullPath($Workspace)
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) { throw "Workspace does not exist: $Workspace" }
$skipGitRepoCheck = if (Test-Path -LiteralPath (Join-Path $Workspace '.git')) { 'false' } else { 'true' }

$bridgeBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bridgeBytes)
$bridgeToken = [Convert]::ToHexString($bridgeBytes).ToLowerInvariant()
$envBody = @"
TELEGRAM_BOT_TOKEN=$BotToken
TELEGRAM_CHAT_ID=$ChatId
TELEGRAM_USER_ID=$UserId
TELEGRAM_MAX_FILE_MB=45
TELEGRAM_UPLOAD_TIMEOUT_SECONDS=60
TELEGRAM_UPLOAD_RETRIES=1
CODEX_WORKSPACE=$Workspace
CODEX_SANDBOX=$Sandbox
CODEX_COMMAND=codex
CODEX_COMMAND_ARGS_JSON=[]
CODEX_SKIP_GIT_REPO_CHECK=$skipGitRepoCheck
CODEX_TIMEOUT_SECONDS=1800
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=43921
BRIDGE_TOKEN=$bridgeToken
STATE_FILE=.data/state.json
RELAY_LOG_FILE=.data/relay.log
LOG_LEVEL=info
"@
[System.IO.File]::WriteAllText((Join-Path $RepoRoot '.env'), $envBody, [System.Text.UTF8Encoding]::new($false))

$me = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$BotToken/getMe" -ContentType 'application/json' -Body '{}'
if (-not $me.ok) { throw 'Telegram rejected the bot token.' }

if (-not $SkipMcp) {
    if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
        throw 'Codex CLI is required to register the MCP server. Install/login to Codex, or rerun with -SkipMcp.'
    }
    & codex mcp remove codex-telegram 2>$null
    & codex mcp add codex-telegram -- node (Join-Path $RepoRoot 'src\mcp-server.js')
    if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration failed.' }
}

if ($InstallStartupTask) {
    & (Join-Path $PSScriptRoot 'install-startup-task.ps1')
}

Write-Host "Installed for @$($me.result.username) and chat $ChatId."
Write-Host 'Run `npm start` now, or use `./scripts/install-startup-task.ps1` for automatic startup.'
Write-Host 'Restart ChatGPT/Codex after MCP registration, then run `npm run doctor`.'
