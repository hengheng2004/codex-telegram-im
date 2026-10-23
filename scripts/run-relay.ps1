$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot
New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot '.data') | Out-Null
& node (Join-Path $RepoRoot 'src\relay.js')
exit $LASTEXITCODE
