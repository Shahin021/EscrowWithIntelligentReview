param([switch]$EnableSending, [switch]$Smtp)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$repo = Join-Path $root 'repo'
Push-Location (Join-Path $repo 'automation')
try {
    $env:GENLAYER_NETWORK = 'testnetBradbury'
    $env:AUTOMATION_PORT = '8790'
    $env:AUTOMATION_PUBLIC_URL = 'http://127.0.0.1:8790'
    $env:AUTOMATION_SITE_URL = 'http://127.0.0.1:5184/one-tx.html'
    $env:AUTOMATION_ALLOWED_ORIGINS = 'http://127.0.0.1:5184'
    $env:AUTOMATION_DB = Join-Path $root 'automation.sqlite'
    $env:MAIL_OUTBOX_DIR = Join-Path $root 'mail-outbox'
    $env:MAIL_TRANSPORT = 'file'
    $env:AUTOMATION_SENDING = 'off'
    Remove-Item Env:OPERATOR_KEY_FILE -ErrorAction SilentlyContinue
    if ($EnableSending) {
        $keyFile = Join-Path $root 'operator-private.key'
        if (-not (Test-Path -LiteralPath $keyFile)) { throw 'Run Prepare-Operator.ps1 first, then fund its PUBLIC address with testnet gas.' }
        $env:OPERATOR_KEY_FILE = $keyFile
        $env:AUTOMATION_SENDING = 'on'
    }
    if ($Smtp) {
        $smtpSecret = Read-Host 'SMTP URL (credentials stay on this machine)' -AsSecureString
        $smtpPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($smtpSecret)
        try { $env:SMTP_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($smtpPointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($smtpPointer); $smtpSecret.Dispose() }
        $env:MAIL_FROM = Read-Host 'Verified sender email address'
        $env:MAIL_TRANSPORT = 'smtp'
    }
    Write-Host 'File transport creates .eml messages locally; real delivery needs -Smtp.'
    npm.cmd start
    if ($LASTEXITCODE -ne 0) { throw 'Background service stopped.' }
}
finally {
    Remove-Item Env:SMTP_URL -ErrorAction SilentlyContinue
    Pop-Location
}
