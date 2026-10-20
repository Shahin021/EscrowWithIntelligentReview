# Packaged beside repo.bundle and manifest.json, not run from the source tree.
$ErrorActionPreference = 'Stop'
$bundle = Join-Path $PSScriptRoot 'repo.bundle'
$manifest = Get-Content (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $bundle)) { throw 'Bundle missing. Extract the complete ZIP first.' }
if ((Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.bundleSha256) { throw 'Bundle checksum differs; stopped.' }
$repo = Join-Path $PSScriptRoot 'repo'
if (Test-Path -LiteralPath $repo) { throw 'Repository already exists here. Use a fresh extraction folder to preserve it.' }
$version = & node.exe --version
if ($LASTEXITCODE -ne 0 -or ([version]$version.TrimStart('v')).Major -lt 24) { throw 'Install Node.js 24 first.' }
git -c core.autocrlf=false clone --single-branch --branch feat/one-transaction-per-party $bundle $repo
if ($LASTEXITCODE -ne 0) { throw 'Local bundle clone failed.' }
Push-Location $repo
try {
    git config core.autocrlf false
    git config core.eol lf
    if ((git rev-parse HEAD).Trim() -ne $manifest.commit) { throw 'Unexpected branch head.' }
    foreach ($part in @('dapp', 'automation')) {
        Push-Location (Join-Path $repo $part)
        try {
            npm.cmd ci
            if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed: $part" }
        } finally { Pop-Location }
    }
    foreach ($part in @('dapp', 'automation')) {
        Push-Location (Join-Path $repo $part)
        try {
            npm.cmd test
            if ($LASTEXITCODE -ne 0) { throw "Tests failed: $part" }
        } finally { Pop-Location }
    }
    Push-Location (Join-Path $repo 'dapp')
    try {
        npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    } finally { Pop-Location }
}
finally { Pop-Location }
$scripts = Join-Path $PSScriptRoot 'scripts'
New-Item -ItemType Directory -Path $scripts -Force | Out-Null
Copy-Item -Path (Join-Path $repo 'scripts\one-tx-windows\*.ps1') -Destination $scripts
Copy-Item -LiteralPath (Join-Path $repo 'docs\ONE_TRANSACTION_MODE.md') -Destination (Join-Path $PSScriptRoot 'README.md')
& (Join-Path $scripts 'Prepare-Operator.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Operator preparation stopped.' }
Write-Host "Installed in: $PSScriptRoot"
Write-Host 'No deployment, signature, broadcast, git push or publication performed.'
Write-Host 'Fund the printed OPERATOR PUBLIC ADDRESS with testnet gas. Never share its private key file.'
Write-Host 'Next command (after funding):'
Write-Host "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$scripts\Start-Background.ps1`" -EnableSending"
Write-Host 'Add -Smtp to configure real email; otherwise notifications are local .eml files.'
Write-Host 'To open the separate site in a second PowerShell:'
Write-Host "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$scripts\Start-Site.ps1`""
Start-Process explorer.exe $PSScriptRoot
