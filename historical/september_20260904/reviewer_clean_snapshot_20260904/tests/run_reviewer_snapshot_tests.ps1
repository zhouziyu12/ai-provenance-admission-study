$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$resultsDir = Join-Path $root "reviewer_test_results"
New-Item -ItemType Directory -Path $resultsDir -Force | Out-Null
$summary = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    workingDirectory = $root
    suites = @()
}

function Invoke-Suite {
    param(
        [string]$Name,
        [scriptblock]$Command,
        [string]$LogName
    )
    $log = Join-Path $resultsDir $LogName
    $global:LASTEXITCODE = 0
    & $Command *>&1 | Tee-Object -FilePath $log
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
    $summary.suites += [ordered]@{ name = $Name; exitCode = $exitCode; log = "reviewer_test_results/$LogName" }
    $script:SuiteExitCode = $exitCode
}

Push-Location $root
$server = $null
try {
    $failed = $false
    Invoke-Suite "Hardhat compile" { npx hardhat compile } "01_hardhat_compile.log"
    if ($script:SuiteExitCode -ne 0) { $failed = $true }
    Invoke-Suite "Registry-derived EIP-712 contract" { npx hardhat test tests/signature_gate.test.js } "02_signature_gate.log"
    if ($script:SuiteExitCode -ne 0) { $failed = $true }
    Invoke-Suite "ZK reproducibility" { node scripts/verify_zk_reproducibility.mjs } "03_zk_reproducibility.log"
    if ($script:SuiteExitCode -ne 0) { $failed = $true }
    Invoke-Suite "Python EIP-712 SDK" { python -m pytest tests/test_eip712_sdk.py -q } "04_eip712_sdk.log"
    if ($script:SuiteExitCode -ne 0) { $failed = $true }

    $env:JWT_SECRET = "reviewer-snapshot-only-jwt-secret-20260821"
    $env:SDK_USERNAME = "researcher"
    $env:SDK_PASSWORD = "researcher-demo-pass"
    $env:AUTH_STORE_PATH = Join-Path $resultsDir "auth-store.json"
    $serverLog = Join-Path $resultsDir "05_backend_server.log"
    $server = Start-Process -FilePath node -ArgumentList "server/server.js" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $serverLog -RedirectStandardError (Join-Path $resultsDir "05_backend_server_error.log") -PassThru
    Start-Sleep -Seconds 4
    Invoke-Suite "SDK and backend snapshot mode" { python tests/test_sdk_backend.py --reviewer-snapshot } "05_sdk_backend.log"
    if ($script:SuiteExitCode -ne 0) { $failed = $true }

    $summary.status = if ($failed) { "failed" } else { "passed" }
    $summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resultsDir "consolidated_test_summary.json") -Encoding utf8
    if ($failed) { exit 1 }
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    Remove-Item Env:JWT_SECRET, Env:SDK_USERNAME, Env:SDK_PASSWORD, Env:AUTH_STORE_PATH -ErrorAction SilentlyContinue
    Pop-Location
}
