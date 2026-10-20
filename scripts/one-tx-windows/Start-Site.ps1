$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:VITE_GENLAYER_NETWORK = 'testnetBradbury'
$env:VITE_AUTOMATION_URL = 'http://127.0.0.1:8790'
Remove-Item Env:VITE_ESCROW_ADDRESS -ErrorAction SilentlyContinue
Remove-Item Env:VITE_REGISTRY_ADDRESS -ErrorAction SilentlyContinue
Push-Location (Join-Path $root 'repo\dapp')
try {
    Set-Clipboard 'http://127.0.0.1:5184/one-tx.html'
    Write-Host 'Once Vite says ready, open the copied URL: http://127.0.0.1:5184/one-tx.html'
    npm.cmd run dev -- --host 127.0.0.1 --port 5184 --strictPort
}
finally { Pop-Location }
