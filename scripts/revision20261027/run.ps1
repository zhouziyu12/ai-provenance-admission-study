param([Parameter(ValueFromRemainingArguments=$true)][string[]]$TaskArguments)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$revisionRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$revisionPointerPath = Join-Path $env:USERPROFILE '.ai-provenance\bcra-final-campaign\latest.json'
$revisionPointer = Get-Content -LiteralPath $revisionPointerPath -Raw | ConvertFrom-Json
$revisionProtected = [IO.File]::ReadAllBytes($revisionPointer.dpapiPasswordFile)
$revisionPlain = [System.Security.Cryptography.ProtectedData]::Unprotect($revisionProtected,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
$env:BCRA_KEYSTORE_DIR = $revisionPointer.keystoreDirectory
$env:BCRA_KEYSTORE_PASSWORD = [Text.Encoding]::UTF8.GetString($revisionPlain)
try { node (Join-Path $PSScriptRoot 'run.mjs') @TaskArguments; exit $LASTEXITCODE }
finally { Remove-Item Env:BCRA_KEYSTORE_PASSWORD -ErrorAction SilentlyContinue; [Array]::Clear($revisionPlain,0,$revisionPlain.Length) }
