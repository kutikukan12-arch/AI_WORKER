@echo off
chcp 65001 > nul
title AI_WORKER - 黒川 Desktop Operator

echo.
echo ╔══════════════════════════════════════════════╗
echo ║   AI_WORKER  黒川 Desktop Operator 起動      ║
echo ╚══════════════════════════════════════════════╝
echo.

:: AI_WORKER フォルダへ移動
cd /d "%~dp0"

:: Node.js 確認
node --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js が見つかりません。インストールしてください。
    pause
    exit /b 1
)

:: Bot プロセス確認（bot.lock）
if exist "data\bot.lock" (
    echo [INFO] AI_WORKER Bot は稼働中です。
) else (
    echo [WARN] AI_WORKER Bot は停止中のようです。
    echo        先に "npm start" で Bot を起動してください。
    echo.
)

:: 二重起動チェック
if exist "data\desktop-operator\operator.lock" (
    echo [WARN] 黒川 Desktop Operator はすでに勤務中です。
    echo        既存プロセスを終了してから再起動してください。
    echo.
    node scripts/desktop-operator.js status
    echo.
    pause
    exit /b 0
)

echo [START] 黒川 Desktop Operator を起動します...
echo         Ctrl+C で停止できます。
echo.
echo ─────────────────────────────────────────────
npm run operator
echo ─────────────────────────────────────────────
echo.
echo 黒川 Desktop Operator が停止しました。
pause
