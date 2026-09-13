# Installs ST-Usage-Monitor into a SillyTavern installation.
# Usage:  powershell -ExecutionPolicy Bypass -File install.ps1 -SillyTavernPath "D:\SillyTavern"
param(
    [Parameter(Mandatory = $true)]
    [string]$SillyTavernPath
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path $SillyTavernPath)) { throw "SillyTavern path not found: $SillyTavernPath" }

# --- 1) browser extension -------------------------------------------------
$extSrc = Join-Path $Root "public\scripts\extensions\st-usage-monitor"
$extDst = Join-Path $SillyTavernPath "public\scripts\extensions\st-usage-monitor"
if (-not (Test-Path $extSrc)) { throw "Missing source: $extSrc" }
New-Item -ItemType Directory -Force -Path $extDst | Out-Null
Copy-Item -Recurse -Force (Join-Path $extSrc "*") $extDst
Write-Host "[1/3] extension installed -> $extDst"

# --- 2) server plugin -----------------------------------------------------
$plgSrc = Join-Path $Root "plugins\st-usage-server"
$plgDst = Join-Path $SillyTavernPath "plugins\st-usage-server"
if (-not (Test-Path $plgSrc)) { throw "Missing source: $plgSrc" }
New-Item -ItemType Directory -Force -Path $plgDst | Out-Null
Copy-Item -Recurse -Force (Join-Path $plgSrc "*") $plgDst
Write-Host "[2/3] server plugin installed -> $plgDst"

$cfg = Join-Path $SillyTavernPath "config.yaml"
if (Test-Path $cfg) {
    $text = Get-Content -Raw $cfg
    if ($text -notmatch "(?m)^\s*enableServerPlugins:\s*true") {
        $text = $text -replace "(?m)^\s*enableServerPlugins:\s*([^\r\n]*)", "enableServerPlugins: true"
        Set-Content -Path $cfg -Value $text -NoNewline
        Write-Host "      config.yaml: enableServerPlugins -> true"
    } else {
        Write-Host "      config.yaml: enableServerPlugins already true"
    }
} else {
    Write-Warning "config.yaml not found - please set enableServerPlugins: true manually."
}

# --- 3) capture patch (required for data) ---------------------------------
$util = Join-Path $SillyTavernPath "src\util.js"
$patch = Join-Path $Root "patches\st-usage-capture.patch"

if ((Test-Path $util) -and (Select-String -Path $util -Pattern "isUsageCaptureEnabled" -Quiet)) {
    Write-Host "[3/3] capture patch: already applied"
} else {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git -and (Test-Path (Join-Path $SillyTavernPath ".git"))) {
        Push-Location $SillyTavernPath
        try {
            & git apply --check $patch 2>$null
            if ($LASTEXITCODE -eq 0) {
                & git apply $patch
                Write-Host "[3/3] capture patch applied (git apply)"
            } else {
                Write-Warning "[3/3] patch does not apply cleanly - your SillyTavern version differs."
                Write-Warning "      Apply patches/st-usage-capture.patch by hand."
            }
        } finally { Pop-Location }
    } else {
        Write-Warning "[3/3] cannot apply the patch automatically (no git, or not a git checkout)."
        Write-Warning "      Apply patches/st-usage-capture.patch by hand - it adds:"
        Write-Warning "        src/util.js                          : hashPromptPayload / isUsageCaptureEnabled / forwardFetchResponseCapture"
        Write-Warning "        src/endpoints/backends/chat-completions.js : stream_options + capture calls"
    }
}

Write-Host ""
Write-Host "Done. Next steps:"
Write-Host "  1) restart SillyTavern (node server.js)"
Write-Host "  2) refresh the browser (F5)"
Write-Host "  3) open Extensions -> ST Usage Monitor, tick capture (creates data/<user>/st-usage.capture)"
Write-Host "  4) send one message - the floating pill starts counting"
