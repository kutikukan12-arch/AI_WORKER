# =====================================================
# start-operator.ps1 — 黒川 Desktop Operator 起動 (PowerShell版)
#
# 使い方:
#   PowerShell から: .\start-operator.ps1
#   右クリック → "PowerShellで実行" でも起動可
#
# bat版より信頼性が高い（引用符問題なし、エラー表示が明確）
# =====================================================

$ErrorActionPreference = 'Continue'
$Host.UI.RawUI.WindowTitle = "黒川 Desktop Operator"

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "   黒川 Desktop Operator 起動スクリプト (PS1)" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ─── 作業ディレクトリ設定 ─────────────────────────────
# このスクリプトがあるフォルダ = AI_WORKER ルート
$ROOT = $PSScriptRoot
if (-not $ROOT) { $ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $ROOT) { $ROOT = Get-Location }

Set-Location $ROOT -ErrorAction Stop
Write-Host "[OK] 作業ディレクトリ: $ROOT" -ForegroundColor Green

# ─── Node.js 確認 ────────────────────────────────────
$nodeVersion = node --version 2>$null
if ($LASTEXITCODE -ne 0 -or -not $nodeVersion) {
    Write-Host "[ERROR] Node.js が見つかりません。https://nodejs.org からインストールしてください。" -ForegroundColor Red
    Read-Host "Enterで終了"
    exit 1
}
Write-Host "[OK] Node.js: $nodeVersion" -ForegroundColor Green

# ─── desktop-operator.js 確認 ─────────────────────────
if (-not (Test-Path "scripts\desktop-operator.js")) {
    Write-Host "[ERROR] scripts\desktop-operator.js が見つかりません。" -ForegroundColor Red
    Read-Host "Enterで終了"
    exit 1
}
Write-Host "[OK] desktop-operator.js: 存在" -ForegroundColor Green

# ─── Lock チェック ────────────────────────────────────
Write-Host "[CHECK] 起動状態を確認中..."
node scripts\check-operator-lock.js
$lockCode = $LASTEXITCODE

if ($lockCode -eq 1) {
    Write-Host ""
    Write-Host "黒川はすでに勤務中です。" -ForegroundColor Yellow
    Write-Host ""
    node scripts\desktop-operator.js status
    Write-Host ""
    Write-Host "再起動する場合は既存プロセスを停止してください。" -ForegroundColor Yellow
    Read-Host "Enterで終了"
    exit 0
}

# ─── 起動 ────────────────────────────────────────────
Write-Host ""
Write-Host "[START] 黒川 Desktop Operator を起動します..." -ForegroundColor Green
Write-Host "        Ctrl+C で退勤できます。" -ForegroundColor Gray
Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

try {
    node scripts\desktop-operator.js watch
    $opCode = $LASTEXITCODE
} catch {
    Write-Host "[ERROR] 予期しないエラー: $_" -ForegroundColor Red
    $opCode = 99
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

if ($opCode -eq 0) {
    Write-Host "[OK] 黒川 Desktop Operator が退勤しました。" -ForegroundColor Green
} else {
    Write-Host "[ERROR] Desktop Operator が異常終了しました。終了コード: $opCode" -ForegroundColor Red
    Write-Host ""
    Write-Host "[HINT] 状態確認: node scripts\desktop-operator.js status" -ForegroundColor Yellow
}

Write-Host ""
Read-Host "Enterで終了"
