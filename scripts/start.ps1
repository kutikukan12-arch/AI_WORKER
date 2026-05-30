# =====================================================
# start.ps1 - AI_WORKER Bot Windows 起動スクリプト
# 実行方法: PowerShell を開いて
#   .\scripts\start.ps1
# =====================================================

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  AI_WORKER Bot 起動チェック" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# AI_WORKER フォルダのルートに移動（スクリプトの1つ上）
$rootDir = Split-Path -Parent $PSScriptRoot
Set-Location $rootDir

# ─── 1. .env ファイル確認 ───
Write-Host "[1/4] .env ファイルを確認中..." -ForegroundColor Yellow
if (-not (Test-Path ".env")) {
    Write-Host "  ❌ .env ファイルが見つかりません" -ForegroundColor Red
    Write-Host ""
    Write-Host "  作成方法:" -ForegroundColor Yellow
    Write-Host "    PowerShell で以下を実行してください:" -ForegroundColor White
    Write-Host "    Copy-Item .env.example .env" -ForegroundColor Green
    Write-Host "    その後、.env をメモ帳で開いて設定値を入力してください" -ForegroundColor White
    Write-Host ""
    Read-Host "  Enter キーを押して終了"
    exit 1
}
Write-Host "  ✅ .env ファイル 確認OK" -ForegroundColor Green

# ─── 2. Node.js 確認 ───
Write-Host "[2/4] Node.js を確認中..." -ForegroundColor Yellow
try {
    $nodeVersion = & node --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✅ Node.js: $nodeVersion" -ForegroundColor Green
    } else {
        throw "Node.js が見つかりません"
    }
} catch {
    Write-Host "  ❌ Node.js が見つかりません" -ForegroundColor Red
    Write-Host ""
    Write-Host "  インストール方法:" -ForegroundColor Yellow
    Write-Host "    https://nodejs.org を開いて" -ForegroundColor White
    Write-Host "    「LTS」バージョンをダウンロードしてインストールしてください" -ForegroundColor White
    Write-Host ""
    Read-Host "  Enter キーを押して終了"
    exit 1
}

# ─── 3. Claude Code 確認 ───
Write-Host "[3/4] Claude Code を確認中..." -ForegroundColor Yellow
try {
    $claudeVersion = & claude --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✅ Claude Code: $claudeVersion" -ForegroundColor Green
    } else {
        throw "Claude Code が見つかりません"
    }
} catch {
    Write-Host "  ⚠️  Claude Code が見つかりません" -ForegroundColor Yellow
    Write-Host "  インストール方法: npm install -g @anthropic-ai/claude-code" -ForegroundColor White
    Write-Host "  ※ インストールせずに起動することもできますが、!claude コマンドは動作しません" -ForegroundColor Gray
}

# ─── 4. npm パッケージ確認 ───
Write-Host "[4/4] 依存パッケージを確認中..." -ForegroundColor Yellow
if (-not (Test-Path "node_modules")) {
    Write-Host "  📦 パッケージをインストールします（初回のみ）..." -ForegroundColor Yellow
    & npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ❌ npm install に失敗しました" -ForegroundColor Red
        Read-Host "  Enter キーを押して終了"
        exit 1
    }
    Write-Host "  ✅ パッケージインストール完了" -ForegroundColor Green
} else {
    Write-Host "  ✅ パッケージ 確認OK" -ForegroundColor Green
}

# ─── 起動 ───
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  🚀 Bot を起動します..." -ForegroundColor Green
Write-Host "  終了するには Ctrl + C を押してください" -ForegroundColor Gray
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

& node bot/index.js
