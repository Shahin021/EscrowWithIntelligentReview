$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $root 'repo\automation')
try {
    $env:ONE_TX_OPERATOR_FILE = Join-Path $root 'operator-private.key'
    @'
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
const p=process.env.ONE_TX_OPERATOR_FILE;
if(!existsSync(p)) writeFileSync(p,generatePrivateKey()+'\n',{mode:0o600,flag:'wx'});
const a=privateKeyToAccount(readFileSync(p,'utf8').trim());
console.log('Dedicated operator PUBLIC address:',a.address);
console.log('Fund only this PUBLIC address with testnet gas. Never upload the key file.');
'@ | node.exe --input-type=module
    if ($LASTEXITCODE -ne 0) { throw 'Operator setup stopped.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $env:ONE_TX_OPERATOR_FILE /inheritance:r /grant:r "${identity}:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict key file permissions.' }
}
finally {
    Remove-Item Env:ONE_TX_OPERATOR_FILE -ErrorAction SilentlyContinue
    Pop-Location
}
