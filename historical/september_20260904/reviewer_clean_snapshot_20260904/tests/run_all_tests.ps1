# Test Suite Runner v2
# Runs all test suites and generates a summary report.

Write-Host "`n====================================" -ForegroundColor Cyan
Write-Host "  AI Provenance Test Suite Runner v2" -ForegroundColor Cyan
Write-Host "  Started: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "====================================`n" -ForegroundColor Cyan

$testResults = @()
$repoRoot = Split-Path -Parent $PSScriptRoot

Push-Location $repoRoot

try {
    Write-Host "`n[1/4] Running v2 Smart Contract Tests..." -ForegroundColor Yellow
    try {
        node scripts/test_contracts.cjs
        if ($LASTEXITCODE -eq 0) {
            $testResults += @{Name="v2 Smart Contracts"; Status="PASS"}
        } else {
            $testResults += @{Name="v2 Smart Contracts"; Status="FAIL"}
        }
    } catch {
        Write-Host "Error running smart contract tests: $_" -ForegroundColor Red
        $testResults += @{Name="v2 Smart Contracts"; Status="ERROR"}
    }

    Write-Host "`n[2/4] Running ZK Proof Tests..." -ForegroundColor Yellow
    try {
        node test_zk_standalone.js
        if ($LASTEXITCODE -eq 0) {
            $testResults += @{Name="ZK Proof System"; Status="PASS"}
        } else {
            $testResults += @{Name="ZK Proof System"; Status="FAIL"}
        }
    } catch {
        Write-Host "Error running ZK proof tests: $_" -ForegroundColor Red
        $testResults += @{Name="ZK Proof System"; Status="ERROR"}
    }

    Write-Host "`n[3/4] Running SDK and Backend Tests..." -ForegroundColor Yellow
    $server = $null
    try {
        $server = Start-Process -FilePath node -ArgumentList 'server/server.js' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
        Start-Sleep -Seconds 4
        python tests/test_sdk_backend.py
        if ($LASTEXITCODE -eq 0) {
            $testResults += @{Name="SDK and Backend"; Status="PASS"}
        } else {
            $testResults += @{Name="SDK and Backend"; Status="FAIL"}
        }
    } catch {
        Write-Host "Error running SDK tests: $_" -ForegroundColor Red
        $testResults += @{Name="SDK and Backend"; Status="ERROR"}
    } finally {
        if ($server -and -not $server.HasExited) {
            Stop-Process -Id $server.Id -Force
        }
    }

    Write-Host "`n====================================" -ForegroundColor Cyan
    Write-Host "  Test Summary" -ForegroundColor Cyan
    Write-Host "====================================`n" -ForegroundColor Cyan

    $summary = @{
        timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
        version = "2.0.0"
        suites = @()
    }

    foreach ($result in $testResults) {
        $color = if ($result.Status -eq "PASS") { "Green" } else { "Red" }
        Write-Host "$($result.Status) $($result.Name)" -ForegroundColor $color

        $resultFile = switch ($result.Name) {
            "v2 Smart Contracts" { "test_results.json" }
            "ZK Proof System" { "results_zk_proof.json" }
            "SDK and Backend" { "tests/results_sdk_backend.json" }
        }

        if ($resultFile -and (Test-Path $resultFile)) {
            $details = Get-Content $resultFile | ConvertFrom-Json
            $summary.suites += $details
        }
    }

    $summaryPath = "tests/test_summary.json"
    $summary | ConvertTo-Json -Depth 10 | Out-File $summaryPath -Encoding UTF8
    Write-Host "`nSummary saved to: $summaryPath" -ForegroundColor Green
} finally {
    Pop-Location
}
