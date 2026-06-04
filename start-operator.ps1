#Requires -Version 5.1
<#
.SYNOPSIS
    Kurokawa Desktop Operator - PowerShell Launcher (正式版)

.DESCRIPTION
    AI_WORKER Desktop Operator を起動する。
    日本語パス (D:\璃蘭\AI_WORKER) でも正常動作。

.NOTES
    使い方:
      ダブルクリック: start-operator.bat (このPS1を呼ぶ)
      直接実行:       powershell -ExecutionPolicy Bypass -File start-operator.ps1
      右クリック:     PowerShellで実行
#>

$ErrorActionPreference = 'Stop'

# ─── ウィンドウタイトル設定 ─────────────────────────
$Host.UI.RawUI.WindowTitle = "Kurokawa Desktop Operator"

# ─── ログファイル ────────────────────────────────────
# $PSScriptRoot = このPS1ファイルがあるフォルダ（日本語パスOK）
$ROOT = $PSScriptRoot

# PSScriptRoot が空の場合のフォールバック
if (-not $ROOT -or $ROOT -eq '') {
    $ROOT = Split-Path -Parent $MyInvocation.MyCommand.Definition
}
if (-not $ROOT -or $ROOT -eq '') {
    $ROOT = (Get-Location).Path
}

$LOG_DIR  = Join-Path $ROOT "logs"
$LOG_FILE = Join-Path $LOG_DIR "operator-startup.log"

function Write-Log {
    param([string]$Msg, [string]$Level = 'INFO')
    $ts = Get-Date -Format "yyyy/MM/dd HH:mm:ss"
    $line = "[$ts] [$Level] $Msg"
    Write-Host $line
    try {
        if (-not (Test-Path $LOG_DIR)) { New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null }
        Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8
    } catch { <# ログ失敗はスルー #> }
}

function Exit-WithPause {
    param([int]$Code = 0)
    Write-Host ""
    Write-Host "Press Enter to exit..." -ForegroundColor Gray
    Read-Host | Out-Null
    exit $Code
}

# ─── ヘッダー表示 ────────────────────────────────────
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Kurokawa Desktop Operator" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Log "Starting. ROOT=$ROOT"

# ─── 作業ディレクトリ設定 ─────────────────────────────
try {
    Set-Location $ROOT
    Write-Log "Working directory: $ROOT"
} catch {
    Write-Log "Failed to set working directory: $_" 'ERROR'
    Exit-WithPause 1
}

# ─── Node.js 確認 ────────────────────────────────────
try {
    $nodeVer = & node --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "node returned $LASTEXITCODE" }
    Write-Log "Node.js: $nodeVer"
} catch {
    Write-Log "Node.js not found. Install from https://nodejs.org" 'ERROR'
    Write-Host ""
    Write-Host "[ERROR] Node.js not found." -ForegroundColor Red
    Exit-WithPause 1
}

# ─── desktop-operator.js 確認 ─────────────────────────
$OPERATOR_JS = Join-Path $ROOT "scripts\desktop-operator.js"
if (-not (Test-Path $OPERATOR_JS)) {
    Write-Log "desktop-operator.js not found: $OPERATOR_JS" 'ERROR'
    Write-Host "[ERROR] scripts\desktop-operator.js not found." -ForegroundColor Red
    Exit-WithPause 1
}
Write-Log "desktop-operator.js: OK"

# ─── Lock チェック ────────────────────────────────────
$CHECK_LOCK = Join-Path $ROOT "scripts\check-operator-lock.js"
if (Test-Path $CHECK_LOCK) {
    Write-Log "Checking operator lock..."
    & node $CHECK_LOCK
    $lockCode = $LASTEXITCODE

    if ($lockCode -eq 1) {
        Write-Host ""
        Write-Host "[INFO] Kurokawa is already on duty." -ForegroundColor Yellow
        Write-Host ""
        & node (Join-Path $ROOT "scripts\desktop-operator.js") status
        Write-Host ""
        Write-Log "Already running. Exiting."
        Exit-WithPause 0
    }
}

# ─── 起動 ─────────────────────────────────────────────
Write-Host ""
Write-Log "Starting Desktop Operator (watch mode)..."
Write-Host "[START] Kurokawa Desktop Operator starting..." -ForegroundColor Green
Write-Host "        Press Ctrl+C to stop." -ForegroundColor Gray
Write-Host ""
Write-Host "==========================================`n" -ForegroundColor Cyan

try {
    & node (Join-Path $ROOT "scripts\desktop-operator.js") watch
    $opCode = $LASTEXITCODE
} catch {
    Write-Log "Unexpected error: $_" 'ERROR'
    $opCode = 99
}

# ─── 終了処理 ─────────────────────────────────────────
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan

if ($opCode -eq 0) {
    Write-Log "Kurokawa exited normally."
    Write-Host "[OK] Kurokawa Desktop Operator stopped." -ForegroundColor Green
} else {
    Write-Log "Kurokawa exited with code $opCode" 'ERROR'
    Write-Host "[ERROR] Desktop Operator exited with code: $opCode" -ForegroundColor Red
    Write-Host "[HINT]  Run: node scripts\desktop-operator.js status" -ForegroundColor Yellow
}

Write-Host ""
Exit-WithPause $opCode
