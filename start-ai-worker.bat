@echo off
setlocal EnableDelayedExpansion
chcp 65001 > nul 2>&1
title [AI_WORKER - 黒川 Desktop Operator]

echo ================================================
echo   AI_WORKER  黒川 Desktop Operator 起動
echo ================================================
echo.

:: ─── 作業ディレクトリを AI_WORKER ルートへ ─────────
cd /d "%~dp0"
if %errorlevel% neq 0 (
    echo [ERROR] フォルダ移動に失敗しました: %~dp0
    goto :error_exit
)
echo [OK] 作業ディレクトリ: %CD%

:: ─── Node.js 確認 ──────────────────────────────────
node --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js が見つかりません。
    echo         https://nodejs.org からインストールしてください。
    goto :error_exit
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do echo [OK] Node.js: %%v

:: ─── npm 確認 ──────────────────────────────────────
npm --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm が見つかりません。Node.js を再インストールしてください。
    goto :error_exit
)

:: ─── 必要ファイル確認 ──────────────────────────────
if not exist "scripts\desktop-operator.js" (
    echo [ERROR] scripts\desktop-operator.js が見つかりません
    goto :error_exit
)
if not exist "package.json" (
    echo [ERROR] package.json が見つかりません
    goto :error_exit
)
echo [OK] 必要ファイル: 確認済み

:: ─── Bot プロセス確認 ──────────────────────────────
echo.
if exist "data\bot.lock" (
    echo [INFO] AI_WORKER Bot: 稼働中
) else (
    echo [WARN] AI_WORKER Bot は停止中のようです。
    echo        先に "npm start" で Bot を起動することを推奨します。
)

:: ─── Lock チェック（専用スクリプトを使用）──────────
echo [CHECK] 起動状態を確認中...
node scripts\check-operator-lock.js
set LOCK_CODE=%errorlevel%

if %LOCK_CODE% equ 1 (
    echo.
    echo [WARN] 黒川はすでに勤務中です。
    echo        既存プロセスを停止してから再起動してください。
    echo.
    node scripts\desktop-operator.js status
    goto :normal_exit
)

:: ─── 起動 ────────────────────────────────────────
echo.
echo [START] 黒川 Desktop Operator を起動します...
echo         Ctrl+C で退勤できます。
echo.
echo ================================================
echo.

node scripts\desktop-operator.js watch
set OP_CODE=%errorlevel%

echo.
echo ================================================
echo.
if %OP_CODE% equ 0 (
    echo [OK] 黒川 Desktop Operator が退勤しました。
) else (
    echo [ERROR] Desktop Operator が異常終了しました。終了コード: %OP_CODE%
    echo         node scripts\desktop-operator.js status で確認してください。
)
goto :normal_exit

:error_exit
echo.
echo ================================================
echo [FAILED] 起動に失敗しました。
echo ================================================
echo.
pause
exit /b 1

:normal_exit
echo.
pause
exit /b 0
