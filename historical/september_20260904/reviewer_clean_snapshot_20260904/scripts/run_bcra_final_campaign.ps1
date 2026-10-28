$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$pointerPath = Join-Path $env:USERPROFILE ".ai-provenance\bcra-final-campaign\latest.json"
if (-not (Test-Path -LiteralPath $pointerPath)) { throw "Rotated-wallet pointer not found" }
$pointer = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
$protected = [IO.File]::ReadAllBytes($pointer.dpapiPasswordFile)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protected,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
$password = [Text.Encoding]::UTF8.GetString($plain)
$env:BCRA_KEYSTORE_DIR = $pointer.keystoreDirectory
$env:BCRA_KEYSTORE_PASSWORD = $password
try {
    node (Join-Path $root "scripts\run_bcra_final_campaign_sepolia.mjs") @args
    exit $LASTEXITCODE
} finally {
    Remove-Item Env:BCRA_KEYSTORE_PASSWORD -ErrorAction SilentlyContinue
    $password = $null
    [Array]::Clear($plain, 0, $plain.Length)
}
