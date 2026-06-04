@echo off
setlocal EnableDelayedExpansion
chcp 65001 > nul 2>&1
title [黒川 Desktop Operator]

echo ================================================
echo   黒川 Desktop Operator 起動スクリプト
echo ================================================
echo.

:: ─── 作業ディレクトリを AI_WORKER ルートへ ─────────
:: %~dp0 = このbatファイルがあるフォルダ（末尾に\あり）
cd /d "%~dp0"
if %errorlevel% neq 0 (
    echo [ERROR] フォルダ移動に失敗: %~dp0
    goto :error_exit
)
echo [OK] 作業ディレクトリ: %CD%

:: ─── Node.js 確認 ──────────────────────────────────
echo [CHECK] Node.js を確認中...
node --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js が見つかりません。
    echo         https://nodejs.org からインストールしてください。
    goto :error_exit
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do (
    echo [OK] Node.js: %%v
)

:: ─── desktop-operator.js 確認 ──────────────────────
echo [CHECK] desktop-operator.js を確認中...
if not exist "scripts\desktop-operator.js" (
    echo [ERROR] scripts\desktop-operator.js が見つかりません。
    echo         このbatファイルを AI_WORKER フォルダに置いてください。
    goto :error_exit
)
echo [OK] desktop-operator.js: 存在

:: ─── package.json 確認 ─────────────────────────────
if not exist "package.json" (
    echo [ERROR] package.json が見つかりません。
    goto :error_exit
)
echo [OK] package.json: 存在

:: ─── Lock チェック（専用スクリプトを使用）──────────
:: node -e のインライン JS は bat の引用符を破壊するため専用ファイルを使用
echo [CHECK] 起動状態を確認中...
node scripts\check-operator-lock.js
set LOCK_CODE=%errorlevel%

if %LOCK_CODE% equ 1 (
    echo.
    echo 黒川はすでに勤務中です。
    echo.
    node scripts\desktop-operator.js status
    echo.
    echo 再起動する場合は既存プロセスを停止してください。
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
    echo [ERROR] Desktop Operator が異常終了しました。
    echo         終了コード: %OP_CODE%
    echo.
    echo [HINT] ログを確認してください:
    echo        node scripts\desktop-operator.js status
)
goto :normal_exit

:error_exit
echo.
echo ================================================
echo [FAILED] 起動に失敗しました。上記のエラーを確認してください。
echo ================================================
echo.
pause
exit /b 1

:normal_exit
echo.
pause
exit /b 0
