@echo off
chcp 65001 > nul 2>&1
title AI_WORKER - 黒川 Desktop Operator

echo.
echo ╔══════════════════════════════════════════════╗
echo ║   AI_WORKER  黒川 Desktop Operator 起動      ║
echo ╚══════════════════════════════════════════════╝
echo.

:: ─── AI_WORKER フォルダへ移動 ─────────────────────
cd /d "%~dp0"
if %errorlevel% neq 0 (
    echo [ERROR] AI_WORKER フォルダへの移動に失敗しました。
    echo         パス: %~dp0
    pause
    exit /b 1
)
echo [OK] フォルダ: %CD%

:: ─── Node.js 確認 ──────────────────────────────────
node --version > nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Node.js が見つかりません。
    echo         https://nodejs.org からインストールしてください。
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do echo [OK] Node.js: %%v

:: ─── npm 確認 ──────────────────────────────────────
npm --version > nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] npm が見つかりません。Node.js を再インストールしてください。
    pause
    exit /b 1
)

:: ─── package.json 確認 ─────────────────────────────
if not exist "package.json" (
    echo.
    echo [ERROR] package.json が見つかりません。
    echo         AI_WORKER フォルダでこの bat を実行してください。
    pause
    exit /b 1
)
echo [OK] package.json: 存在

:: ─── scripts/desktop-operator.js 確認 ─────────────
if not exist "scripts\desktop-operator.js" (
    echo.
    echo [ERROR] scripts\desktop-operator.js が見つかりません。
    pause
    exit /b 1
)
echo [OK] desktop-operator.js: 存在

:: ─── Bot プロセス確認（bot.lock）──────────────────
echo.
if exist "data\bot.lock" (
    echo [INFO] AI_WORKER Bot: 稼働中
) else (
    echo [WARN] AI_WORKER Bot は停止中のようです。
    echo        先に "npm start" で Bot を起動することを推奨します。
)

:: ─── stale lock チェック（PID確認）────────────────
if exist "data\desktop-operator\operator.lock" (
    :: Node.js で PID の生存確認（stale lock 自動解除）
    node -e "
      const fs=require('fs');
      try {
        const l=JSON.parse(fs.readFileSync('data/desktop-operator/operator.lock','utf8'));
        const age=Date.now()-new Date(l.startedAt).getTime();
        try { process.kill(l.pid,0); if(age<300000){process.exit(1);} } catch{}
        fs.unlinkSync('data/desktop-operator/operator.lock');
        console.log('[INFO] stale lock を解除しました (pid='+l.pid+')');
      } catch(e){process.exit(0);}
    " 2>nul
    if %errorlevel% equ 1 (
        echo.
        echo [WARN] 黒川 Desktop Operator はすでに勤務中です。
        echo        既存プロセスを停止してから再起動してください。
        echo.
        node scripts\desktop-operator.js status
        echo.
        pause
        exit /b 0
    )
)

:: ─── 起動 ────────────────────────────────────────
echo.
echo [START] 黒川 Desktop Operator を起動します...
echo         Ctrl+C で退勤できます。
echo         ウィンドウを閉じると強制退勤します。
echo.
echo ══════════════════════════════════════════════
echo.

node scripts\desktop-operator.js watch
set EXITCODE=%errorlevel%

echo.
echo ══════════════════════════════════════════════
echo.
if %EXITCODE% neq 0 (
    echo [ERROR] Desktop Operator が異常終了しました (code=%EXITCODE%)
    echo         logs/ を確認してください。
) else (
    echo [OK] 黒川 Desktop Operator が退勤しました。
)
echo.
pause
