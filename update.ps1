<#
.SYNOPSIS
    Vikunja Update Script - pull latest code + update Docker image + restart container + restart gantt proxy
.DESCRIPTION
    Steps:
      1. git pull (from chenweihanfool/tasktracker on GitHub)
      2. docker compose pull (latest official Vikunja image)
      3. docker compose up -d (recreate container)
      4. restart gantt-today-line proxy (injects custom CSS/JS into Gantt view)
      5. health check (verify site responds)
    
    Usage:
      - Double-click this .ps1 file
      - Or run in PowerShell: & "F:\vikunja-src\update.ps1"
.NOTES
    Version: 2.0
    Requires: F:\deploy-helpers\DeployHelpers.psm1
#>

$ErrorActionPreference = "Continue"
$LogFile = "F:\vikunja-src\update.log"
$StartTime = Get-Date

# Import shared deployment helpers
$modulePath = "F:\deploy-helpers\DeployHelpers.psm1"
if (-not (Test-Path $modulePath)) {
    Write-Host "ERROR: Shared module not found at $modulePath" -ForegroundColor Red
    Write-Host "  Clone from: git@github.com:chenweihanfool/deploy-helpers.git" -ForegroundColor Yellow
    exit 1
}
Import-Module $modulePath -Force

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "       Vikunja Update Script v2.0        " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Start: $($StartTime.ToString('yyyy-MM-dd HH:mm:ss'))" -ForegroundColor Gray
Write-Host ""

function Run-Native {
    param([scriptblock]$ScriptBlock)
    $output = & $ScriptBlock
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "Exit code: $exitCode - $output"
    }
    return $output
}

# ==============================================
# Step 1: git pull
# ==============================================
Write-Host "[1/5] Pulling latest code from GitHub..." -ForegroundColor Yellow
try {
    Push-Location F:\vikunja-src
    $gitResult = Run-Native { git pull 2>&1 }
    Write-Host $gitResult
    if ($gitResult -match "Updating") {
        Write-Host "  >> Changes pulled" -ForegroundColor Green
    } else {
        Write-Host "  >> Already up to date" -ForegroundColor Gray
    }
    Pop-Location
}
catch {
    Write-Host "ERROR git pull: $_" -ForegroundColor Red
    Pop-Location
    exit 1
}

# ==============================================
# Step 2: docker compose pull
# ==============================================
Write-Host "[2/5] Pulling latest Vikunja Docker image..." -ForegroundColor Yellow
try {
    Push-Location F:\vikunja
    $pullResult = cmd /c "docker compose pull 2>&1"
    Write-Host $pullResult
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose pull failed (exit code: $LASTEXITCODE)"
    }
    Pop-Location
}
catch {
    Write-Host "ERROR docker pull: $_" -ForegroundColor Red
    Write-Host "Make sure Docker Desktop is running" -ForegroundColor Yellow
    Pop-Location
    exit 1
}

# ==============================================
# Step 3: docker compose up -d
# ==============================================
Write-Host "[3/5] Recreating containers..." -ForegroundColor Yellow
try {
    Push-Location F:\vikunja
    $upResult = cmd /c "docker compose up -d 2>&1"
    Write-Host $upResult
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose up -d failed (exit code: $LASTEXITCODE)"
    }
    Write-Host "  >> Container restarted" -ForegroundColor Green
    Pop-Location
}
catch {
    Write-Host "ERROR docker up: $_" -ForegroundColor Red
    Pop-Location
    exit 1
}

# ==============================================
# Step 4: Restart gantt-today-line proxy
# ==============================================
Write-Host "[4/5] Restarting gantt-today-line proxy..." -ForegroundColor Yellow
try {
    # Kill existing proxy on port 3456 (uses Get-NetTCPConnection, not locale-dependent netstat)
    Write-Host "  >> Stopping existing proxy..." -ForegroundColor Gray
    Stop-ProcessByPort -Port 3456
    Start-Sleep -Seconds 2

    # Start proxy using Start-DetachedProcess (no console sharing, exits immediately)
    $proxyDir = "F:\vikunja-src\scripts\gantt-today-line"
    Start-DetachedProcess -FilePath "node" -Arguments "proxy.js" -WorkingDirectory $proxyDir -Environment @{
        GANTT_PROXY_PUBLIC_PORT = "3456"
        GANTT_PROXY_INTERNAL_PORT = "3457"
    }
    Start-Sleep -Seconds 3

    # Verify proxy is listening (same locale-independence as above)
    if (Test-PortListening -Port 3456) {
        Write-Host "  >> Proxy started (listening on port 3456)" -ForegroundColor Green
    } else {
        throw "Proxy failed to bind to port 3456"
    }
}
catch {
    Write-Host "ERROR proxy restart: $_" -ForegroundColor Red
    Write-Host "  Manually start with: F:\vikunja-src\scripts\gantt-today-line\start-proxy.bat" -ForegroundColor Yellow
}

# ==============================================
# Step 5: Health check
# ==============================================
Write-Host "[5/5] Health check..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

try {
    $statusCode = (Invoke-WebRequest -Uri "https://cwh2023.asuscomm.com/" -UseBasicParsing -TimeoutSec 15).StatusCode
    if ($statusCode -eq 200) {
        Write-Host "  >> PASS - Vikunja is running (HTTP $statusCode)" -ForegroundColor Green
    } else {
        Write-Host "  >> WARNING - HTTP $statusCode, verify manually" -ForegroundColor Yellow
    }
}
catch {
    Write-Host "  >> FAILED - $_" -ForegroundColor Red
    Write-Host "     Try: docker compose logs --tail=20" -ForegroundColor Yellow
}

# Verify proxy injection works
try {
    $html = Invoke-WebRequest -Uri "https://cwh2023.asuscomm.com/" -UseBasicParsing -TimeoutSec 10
    if ($html.Content -match "gantt-today-line") {
        Write-Host "  >> Proxy injection verified (gantt-today-line found in HTML)" -ForegroundColor Green
    } else {
        Write-Host "  >> WARNING: Proxy injection not detected in HTML" -ForegroundColor Yellow
    }
}
catch {
    Write-Host "  >> WARNING: Could not verify proxy injection" -ForegroundColor Yellow
}

# ==============================================
# Done
# ==============================================
$EndTime = Get-Date
$Duration = ($EndTime - $StartTime).TotalSeconds
Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Update complete! ($($Duration.ToString('0.0'))s)" -ForegroundColor Cyan
Write-Host "https://cwh2023.asuscomm.com" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

$LogLine = "$($StartTime.ToString('yyyy-MM-dd HH:mm:ss')) | ${Duration:0.0}s | Done"
Add-Content -Path $LogFile -Value $LogLine -Encoding UTF8
