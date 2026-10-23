[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$skillSource = Join-Path $repoRoot 'skills\codex-telegram'
$codexHomePath = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$skillsRoot = Join-Path $codexHomePath 'skills'

New-Item -ItemType Directory -Force -Path $skillsRoot | Out-Null
Copy-Item -LiteralPath $skillSource -Destination $skillsRoot -Recurse -Force
Write-Host "Installed Codex Telegram skill in $skillsRoot"
